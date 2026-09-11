/**
 * Phase 4 — SmtpService tests with a fake transport (no sockets).
 */

import { describe, expect, it, vi } from 'vitest';
import type { AccountConfig } from '../../src/core/types/config.js';
import { AuthenticationError, NetworkError } from '../../src/core/utils/errors.js';
import { SmtpService } from '../../src/core/smtp/SmtpService.js';
import type { SmtpEnvelope, SmtpTransport } from '../../src/core/smtp/types.js';

const DUMMY_SECRET = 'dummy-password-123';

const baseAccount: AccountConfig = {
  id: 'work',
  name: 'Work',
  email: 'me@example.com',
  enabled: true,
  host: 'imap.example.com',
  port: 993,
  useTls: true,
  authType: 'password',
  smtpHost: 'smtp.example.com',
  smtpPort: 465,
  smtpMode: 'implicit-tls',
};

const envelope: SmtpEnvelope = {
  from: 'me@example.com',
  to: ['to@example.com'],
  cc: [],
  bcc: [],
  subject: 'hi',
  body: 'hello',
};

function makeService(fake: { send: ReturnType<typeof vi.fn> }, env: NodeJS.ProcessEnv = {}) {
  const factory = () => fake as unknown as SmtpTransport;
  return new SmtpService({ factory, env });
}

describe('SmtpService', () => {
  it('sends successfully and reuses TERMAIL_<ID>_PASSWORD', async () => {
    const fake = { send: vi.fn().mockResolvedValue(undefined) };
    let seenSecret = '';
    const factory = (args: any) => {
      seenSecret = args.secret;
      expect(args.host).toBe('smtp.example.com');
      expect(args.port).toBe(465);
      expect(args.mode).toBe('implicit-tls');
      expect(args.user).toBe('me@example.com');
      return fake as unknown as SmtpTransport;
    };
    const service = new SmtpService({
      factory,
      env: { TERMAIL_WORK_PASSWORD: DUMMY_SECRET },
    });
    const outcome = await service.sendMail(baseAccount, envelope);
    expect(outcome).toEqual({ kind: 'ok' });
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(seenSecret).toBe(DUMMY_SECRET);
    // Envelope passed through (BCC envelope-only is enforced by the builder).
    expect(fake.send).toHaveBeenCalledWith(envelope);
  });

  it('returns validation when no recipient is given (no transport call)', async () => {
    const fake = { send: vi.fn() };
    const service = makeService(fake, { TERMAIL_WORK_PASSWORD: DUMMY_SECRET });
    const outcome = await service.sendMail(baseAccount, { ...envelope, to: [] });
    expect(outcome.kind).toBe('validation');
    expect(fake.send).not.toHaveBeenCalled();
  });

  it('returns auth when the password env var is missing', async () => {
    const fake = { send: vi.fn() };
    const service = makeService(fake, {});
    const outcome = await service.sendMail(baseAccount, envelope);
    expect(outcome.kind).toBe('auth');
    expect(fake.send).not.toHaveBeenCalled();
    if (outcome.kind === 'auth') {
      expect(outcome.message).toContain('TERMAIL_WORK_PASSWORD');
      expect(outcome.message).not.toContain(DUMMY_SECRET);
    }
  });

  it('rejects OAuth2 accounts before connecting', async () => {
    const fake = { send: vi.fn() };
    const service = makeService(fake, { TERMAIL_WORK_OAUTH_TOKEN: 'tok' });
    const outcome = await service.sendMail({ ...baseAccount, authType: 'oauth2' }, envelope);
    expect(outcome.kind).toBe('auth');
    expect(fake.send).not.toHaveBeenCalled();
  });

  it('returns network when smtpHost is missing (fails before connect)', async () => {
    const fake = { send: vi.fn() };
    const service = makeService(fake, { TERMAIL_WORK_PASSWORD: DUMMY_SECRET });
    const { smtpHost: _h, ...rest } = baseAccount;
    void _h;
    const outcome = await service.sendMail(rest, envelope);
    expect(outcome.kind).toBe('network');
    expect(fake.send).not.toHaveBeenCalled();
  });

  it('maps AuthenticationError to auth without the secret', async () => {
    const fake = {
      send: vi.fn().mockRejectedValue(new AuthenticationError(`bad ${DUMMY_SECRET} creds`)),
    };
    const service = makeService(fake, { TERMAIL_WORK_PASSWORD: DUMMY_SECRET });
    const outcome = await service.sendMail(baseAccount, envelope);
    expect(outcome.kind).toBe('auth');
    if (outcome.kind === 'auth') {
      expect(outcome.message).not.toContain(DUMMY_SECRET);
      expect(outcome.message).toContain('***');
    }
  });

  it('maps NetworkError to network without the secret', async () => {
    const fake = {
      send: vi.fn().mockRejectedValue(new NetworkError(`down ${DUMMY_SECRET}`)),
    };
    const service = makeService(fake, { TERMAIL_WORK_PASSWORD: DUMMY_SECRET });
    const outcome = await service.sendMail(baseAccount, envelope);
    expect(outcome.kind).toBe('network');
    if (outcome.kind === 'network') {
      expect(outcome.message).not.toContain(DUMMY_SECRET);
    }
  });

  it('maps envelope validation errors without exposing addresses as secrets', async () => {
    const fake = { send: vi.fn().mockRejectedValue(new Error('boom')) };
    const service = makeService(fake, { TERMAIL_WORK_PASSWORD: DUMMY_SECRET });
    const bad: SmtpEnvelope = { ...envelope, to: ['bad\r\n@example.com'] };
    // Builder throws inside the fake transport here; emulate transport-level
    // validation by rejecting with a ValidationError-like shape.
    const { ValidationError } = await import('../../src/core/utils/errors.js');
    fake.send.mockRejectedValueOnce(new ValidationError('To[0] must not contain CR or LF characters'));
    const outcome = await service.sendMail(baseAccount, bad);
    expect(outcome.kind).toBe('validation');
  });
});
