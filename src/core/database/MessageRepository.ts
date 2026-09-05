/**
 * Phase 2.4 — `MessageRepository`.
 *
 * Persists the output of `ImapService.syncMessages` (Phase 2.3) into the
 * SQLite database. Owns:
 *   - Idempotent account / folder row creation.
 *   - The IMAP-synchronization-identity upsert (keyed on
 *     `id = ${accountId}:${folderId}:${uid}`).
 *   - Per-(account, folder) sync state (`folder_sync_state`).
 *
 * Design notes (Phase 2.4 review):
 *   - The application id is derived from the synchronization identity,
 *     not from `message_id`, so an empty `messageId` is still upsertable.
 *   - The `(account_id, folder_id, uid)` unique index is the
 *     synchronization identity. The legacy
 *     `UNIQUE (account_id, folder_id, message_id)` constraint is left
 *     in place as a defense-in-depth index.
 *   - `highest_uid` is updated with `MAX(highest_uid, excluded.highest_uid)`
 *     so it never regresses. Partial / error status updates omit the
 *     `highest_uid` column from the `SET` clause entirely.
 *   - `last_sync_status = 'partial'` is set only when the caller passes
 *     `options.status = 'partial'`. The repository never infers
 *     partial status from `result.deduped`.
 *   - The repository never reads or writes the `password` /
 *     `oauth_*` columns on `accounts`. The Phase 2.1 env-var
 *     credential policy is preserved.
 */

