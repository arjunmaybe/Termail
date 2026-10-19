/**
 * Phase post-audit — v5 migration: allow distinct IMAP UIDs to share a
 * Message-ID in the same folder.
 *
 * Background:
 *   The authoritative synchronization identity is
 *   `(account_id, folder_id, uid)` (unique index
 *   `uq_emails_account_folder_uid`, added in v2). The v1 table constraint
 *   `UNIQUE (account_id, folder_id, message_id)` retained by v4 treats a
 *   Message-ID as a mailbox identity, which it is not: two distinct
 *   messages can legitimately share a Message-ID (mailing-list copies,
 *   resends, malformed clients, or server-side duplicates with distinct
 *   UIDs). The old constraint caused the second UID to fail persistence
 *   and repeatedly re-fail on the next sync.
 *
 * What this migration does (in order):
 *   1. Drop the three FTS5 triggers and the `emails_fts` virtual table
 *      (same ordering as v3/v4 — triggers reference the FTS column list).
 *   2. Rebuild `emails` with the same columns, defaults, and foreign keys,
 *      but WITHOUT the legacy `UNIQUE (account_id, folder_id, message_id)`
 *      constraint. `message_id` remains nullable.
 *   3. Copy every existing row verbatim, preserving `rowid`, `id`, `uid`,
 *      `message_id` (including NULL), timestamps, and all other values.
 *      No deduplication, merge, renumbering, or value transformation is
 *      performed. v4 already guarantees at most one row per
 *      `(account_id, folder_id, message_id)`, so dropping the constraint
 *      cannot create a conflict.
 *   4. Recreate all v1/v2 indexes, including the non-unique
 *      `idx_emails_message_id` and the unique UID identity index.
 *   5. Recreate `emails_fts` with the v3/v4 column list and repopulate it
 *      from `emails`.
 *   6. Recreate the three FTS5 triggers.
 *
 * Safety:
 *   - NON-destructive to user data. Every `emails` row survives with
 *     identical values and the same `rowid`.
 *   - Forward-only like v3/v4: no `down` (reverting would require another
 *     full rebuild and could not safely restore Message-ID uniqueness once
 *     duplicate Message-IDs have been persisted).
 */

export const MIGRATION_V5_UP_SQL = `
-- 1. Drop FTS triggers + virtual table (v3/v4 ordering).
DROP TRIGGER IF EXISTS emails_fts_insert;
DROP TRIGGER IF EXISTS emails_fts_delete;
DROP TRIGGER IF EXISTS emails_fts_update;
DROP TABLE IF EXISTS emails_fts;

-- 2. Rebuild emails without the legacy Message-ID unique constraint.
--    All columns, defaults, and FKs are preserved verbatim.
CREATE TABLE emails_new (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  message_id TEXT,
  from_addresses TEXT NOT NULL DEFAULT '[]',
  to_addresses TEXT NOT NULL DEFAULT '[]',
  cc_addresses TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  date INTEGER NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  is_flagged INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  body_text TEXT,
  body_html TEXT,
  headers TEXT NOT NULL DEFAULT '{}',
  attachments TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  uid INTEGER,
  internal_date INTEGER,
  received_at INTEGER,
  is_answered INTEGER NOT NULL DEFAULT 0,
  is_draft INTEGER NOT NULL DEFAULT 0,
  flags TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
);

-- 3. Copy rows verbatim. rowid is preserved for FTS external-content rows.
INSERT INTO emails_new (
  rowid, id, account_id, folder_id, message_id,
  from_addresses, to_addresses, cc_addresses, subject, date,
  is_read, is_flagged, has_attachments, size,
  body_text, body_html, headers, attachments,
  created_at, updated_at,
  uid, internal_date, received_at, is_answered, is_draft, flags
)
SELECT
  rowid, id, account_id, folder_id, message_id,
  from_addresses, to_addresses, cc_addresses, subject, date,
  is_read, is_flagged, has_attachments, size,
  body_text, body_html, headers, attachments,
  created_at, updated_at,
  uid, internal_date, received_at, is_answered, is_draft, flags
FROM emails;

DROP TABLE emails;
ALTER TABLE emails_new RENAME TO emails;

-- 4. Recreate v1 + v2 indexes. The UID index remains the unique
--    synchronization identity; the Message-ID index is lookup-only.
CREATE INDEX IF NOT EXISTS idx_emails_account ON emails(account_id);
CREATE INDEX IF NOT EXISTS idx_emails_folder ON emails(folder_id);
CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date DESC);
CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
CREATE INDEX IF NOT EXISTS idx_emails_read ON emails(is_read);
CREATE INDEX IF NOT EXISTS idx_emails_flagged ON emails(is_flagged);
CREATE UNIQUE INDEX IF NOT EXISTS uq_emails_account_folder_uid
  ON emails (account_id, folder_id, uid);
CREATE INDEX IF NOT EXISTS idx_emails_internal_date
  ON emails (account_id, folder_id, internal_date DESC);

-- 5. Recreate emails_fts (v3/v4 column list) and repopulate.
CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
  message_id UNINDEXED,
  subject,
  body_text,
  from_addresses,
  to_addresses,
  cc_addresses,
  content='emails',
  content_rowid='rowid'
);

INSERT INTO emails_fts (rowid, message_id, subject, body_text,
                        from_addresses, to_addresses, cc_addresses)
SELECT rowid, message_id, subject, body_text,
       from_addresses, to_addresses, cc_addresses
  FROM emails;

-- 6. Recreate the three triggers (v3/v4 versions).
CREATE TRIGGER IF NOT EXISTS emails_fts_insert AFTER INSERT ON emails BEGIN
  INSERT INTO emails_fts (rowid, message_id, subject, body_text,
                          from_addresses, to_addresses, cc_addresses)
  VALUES (new.rowid, new.message_id, new.subject, new.body_text,
          new.from_addresses, new.to_addresses, new.cc_addresses);
END;

CREATE TRIGGER IF NOT EXISTS emails_fts_delete AFTER DELETE ON emails BEGIN
  INSERT INTO emails_fts (emails_fts, rowid, message_id, subject, body_text,
                          from_addresses, to_addresses, cc_addresses)
  VALUES ('delete', old.rowid, old.message_id, old.subject, old.body_text,
          old.from_addresses, old.to_addresses, old.cc_addresses);
END;

CREATE TRIGGER IF NOT EXISTS emails_fts_update AFTER UPDATE ON emails BEGIN
  INSERT INTO emails_fts (emails_fts, rowid, message_id, subject, body_text,
                          from_addresses, to_addresses, cc_addresses)
  VALUES ('delete', old.rowid, old.message_id, old.subject, old.body_text,
          old.from_addresses, old.to_addresses, old.cc_addresses);
  INSERT INTO emails_fts (rowid, message_id, subject, body_text,
                          from_addresses, to_addresses, cc_addresses)
  VALUES (new.rowid, new.message_id, new.subject, new.body_text,
          new.from_addresses, new.to_addresses, new.cc_addresses);
END;
`;
