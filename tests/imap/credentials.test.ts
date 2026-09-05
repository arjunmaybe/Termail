/**
 * Tests for credential resolution and redaction.
 */

import { describe, expect, it } from 'vitest';
import type { AccountConfig } from '../../src/core/types/config.js';
import { AuthenticationError } from '../../src/core/utils/errors.js';
import {
  getEnvSecretName,
  getEnvSecretSuffix,
  redactSecrets,
  resolveCredentials,
} from '../../src/core/imap/credentials.js';

const baseAccount: AccountConfig = {
  id: 'work',
  name: 'Work',
  email: 'me@example.com',
  enabled: true,
  host: 'imap.example.com',
  port: 993,
  useTls: true,
  authType: 'password',
};

describe('getEnvSecretSuffix', () => {
  it('uppercases and replaces non-alphanumeric characters', () => {
    expect(getEnvSecretSuffix('work-mail')).toBe('WORK_MAIL');
    expect(getEnvSecretSuffix('gmail')).toBe('GMAIL');
    expect(getEnvSecretSuffix('a.b@c')).toBe('A_B_C');
  });
});

describe('getEnvSecretName', () => {
  it('returns the password env var name for password auth', () => {
    expect(getEnvSecretName(baseAccount)).toBe('TERMAIL_WORK_PASSWORD');
  });

  it('returns the oauth2 env var name for oauth2 auth', () => {
    expect(getEnvSecretName({ ...baseAccount, authType: 'oauth2' })).toBe(
      'TERMAIL_WORK_OAUTH_TOKEN'
    );
  });
});

describe('resolveCredentials', () => {
  it('returns the secret and user when the env var is set', () => {
    const result = resolveCredentials(baseAccount, { TERMAIL_WORK_PASSWORD: 'hunter2' });
    expect(result).toEqual({
      user: 'me@example.com',
      secret: 'hunter2',
      kind: 'password',
    });
  });

  it('uses the explicit username when set', () => {
    const result = resolveCredentials(
      { ...baseAccount, username: 'me-just-the-name' },
      { TERMAIL_WORK_PASSWORD: 'hunter2' }
    );
    expect(result.user).toBe('me-just-the-name');
  });

  it('throws AuthenticationError when the env var is missing', () => {
    expect(() => resolveCredentials(baseAccount, {})).toThrow(AuthenticationError);
  });

  it('throws AuthenticationError when the env var is empty', () => {
    expect(() => resolveCredentials(baseAccount, { TERMAIL_WORK_PASSWORD: '' })).toThrow(
      AuthenticationError
    );
  });

  it('throws AuthenticationError with a non-secret message', () => {
    try {
      resolveCredentials(baseAccount, {});
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthenticationError);
      const message = (error as Error).message;
      expect(message).toContain('TERMAIL_WORK_PASSWORD');
      expect(message).not.toContain('hunter2');
    }
  });

  it('returns an oauth2 credential when authType is oauth2', () => {
    const account = { ...baseAccount, authType: 'oauth2' as const };
    const result = resolveCredentials(account, { TERMAIL_WORK_OAUTH_TOKEN: 'token-xyz' });
    expect(result).toEqual({
      user: 'me@example.com',
      secret: 'token-xyz',
      kind: 'oauth2',
    });
  });
});

describe('redactSecrets', () => {
  it('replaces exact matches inside strings', () => {
    const out = redactSecrets('login failed for user hunter2 from 1.2.3.4', ['hunter2']);
    expect(out).toBe('login failed for user *** from 1.2.3.4');
  });

  it('replaces multiple distinct secrets', () => {
    const out = redactSecrets('p=hunter2 t=token-xyz', ['hunter2', 'token-xyz']);
    expect(out).toBe('p=*** t=***');
  });

  it('walks nested objects and arrays', () => {
    const out = redactSecrets(
      { user: 'me', nested: { pw: 'hunter2' }, history: ['login hunter2 ok', 'noop'] },
      ['hunter2']
    );
    expect(out).toEqual({
      user: 'me',
      nested: { pw: '***' },
      history: ['login *** ok', 'noop'],
    });
  });

  it('is a no-op when there are no secrets', () => {
    const value = { a: 1, b: 'hi' };
    expect(redactSecrets(value, [])).toEqual(value);
  });

  it('ignores empty-string secrets', () => {
    const out = redactSecrets('nothing to redact', ['']);
    expect(out).toBe('nothing to redact');
  });

  it('returns non-string primitives unchanged', () => {
    expect(redactSecrets(42, ['42'])).toBe(42);
    expect(redactSecrets(null, ['x'])).toBe(null);
  });
});
