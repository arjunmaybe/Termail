/**
 * Phase 5 — OpenRouter transport tests with an injected fetch fake.
 * No network, no real credentials. Dummy key only.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  OpenRouterTransport,
  type FetchFn,
} from '../../src/core/ai/OpenRouterTransport.js';
import { AuthenticationError, NetworkError } from '../../src/core/utils/errors.js';

const DUMMY_KEY = 'test-ai-key-123';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

function okResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function successBody(text: string): unknown {
  return { id: 'gen-1', choices: [{ message: { role: 'assistant', content: text } }] };
}

describe('OpenRouterTransport', () => {
  it('posts model + messages with a Bearer key and returns the text', async () => {
    const fetchMock = vi.fn(async () => okResponse(successBody('Hello summary')));
    const transport = new OpenRouterTransport({
      endpoint: ENDPOINT,
      model: 'test-model',
      apiKey: DUMMY_KEY,
      timeoutMs: 1000,
      fetchFn: fetchMock as unknown as FetchFn,
    });
    const text = await transport.complete({ system: 'sys', user: 'usr' });
    expect(text).toBe('Hello summary');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${DUMMY_KEY}`);
    const payload = JSON.parse(init.body as string) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(payload.model).toBe('test-model');
    expect(payload.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
  });

  it('maps 401 to AuthenticationError without the key', async () => {
    const fetchFn = (async () => new Response('unauthorized', { status: 401 })) as unknown as FetchFn;
    const transport = new OpenRouterTransport({
      endpoint: ENDPOINT,
      model: 'm',
      apiKey: DUMMY_KEY,
      timeoutMs: 1000,
      fetchFn,
    });
    const err = await transport.complete({ system: 's', user: 'u' }).then(
      () => new Error('expected throw'),
      (e: unknown) => e as Error
    );
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.message).not.toContain(DUMMY_KEY);
  });

  it('maps 429 to a rate-limit NetworkError', async () => {
    const fetchFn = (async () => new Response('slow down', { status: 429 })) as unknown as FetchFn;
    const transport = new OpenRouterTransport({
      endpoint: ENDPOINT,
      model: 'm',
      apiKey: DUMMY_KEY,
      timeoutMs: 1000,
      fetchFn,
    });
    const err = await transport.complete({ system: 's', user: 'u' }).then(
      () => new Error('expected throw'),
      (e: unknown) => e as Error
    );
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.message).toMatch(/rate-limited/i);
  });

  it('maps provider error bodies and malformed responses to NetworkError', async () => {
    const cases: unknown[] = [
      { error: { message: 'insufficient credits' } },
      { choices: [] },
      { choices: [{ message: { content: '   ' } }] },
      { notAnObject: true },
    ];
    for (const body of cases) {
      const fetchFn = (async () => okResponse(body)) as unknown as FetchFn;
      const transport = new OpenRouterTransport({
        endpoint: ENDPOINT,
        model: 'm',
        apiKey: DUMMY_KEY,
        timeoutMs: 1000,
        fetchFn,
      });
      await expect(transport.complete({ system: 's', user: 'u' })).rejects.toBeInstanceOf(
        NetworkError
      );
    }
  });

  it('maps invalid JSON to NetworkError', async () => {
    const fetchFn = (async () =>
      new Response('not json{{{', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as FetchFn;
    const transport = new OpenRouterTransport({
      endpoint: ENDPOINT,
      model: 'm',
      apiKey: DUMMY_KEY,
      timeoutMs: 1000,
      fetchFn,
    });
    await expect(transport.complete({ system: 's', user: 'u' })).rejects.toBeInstanceOf(NetworkError);
  });

  it('times out when fetch never settles', async () => {
    const fetchFn = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      })) as unknown as FetchFn;
    const transport = new OpenRouterTransport({
      endpoint: ENDPOINT,
      model: 'm',
      apiKey: DUMMY_KEY,
      timeoutMs: 50,
      fetchFn,
    });
    const err = await transport.complete({ system: 's', user: 'u' }).then(
      () => new Error('expected throw'),
      (e: unknown) => e as Error
    );
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.message).toMatch(/timed out/i);
  });

  it('redacts the key from fetch failure messages', async () => {
    const fetchFn = (async () => {
      throw new Error(`connect failed with ${DUMMY_KEY} inside`);
    }) as unknown as FetchFn;
    const transport = new OpenRouterTransport({
      endpoint: ENDPOINT,
      model: 'm',
      apiKey: DUMMY_KEY,
      timeoutMs: 1000,
      fetchFn,
    });
    const err = await transport.complete({ system: 's', user: 'u' }).then(
      () => new Error('expected throw'),
      (e: unknown) => e as Error
    );
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.message).not.toContain(DUMMY_KEY);
    expect(err.message).toContain('***');
  });
});
