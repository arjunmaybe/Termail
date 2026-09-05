/**
 * IMAP service - thin wrapper around `imapflow`'s `ImapFlow`.
 *
 * Responsibilities (Phase 2):
 *   - Build a connection from an `AccountConfig` + env-resolved credentials.
 *   - Connect and authenticate (TLS, STARTTLS, or cleartext per config).
 *   - List mailboxes/folders (raw and normalized).
 *   - Synchronize folders: classify, dedupe, and order.
 *   - Synchronize messages: fetch, parse, normalize, dedupe.
 *   - Disconnect gracefully.
 *
 * Out of scope:
 *   - IDLE / push notifications.
 *   - Caching mailboxes or sync state on disk.
 *   - Saving emails to the database (Phase 2.4).
 *   - Downloading attachment bodies.
 *
 * The service is deliberately small: it does NOT store credentials, does NOT
 * hold a password past the connect() call, and does NOT log credentials. If
 * a value is ever passed to the logger, it is first run through
 * `redactSecrets` with the resolved secret.
 */

import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import type { AccountConfig } from '../types/config.js';
import { AuthenticationError, NetworkError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { type ResolvedCredentials, resolveCredentials } from './credentials.js';
import type { FolderSyncResult } from './folders.js';
import { syncMailboxes } from './folders.js';
import {
  buildFetchQuery,
  dedupeMessages,
  extractBodyAsync,
  normalizeFetchedMessage,
  planBatches,
  resolveLimits,
  sortNewestFirst,
} from './messages.js';
import type {
  ImapAccountConfig,
  ImapFlowFactory,
  ImapFolderInfo,
  MessageSyncOptions,
  MessageSyncResult,
  SyncMessage,
} from './types.js';

/** Default factory: produces real `ImapFlow` instances. */
const defaultFactory: ImapFlowFactory = {
  create: (options) => new ImapFlow(options),
};

/**
 * Substrings whose presence in an IMAP error message indicates
 * authentication failed. Used to map low-level `ImapFlow` errors to our
 * typed `AuthenticationError`. Substrings are matched case-insensitively.
 */
const AUTH_FAILURE_HINTS: ReadonlyArray<string> = [
  'authenticationfailed',
  'auth',
  'invalid credentials',
  'login failed',
  'authentication failed',
];

export interface ImapServiceOptions {
  /** Override the factory (used in tests). */
  factory?: ImapFlowFactory;
  /** Override env (used in tests). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Service for a single IMAP account. Holds a single live `ImapFlow`
 * connection at a time; calls to `connect()` while connected throw.
 */
export class ImapService {
  private readonly account: ImapAccountConfig;
  private readonly factory: ImapFlowFactory;
  private readonly env: NodeJS.ProcessEnv;
  private client: ImapFlow | null = null;
  private lastCredentials: ResolvedCredentials | null = null;

  constructor(account: ImapAccountConfig, options: ImapServiceOptions = {}) {
    this.account = account;
    this.factory = options.factory ?? defaultFactory;
    this.env = options.env ?? process.env;
  }

  /** Account this service is bound to. */
  getAccount(): ImapAccountConfig {
    return this.account;
  }

  /** Whether a live connection is currently held. */
  isConnected(): boolean {
    return this.client !== null;
  }

  /**
   * Open a connection and authenticate. Throws if already connected; callers
   * are expected to `disconnect()` first.
   */
  async connect(): Promise<void> {
    if (this.client) {
      throw new NetworkError('IMAP service is already connected. Call disconnect() first.');
    }

    const credentials = resolveCredentials(this.account, this.env);
    this.lastCredentials = credentials;

    const options = buildImapOptions(this.account, credentials);

    let client: ImapFlow;
    try {
      client = this.factory.create(options);
    } catch (error) {
      throw new NetworkError(
        `Failed to construct IMAP client: ${redactMessage(getErrorMessage(error), credentials.secret)}`
      );
    }

    try {
      await client.connect();
    } catch (error) {
      try {
        client.close();
      } catch {
        /* ignore */
      }
      throw mapConnectionError(error, credentials.secret);
    }

    this.client = client;
    logger.info('IMAP connection established', {
      accountId: this.account.id,
      host: this.account.host,
      port: this.account.port,
      secure: this.account.useTls,
    });
  }

  /** Graceful close: sends LOGOUT if possible, then drops the socket. */
  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.lastCredentials = null;
    if (!client) return;

    try {
      await client.logout();
    } catch (error) {
      logger.warn('IMAP logout failed; closing socket anyway', {
        accountId: this.account.id,
        error: redactMessage(getErrorMessage(error), /* secret= */ ''),
      });
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }
    logger.info('IMAP connection closed', { accountId: this.account.id });
  }

  /**
   * List all mailboxes on the server. Auto-connects if not already
   * connected so callers can do `await service.listMailboxes()` without
   * separate setup.
   */
  async listMailboxes(): Promise<ImapFolderInfo[]> {
    if (!this.client) {
      await this.connect();
    }
    const client = this.requireClient();
    const secret = this.lastCredentials?.secret ?? '';
    let raw;
    try {
      raw = await client.list();
    } catch (error) {
      throw mapConnectionError(error, secret);
    }
    return raw.map(normalizeMailbox);
  }

  /**
   * List mailboxes and run them through the folder synchronization
   * pipeline: classify, dedupe, sort. Returns a deterministic
   * `FolderSyncResult` ready for persistence in a later milestone.
   *
   * The connection is left open on success so callers can chain a
   * message sync in a follow-up milestone without reconnecting. Errors
   * are mapped through the same path as `connect()` and `listMailboxes()`.
   */
  async syncFolders(): Promise<FolderSyncResult> {
    const entries = await this.listRawMailboxes();
    return syncMailboxes(entries);
  }

  /**
   * List mailboxes and return them in the raw shape consumed by
   * `syncMailboxes`. Kept separate from `listMailboxes()` so the
   * normalized `ImapFolderInfo` and the raw `ListResponse` shapes
   * don't get confused at the type level.
   */
  private async listRawMailboxes(): Promise<
    Array<{
      path: string;
      delimiter: string;
      flags: Set<string>;
      specialUse?: string;
    }>
  > {
    if (!this.client) {
      await this.connect();
    }
    const client = this.requireClient();
    const secret = this.lastCredentials?.secret ?? '';
    let raw;
    try {
      raw = await client.list();
    } catch (error) {
      throw mapConnectionError(error, secret);
    }
    return raw.map((entry) => ({
      path: entry.path,
      delimiter: entry.delimiter,
      flags: entry.flags ?? new Set<string>(),
      specialUse: entry.specialUse,
    }));
  }

  /**
   * Fetch and normalize messages from a single folder. Opens the
   * mailbox in read-only mode, fetches in batches with a hard cap on
   * messages and per-message source bytes, runs each batch through
   * `mailparser`, normalizes, and dedupes. The mailbox is closed when
   * the sync completes (success or failure); the underlying IMAP
   * connection stays open.
   *
   * Errors are mapped through the same path as `connect()` and
   * `listMailboxes()`: `AuthenticationError` for auth failures,
   * `NetworkError` for everything else. The resolved secret is
   * redacted from any thrown message.
   */
  async syncMessages(
    folderPath: string,
    options: MessageSyncOptions = {}
  ): Promise<MessageSyncResult> {
    if (!this.client) {
      await this.connect();
    }
    const client = this.requireClient();
    const secret = this.lastCredentials?.secret ?? '';
    const accountId = this.account.id;
    const limits = resolveLimits(options.limits);

    let mailbox;
    try {
      mailbox = await client.mailboxOpen(folderPath, { readOnly: true });
    } catch (error) {
      throw mapConnectionError(error, secret);
    }

    try {
      const upperUid = Number(mailbox.uidNext) - 1;
      const batches = planBatches({
        upperUid,
        sinceUid: limits.sinceUid ?? 0,
        batchSize: limits.batchSize,
        maxMessages: limits.maxMessages,
      });

      const query = buildFetchQuery(limits.maxSourceBytes);
      const receivedAt = new Date();
      const collected: SyncMessage[] = [];
      let total = 0;

      for (const batch of batches) {
        const range = `${batch.from}:${batch.to}`;
        let raw: Awaited<ReturnType<typeof client.fetchAll>>;
        try {
          raw = await client.fetchAll(range, query);
        } catch (error) {
          throw mapConnectionError(error, secret);
        }
        for (const entry of raw) {
          total += 1;
          const body = await extractBodyAsync(entry);
          const normalized = await normalizeFetchedMessage({
            accountId,
            folder: folderPath,
            receivedAt,
            raw: entry,
            body,
          });
          collected.push(normalized);
        }
      }

      const deduped = dedupeMessages(collected);
      const messages = sortNewestFirst(deduped.unique);
      return {
        folder: folderPath,
        total,
        parsed: messages.length,
        deduped: deduped.deduped,
        messages,
      };
    } finally {
      try {
        await client.mailboxClose();
      } catch (error) {
        logger.warn('IMAP mailboxClose failed; ignoring', {
          accountId: this.account.id,
          folder: folderPath,
          error: redactMessage(getErrorMessage(error), /* secret= */ ''),
        });
      }
    }
  }

  private requireClient(): ImapFlow {
    if (!this.client) {
      throw new NetworkError('IMAP service is not connected. Call connect() first.');
    }
    return this.client;
  }
}

/**
 * Build the `ImapFlow` options from the account config + resolved
 * credentials. Exported so tests can assert the options shape without
 * standing up a full service.
 */
export function buildImapOptions(
  account: ImapAccountConfig,
  credentials: ResolvedCredentials
): ImapFlowOptions {
  if (!account.host) {
    throw new NetworkError(
      `Account "${account.id}" is missing an IMAP host. Add a "host" field to the account config.`
    );
  }

  const auth: ImapFlowOptions['auth'] = {
    user: credentials.user,
  };
  if (credentials.kind === 'oauth2') {
    auth.accessToken = credentials.secret;
  } else {
    auth.pass = credentials.secret;
  }

  const options: ImapFlowOptions = {
    host: account.host,
    port: account.port,
    secure: account.useTls,
    auth,
    // Disable imapflow's built-in logger; we log through our own structured
    // logger and never want to risk credentials leaking through imapflow's
    // debug output.
    logger: false,
    tls: {
      // Reject invalid certs by default; callers can override via
      // ImapConnectionOptions in a later milestone if needed.
      rejectUnauthorized: true,
    },
  };
  return options;
}

/** Re-export internals for tests. Not part of the public surface. */
export const __testing = {
  AUTH_FAILURE_HINTS,
  buildImapOptions,
  defaultFactory,
  mapConnectionError,
  normalizeMailbox,
  redactMessage,
};

/** Map a single raw `ListResponse` entry to our normalized folder shape. */
function normalizeMailbox(entry: {
  path: string;
  delimiter: string;
  flags?: Set<string>;
  specialUse?: string;
}): ImapFolderInfo {
  const flags: string[] = [];
  if (entry.flags) {
    for (const f of entry.flags) flags.push(f);
  }
  let specialUse = '';
  if (entry.specialUse) {
    specialUse = entry.specialUse.replace(/^\\/, '').toLowerCase();
  }

  // Derive a human-readable name from the last path segment. For "INBOX"
  // we keep it as-is; for "Foo/Bar" we get "Bar".
  const segments = entry.path.split(/[./]/).filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  const name = last ?? entry.path;

  return {
    path: entry.path,
    name,
    delimiter: entry.delimiter,
    flags,
    specialUse,
  };
}

/** Replace any secret string in a message with `***`. */
function redactMessage(message: string, secret: string): string {
  if (!secret) return message;
  return message.split(secret).join('***');
}

/** Pull a printable message out of an unknown thrown value. */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

/**
 * Map any error thrown by `ImapFlow.connect()` or by an IMAP command to
 * the right `TermailError` subtype. Authentication errors become
 * `AuthenticationError`; everything else (DNS, TLS, socket, timeouts,
 * capability failures) becomes `NetworkError`.
 */
function mapConnectionError(error: unknown, secret: string): Error {
  const message = redactMessage(getErrorMessage(error), secret);
  const lower = message.toLowerCase();

  // imapflow sets a discriminator on its auth-failure class.
  if (typeof error === 'object' && error !== null) {
    const flag = (error as { authenticationFailed?: unknown }).authenticationFailed;
    if (flag === true) {
      return new AuthenticationError(`IMAP authentication failed: ${message}`);
    }
  }
  for (const hint of AUTH_FAILURE_HINTS) {
    if (lower.includes(hint)) {
      return new AuthenticationError(`IMAP authentication failed: ${message}`);
    }
  }
  return new NetworkError(`IMAP connection error: ${message}`);
}

// --- Singleton ---

let imapServiceInstance: ImapService | null = null;
let imapServiceAccountId: string | null = null;

/**
 * Get the singleton IMAP service. The singleton is per-account; calling
 * with a different account id resets the previous instance. Use
 * `resetImapService()` for explicit teardown (used in tests).
 */
export function getImapService(
  account: ImapAccountConfig,
  options?: ImapServiceOptions
): ImapService {
  if (!imapServiceInstance || imapServiceAccountId !== account.id) {
    imapServiceInstance = new ImapService(account, options);
    imapServiceAccountId = account.id;
  }
  return imapServiceInstance;
}

/** Drop the singleton; the next call to `getImapService` builds a new one. */
export function resetImapService(): void {
  imapServiceInstance = null;
  imapServiceAccountId = null;
}

// Re-export the AccountConfig type via this module so callers can import it
// from one place alongside the service.
export type { AccountConfig };
