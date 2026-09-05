/**
 * IMAP service type definitions.
 *
 * These types intentionally live outside the `Account` (database) layer and
 * outside the config layer: they describe the runtime shape the IMAP service
 * needs to build a connection. The configuration layer is responsible for
 * validating user input; the service layer is responsible for turning that
 * validated config into a live `ImapFlow` session.
 */

import type { ImapFlow, ImapFlowOptions, ListResponse } from 'imapflow';
import type { AccountConfig } from '../types/config.js';

/**
 * Subset of `AccountConfig` fields the IMAP service reads. The service
 * accepts a plain `AccountConfig` but exposes the narrower view in public
 * methods so callers don't accidentally pass the wrong shape.
 */
export type ImapAccountConfig = AccountConfig;

/**
 * Connection options that callers can override per-call. Currently a no-op
 * placeholder; reserved for future flags like `connectionTimeout` or
 * `disableAutoIdle`.
 */
export interface ImapConnectionOptions {
  /** Override the connection timeout (ms). */
  connectionTimeoutMs?: number;
}

/** Normalized folder/mailbox information returned by `listMailboxes`. */
export interface ImapFolderInfo {
  /** Full IMAP path of the mailbox, e.g. "INBOX" or "Archive/2024". */
  path: string;
  /** Human-readable name, derived from the last path segment. */
  name: string;
  /** Hierarchy delimiter reported by the server, usually "." or "/". */
  delimiter: string;
  /** Any special-use flags the server reported, e.g. "\\Inbox". */
  flags: string[];
  /**
   * Special-use attribute if the server reported one, normalized without
   * the leading backslash. Examples: "Inbox", "Sent", "Drafts", "Trash",
   * "Junk", "Archive", "All", "Flagged". Empty string when unknown.
   */
  specialUse: string;
}

/** Factory used to construct the underlying `ImapFlow` client. */
export interface ImapFlowFactory {
  create(options: ImapFlowOptions): ImapFlow;
}

/** The raw list response shape from `imapflow`. Re-exported for tests. */
export type { ListResponse, ImapFlow, ImapFlowOptions };

// ---------------------------------------------------------------------------
// Email / message sync types (Phase 2.3)
// ---------------------------------------------------------------------------

/**
 * A single email address as it appears in a header. Both `name` and
 * `address` are always present as strings: empty string when the
 * underlying parser didn't return one. `address` is what the consumer
 * should use as the stable identifier.
 */
export interface EmailAddress {
  name: string;
  address: string;
}

/**
 * Attachment metadata. We do NOT carry the bytes here; downloading
 * attachment contents is a separate milestone. `filename` may be empty if
 * the server didn't report one. `contentType` defaults to
 * `application/octet-stream`. `size` is in bytes and may be 0 when
 * unknown.
 */
export interface SyncAttachment {
  filename: string;
  contentType: string;
  size: number;
  /** Whether the part is announced as `inline` or `attachment`, or unknown. */
  disposition: 'attachment' | 'inline' | 'unknown';
  /** RFC 2392 Content-ID, without angle brackets, when present. */
  contentId?: string;
}

/**
 * Normalized message record produced by `ImapService.syncMessages`.
 * Intentionally a plain shape (not the DB `EmailEnvelope` type) so this
 * module has no opinion about persistence. The persistence layer
 * (Phase 2.4) maps `SyncMessage[]` to database rows.
 */
export interface SyncMessage {
  /** IMAP UID. Stable across a mailbox for as long as the message exists. */
  uid: number;
  /** RFC 5322 Message-ID, with angle brackets stripped. Empty string when absent. */
  messageId: string;
  /** Path of the mailbox this message was fetched from. */
  folder: string;
  /** Account id this message belongs to. */
  accountId: string;
  /** Sender(s) of the message. Empty array when no From: header is present. */
  from: EmailAddress[];
  /** Primary recipients. Empty array when no To: header is present. */
  to: EmailAddress[];
  /** Carbon-copy recipients. Empty array when no Cc: header is present. */
  cc: EmailAddress[];
  /** Subject. Empty string when no Subject header is present. */
  subject: string;
  /** Date from the message envelope (Date: header). `null` when absent. */
  date: Date | null;
  /** Internal date the server assigned on arrival. `null` when absent. */
  internalDate: Date | null;
  /** Local time the message was synchronized. */
  receivedAt: Date;
  /** `\Seen` flag. */
  isRead: boolean;
  /** `\Flagged` flag. */
  isFlagged: boolean;
  /** `\Answered` flag. */
  isAnswered: boolean;
  /** `\Draft` flag. */
  isDraft: boolean;
  /** Size of the message in bytes. 0 when unknown. */
  size: number;
  /** Plain-text body, decoded. Empty string when no text part is available. */
  textBody: string;
  /** Whether an HTML alternative was present in the source. */
  hasHtmlBody: boolean;
  /** Attachment metadata. Empty array when no attachments are present. */
  attachments: SyncAttachment[];
  /** Raw IMAP flags as a flat string array, e.g. ["\\Seen", "\\Flagged"]. */
  flags: string[];
}

/** Outcome of `ImapService.syncMessages`. */
export interface MessageSyncResult {
  /** Folder path that was synced. */
  folder: string;
  /** Total messages the server reported for the range before dedup. */
  total: number;
  /** Messages that were successfully normalized. */
  parsed: number;
  /** Messages dropped as duplicates by UID or Message-ID. */
  deduped: number;
  /** Deterministic, deduped, newest-first message list. */
  messages: SyncMessage[];
}

/** Batching / safety limits for `syncMessages`. */
export interface MessageSyncLimits {
  /** Hard cap on how many messages to fetch. Default 500. */
  maxMessages?: number;
  /** IMAP FETCH batch size. Default 100. */
  batchSize?: number;
  /** Lower bound UID. Only messages with `uid > sinceUid` are returned. Default none. */
  sinceUid?: number;
  /** Max raw bytes per message we'll request. Default 25 MiB. */
  maxSourceBytes?: number;
}

export interface MessageSyncOptions {
  limits?: MessageSyncLimits;
}
