/**
 * Phase 4 — SMTP message builder (pure, no I/O).
 *
 * - Plain-text only, UTF-8, CRLF framing.
 * - Rejects CR/LF injection in every user-controlled header/address field.
 * - Validates addresses minimally (single `@`, no whitespace, no CRLF).
 * - BCC is NEVER rendered into headers; callers pass it only as envelope
 *   recipients to the transport (`RCPT TO`).
 * - Applies DATA dot-stuffing to the body.
 */

import { ValidationError } from '../utils/errors.js';

export interface BuiltMessage {
  /** Full RFC 5322 payload ready for DATA (headers + blank line + body). Headers exclude BCC. */
  raw: string;
  /** Envelope recipients: to + cc + bcc (for RCPT TO). */
  envelopeRecipients: string[];
}

const CRLF_RE = /[\r\n]/;
const ADDRESS_RE = /^[^\s@]+@[^\s@]+$/;

function assertNoCrlf(value: string, field: string): void {
  if (CRLF_RE.test(value)) {
    throw new ValidationError(`${field} must not contain CR or LF characters`);
  }
}

export function validateAddress(address: string, field: string): string {
  const trimmed = address.trim();
  if (trimmed.length === 0) {
    throw new ValidationError(`${field} must not be empty`);
  }
  assertNoCrlf(trimmed, field);
  if (!ADDRESS_RE.test(trimmed)) {
    throw new ValidationError(`${field} is not a valid email address: "${trimmed}"`);
  }
  return trimmed;
}

export function validateSubject(subject: string): string {
  assertNoCrlf(subject, 'Subject');
  return subject;
}

/** Split on any newline style and rejoin with CRLF. Preserves Unicode as-is. */
export function normalizeBodyLines(body: string): string {
  return body.split(/\r\n|\n|\r/).join('\r\n');
}

/** DATA dot-stuffing: lines starting with `.` gain an extra leading `.`. */
export function dotStuffBody(body: string): string {
  const normalized = normalizeBodyLines(body);
  if (normalized.length === 0) return '';
  return normalized
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}

function generateMessageId(from: string): string {
  const domain = from.includes('@') ? (from.split('@')[1] ?? 'termail.local') : 'termail.local';
  return `<${crypto.randomUUID()}@${domain}>`;
}

export interface BuildMessageInput {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  date?: Date;
  messageId?: string;
}

/**
 * Build headers + dot-stuffed body. Never accepts BCC — by construction BCC
 * cannot leak into headers. Throws `ValidationError` on injection/bad input.
 */
export function buildMessage(input: BuildMessageInput): BuiltMessage {
  const from = validateAddress(input.from, 'From');
  const to = input.to.map((a, i) => validateAddress(a, `To[${i}]`));
  const cc = (input.cc ?? []).map((a, i) => validateAddress(a, `Cc[${i}]`));
  const subject = validateSubject(input.subject);
  const date = input.date ?? new Date();
  const messageId = input.messageId ?? generateMessageId(from);
  assertNoCrlf(messageId, 'Message-ID');

  const headers: string[] = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    ...(cc.length > 0 ? [`Cc: ${cc.join(', ')}`] : []),
    `Subject: ${subject}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  const stuffed = dotStuffBody(input.body);
  const raw = `${headers.join('\r\n')}\r\n\r\n${stuffed}`;
  return { raw, envelopeRecipients: [...to, ...cc] };
}

/**
 * Build the full DATA payload for an envelope that includes BCC.
 * Headers exclude BCC; `envelopeRecipients` includes to + cc + bcc.
 */
export function buildEnvelopePayload(envelope: {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  date?: Date;
  messageId?: string;
}): BuiltMessage {
  const built = buildMessage({
    from: envelope.from,
    to: envelope.to,
    cc: envelope.cc,
    subject: envelope.subject,
    body: envelope.body,
    ...(envelope.date !== undefined ? { date: envelope.date } : {}),
    ...(envelope.messageId !== undefined ? { messageId: envelope.messageId } : {}),
  });
  const bcc = envelope.bcc.map((a, i) => validateAddress(a, `Bcc[${i}]`));
  return { raw: built.raw, envelopeRecipients: [...built.envelopeRecipients, ...bcc] };
}
