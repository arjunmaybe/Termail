/**
 * Phase 4 — Minimal SMTP transport over `node:net` / `node:tls`.
 *
 * Explicit `smtpMode` only; no inference from IMAP `useTls`, no plaintext
 * fallback, no OAuth2, password only.
 *
 * - implicit-tls: TLS immediately, then greeting/EHLO/AUTH/MAIL/RCPT/DATA/QUIT.
 * - starttls: plain TCP for greeting + EHLO + STARTTLS only, then mandatory
 *   upgrade (rejectUnauthorized:true, servername=smtpHost), discard pre-TLS
 *   buffer, re-EHLO, then AUTH/MAIL/RCPT/DATA/QUIT.
 *
 * AUTH/MAIL/RCPT/DATA are NEVER sent before TLS is established. If STARTTLS
 * is required but not advertised, the connection is closed with NetworkError.
 */

import net from 'node:net';
import tls from 'node:tls';
import type { SmtpMode } from '../types/config.js';
import { AuthenticationError, NetworkError, getErrorMessage } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { buildEnvelopePayload } from './message.js';
import type { SmtpEnvelope, SmtpTimeouts } from './types.js';
import { DEFAULT_SMTP_TIMEOUTS } from './types.js';

/** Minimal socket surface used by the protocol driver (real or fake). */
export interface LineSocket {
  write(data: string): unknown;
  end(data?: string): unknown;
  destroy(...args: any[]): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}

export interface SmtpTransportHooks {
  connectTcp(host: string, port: number, timeoutMs: number): Promise<LineSocket>;
  connectTls(host: string, port: number, timeoutMs: number): Promise<LineSocket>;
  upgradeTls(socket: LineSocket, host: string, port: number, timeoutMs: number): Promise<LineSocket>;
}

export interface NodeSmtpTransportOptions {
  host: string;
  port: number;
  mode: SmtpMode;
  user: string;
  secret: string;
  timeouts?: Partial<SmtpTimeouts>;
  hooks?: Partial<SmtpTransportHooks>;
}

export interface SmtpReply {
  code: number;
  lines: string[];
  text: string;
}

const AUTH_FAILURE_HINTS = [
  'authenticationfailed',
  'authentication failed',
  'invalid credentials',
  'login failed',
  'bad username',
  'bad password',
];

/**
 * TLS options for implicit-TLS connects. Exported so tests can assert
 * `rejectUnauthorized: true` and `servername === host` without opening a
 * real socket. The default hooks always build options through here.
 */
export function buildImplicitTlsOptions(host: string, port: number): tls.ConnectionOptions {
  return { host, port, servername: host, rejectUnauthorized: true };
}

/** TLS options for the STARTTLS upgrade (same hardening as implicit TLS). */
export function buildStarttlsUpgradeOptions(
  socket: net.Socket,
  host: string,
  port: number
): tls.ConnectionOptions {
  return { socket, host, port, servername: host, rejectUnauthorized: true };
}

function defaultConnectTcp(host: string, port: number, timeoutMs: number): Promise<LineSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy(new Error(`SMTP connection timed out after ${timeoutMs}ms`));
      } catch {
        /* ignore */
      }
      reject(new NetworkError(`SMTP connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket as unknown as LineSocket);
    });
    socket.once('error', (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new NetworkError(`SMTP connection error: ${getErrorMessage(err)}`));
    });
  });
}

function defaultConnectTls(host: string, port: number, timeoutMs: number): Promise<LineSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = tls.connect(buildImplicitTlsOptions(host, port));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy(new Error(`SMTP TLS connection timed out after ${timeoutMs}ms`));
      } catch {
        /* ignore */
      }
      reject(new NetworkError(`SMTP TLS connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once('secureConnect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket as unknown as LineSocket);
    });
    socket.once('error', (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new NetworkError(`SMTP TLS connection error: ${getErrorMessage(err)}`));
    });
  });
}