import { Database } from './Database.js';
import { DatabaseError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { AccountConfig } from '../types/config.js';
import type { SyncFolder } from '../imap/folders.js';
import type {
  EmailAddress,
  MessageSyncLimits,
  MessageSyncResult,
  SyncAttachment,
  SyncMessage,
} from '../imap/types.js';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Subset of `AccountConfig` the repository is allowed to see. */
export type SafeAccountInput = Pick<
  AccountConfig,
  'id' | 'name' | 'email' | 'host' | 'port' | 'username' | 'useTls' | 'authType'
>;

/** Sync-state status the repository writes. */
export type SyncStatus = 'ok' | 'partial' | 'error';

/** A single row in the `folder_sync_state` table. */
export interface FolderSyncState {
  accountId: string;
  folderId: string;
  highestUid: number;
  lastSyncAt: number | null;
  lastSyncStatus: SyncStatus;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Typed return shape for a single `emails` row. */
export interface PersistedEmail {
  id: string;
  accountId: string;
  folderId: string;
  messageId: string;
  fromAddresses: EmailAddress[];
  toAddresses: EmailAddress[];
  ccAddresses: EmailAddress[];
  subject: string;
  date: number;
  internalDate: number | null;
  receivedAt: number | null;
  isRead: boolean;
  isFlagged: boolean;
  isAnswered: boolean;
  isDraft: boolean;
  hasAttachments: boolean;
  size: number;
  bodyText: string | null;
  bodyHtml: string | null;
  headers: Record<string, string>;
  attachments: SyncAttachment[];
  flags: string[];
  uid: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Outcome of an `upsertMessages` call. */
export interface UpsertMessagesResult {
  inserted: number;
  updated: number;
  highestUid: number;
}

/** Options for `markSyncPartial` / `markSyncError`. */
export interface SyncStatusOptions {
  /** Required status. */
  status: 'partial' | 'error';
  /** Error message stored in `last_error`. */
  error: string;
}

/** Options for `persistSyncResult`. */
export interface PersistSyncResultOptions {
  /**
   * Sync status to record. `'ok'` is the default. `'partial'` and
   * `'error'` require `error` to be set. The repository NEVER infers
   * a status from `result.deduped`.
   */
  status?: SyncStatus;
  /** Error message for `'partial'` / `'error'`. Ignored when status is `'ok'`. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (no I/O; exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Derive the application id for an email row from the synchronization
 * identity `(accountId, folderId, uid)`. Deterministic, non-empty, and
 * stable across re-syncs of the same physical message.
 */
export function deriveEmailId(
  accountId: string,
  folderId: string,
  uid: number
): string {
  return `${accountId}:${folderId}:${uid}`;
}

/** Derive the deterministic id for a folder row. Path-keyed. */
export function deriveFolderId(accountId: string, path: string): string {
  return `${accountId}:${path}`;
}

/** Epoch seconds for a `Date | null`, falling back when needed. */
export function toEpochSeconds(value: Date | null | undefined): number {
  if (!value) return Math.floor(Date.now() / 1000);
  return Math.floor(value.getTime() / 1000);
}

/** Stable JSON for an `EmailAddress[]`. Empty array for empty / undefined. */
export function serializeAddresses(
  addrs: ReadonlyArray<EmailAddress> | undefined
): string {
  if (!addrs || addrs.length === 0) return '[]';
  return JSON.stringify(addrs.map((a) => ({ name: a.name, address: a.address })));
}

/** Stable JSON for a `SyncAttachment[]`. */
export function serializeAttachments(
  attachments: ReadonlyArray<SyncAttachment> | undefined
): string {
  if (!attachments || attachments.length === 0) return '[]';
  return JSON.stringify(
    attachments.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
      disposition: a.disposition,
      ...(a.contentId !== undefined ? { contentId: a.contentId } : {}),
    }))
  );
}

/** JSON-stringify the raw flag array. */
export function serializeFlags(flags: ReadonlyArray<string> | undefined): string {
  if (!flags || flags.length === 0) return '[]';
  return JSON.stringify([...flags]);
}

/** Parse a JSON array of addresses, tolerating malformed input. */
export function parseAddresses(raw: string | null | undefined): EmailAddress[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: EmailAddress[] = [];
    for (const item of parsed) {
      if (item && typeof item === 'object' && 'address' in item) {
        const obj = item as { name?: unknown; address?: unknown };
        out.push({
          name: typeof obj.name === 'string' ? obj.name : '',
          address: typeof obj.address === 'string' ? obj.address : '',
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Parse a JSON array of attachments, tolerating malformed input. */
export function parseAttachments(
  raw: string | null | undefined
): SyncAttachment[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: SyncAttachment[] = [];
    for (const item of parsed) {
      if (item && typeof item === 'object') {
        const obj = item as {
          filename?: unknown;
          contentType?: unknown;
          size?: unknown;
          disposition?: unknown;
          contentId?: unknown;
        };
        const dispRaw = typeof obj.disposition === 'string' ? obj.disposition : 'unknown';
        const disp: SyncAttachment['disposition'] =
          dispRaw === 'attachment' || dispRaw === 'inline' || dispRaw === 'unknown'
            ? dispRaw
            : 'unknown';
        out.push({
          filename: typeof obj.filename === 'string' ? obj.filename : '',
          contentType:
            typeof obj.contentType === 'string' ? obj.contentType : 'application/octet-stream',
          size: typeof obj.size === 'number' ? obj.size : 0,
          disposition: disp,
          ...(typeof obj.contentId === 'string' ? { contentId: obj.contentId } : {}),
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Parse a JSON array of flag strings. */
export function parseFlags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((f): f is string => typeof f === 'string');
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class MessageRepository {
  private readonly database: Database;

  constructor(database: Database) {
    this.database = database;
  }

  // -- Account / folder scaffolding --------------------------------------

  /**
   * Insert (or no-op) the `accounts` row for an `AccountConfig`. Only
   * safe columns are written; credentials (password / oauth_*) are
   * NEVER read or written.
   */
  ensureAccountRow(account: SafeAccountInput): void {
    this.database.transaction(() => {
      this.database
        .query(
          `INSERT OR IGNORE INTO accounts
            (id, name, type, email, host, port, username, use_tls, auth_type)
          VALUES (?, ?, 'imap', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          account.id,
          account.name,
          account.email,
          account.host ?? null,
          account.port,
          account.username ?? null,
          account.useTls ? 1 : 0,
          account.authType
        );
    });
  }

  /**
   * Insert (or no-op) a `folders` row for a `SyncFolder`. Idempotent.
   *
   * The `parent_id` FK is only set when the parent folder already
   * exists. A folder whose parent has not been synced yet still
   * gets a row, just without the parent link; a later call to
   * `ensureFolderRow` for the parent will not retroactively patch
   * the child's `parent_id` (that's a future cleanup task, not in
   * Phase 2.4 scope). This makes the repository safe to use with
   * partial / out-of-order folder syncs.
   *
   * The `account_id` FK is satisfied by the caller passing a known
   * `accountId`. Callers that have an `AccountConfig` should call
   * `ensureAccountRow` first (or pass through `upsertMessages`, which
   * does so automatically). When called directly with only an id,
   * the account row is NOT auto-created; that responsibility is the
   * caller's, so the repo never silently invents a partial account.
   */
  ensureFolderRow(accountId: string, folder: SyncFolder): string {
    const folderId = deriveFolderId(accountId, folder.path);
    this.database.transaction(() => {
      const parentId = folder.parentPath
        ? deriveFolderId(accountId, folder.parentPath)
        : null;
      let resolvedParentId: string | null = null;
      if (parentId) {
        const existing = this.database
          .query('SELECT 1 AS x FROM folders WHERE id = ?')
          .get(parentId) as { x: number } | undefined;
        if (existing) resolvedParentId = parentId;
      }
      this.database
        .query(
          `INSERT OR IGNORE INTO folders
            (id, account_id, name, full_name, type, parent_id, delimiter, attributes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          folderId,
          accountId,
          folder.displayName,
          folder.path,
          folder.type,
          resolvedParentId,
          folder.delimiter,
          '[]'
        );
    });
    return folderId;
  }

  // -- Sync state ---------------------------------------------------------

  /**
   * Read the current sync state for `(accountId, folderId)`. Returns
   * `null` when no sync has ever been recorded.
   */
  getSyncState(accountId: string, folderId: string): FolderSyncState | null {
    const row = this.database
      .query(
        `SELECT account_id, folder_id, highest_uid, last_sync_at,
                last_sync_status, last_error, created_at, updated_at
           FROM folder_sync_state
          WHERE account_id = ? AND folder_id = ?`
      )
      .get(accountId, folderId) as
      | {
          account_id: string;
          folder_id: string;
          highest_uid: number;
          last_sync_at: number | null;
          last_sync_status: SyncStatus;
          last_error: string | null;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      accountId: row.account_id,
      folderId: row.folder_id,
      highestUid: row.highest_uid,
      lastSyncAt: row.last_sync_at,
      lastSyncStatus: row.last_sync_status,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // -- Upsert -------------------------------------------------------------

  /**
   * Insert / update a batch of `SyncMessage` records for a single folder
   * and atomically advance the folder's sync state. All writes happen
   * inside a single transaction; on any failure nothing is persisted.
   *
   * Returns counts plus the new `highest_uid`. `last_sync_status` is
   * reset to `'ok'` and `last_error` is cleared.
   */
  upsertMessages(
    account: SafeAccountInput,
    folder: SyncFolder,
    messages: ReadonlyArray<SyncMessage>
  ): UpsertMessagesResult {
    if (messages.length === 0) {
      return { inserted: 0, updated: 0, highestUid: 0 };
    }

    this.ensureAccountRow(account);
    const folderId = this.ensureFolderRow(account.id, folder);

    const upsertSql = `INSERT INTO emails (
        id, account_id, folder_id, message_id, from_addresses, to_addresses,
        cc_addresses, subject, date, internal_date, received_at,
        is_read, is_flagged, is_answered, is_draft, has_attachments,
        size, body_text, headers, attachments, flags, uid
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        message_id      = excluded.message_id,
        from_addresses  = excluded.from_addresses,
        to_addresses    = excluded.to_addresses,
        cc_addresses    = excluded.cc_addresses,
        subject         = excluded.subject,
        date            = excluded.date,
        internal_date   = excluded.internal_date,
        received_at     = excluded.received_at,
        is_read         = excluded.is_read,
        is_flagged      = excluded.is_flagged,
        is_answered     = excluded.is_answered,
        is_draft        = excluded.is_draft,
        has_attachments = excluded.has_attachments,
        size            = excluded.size,
        body_text       = excluded.body_text,
        headers         = excluded.headers,
        attachments     = excluded.attachments,
        flags           = excluded.flags,
        uid             = excluded.uid,
        updated_at      = strftime('%s', 'now')`;

    const syncStateSql = `INSERT INTO folder_sync_state
        (account_id, folder_id, highest_uid, last_sync_at,
         last_sync_status, last_error, created_at, updated_at)
      VALUES (?, ?, ?, strftime('%s', 'now'), 'ok', NULL,
              strftime('%s', 'now'), strftime('%s', 'now'))
      ON CONFLICT(account_id, folder_id) DO UPDATE SET
        highest_uid     = MAX(folder_sync_state.highest_uid, excluded.highest_uid),
        last_sync_at    = strftime('%s', 'now'),
        last_sync_status = 'ok',
        last_error      = NULL,
        updated_at      = strftime('%s', 'now')`;

    let inserted = 0;
    let updated = 0;
    let highestUid = 0;

    try {
      this.database.transaction(() => {
        const upsertStmt = this.database.query(upsertSql);
        const stateStmt = this.database.query(syncStateSql);

        for (const m of messages) {
          const id = deriveEmailId(account.id, folderId, m.uid);
          // Pre-check whether the row exists so we can report counts.
          const existing = this.database
            .query('SELECT 1 AS x FROM emails WHERE id = ?')
            .get(id) as { x: number } | undefined;

          upsertStmt.run(
            id,
            account.id,
            folderId,
            m.messageId,
            serializeAddresses(m.from),
            serializeAddresses(m.to),
            serializeAddresses(m.cc),
            m.subject,
            toEpochSeconds(m.date),
            m.internalDate ? toEpochSeconds(m.internalDate) : null,
            toEpochSeconds(m.receivedAt),
            m.isRead ? 1 : 0,
            m.isFlagged ? 1 : 0,
            m.isAnswered ? 1 : 0,
            m.isDraft ? 1 : 0,
            m.attachments.length > 0 ? 1 : 0,
            m.size,
            m.textBody || null,
            '{}',
            serializeAttachments(m.attachments),
            serializeFlags(m.flags),
            m.uid
          );
          if (existing) updated += 1;
          else inserted += 1;
          if (m.uid > highestUid) highestUid = m.uid;
        }

        stateStmt.run(account.id, folderId, highestUid);
      });
    } catch (error) {
      throw new DatabaseError(
        `Failed to persist messages for account "${account.id}", folder "${folder.path}": ${getErrorMessage(error)}`
      );
    }

    logger.debug('Persisted message batch', {
      accountId: account.id,
      folder: folder.path,
      inserted,
      updated,
      highestUid,
    });

    return { inserted, updated, highestUid };
  }

  // -- Status updates -----------------------------------------------------

  /**
   * Mark a folder as having completed a partial sync. `highest_uid` is
   * NEVER modified by this call. `last_sync_status` becomes `'partial'`
   * and `last_error` records the diagnostic. If no sync-state row
   * exists yet, one is created.
   */
  markSyncPartial(
    account: SafeAccountInput,
    folder: SyncFolder,
    error: string
  ): void {
    this.setStatus(account, folder, 'partial', error);
  }

  /** Mark a folder as failed. `highest_uid` is NEVER modified. */
  markSyncError(
    account: SafeAccountInput,
    folder: SyncFolder,
    error: string
  ): void {
    this.setStatus(account, folder, 'error', error);
  }

  private setStatus(
    account: SafeAccountInput,
    folder: SyncFolder,
    status: 'partial' | 'error',
    error: string
  ): void {
    this.ensureAccountRow(account);
    const folderId = this.ensureFolderRow(account.id, folder);
    const sql = `INSERT INTO folder_sync_state
        (account_id, folder_id, highest_uid, last_sync_at,
         last_sync_status, last_error, created_at, updated_at)
      VALUES (?, ?, 0, strftime('%s', 'now'), ?, ?,
              strftime('%s', 'now'), strftime('%s', 'now'))
      ON CONFLICT(account_id, folder_id) DO UPDATE SET
        last_sync_status = excluded.last_sync_status,
        last_error      = excluded.last_error,
        updated_at      = strftime('%s', 'now')`;
    try {
      this.database.transaction(() => {
        this.database.query(sql).run(account.id, folderId, status, error);
      });
    } catch (e) {
      throw new DatabaseError(
        `Failed to record sync status (${status}) for account "${account.id}", folder "${folder.path}": ${getErrorMessage(e)}`
      );
    }
  }

  // -- Read helpers -------------------------------------------------------

  /** Read a single `emails` row by its application id. */
  findById(id: string): PersistedEmail | null {
    const row = this.database
      .query(
        `SELECT id, account_id, folder_id, message_id,
                from_addresses, to_addresses, cc_addresses, subject,
                date, internal_date, received_at,
                is_read, is_flagged, is_answered, is_draft, has_attachments,
                size, body_text, body_html, headers, attachments, flags, uid,
                created_at, updated_at
           FROM emails WHERE id = ?`
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToEmail(row);
  }

  /**
   * List emails in a folder, newest first by `internal_date` (with
   * `date` as fallback). Optional cap; default 100.
   */
  listByFolder(
    accountId: string,
    folderId: string,
    limit = 100
  ): PersistedEmail[] {
    const rows = this.database
      .query(
        `SELECT id, account_id, folder_id, message_id,
                from_addresses, to_addresses, cc_addresses, subject,
                date, internal_date, received_at,
                is_read, is_flagged, is_answered, is_draft, has_attachments,
                size, body_text, body_html, headers, attachments, flags, uid,
                created_at, updated_at
           FROM emails
          WHERE account_id = ? AND folder_id = ?
          ORDER BY COALESCE(internal_date, date) DESC
          LIMIT ?`
      )
      .all(accountId, folderId, limit) as Record<string, unknown>[];
    return rows.map(rowToEmail);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function rowToEmail(row: Record<string, unknown>): PersistedEmail {
  const getNum = (k: string): number => (typeof row[k] === 'number' ? (row[k] as number) : 0);
  const getNumOrNull = (k: string): number | null =>
    row[k] === null || row[k] === undefined ? null : (row[k] as number);
  const getStr = (k: string): string =>
    typeof row[k] === 'string' ? (row[k] as string) : '';
  const getStrOrNull = (k: string): string | null =>
    row[k] === null || row[k] === undefined ? null : (row[k] as string);
  const getBool = (k: string): boolean => getNum(k) !== 0;

  let headers: Record<string, string> = {};
  const headersRaw = getStrOrNull('headers');
  if (headersRaw) {
    try {
      const parsed: unknown = JSON.parse(headersRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        headers = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string') headers[k] = v;
        }
      }
    } catch {
      headers = {};
    }
  }

  return {
    id: getStr('id'),
    accountId: getStr('account_id'),
    folderId: getStr('folder_id'),
    messageId: getStr('message_id'),
    fromAddresses: parseAddresses(getStrOrNull('from_addresses')),
    toAddresses: parseAddresses(getStrOrNull('to_addresses')),
    ccAddresses: parseAddresses(getStrOrNull('cc_addresses')),
    subject: getStr('subject'),
    date: getNum('date'),
    internalDate: getNumOrNull('internal_date'),
    receivedAt: getNumOrNull('received_at'),
    isRead: getBool('is_read'),
    isFlagged: getBool('is_flagged'),
    isAnswered: getBool('is_answered'),
    isDraft: getBool('is_draft'),
    hasAttachments: getBool('has_attachments'),
    size: getNum('size'),
    bodyText: getStrOrNull('body_text'),
    bodyHtml: getStrOrNull('body_html'),
    headers,
    attachments: parseAttachments(getStrOrNull('attachments')),
    flags: parseFlags(getStrOrNull('flags')),
    uid: getNumOrNull('uid'),
    createdAt: getNum('created_at'),
    updatedAt: getNum('updated_at'),
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

// ---------------------------------------------------------------------------
// Integration helper
// ---------------------------------------------------------------------------

/**
 * Persist a `MessageSyncResult` and update the folder's sync state in
 * one atomic step.
 *
 * The status recorded in `folder_sync_state` is taken from
 * `options.status`. If `options.status` is omitted, `'ok'` is recorded.
 * The repository NEVER infers a status from `result.deduped` — a clean
 * sync with deduplicated messages is `'ok'`, not `'partial'`.
 *
 * On a successful `upsertMessages`, the sync state is advanced
 * (`highest_uid` uses `MAX`, so it never regresses). On a thrown
 * error, the whole transaction rolls back and sync state is left
 * alone — the caller is expected to call `markSyncError` separately
 * if it wants the failure recorded.
 */
export function persistSyncResult(
  repo: MessageRepository,
  account: SafeAccountInput,
  folder: SyncFolder,
  result: MessageSyncResult,
  options: PersistSyncResultOptions = {}
): UpsertMessagesResult {
  const status: SyncStatus = options.status ?? 'ok';
  if (status !== 'ok' && !options.error) {
    throw new DatabaseError(
      `persistSyncResult: status="${status}" requires options.error`
    );
  }
  const upsert = repo.upsertMessages(account, folder, result.messages);
  if (status === 'partial') {
    repo.markSyncPartial(account, folder, options.error as string);
  } else if (status === 'error') {
    repo.markSyncError(account, folder, options.error as string);
  }
  return upsert;
}

/**
 * Build the `MessageSyncLimits` for the next sync of a folder from the
 * persisted sync state. `sinceUid` is exclusive per the Phase 2.3
 * `buildFetchRange` semantics, so the returned limit equals the
 * previously recorded `highest_uid`. If there is no recorded state,
 * `undefined` is returned (caller will perform a full sync).
 */
export function buildImapSyncLimits(
  state: FolderSyncState | null
): MessageSyncLimits | undefined {
  if (!state) return undefined;
  return { sinceUid: state.highestUid };
}
