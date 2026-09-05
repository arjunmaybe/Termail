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