function defaultUpgradeTls(
  socket: LineSocket,
  host: string,
  port: number,
  timeoutMs: number
): Promise<LineSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const plain = socket as unknown as net.Socket;
    const upgraded = tls.connect(buildStarttlsUpgradeOptions(plain, host, port));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        upgraded.destroy(new Error(`SMTP STARTTLS upgrade timed out after ${timeoutMs}ms`));
      } catch {
        /* ignore */
      }
      reject(new NetworkError(`SMTP STARTTLS upgrade timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    upgraded.once('secureConnect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(upgraded as unknown as LineSocket);
    });
    upgraded.once('error', (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new NetworkError(`SMTP STARTTLS upgrade failed: ${getErrorMessage(err)}`));
    });
  });
}

const defaultHooks: SmtpTransportHooks = {
  connectTcp: defaultConnectTcp,
  connectTls: defaultConnectTls,
  upgradeTls: defaultUpgradeTls,
};

/** Parse complete replies out of a CRLF buffer. Returns reply + remaining. */
export function parseSmtpBuffer(buffer: string): { reply: SmtpReply | null; rest: string } {
  const lines: string[] = [];
  let rest = buffer;
  let cursor = 0;
  for (;;) {
    const idx = rest.indexOf('\r\n', cursor);
    if (idx === -1) return { reply: null, rest: buffer };
    const line = rest.slice(cursor, idx);
    if (!/^\d{3}[ -]/.test(line)) {
      // Protocol violation: skip bare lines but keep scanning.
      cursor = idx + 2;
      // If we consumed garbage before any reply line, drop it from rest.
      continue;
    }
    lines.push(line);
    if (/^\d{3} /.test(line)) {
      const code = Number.parseInt(line.slice(0, 3), 10);
      return { reply: { code, lines: [...lines], text: lines.join('\n') }, rest: rest.slice(idx + 2) };
    }
    cursor = idx + 2;
  }
}

export function parseCapabilities(reply: SmtpReply): { starttls: boolean; auth: string[] } {
  const upper = reply.lines.map((l) => l.slice(4).toUpperCase());
  const starttls = upper.some((l) => l === 'STARTTLS' || l.startsWith('STARTTLS '));
  const auth: string[] = [];
  for (const line of upper) {
    const m = /^AUTH\s+(.+)$/.exec(line.trim());
    if (m?.[1]) {
      for (const mech of m[1].split(/\s+/)) {
        if (mech) auth.push(mech);
      }
    }
  }
  return { starttls, auth };
}

export function buildAuthPlainPayload(user: string, secret: string): string {
  return Buffer.from(`\0${user}\0${secret}`, 'utf8').toString('base64');
}

function redactSecret(message: string, secret: string): string {
  if (!secret) return message;
  return message.split(secret).join('***');
}

function mapSmtpError(code: number | null, context: string, secret: string): Error {
  const safe = redactSecret(context, secret);
  const lower = safe.toLowerCase();
  if (code === 535 || code === 534 || code === 530) {
    return new AuthenticationError(`SMTP authentication failed: ${safe}`);
  }
  for (const hint of AUTH_FAILURE_HINTS) {
    if (lower.includes(hint)) {
      return new AuthenticationError(`SMTP authentication failed: ${safe}`);
    }
  }
  return new NetworkError(`SMTP error: ${safe}`);
}

interface Session {
  socket: LineSocket;
  buffer: string;
  closed: boolean;
  secret: string;
}

function destroySession(session: Session): void {
  session.closed = true;
  try {
    session.socket.destroy();
  } catch {
    /* ignore */
  }
}

function readReply(session: Session, timeoutMs: number): Promise<SmtpReply> {
  const parsed = parseSmtpBuffer(session.buffer);
  if (parsed.reply) {
    session.buffer = parsed.rest;
    return Promise.resolve(parsed.reply);
  }
  return new Promise((resolve, reject) => {
    if (session.closed) {
      reject(new NetworkError('SMTP connection closed'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      destroySession(session);
      reject(new NetworkError(`SMTP response timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onData = (chunk: unknown): void => {
      session.buffer += chunk instanceof Buffer ? chunk.toString('utf8') : String(chunk);
      const next = parseSmtpBuffer(session.buffer);
      if (next.reply) {
        cleanup();
        session.buffer = next.rest;
        resolve(next.reply);
      }
    };
    const onError = (err: unknown): void => {
      cleanup();
      reject(new NetworkError(`SMTP connection error: ${redactSecret(getErrorMessage(err), session.secret)}`));
    };
    const onClose = (): void => {
      cleanup();
      reject(new NetworkError('SMTP connection closed by server'));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      try {
        session.socket.removeListener('data', onData);
        session.socket.removeListener('error', onError);
        session.socket.removeListener('close', onClose);
      } catch {
        /* ignore */
      }
    };
    session.socket.on('data', onData);
    session.socket.once('error', onError);
    session.socket.once('close', onClose);
  });
}

async function sendCommand(
  session: Session,
  command: string,
  timeoutMs: number
): Promise<SmtpReply> {
  if (session.closed) throw new NetworkError('SMTP connection is closed');
  try {
    session.socket.write(`${command}\r\n`);
  } catch (error) {
    throw new NetworkError(
      `SMTP send failed: ${redactSecret(getErrorMessage(error), session.secret)}`
    );
  }
  return readReply(session, timeoutMs);
}

