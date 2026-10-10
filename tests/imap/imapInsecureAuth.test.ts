/**
 * Cleartext IMAP authentication must never happen silently.
 *
 * `useTls: false` maps to imapflow's `secure: false`, which is only
 * opportunistic STARTTLS: the library upgrades when the server advertises
 * STARTTLS and otherwise authenticates over the plain connection
 * (verified in imapflow 1.7.8 `lib/imap-flow.js`: `startSession()` calls
 * `upgradeToSTARTTLS()` then `authenticate()` unconditionally;
 * `_failSTARTTLS()` returns false for the default `doSTARTTLS`, and
 * `authenticate()` sends LOGIN/AUTHENTICATE without checking encryption).
 *
 * These tests pin the safe behavior: refusal by default, explicit
 * `allowInsecureAuth: true` opt-in only, warnings free of secrets.
 * Fake `ImapFlow` objects only — no network, dummy secrets only.
 */

import type { ImapFlow } from 'imapflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountConfigSchema } from '../../src/core/config/schema.js';
import { ImapService, buildImapOptions } from '../../src/core/imap/ImapService.js';
import type { ImapFlowFactory } from '../../src/core/imap/types.js';
import type { AccountConfig } from '../../src/core/types/config.js';
import { AuthenticationError } from '../../src/core/utils/errors.js';

const SECRET = 'super-secret-password-xyz';
const TOKEN = 'oauth-token-abc-123';

const tlsAccount: AccountConfig = {
  id: 'work',
  name: 'Work',
  email: 'me@example.com',
  enabled: true,
  host: 'imap.example.com',
  port: 993,
  useTls: true,
  authType: 'password',
};

const plainAccount: AccountConfig = {
  ...tlsAccount,
  port: 143,
  useTls: false,
};

interface FakeImapFlow {
  connect: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function makeFake(): FakeImapFlow {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

function makeFactory(fake: FakeImapFlow): ImapFlowFactory & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    create: vi.fn((options) => {
      calls.push(options);
      return fake as unknown as ImapFlow;
    }),
  };
}

describe('insecure IMAP authentication opt-in', () => {
  describe('accountConfigSchema', () => {
    it('defaults allowInsecureAuth to false', () => {
      const parsed = accountConfigSchema.parse({
        id: 'w',
        name: 'W',
        email: 'me@example.com',
        useTls: true,
      });
      expect(parsed.allowInsecureAuth).toBe(false);
    });

    it('keeps an explicit opt-in', () => {
      const parsed = accountConfigSchema.parse({
        id: 'w',
        name: 'W',
        email: 'me@example.com',
        useTls: false,
        allowInsecureAuth: true,
      });
      expect(parsed.allowInsecureAuth).toBe(true);
    });
  });

  describe('buildImapOptions', () => {
    it('builds the default secure path unchanged', () => {
      const opts = buildImapOptions(tlsAccount, {
        user: 'me@example.com',
        secret: SECRET,
        kind: 'password',
      });
      expect(opts.secure).toBe(true);
      expect(opts.doSTARTTLS).toBeUndefined();
    });

    it('refuses cleartext password auth without the opt-in', () => {
      let message = '';
      try {
        buildImapOptions(plainAccount, {
          user: 'me@example.com',
          secret: SECRET,
          kind: 'password',
        });
      } catch (error) {
        expect(error).toBeInstanceOf(AuthenticationError);
        message = (error as Error).message;
      }
      expect(message.length).toBeGreaterThan(0);
      expect(message).toContain(plainAccount.id);
      expect(message).not.toContain(SECRET);
    });

    it('refuses cleartext OAuth token auth without the opt-in', () => {
      expect(() =>
        buildImapOptions(
          { ...plainAccount, authType: 'oauth2' },
          { user: 'me@example.com', secret: TOKEN, kind: 'oauth2' }
        )
      ).toThrow(AuthenticationError);
    });

    it('permits the explicit opt-in without disabling STARTTLS', () => {
      const opts = buildImapOptions(
        { ...plainAccount, allowInsecureAuth: true },
        { user: 'me@example.com', secret: SECRET, kind: 'password' }
      );
      expect(opts.secure).toBe(false);
      // Opportunistic STARTTLS must stay intact: never force-disable it.
      expect(opts.doSTARTTLS).toBeUndefined();
    });
  });

  describe('ImapService.connect()', () => {
    let fake: FakeImapFlow;
    let factory: ReturnType<typeof makeFactory>;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fake = makeFake();
      factory = makeFactory(fake);
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('refuses useTls:false without the opt-in before opening any connection', async () => {
      const service = new ImapService(plainAccount, {
        factory,
        env: { TERMAIL_WORK_PASSWORD: SECRET },
      });
      await expect(service.connect()).rejects.toBeInstanceOf(AuthenticationError);
      expect(factory.create).not.toHaveBeenCalled();
      expect(fake.connect).not.toHaveBeenCalled();
      expect(service.isConnected()).toBe(false);
    });

    it('connects with the explicit opt-in and warns without secrets', async () => {
      const service = new ImapService(
        { ...plainAccount, allowInsecureAuth: true },
        { factory, env: { TERMAIL_WORK_PASSWORD: SECRET } }
      );
      await service.connect();
      expect(factory.create).toHaveBeenCalledTimes(1);
      expect(service.isConnected()).toBe(true);

      const logged = warnSpy.mock.calls.map((args: Array<unknown>) => args.join(' ')).join('\n');
      expect(warnSpy).toHaveBeenCalled();
      expect(logged).toContain(plainAccount.id);
      expect(logged).not.toContain(SECRET);
      await service.disconnect();
    });

    it('does not warn on the default secure path', async () => {
      const service = new ImapService(tlsAccount, {
        factory,
        env: { TERMAIL_WORK_PASSWORD: SECRET },
      });
      await service.connect();
      expect(service.isConnected()).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();
      await service.disconnect();
    });
  });
});
