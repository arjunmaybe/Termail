/**
 * AI endpoint HTTPS enforcement. No network, no real credentials.
 * Dummy key and synthetic email content only.
 */

import { describe, expect, it, vi } from 'vitest';
import { AiService } from '../../src/core/ai/AiService.js';
import {
  OpenRouterTransport,
  type FetchFn,
} from '../../src/core/ai/OpenRouterTransport.js';
import { aiConfigSchema } from '../../src/core/config/schema.js';
import { DEFAULT_AI_CONFIG } from '../../src/core/types/config.js';
import { ValidationError } from '../../src/core/utils/errors.js';

const DUMMY_KEY = 'test-ai-key-123';
const HTTPS_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const HTTPS_GATEWAY = 'https://gateway.example.com/v1/chat/completions';
const HTTP_ENDPOINT = 'http://openrouter.ai/api/v1/chat/completions';
const SECRET_BODY = 'synthetic-secret-body-987';
const SECRET_SUBJECT = 'synthetic-secret-subject-654';

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('AI endpoint HTTPS enforcement', () => {
  it('accepts the default HTTPS endpoint in config validation', () => {
    const parsed = aiConfigSchema.parse({});
    expect(parsed.endpoint).toBe(HTTPS_ENDPOINT);
  });

  it('accepts a custom HTTPS gateway endpoint', () => {
    const parsed = aiConfigSchema.parse({ endpoint: HTTPS_GATEWAY });
    expect(parsed.endpoint).toBe(HTTPS_GATEWAY);
  });

  it('rejects an HTTP endpoint in config validation', () => {
    expect(() => aiConfigSchema.parse({ endpoint: HTTP_ENDPOINT })).toThrow(/https/i);
  });

  it('rejects non-HTTPS schemes in config validation', () => {
    expect(() => aiConfigSchema.parse({ endpoint: 'ftp://example.com/v1' })).toThrow(/https/i);
  });

  it('sends the request for an HTTPS endpoint', async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({ choices: [{ message: { content: 'summary' } }] })
    );
    const transport = new OpenRouterTransport({
      endpoint: HTTPS_ENDPOINT,
      model: 'm',
      apiKey: DUMMY_KEY,
      timeoutMs: 1000,
      fetchFn: fetchMock as unknown as FetchFn,
    });
    await expect(transport.complete({ system: 'sys', user: 'usr' })).resolves.toBe('summary');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an HTTP endpoint without calling fetch or leaking secrets', async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({ choices: [{ message: { content: 'should never arrive' } }] })
    );
    const transport = new OpenRouterTransport({
      endpoint: HTTP_ENDPOINT,
      model: 'm',
      apiKey: DUMMY_KEY,
      timeoutMs: 1000,
      fetchFn: fetchMock as unknown as FetchFn,
    });
    const err = await transport
      .complete({ system: SECRET_SUBJECT, user: SECRET_BODY })
      .then(
        () => new Error('expected throw'),
        (e: unknown) => e as Error
      );
    expect(err).toBeInstanceOf(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(err.message).not.toContain(DUMMY_KEY);
    expect(err.message).not.toContain(SECRET_BODY);
    expect(err.message).not.toContain(SECRET_SUBJECT);
    expect(err.message).not.toContain(HTTP_ENDPOINT);
  });

  it('returns a validation outcome without fetching for an HTTP endpoint via AiService', async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({ choices: [{ message: { content: 'should never arrive' } }] })
    );
    const service = new AiService({
      config: { ...DEFAULT_AI_CONFIG, enabled: true, endpoint: HTTP_ENDPOINT },
      env: { TERMAIL_AI_API_KEY: DUMMY_KEY },
      fetchFn: fetchMock as unknown as FetchFn,
    });
    const outcome = await service.summarizeEmail({
      from: 'alice@example.com',
      to: 'me@example.com',
      cc: '(none)',
      subject: SECRET_SUBJECT,
      date: 'Mon, 01 Sep 2026 10:00:00 GMT',
      body: SECRET_BODY,
    });
    expect(outcome.kind).toBe('validation');
    expect(fetchMock).not.toHaveBeenCalled();
    if (outcome.kind === 'validation') {
      expect(outcome.message).not.toContain(DUMMY_KEY);
      expect(outcome.message).not.toContain(SECRET_BODY);
      expect(outcome.message).not.toContain(SECRET_SUBJECT);
    }
  });
});