function expectCode(reply: SmtpReply, expected: number[], what: string, secret: string): void {
  if (!expected.includes(reply.code)) {
    throw mapSmtpError(reply.code, `${what} failed with code ${reply.code}`, secret);
  }
}

/**
 * Minimal injectable SMTP transport. Owns all socket I/O; callers provide a
 * validated envelope. Credentials never leave this module except inside the
 * TLS-protected AUTH exchange, and are redacted from every thrown error.
 */
export class NodeSmtpTransport {
  private readonly host: string;
  private readonly port: number;
  private readonly mode: SmtpMode;
  private readonly user: string;
  private readonly secret: string;
  private readonly timeouts: SmtpTimeouts;
  private readonly hooks: SmtpTransportHooks;

  constructor(options: NodeSmtpTransportOptions) {
    this.host = options.host;
    this.port = options.port;
    this.mode = options.mode;
    this.user = options.user;
    this.secret = options.secret;
    this.timeouts = { ...DEFAULT_SMTP_TIMEOUTS, ...options.timeouts };
    this.hooks = { ...defaultHooks, ...options.hooks };
  }

  getTarget(): { host: string; port: number; mode: SmtpMode } {
    return { host: this.host, port: this.port, mode: this.mode };
  }

  async send(envelope: SmtpEnvelope): Promise<void> {
    const built = buildEnvelopePayload({
      from: envelope.from,
      to: envelope.to,
      cc: envelope.cc,
      bcc: envelope.bcc,
      subject: envelope.subject,
      body: envelope.body,
    });
    const recipients = [...envelope.to, ...envelope.cc, ...envelope.bcc];

    let session: Session | null = null;
    try {
      if (this.mode === 'implicit-tls') {
        const socket = await this.hooks.connectTls(
          this.host,
          this.port,
          this.timeouts.connectionTimeoutMs
        );
        session = { socket, buffer: '', closed: false, secret: this.secret };
        await this.runTlsSession(session, built.raw, envelope.from, recipients);
      } else {
        const plain = await this.hooks.connectTcp(
          this.host,
          this.port,
          this.timeouts.connectionTimeoutMs
        );
        const plainSession: Session = { socket: plain, buffer: '', closed: false, secret: this.secret };
        try {
          await this.runStarttlsHandshake(plainSession);
        } catch (error) {
          destroySession(plainSession);
          throw error;
        }
        // Upgrade: discard pre-TLS buffer, continue on the TLS socket.
        // If the upgrade itself fails, the plain socket must be destroyed
        // here: `session` still refers to no TLS session at this point, so
        // the outer catch cannot clean it up.
        let upgraded: LineSocket;
        try {
          upgraded = await this.hooks.upgradeTls(
            plainSession.socket,
            this.host,
            this.port,
            this.timeouts.connectionTimeoutMs
          );
        } catch (error) {
          destroySession(plainSession);
          throw error;
        }
        session = { socket: upgraded, buffer: '', closed: false, secret: this.secret };
        await this.runTlsSession(session, built.raw, envelope.from, recipients);
      }
      logger.info('SMTP message sent', {
        host: this.host,
        port: this.port,
        mode: this.mode,
        recipients: recipients.length,
      });
    } catch (error) {
      if (session) destroySession(session);
      if (error instanceof AuthenticationError || error instanceof NetworkError) throw error;
      throw new NetworkError(
        `SMTP send failed: ${redactSecret(getErrorMessage(error), this.secret)}`
      );
    }
  }

  /** Plain-TCP preamble for starttls: greeting + EHLO + STARTTLS only. */
  private async runStarttlsHandshake(session: Session): Promise<void> {
    const greeting = await readReply(session, this.timeouts.greetingTimeoutMs);
    if (greeting.code !== 220) {
      throw mapSmtpError(greeting.code, `SMTP greeting failed with code ${greeting.code}`, this.secret);
    }
    const ehlo = await sendCommand(session, 'EHLO termail', this.timeouts.commandTimeoutMs);
    expectCode(ehlo, [250], 'SMTP EHLO', this.secret);
    const caps = parseCapabilities(ehlo);
    if (!caps.starttls) {
      throw new NetworkError('SMTP server does not advertise STARTTLS; refusing to send without TLS');
    }
    const tlsReply = await sendCommand(session, 'STARTTLS', this.timeouts.commandTimeoutMs);
    expectCode(tlsReply, [220], 'SMTP STARTTLS', this.secret);
    logger.info('SMTP STARTTLS negotiated', { host: this.host, port: this.port });
  }

