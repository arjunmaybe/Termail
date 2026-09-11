/**
 * Phase 5 — AI configuration tests. No network, no real credentials.
 */

import { describe, expect, it } from 'vitest';
import { aiConfigSchema, validateConfig } from '../../src/core/config/schema.js';
import { mergeWithDefaults } from '../../src/core/config/defaults.js';
import { DEFAULT_AI_CONFIG } from '../../src/core/types/config.js';

describe('aiConfigSchema', () => {
  it('defaults to disabled with OpenRouter endpoint', () => {
    const parsed = aiConfigSchema.parse({});
    expect(parsed.enabled).toBe(false);
    expect(parsed.provider).toBe('openrouter');
    expect(parsed.model).toBe(DEFAULT_AI_CONFIG.model);
    expect(parsed.endpoint).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(parsed.maxBodyChars).toBe(8000);
    expect(parsed.requestTimeoutMs).toBe(30000);
  });

  it('accepts a custom model and endpoint', () => {
    const parsed = aiConfigSchema.parse({
      enabled: true,
      model: 'some-vendor/some-model',
      endpoint: 'https://gateway.example.com/v1/chat/completions',
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.model).toBe('some-vendor/some-model');
    expect(parsed.endpoint).toBe('https://gateway.example.com/v1/chat/completions');
  });

  it('rejects an unknown provider', () => {
    expect(() => aiConfigSchema.parse({ provider: 'other' })).toThrow();
  });

  it('rejects a non-URL endpoint and out-of-range limits', () => {
    expect(() => aiConfigSchema.parse({ endpoint: 'not-a-url' })).toThrow();
    expect(() => aiConfigSchema.parse({ maxBodyChars: 10 })).toThrow();
    expect(() => aiConfigSchema.parse({ requestTimeoutMs: 100 })).toThrow();
  });
});

describe('app config AI integration', () => {
  it('fills AI defaults for old config files without an ai section', () => {
    const config = validateConfig({
      version: 1,
      database: { path: '/tmp/db.sqlite' },
      ui: {},
      accounts: [],
    });
    expect(config.ai.enabled).toBe(false);
    expect(config.ai.model).toBe(DEFAULT_AI_CONFIG.model);
  });

  it('does not change IMAP/SMTP port defaults', () => {
    const config = validateConfig({
      version: 1,
      database: { path: '/tmp/db.sqlite' },
      ui: {},
      accounts: [{ id: 'w', name: 'W', email: 'me@example.com' }],
    });
    expect(config.accounts[0]?.port).toBe(993);
    expect(config.accounts[0]?.smtpPort).toBe(465);
    expect(config.accounts[0]?.smtpMode).toBe('implicit-tls');
  });

  it('mergeWithDefaults deep-merges the ai section', () => {
    const merged = mergeWithDefaults({ ai: { enabled: true } as never });
    expect(merged.ai.enabled).toBe(true);
    expect(merged.ai.model).toBe(DEFAULT_AI_CONFIG.model);
  });
});
