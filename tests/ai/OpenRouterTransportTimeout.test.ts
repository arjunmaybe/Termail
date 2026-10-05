/**
 * B13 — AI timeout must cover response body consumption.
 *
 * Deterministic fake: fetch resolves headers immediately, but the
 * response body read stalls until the abort timer fires. The request
 * must reject with existing timeout/network semantics and never leak
 * the API key.
 */

import { describe, expect, it } from 'vitest';
import {
  OpenRouterTransport,
  type FetchFn,
} from '../../src/core/ai/OpenRouterTransport.js';
import { NetworkError } from '../../src/core/utils/errors.js';

const DUMMY_KEY = 'test-ai-key-123';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

describe('B13 OpenRouterTransport body-consumption timeout', () => {
  it('times out when response.json() stalls after headers resolve', async () => {
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      return {
        ok: true,
        status: 200,
        json: async () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              // Simulate an abort error that (maliciously) contains the key;
              // the transport must still redact it.
              reject(new DOMException(`aborted with ${DUMMY_KEY}`, 'AbortError'));
            });
          }),
        text: async () =>
          new Promise<string>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException(`aborted with ${DUMMY_KEY}`, 'AbortError'));
            });
          }),
      } as unknown as Response;
    }) as unknown as FetchFn;

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
    expect(err.message).not.toContain(DUMMY_KEY);
  });

  it('times out when response.text() stalls on a non-ok status', async () => {
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      return {
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () =>
          new Promise<string>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException(`aborted with ${DUMMY_KEY}`, 'AbortError'));
            });
          }),
      } as unknown as Response;
    }) as unknown as FetchFn;

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
    expect(err.message).not.toContain(DUMMY_KEY);
  });
});
