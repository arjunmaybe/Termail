/**
 * Phase 2.4 — v2 migration: add IMAP synchronization identity and
 * per-folder sync state.
 *
 * Additive only:
 *   - New columns on `emails` (`uid`, `internal_date`, `received_at`,
 *     `is_answered`, `is_draft`, `flags`).
 *   - New table `folder_sync_state` for incremental sync bookkeeping.
 *   - New unique index on `(account_id, folder_id, uid)` for upsert.
 *   - New index on `(account_id, folder_id, internal_date)` for listing.
 *
 * Deliberate non-changes:
 *   - We do NOT force `uid` to be NOT NULL. Pre-v2 rows are migrated
 *     to `uid = NULL` and remain invisible to the new synchronization
 *     identity (SQLite treats NULLs as non-colliding in a unique
 *     index). The repository only ever writes a real UID going
 *     forward. No fake UIDs are generated.
 *   - We do NOT rebuild the `emails` table. The v1 FTS5 triggers
 *     reference `emails.rowid` and the same six columns; adding
 *     columns does not change rowids and does not change the columns
 *     the triggers read, so the triggers continue to fire correctly.
 *   - We do NOT touch the existing `UNIQUE (account_id, folder_id,
 *     message_id)` constraint. It is now a defense-in-depth index; the
 *     new `(account_id, folder_id, uid)` unique index is the actual
 *     synchronization identity.
 */

export const MIGRATION_V2_UP_SQL = `
-- New nullable column: IMAP UID. Pre-v2 rows stay NULL.
ALTER TABLE emails ADD COLUMN uid INTEGER;

-- Informational columns populated by Phase 2.3 sync.
ALTER TABLE emails ADD COLUMN internal_date INTEGER;
ALTER TABLE emails ADD COLUMN received_at INTEGER;
ALTER TABLE emails ADD COLUMN is_answered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE emails ADD COLUMN is_draft INTEGER NOT NULL DEFAULT 0;
ALTER TABLE emails ADD COLUMN flags TEXT NOT NULL DEFAULT '[]';

-- Per-(account, folder) sync state for incremental syncs.
CREATE TABLE IF NOT EXISTS folder_sync_state (
  account_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  highest_uid INTEGER NOT NULL DEFAULT 0,
  last_sync_at INTEGER,
  last_sync_status TEXT NOT NULL DEFAULT 'ok'
    CHECK (last_sync_status IN ('ok', 'partial', 'error')),
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  PRIMARY KEY (account_id, folder_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
);

-- Synchronization-identity unique index. NULLs are non-colliding in
-- SQLite, so pre-v2 rows with uid=NULL do not violate this index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_emails_account_folder_uid
  ON emails (account_id, folder_id, uid);

-- Secondary index for "list messages by internal date, newest first".
CREATE INDEX IF NOT EXISTS idx_emails_internal_date
  ON emails (account_id, folder_id, internal_date DESC);
`;
