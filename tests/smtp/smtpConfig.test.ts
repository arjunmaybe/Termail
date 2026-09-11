/**
 * Phase 4 — SMTP configuration resolution tests.
 *
 * Uses dummy values only; no network, no real credentials.
 */

import { describe, expect, it } from 'vitest';
import { accountConfigSchema, resolveSmtpDefaults } from '../../src/core/config/schema.js';
import { resolveSmtpConfig, resolveSmtpMode, resolveSmtpPort } from '../../src/core/smtp/config.js';
import type { AccountConfig } from '../../src/core/types/config.js';

const base: AccountConfig = {
  id: 'work',
  name: 'Work',
  email: 'me@example.com',
  enabled: true,
  host: 'imap.example.com',
  port: 993,
  useTls: true,
  authType: 'password',
};

describe('resolveSmtpDefaults (schema)', () => {
  it('defaults to implicit-tls/465 when neither is set', () => {
    expect(resolveSmtpDefaults({})).toEqual({ smtpPort: 465, smtpMode: 'implicit-tls' });
  });

  it('infers implicit-tls from port 465', () => {
    expect(resolveSmtpDefaults({ smtpPort: 465 })).toEqual({
      smtpPort: 465,
      smtpMode: 'implicit-tls',
    });
  });

  it('infers starttls from any non-465 port', () => {
    expect(resolveSmtpDefaults({ smtpPort: 587 })).toEqual({
      smtpPort: 587,
      smtpMode: 'starttls',
    });
    expect(resolveSmtpDefaults({ smtpPort: 25 })).toEqual({
      smtpPort: 25,
      smtpMode: 'starttls',
    });
  });

  it('defaults port from mode', () => {
    expect(resolveSmtpDefaults({ smtpMode: 'implicit-tls' })).toEqual({
      smtpPort: 465,
      smtpMode: 'implicit-tls',
    });
    expect(resolveSmtpDefaults({ smtpMode: 'starttls' })).toEqual({
      smtpPort: 587,
      smtpMode: 'starttls',
    });
  });

  it('explicit port always wins over the mode default', () => {
    expect(resolveSmtpDefaults({ smtpPort: 2525, smtpMode: 'implicit-tls' })).toEqual({
      smtpPort: 2525,
      smtpMode: 'implicit-tls',
    });
  });
});

describe('accountConfigSchema SMTP fields', () => {
  const input = {
    id: 'work',
    name: 'Work',
    email: 'me@example.com',
    enabled: true,
    useTls: true,
    authType: 'password' as const,
  };

  it('defaults SMTP to implicit-tls/465', () => {
    const parsed = accountConfigSchema.parse(input);
    expect(parsed.smtpPort).toBe(465);
    expect(parsed.smtpMode).toBe('implicit-tls');
  });

  it('keeps explicit smtpHost/smtpPort/smtpMode', () => {
    const parsed = accountConfigSchema.parse({
      ...input,
      smtpHost: 'smtp.example.com',
      smtpPort: 587,
      smtpMode: 'starttls',
    });
    expect(parsed.smtpHost).toBe('smtp.example.com');
    expect(parsed.smtpPort).toBe(587);
    expect(parsed.smtpMode).toBe('starttls');
  });

  it('does not infer SMTP mode from IMAP useTls', () => {
    const plain = accountConfigSchema.parse({ ...input, useTls: false });
    // IMAP port follows useTls...
    expect(plain.port).toBe(143);
    // ...but SMTP still defaults to implicit-tls/465.
    expect(plain.smtpPort).toBe(465);
    expect(plain.smtpMode).toBe('implicit-tls');
  });

  it('rejects unknown smtpMode', () => {
    expect(() => accountConfigSchema.parse({ ...input, smtpMode: 'ssl' })).toThrow();
  });

  it('rejects out-of-range smtpPort', () => {
    expect(() => accountConfigSchema.parse({ ...input, smtpPort: 0 })).toThrow();
    expect(() => accountConfigSchema.parse({ ...input, smtpPort: 70000 })).toThrow();
  });
});

describe('resolveSmtpConfig', () => {
  it('resolves explicit starttls config', () => {
    const out = resolveSmtpConfig({
      ...base,
      smtpHost: 'smtp.example.com',
      smtpPort: 587,
      smtpMode: 'starttls',
    });
    expect(out).toEqual({ host: 'smtp.example.com', port: 587, mode: 'starttls' });
  });

  it('applies mode-only defaults', () => {
    expect(resolveSmtpMode({ smtpMode: 'starttls' })).toBe('starttls');
    expect(resolveSmtpPort({ smtpMode: 'starttls' })).toBe(587);
    expect(resolveSmtpPort({ smtpMode: 'implicit-tls' })).toBe(465);
  });

  it('throws NetworkError before connecting when smtpHost is missing', () => {
    expect(() => resolveSmtpConfig({ ...base })).toThrow(/missing an SMTP host/i);
    expect(() => resolveSmtpConfig({ ...base, smtpHost: '  ' })).toThrow(/missing an SMTP host/i);
  });

  it('throws on invalid port', () => {
    expect(() => resolveSmtpConfig({ ...base, smtpHost: 's', smtpPort: 0 })).toThrow(/invalid SMTP port/i);
  });
});
