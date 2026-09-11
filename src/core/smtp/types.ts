/**
 * Phase 4 — SMTP types.
 *
 * Minimal shapes for password-only SMTP sending. No OAuth2, no attachments,
 * no HTML, no drafts, no queueing. The transport owns all socket I/O; the
 * service owns validation/orchestration; the controller owns TUI state.
 */

import type { SmtpMode } from '../types/config.js';

/** Fully resolved SMTP connection target. Host is required to connect. */
export interface ResolvedSmtpConfig {
  host: string;
  port: number;
  mode: SmtpMode;
}

/** User-composed message. BCC is envelope-only (never rendered to headers). */
export interface SmtpEnvelope {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

/** Per-operation timeouts (ms). All required after defaults are applied. */
export interface SmtpTimeouts {
  connectionTimeoutMs: number;
  greetingTimeoutMs: number;
  commandTimeoutMs: number;
}

export const DEFAULT_SMTP_TIMEOUTS: SmtpTimeouts = {
  connectionTimeoutMs: 10_000,
  greetingTimeoutMs: 10_000,
  commandTimeoutMs: 10_000,
};

/** Injectable transport surface. Tests substitute a fake. */
export interface SmtpTransport {
  send(envelope: SmtpEnvelope): Promise<void>;
}

/** Factory producing a transport bound to one account's credentials. */
export type SmtpTransportFactory = (args: {
  host: string;
  port: number;
  mode: SmtpMode;
  user: string;
  secret: string;
  timeouts: SmtpTimeouts;
}) => SmtpTransport;
