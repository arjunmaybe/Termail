/**
 * Tests for the IMAP-enabled account config schema.
 */

import { describe, expect, it } from 'vitest';
import { accountConfigSchema } from '../../src/core/config/schema.js';

const baseAccount = {
  id: 'work',
  name: 'Work',
  email: 'me@example.com',
  enabled: true,
  useTls: true,
  authType: 'password' as const,
};

describe('accountConfigSchema (IMAP fields)', () => {
  it('defaults the port to 993 when useTls is true', () => {
    const parsed = accountConfigSchema.parse(baseAccount);
    expect(parsed.port).toBe(993);
  });

  it('defaults the port to 143 when useTls is false', () => {
    const parsed = accountConfigSchema.parse({ ...baseAccount, useTls: false });
    expect(parsed.port).toBe(143);
  });

  it('keeps an explicit port when provided', () => {
    const parsed = accountConfigSchema.parse({ ...baseAccount, port: 1430 });
    expect(parsed.port).toBe(1430);
  });

  it('accepts an optional host', () => {
    const parsed = accountConfigSchema.parse({ ...baseAccount, host: 'imap.example.com' });
    expect(parsed.host).toBe('imap.example.com');
  });

  it('accepts an optional username', () => {
    const parsed = accountConfigSchema.parse({ ...baseAccount, username: 'me' });
    expect(parsed.username).toBe('me');
  });

  it('defaults enabled to true when omitted', () => {
    const { enabled: _enabled, ...rest } = baseAccount;
    void _enabled;
    const parsed = accountConfigSchema.parse(rest);
    expect(parsed.enabled).toBe(true);
  });

  it('defaults authType to password when omitted', () => {
    const { authType: _authType, ...rest } = baseAccount;
    void _authType;
    const parsed = accountConfigSchema.parse(rest);
    expect(parsed.authType).toBe('password');
  });

  it('accepts oauth2 auth type', () => {
    const parsed = accountConfigSchema.parse({ ...baseAccount, authType: 'oauth2' });
    expect(parsed.authType).toBe('oauth2');
  });

  it('rejects an invalid email', () => {
    expect(() => accountConfigSchema.parse({ ...baseAccount, email: 'not-an-email' })).toThrow();
  });

  it('rejects a port out of range', () => {
    expect(() => accountConfigSchema.parse({ ...baseAccount, port: 0 })).toThrow();
    expect(() => accountConfigSchema.parse({ ...baseAccount, port: 70000 })).toThrow();
  });

  it('rejects a non-integer port', () => {
    expect(() => accountConfigSchema.parse({ ...baseAccount, port: 1.5 })).toThrow();
  });

  it('rejects an empty id', () => {
    expect(() => accountConfigSchema.parse({ ...baseAccount, id: '' })).toThrow();
  });

  it('rejects an empty host when provided', () => {
    expect(() => accountConfigSchema.parse({ ...baseAccount, host: '' })).toThrow();
  });

  it('does not accept a password field even if provided in input', () => {
    // Zod's `.object({...})` strips unknown keys, so the password is
    // silently dropped. We assert by reading it back from the parsed value.
    const parsed = accountConfigSchema.parse({
      ...baseAccount,
      password: 'super-secret',
    });
    expect((parsed as Record<string, unknown>).password).toBeUndefined();
  });
});
