/**
 * Tests for `ImapService`.
 *
 * Strategy: stand up a fake `ImapFlow`-shaped object whose methods are
 * spies, then inject it through the `factory` constructor option. This
 * keeps the tests fast, hermetic, and free of network code paths.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImapFlow } from 'imapflow';
import type { AccountConfig } from '../../src/core/types/config.js';
import { AuthenticationError, NetworkError } from '../../src/core/utils/errors.js';
import {
  ImapService,
  buildImapOptions,
} from '../../src/core/imap/ImapService.js';
import type { ImapFlowFactory } from '../../src/core/imap/types.js';

interface FakeImapFlow {
  options: unknown;
  connect: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  noop: ReturnType<typeof vi.fn>;
}

function makeFake(): FakeImapFlow {
  return {
    options: undefined,
    connect: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    noop: vi.fn().mockResolvedValue(undefined),
  };
}

function makeFactory(fake: FakeImapFlow): ImapFlowFactory & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    create: vi.fn((options) => {
      calls.push(options);
      fake.options = options;
      return fake as unknown as ImapFlow;
    }),
  };
}

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

const envWithPassword = { TERMAIL_WORK_PASSWORD: 'super-secret' };

describe('ImapService', () => {
  let fake: FakeImapFlow;
  let factory: ReturnType<typeof makeFactory>;
  let service: ImapService;

  beforeEach(() => {
    fake = makeFake();
    factory = makeFactory(fake);
    service = new ImapService(baseAccount, {
      factory,
      env: envWithPassword,
    });
  });

  describe('connect()', () => {
    it('builds ImapFlow with the expected options', async () => {
      await service.connect();

      expect(factory.create).toHaveBeenCalledTimes(1);
      const opts = factory.calls[0] as Record<string, unknown>;
      expect(opts['host']).toBe('imap.example.com');
      expect(opts['port']).toBe(993);
      expect(opts['secure']).toBe(true);
      const auth = opts['auth'] as { user: string; pass: string; accessToken?: string };
      expect(auth.user).toBe('me@example.com');
      expect(auth.pass).toBe('super-secret');
      expect(auth.accessToken).toBeUndefined();
      // logger: false so imapflow's built-in logger never prints secrets.
      expect(opts['logger']).toBe(false);
      // TLS hardening stays on by default.
      expect((opts['tls'] as { rejectUnauthorized: boolean }).rejectUnauthorized).toBe(true);
    });

    it('marks the service as connected after a successful connect', async () => {
      expect(service.isConnected()).toBe(false);
      await service.connect();
      expect(service.isConnected()).toBe(true);
    });

    it('throws NetworkError if already connected', async () => {
      await service.connect();
      await expect(service.connect()).rejects.toBeInstanceOf(NetworkError);
    });

    it('maps connection errors to NetworkError and closes the client', async () => {
      fake.connect.mockRejectedValueOnce(new Error('ECONNREFUSED 1.2.3.4:993'));
      await expect(service.connect()).rejects.toBeInstanceOf(NetworkError);
      expect(fake.close).toHaveBeenCalled();
      expect(service.isConnected()).toBe(false);
    });

    it('maps authentication failures to AuthenticationError', async () => {
      fake.connect.mockRejectedValueOnce(
        Object.assign(new Error('Authentication failed'), { authenticationFailed: true })
      );
      await expect(service.connect()).rejects.toBeInstanceOf(AuthenticationError);
      expect(service.isConnected()).toBe(false);
    });

    it('redacts the resolved secret in any thrown error message', async () => {
      fake.connect.mockRejectedValueOnce(new Error('auth failed: super-secret is wrong'));
      const caught: Error = await service
        .connect()
        .then(
          () => new Error('expected connect to reject'),
          (e: unknown) => e as Error
        );
      expect(caught).toBeInstanceOf(Error);
      expect(caught.message).toMatch(/auth failed: \*\*\* is wrong/);
      expect(caught.message).not.toContain('super-secret');
    });


    it('throws AuthenticationError when the env var is missing', async () => {
      const noEnvService = new ImapService(baseAccount, { factory, env: {} });
      await expect(noEnvService.connect()).rejects.toBeInstanceOf(AuthenticationError);
    });
  });

  describe('disconnect()', () => {
    it('sends LOGOUT and clears the connection', async () => {
      await service.connect();
      await service.disconnect();
      expect(fake.logout).toHaveBeenCalledTimes(1);
      expect(service.isConnected()).toBe(false);
    });

    it('is a no-op when not connected', async () => {
      await service.disconnect();
      expect(fake.logout).not.toHaveBeenCalled();
    });

    it('closes the socket if LOGOUT throws', async () => {
      await service.connect();
      fake.logout.mockRejectedValueOnce(new Error('server hung up'));
      await service.disconnect();
      expect(fake.close).toHaveBeenCalled();
    });
  });

  describe('listMailboxes()', () => {
    it('auto-connects and returns normalized folder info', async () => {
      const flags = new Set<string>(['\\Inbox', '\\HasChildren']);
      fake.list.mockResolvedValueOnce([
        { path: 'INBOX', delimiter: '/', flags, specialUse: '\\Inbox' },
        { path: 'Sent', delimiter: '/', flags: new Set(['\\Sent']), specialUse: '\\Sent' },
        { path: 'Archive/2024', delimiter: '/', flags: new Set<string>() },
      ]);
      const folders = await service.listMailboxes();
      expect(folders).toEqual([
        { path: 'INBOX', name: 'INBOX', delimiter: '/', flags: ['\\Inbox', '\\HasChildren'], specialUse: 'inbox' },
        { path: 'Sent', name: 'Sent', delimiter: '/', flags: ['\\Sent'], specialUse: 'sent' },
        { path: 'Archive/2024', name: '2024', delimiter: '/', flags: [], specialUse: '' },
      ]);
      // Connect was called automatically.
      expect(service.isConnected()).toBe(true);
    });

    it('maps list errors to the right error type', async () => {
      await service.connect();
      fake.list.mockRejectedValueOnce(
        Object.assign(new Error('NO SELECT'), { authenticationFailed: true })
      );
      await expect(service.listMailboxes()).rejects.toBeInstanceOf(AuthenticationError);
    });
  });

  describe('oauth2', () => {
    it('passes the resolved token as accessToken', async () => {
      const oauthAccount: AccountConfig = { ...baseAccount, authType: 'oauth2' };
      const oauthService = new ImapService(oauthAccount, {
        factory,
        env: { TERMAIL_WORK_OAUTH_TOKEN: 'tok-123' },
      });
      await oauthService.connect();
      const opts = factory.calls[0] as Record<string, unknown>;
      const auth = opts['auth'] as { accessToken?: string; pass?: string };
      expect(auth.accessToken).toBe('tok-123');
      expect(auth.pass).toBeUndefined();
    });
  });
});

describe('buildImapOptions', () => {
  it('throws NetworkError when host is missing', () => {
    expect(() =>
      buildImapOptions(
        { ...baseAccount, host: undefined },
        { user: 'u', secret: 's', kind: 'password' }
      )
    ).toThrow(NetworkError);
  });
});
