/**
 * Phase post-audit — v4 migration: allow multiple messages with a missing
 * Message-ID in the same folder.
 *
 * Background:
 *   The authoritative synchronization identity is
 *   `(account_id, folder_id, uid)` (unique index
 *   `uq_emails_account_folder_uid`, added in v2). The v1 table constraint
 *   `UNIQUE (account_id, folder_id, message_id)` is retained as a
 *   defense-in-depth index for non-empty Message-IDs, but it incorrectly
 *   rejects two legitimate messages that both lack a Message-ID: the
 *   parser normalizes a missing Message-ID to `''`, so two rows collide
 *   on `(account, folder, '')`.
 *
 * What this migration does (in order):
 *   1. Drop the three FTS5 triggers and the `emails_fts` virtual table
 *      (same ordering as v3 — triggers reference the FTS column list).
 *   2. Rebuild `emails` with `message_id TEXT` (nullable, no `NOT NULL`)
 *      while preserving every other column, FK, and the legacy
 *      `UNIQUE (account_id, folder_id, message_id)` constraint. SQLite
 *      treats NULLs as distinct in a UNIQUE constraint, so rows with a
 *      missing Message-ID (stored as NULL going forward) no longer
 *      collide, while duplicate non-empty Message-IDs are still
 *      rejected as before.
 *   3. Copy existing rows, converting legacy `''` to `NULL`. At most one
 *      `''` per `(account, folder)` can exist today (a second would have
 *      been rejected), so the conversion cannot introduce a new
 *      collision. `rowid` values are preserved so any external rowid
 *      references stay stable.
 *   4. Recreate all v1/v2 indexes.
 *   5. Recreate `emails_fts` (v3 column list with `cc_addresses`) and
 *      repopulate it from `emails`.
 *   6. Recreate the three FTS5 triggers (v3 versions with
 *      `cc_addresses`).
 *
 * Safety:
 *   - NON-destructive to user data. Every `emails` row survives with
 *     identical values except `message_id = ''` becoming `NULL`
 *     (which the repository reads back as `''`).
 *   - Forward-only like v3: no `down` (reverting would require another
 *     full rebuild).
 */

export const MIGRATION_V4_UP_SQL = `
-- 1. Drop FTS triggers + virtual table (v3 ordering).
DROP TRIGGER IF EXISTS emails_fts_insert;
DROP TRIGGER IF EXISTS emails_fts_delete;
DROP TRIGGER IF EXISTS emails_fts_update;
DROP TABLE IF EXISTS emails_fts;

-- 2. Rebuild emails with message_id nullable. All other columns,
--    FKs, defaults, and the legacy UNIQUE are preserved verbatim
--    except the NOT NULL on message_id.
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
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
  UNIQUE (account_id, folder_id, message_id)
);

-- 3. Copy rows, normalizing legacy '' to NULL. rowid is preserved.
INSERT INTO emails_new (
  rowid, id, account_id, folder_id, message_id,
  from_addresses, to_addresses, cc_addresses, subject, date,
  is_read, is_flagged, has_attachments, size,
  body_text, body_html, headers, attachments,
  created_at, updated_at,
  uid, internal_date, received_at, is_answered, is_draft, flags
)
SELECT
  rowid, id, account_id, folder_id,
  CASE WHEN message_id = '' THEN NULL ELSE message_id END,
  from_addresses, to_addresses, cc_addresses, subject, date,
  is_read, is_flagged, has_attachments, size,
  body_text, body_html, headers, attachments,
  created_at, updated_at,
  uid, internal_date, received_at, is_answered, is_draft, flags
FROM emails;

DROP TABLE emails;
ALTER TABLE emails_new RENAME TO emails;

-- 4. Recreate v1 + v2 indexes (dropping is unnecessary: DROP TABLE
--    already removed the old auto/indexes with the old table).
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

-- 5. Recreate emails_fts (v3 column list) and repopulate.
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

-- 6. Recreate the three triggers (v3 versions).
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