  /** TLS-established session: (re-)EHLO, AUTH, MAIL/RCPT/DATA, QUIT. */
  private async runTlsSession(
    session: Session,
    raw: string,
    from: string,
    recipients: string[]
  ): Promise<void> {
    try {
      // For implicit-tls the greeting arrives here; for starttls the greeting
      // was already consumed pre-upgrade, so this read only applies to the
      // implicit path. Detect by peeking: implicit sessions have an empty
      // buffer and no prior EHLO. We disambiguate via mode.
      if (this.mode === 'implicit-tls') {
        const greeting = await readReply(session, this.timeouts.greetingTimeoutMs);
        if (greeting.code !== 220) {
          throw mapSmtpError(
            greeting.code,
            `SMTP greeting failed with code ${greeting.code}`,
            this.secret
          );
        }
      }
      const ehlo = await sendCommand(session, 'EHLO termail', this.timeouts.commandTimeoutMs);
      expectCode(ehlo, [250], 'SMTP EHLO', this.secret);
      const caps = parseCapabilities(ehlo);

      await this.authenticate(session, caps.auth);

      const mail = await sendCommand(
        session,
        `MAIL FROM:<${from}>`,
        this.timeouts.commandTimeoutMs
      );
      expectCode(mail, [250], 'SMTP MAIL FROM', this.secret);

      for (const rcpt of recipients) {
        const rcptReply = await sendCommand(
          session,
          `RCPT TO:<${rcpt}>`,
          this.timeouts.commandTimeoutMs
        );
        expectCode(rcptReply, [250, 251], 'SMTP RCPT TO', this.secret);
      }

      const data = await sendCommand(session, 'DATA', this.timeouts.commandTimeoutMs);
      expectCode(data, [354], 'SMTP DATA', this.secret);

      try {
        session.socket.write(`${raw}\r\n.\r\n`);
      } catch (error) {
        throw new NetworkError(
          `SMTP send failed: ${redactSecret(getErrorMessage(error), this.secret)}`
        );
      }
      const queued = await readReply(session, this.timeouts.commandTimeoutMs);
      expectCode(queued, [250], 'SMTP message submission', this.secret);

      try {
        const quit = await sendCommand(session, 'QUIT', this.timeouts.commandTimeoutMs);
        if (quit.code !== 221) {
          logger.warn('SMTP QUIT returned unexpected code', { code: quit.code });
        }
      } catch (error) {
        logger.warn('SMTP QUIT failed; closing anyway', {
          error: redactSecret(getErrorMessage(error), this.secret),
        });
      }
    } finally {
      destroySession(session);
    }
  }

  private async authenticate(session: Session, advertised: string[]): Promise<void> {
    const upper = new Set(advertised.map((a) => a.toUpperCase()));
    if (upper.has('PLAIN')) {
      const payload = buildAuthPlainPayload(this.user, this.secret);
      const reply = await sendCommand(
        session,
        `AUTH PLAIN ${payload}`,
        this.timeouts.commandTimeoutMs
      );
      if (reply.code !== 235) {
        throw mapSmtpError(reply.code, `SMTP AUTH PLAIN failed with code ${reply.code}`, this.secret);
      }
      return;
    }
    if (upper.has('LOGIN')) {
      const step1 = await sendCommand(session, 'AUTH LOGIN', this.timeouts.commandTimeoutMs);
      if (step1.code !== 334) {
        throw mapSmtpError(step1.code, `SMTP AUTH LOGIN failed with code ${step1.code}`, this.secret);
      }
      const userB64 = Buffer.from(this.user, 'utf8').toString('base64');
      const step2 = await sendCommand(session, userB64, this.timeouts.commandTimeoutMs);
      if (step2.code !== 334) {
        throw mapSmtpError(step2.code, `SMTP AUTH LOGIN failed with code ${step2.code}`, this.secret);
      }
      const passB64 = Buffer.from(this.secret, 'utf8').toString('base64');
      const step3 = await sendCommand(session, passB64, this.timeouts.commandTimeoutMs);
      if (step3.code !== 235) {
        throw mapSmtpError(step3.code, `SMTP AUTH LOGIN failed with code ${step3.code}`, this.secret);
      }
      return;
    }
    throw new NetworkError('SMTP server does not advertise AUTH PLAIN or AUTH LOGIN');
  }
}

export const __testing = {
  parseSmtpBuffer,
  parseCapabilities,
  buildAuthPlainPayload,
  defaultHooks,
};
