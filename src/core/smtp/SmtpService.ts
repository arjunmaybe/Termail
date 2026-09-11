/**
 * Phase 4 — `SmtpService`.
 *
 * Thin orchestrator between credentials/config and the injectable SMTP
 * transport. Mirrors the `SyncService` outcome pattern:
 *
 * - Never sees a password except via `resolveCredentials` at send time.
 * - Rejects `oauth2` accounts before any socket is opened.
 * - Validates the envelope (via the message builder) before connecting.
 * - Maps transport errors to a typed `SendOutcome` with redacted messages.
 * - No database, no drafts, no queueing, no background sending.
 */

import { resolveCredentials } from '../imap/credentials.js';
import type { AccountConfig } from '../types/config.js';
import {
  AuthenticationError,
  NetworkError,
  ValidationError,
  getErrorMessage,
} from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { resolveSmtpConfig } from './config.js';
import { NodeSmtpTransport } from './transport.js';
import type { SmtpEnvelope, SmtpTimeouts, SmtpTransportFactory } from './types.js';

export type SendOutcome =
  | { kind: 'ok' }
  | { kind: 'validation'; message: string }
  | { kind: 'auth'; message: string }
  | { kind: 'network'; message: string };

const defaultFactory: SmtpTransportFactory = (args) =>
  new NodeSmtpTransport({
    host: args.host,
    port: args.port,
    mode: args.mode,
    user: args.user,
    secret: args.secret,
    timeouts: args.timeouts,
  });

export interface SmtpServiceOptions {
  factory?: SmtpTransportFactory;
  env?: NodeJS.ProcessEnv;
  timeouts?: Partial<SmtpTimeouts>;
}

export class SmtpService {
  private readonly factory: SmtpTransportFactory;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeouts?: Partial<SmtpTimeouts>;

  constructor(options: SmtpServiceOptions = {}) {
    this.factory = options.factory ?? defaultFactory;
    this.env = options.env ?? process.env;
    this.timeouts = options.timeouts;
  }

  async sendMail(account: AccountConfig, envelope: SmtpEnvelope): Promise<SendOutcome> {
    if (!account || !account.id) {
      return { kind: 'validation', message: 'No account configured' };
    }
    if (account.authType !== 'password') {
      return {
        kind: 'auth',
        message: `Account "${account.id}" uses OAuth2, which is not supported for SMTP in Phase 4.`,
      };
    }

    let target: { host: string; port: number; mode: 'implicit-tls' | 'starttls' };
    try {
      target = resolveSmtpConfig(account);
    } catch (error) {
      return { kind: 'network', message: getErrorMessage(error) };
    }

    let user: string;
    let secret: string;
    try {
      const creds = resolveCredentials(account, this.env);
      user = creds.user;
      secret = creds.secret;
    } catch (error) {
      const message = getErrorMessage(error);
      return {
        kind: 'auth',
        message,
      };
    }

    const recipientCount = envelope.to.length + envelope.cc.length + envelope.bcc.length;
    if (recipientCount === 0) {
      return { kind: 'validation', message: 'At least one recipient (To, Cc, or Bcc) is required' };
    }

    const transport = this.factory({
      host: target.host,
      port: target.port,
      mode: target.mode,
      user,
      secret,
      timeouts: { ...(this.timeouts ?? {}) } as SmtpTimeouts,
    });

    try {
      await transport.send(envelope);
    } catch (error) {
      return mapSendError(error, secret);
    }

    // Never log addresses/subject/body — counts only.
    logger.info('SMTP send completed', {
      accountId: account.id,
      host: target.host,
      port: target.port,
      mode: target.mode,
      recipients: recipientCount,
    });
    return { kind: 'ok' };
  }
}

function redactSecret(message: string, secret: string): string {
  if (!secret) return message;
  return message.split(secret).join('***');
}

function mapSendError(error: unknown, secret: string): SendOutcome {
  if (error instanceof ValidationError) {
    return { kind: 'validation', message: redactSecret(error.message, secret) };
  }
  if (error instanceof AuthenticationError) {
    return { kind: 'auth', message: redactSecret(error.message, secret) };
  }
  if (error instanceof NetworkError) {
    return { kind: 'network', message: redactSecret(error.message, secret) };
  }
  return { kind: 'network', message: redactSecret(getErrorMessage(error), secret) };
}
