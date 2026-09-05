/**
 * IMAP message synchronization.
 *
 * Phase 2.3: take the raw `FetchMessageObject`s from `imapflow` and
 * normalize them into a stable, application-level representation
 * (`SyncMessage`). Also build the FETCH query, slice the UID range into
 * batches, and dedupe the result.
 *
 * Functions in this module are pure: no I/O, no `ImapFlow` calls. The
 * `ImapService.syncMessages` method owns the actual `mailboxOpen` /
 * `fetchAll` / `mailboxClose` calls and threads the credentials in.
 *
 * Out of scope:
 *   - Attachment byte download.
 *   - HTML rendering.
 *   - Saving to the database.
 *   - IDLE / push notifications.
 *   - OAuth token refresh.
 */

import { simpleParser, type MailparserAttachment } from 'mailparser';
import type {
  FetchMessageObject,
  FetchQueryObject,
  MessageAddressObject,
  MessageEnvelopeObject,
} from 'imapflow';
import { logger } from '../utils/logger.js';
import type {
  EmailAddress,
  MessageSyncLimits,
  SyncAttachment,
  SyncMessage,
} from './types.js';

/** Default cap on messages returned per sync. */
export const DEFAULT_MAX_MESSAGES = 500;
/** Default IMAP FETCH batch size. */
export const DEFAULT_BATCH_SIZE = 100;
/** Default per-message raw-source cap (25 MiB). */
export const DEFAULT_MAX_SOURCE_BYTES = 25 * 1024 * 1024;

/** Build the FETCH query used to pull envelope + structure + raw bytes. */
export function buildFetchQuery(maxSourceBytes: number = DEFAULT_MAX_SOURCE_BYTES): FetchQueryObject {
  return {
    uid: true,
    flags: true,
    envelope: true,
    internalDate: true,
    size: true,
    bodyStructure: true,
    source: { maxLength: maxSourceBytes },
  };
}

/** Normalize the message-sync limits object, filling in defaults. */
export function resolveLimits(limits?: MessageSyncLimits): {
  maxMessages: number;
  batchSize: number;
  sinceUid?: number;
  maxSourceBytes: number;
} {
  return {
    maxMessages: limits?.maxMessages ?? DEFAULT_MAX_MESSAGES,
    batchSize: limits?.batchSize ?? DEFAULT_BATCH_SIZE,
    sinceUid: limits?.sinceUid,
    maxSourceBytes: limits?.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES,
  };
}

/**
 * Build a UID range string for IMAP FETCH. `sinceUid` is exclusive
 * (UIDs strictly greater are included). Returns `'1:*'` for a full sync.
 */
export function buildFetchRange(sinceUid?: number): string {
  if (sinceUid !== undefined && sinceUid >= 0) {
    return `${sinceUid + 1}:*`;
  }
  return '1:*';
}

/** Split a range string of the form `A:*` into UID batches of size N. */
export function planBatches(opts: {
  upperUid: number;
  sinceUid: number;
  batchSize: number;
  maxMessages: number;
}): Array<{ from: number; to: number }> {
  const start = Math.max(opts.sinceUid + 1, 1);
  const end = Math.max(opts.upperUid, start - 1);
  if (end < start) return [];
  const total = end - start + 1;
  const allowed = Math.min(total, opts.maxMessages);
  const batches: Array<{ from: number; to: number }> = [];
  let cursor = start;
  let remaining = allowed;
  while (remaining > 0) {
    const size = Math.min(opts.batchSize, remaining);
    const to = cursor + size - 1;
    batches.push({ from: cursor, to });
    cursor = to + 1;
    remaining -= size;
  }
  return batches;
}

/** Map imapflow's `MessageAddressObject` to our `EmailAddress[]`. */
export function parseEnvelopeAddresses(
  addrs: ReadonlyArray<MessageAddressObject> | undefined
): EmailAddress[] {
  if (!addrs || addrs.length === 0) return [];
  const out: EmailAddress[] = [];
  for (const a of addrs) {
    if (!a) continue;
    const address = (a.address ?? '').trim();
    const name = (a.name ?? '').trim();
    if (!address && !name) continue;
    out.push({ name, address });
  }
  return out;
}

/** Strip angle brackets from a Message-ID and return the empty string on falsy input. */
export function normalizeMessageId(value: string | undefined | null): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  let out = value;
  while (out.startsWith('<')) out = out.slice(1);
  while (out.endsWith('>')) out = out.slice(0, -1);
  return out;
}

/** Map a Set of IMAP flags to our boolean fields. */
export function flagsToBooleans(flags: Set<string> | undefined): {
  isRead: boolean;
  isFlagged: boolean;
  isAnswered: boolean;
  isDraft: boolean;
  raw: string[];
} {
  if (!flags) {
    return { isRead: false, isFlagged: false, isAnswered: false, isDraft: false, raw: [] };
  }
  const raw: string[] = [];
  const lower = new Set<string>();
  for (const f of flags) {
    raw.push(f);
    lower.add(f.toLowerCase());
  }
  return {
    isRead: lower.has('\\seen'),
    isFlagged: lower.has('\\flagged'),
    isAnswered: lower.has('\\answered'),
    isDraft: lower.has('\\draft'),
    raw,
  };
}

