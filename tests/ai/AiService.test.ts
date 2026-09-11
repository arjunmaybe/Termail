/**
 * Phase 5 — AiService tests with a fake provider (no network).
 */

import { describe, expect, it, vi } from 'vitest';
import { AiService } from '../../src/core/ai/AiService.js';
import type { AiEmailInput, AiProvider } from '../../src/core/ai/types.js';
import { DEFAULT_AI_CONFIG, type AiConfig } from '../../src/core/types/config.js';
import { AuthenticationError, NetworkError } from '../../src/core/utils/errors.js';

const DUMMY_KEY = 'test-ai-key-123';

const enabled: AiConfig = { ...DEFAULT_AI_CONFIG, enabled: true };

const email: AiEmailInput = {
  from: 'alice@example.com',
  to: 'me@example.com',
  cc: '(none)',
  subject: 'Q3 planning',
  date: 'Mon, 01 Sep 2026 10:00:00 GMT',
  body: 'Please review by Friday.',
};

function serviceWith(provider: AiProvider, env: NodeJS.ProcessEnv = {}) {
  return new AiService({ config: enabled, factory: () => provider, env });
}

describe('AiService', () => {
  it('refuses to run when disabled', async () => {
    const provider: AiProvider = { complete: vi.fn() };
    const service = new AiService({
      config: { ...DEFAULT_AI_CONFIG, enabled: false },
      factory: () => provider,
      env: { TERMAIL_AI_API_KEY: DUMMY_KEY },
    });
    const outcome = await service.summarizeEmail(email);
    expect(outcome.kind).toBe('validation');
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('validates empty emails without calling the provider', async () => {
    const provider: AiProvider = { complete: vi.fn().mockResolvedValue('x') };
    const service = serviceWith(provider, { TERMAIL_AI_API_KEY: DUMMY_KEY });
    const outcome = await service.summarizeEmail({ ...email, subject: '  ', body: '  ' });
    expect(outcome.kind).toBe('validation');
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('returns auth when the API key is missing (no provider call)', async () => {
    const provider: AiProvider = { complete: vi.fn() };
    const service = serviceWith(provider, {});
    const outcome = await service.summarizeEmail(email);
    expect(outcome.kind).toBe('auth');
    if (outcome.kind === 'auth') {
      expect(outcome.message).toContain('TERMAIL_AI_API_KEY');
      expect(outcome.message).not.toContain(DUMMY_KEY);
    }
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('returns ok text on success', async () => {
    const provider: AiProvider = { complete: vi.fn().mockResolvedValue('Short summary.') };
    const service = serviceWith(provider, { TERMAIL_AI_API_KEY: DUMMY_KEY });
    const outcome = await service.summarizeEmail(email);
    expect(outcome).toEqual({ kind: 'ok', text: 'Short summary.' });
  });

  it('routes drafts through the draft prompt path', async () => {
    const provider: AiProvider = { complete: vi.fn().mockResolvedValue('Draft body.') };
    const service = serviceWith(provider, { TERMAIL_AI_API_KEY: DUMMY_KEY });
    const outcome = await service.draftReply(email, 'accept');
    expect(outcome).toEqual({ kind: 'ok', text: 'Draft body.' });
    const request = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      system: string;
      user: string;
    };
    expect(request.system).toMatch(/draft/i);
    expect(request.user).toContain('accept');
  });

  it('maps AuthenticationError to auth without the key', async () => {
    const provider: AiProvider = {
      complete: vi.fn().mockRejectedValue(new AuthenticationError(`bad ${DUMMY_KEY}`)),
    };
    const service = serviceWith(provider, { TERMAIL_AI_API_KEY: DUMMY_KEY });
    const outcome = await service.summarizeEmail(email);
    expect(outcome.kind).toBe('auth');
    if (outcome.kind === 'auth') {
      expect(outcome.message).not.toContain(DUMMY_KEY);
      expect(outcome.message).toContain('***');
    }
  });

  it('maps NetworkError to network without the key', async () => {
    const provider: AiProvider = {
      complete: vi.fn().mockRejectedValue(new NetworkError(`down ${DUMMY_KEY}`)),
    };
    const service = serviceWith(provider, { TERMAIL_AI_API_KEY: DUMMY_KEY });
    const outcome = await service.summarizeEmail(email);
    expect(outcome.kind).toBe('network');
    if (outcome.kind === 'network') {
      expect(outcome.message).not.toContain(DUMMY_KEY);
    }
  });
});