/** Convert a `Date | string | undefined` to a `Date` or `null`. */
export function normalizeDate(value: Date | string | number | undefined | null): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Map a `mailparser` attachment to our `SyncAttachment` shape. */
export function mapAttachment(att: MailparserAttachment): SyncAttachment {
  let disposition: SyncAttachment['disposition'] = 'unknown';
  if (typeof att.contentDisposition === 'string') {
    const d = att.contentDisposition.toLowerCase();
    if (d === 'attachment') disposition = 'attachment';
    else if (d === 'inline') disposition = 'inline';
  }
  return {
    filename: att.filename ?? '',
    contentType: att.contentType || 'application/octet-stream',
    size: typeof att.size === 'number' ? att.size : 0,
    disposition,
    contentId: att.contentId ? normalizeMessageId(att.contentId) : undefined,
  };
}

/**
 * Strip HTML tags and decode a few common entities to produce a safe
 * plain-text fallback for HTML-only messages. This is intentionally
 * crude; a real renderer will be added in a later milestone.
 */
export function htmlToPlainText(html: string): string {
  if (!html) return '';
  let out = html;
  // Remove script/style blocks.
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  // Replace <br> and block closers with newlines.
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n');
  // Strip all remaining tags.
  out = out.replace(/<[^>]+>/g, '');
  // Decode a few common entities. (mailparser already decodes most of
  // them, but inline HTML inside text/plain multiparts may not be.)
  out = out
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // Collapse runs of blank lines.
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

/**
 * Best-effort plain-text body extraction from a `FetchMessageObject`.
 * If `source` is present, runs it through `mailparser` to get the
 * cleanest text. Falls back to `htmlToPlainText` for HTML-only
 * messages. Returns empty strings when no source is available.
 */
export async function extractBodyAsync(message: FetchMessageObject): Promise<{
  textBody: string;
  hasHtmlBody: boolean;
  attachments: SyncAttachment[];
}> {
  if (!message.source || message.source.length === 0) {
    return { textBody: '', hasHtmlBody: false, attachments: [] };
  }
  try {
    const parsed = await simpleParser(message.source);
    const textBody = parsed.text && parsed.text.length > 0 ? parsed.text : '';
    const hasHtmlBody = typeof parsed.html === 'string' && parsed.html.length > 0;
    const finalText = textBody || (hasHtmlBody ? htmlToPlainText(parsed.html as string) : '');
    const attachments = Array.isArray(parsed.attachments)
      ? parsed.attachments.map(mapAttachment)
      : [];
    return { textBody: finalText, hasHtmlBody, attachments };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn('mailparser failed to parse message source; returning empty body', {
      uid: message.uid,
      error: errMsg,
    });
    return { textBody: '', hasHtmlBody: false, attachments: [] };
  }
}

/**
 * Normalize a single `FetchMessageObject` into a `SyncMessage`. The
 * `bodyPromise` parameter is what `extractBodyAsync` returned, so the
 * caller can decide whether to call it (skip in tests that don't have a
 * full source buffer).
 */
export async function normalizeFetchedMessage(args: {
  accountId: string;
  folder: string;
  receivedAt: Date;
  raw: FetchMessageObject;
  body: { textBody: string; hasHtmlBody: boolean; attachments: SyncAttachment[] };
}): Promise<SyncMessage> {
  const { accountId, folder, receivedAt, raw, body } = args;
  const envelope: MessageEnvelopeObject | undefined = raw.envelope;
  const flagState = flagsToBooleans(raw.flags);

  return {
    uid: raw.uid,
    messageId: normalizeMessageId(envelope?.messageId),
    folder,
    accountId,
    from: parseEnvelopeAddresses(envelope?.from),
    to: parseEnvelopeAddresses(envelope?.to),
    cc: parseEnvelopeAddresses(envelope?.cc),
    subject: envelope?.subject ?? '',
    date: normalizeDate(envelope?.date),
    internalDate: normalizeDate(raw.internalDate),
    receivedAt,
    isRead: flagState.isRead,
    isFlagged: flagState.isFlagged,
    isAnswered: flagState.isAnswered,
    isDraft: flagState.isDraft,
    size: typeof raw.size === 'number' ? raw.size : 0,
    textBody: body.textBody,
    hasHtmlBody: body.hasHtmlBody,
    attachments: body.attachments,
    flags: flagState.raw,
  };
}

/**
 * Dedupe a list of normalized messages. Primary key is UID; secondary
 * key is a non-empty Message-ID. First occurrence wins, preserving the
 * input order. Returns `{ unique, deduped }` where `deduped` is the
 * number of dropped entries.
 */
export function dedupeMessages(messages: ReadonlyArray<SyncMessage>): {
  unique: SyncMessage[];
  deduped: number;
} {
  const seenUids = new Set<number>();
  const seenMessageIds = new Set<string>();
  const unique: SyncMessage[] = [];
  for (const m of messages) {
    if (seenUids.has(m.uid)) {
      continue;
    }
    if (m.messageId.length > 0) {
      if (seenMessageIds.has(m.messageId)) {
        continue;
      }
      seenMessageIds.add(m.messageId);
    }
    seenUids.add(m.uid);
    unique.push(m);
  }
  return { unique, deduped: messages.length - unique.length };
}

/** Sort newest-first. Messages with no date sink to the bottom. */
export function sortNewestFirst(messages: SyncMessage[]): SyncMessage[] {
  return [...messages].sort((a, b) => {
    const ad = (a.internalDate ?? a.date)?.getTime() ?? 0;
    const bd = (b.internalDate ?? b.date)?.getTime() ?? 0;
    return bd - ad;
  });
}

// --- internals (re-exported for tests) ---

export const __testing = {
  htmlToPlainText,
  mapAttachment,
};
