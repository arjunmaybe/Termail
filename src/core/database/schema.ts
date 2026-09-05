/**
 * Database schema DDL statements.
 *
 * The DDL is split by migration version. `CREATE_TABLES_V1_SQL` is the
 * Phase 1 baseline (accounts, folders, emails, FTS5, triggers, version
 * table). The legacy `CREATE_TABLES_SQL` export is preserved as a
 * re-export of the v1 DDL so any external imports continue to work.
 *
 * v2 lives in `migrations/v2.sql.ts` and is applied by an additive
 * migration entry in `migrations.ts`. v2 only adds new columns on
 * `emails`, a new `folder_sync_state` table, and new indexes — it
 * does NOT rebuild `emails` and does NOT change the FTS5 triggers.
 */

export const SCHEMA_VERSION = 2;

export const CREATE_TABLES_V1_SQL = `
-- Accounts table
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('imap', 'local')),
  email TEXT NOT NULL,
  host TEXT,
  port INTEGER,
  username TEXT,
  password TEXT,
  use_tls INTEGER NOT NULL DEFAULT 1,
  auth_type TEXT NOT NULL DEFAULT 'password' CHECK (auth_type IN ('password', 'oauth2')),
  oauth_client_id TEXT,
  oauth_client_secret TEXT,
  oauth_refresh_token TEXT,
  oauth_token_url TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Folders table
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('inbox', 'sent', 'drafts', 'archive', 'trash', 'spam', 'starred', 'important', 'custom')),
  parent_id TEXT,
  delimiter TEXT NOT NULL DEFAULT '/',
  attributes TEXT NOT NULL DEFAULT '[]',
  unread_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_folders_account ON folders(account_id);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);

-- Emails table
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
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
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
  UNIQUE (account_id, folder_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_emails_account ON emails(account_id);
CREATE INDEX IF NOT EXISTS idx_emails_folder ON emails(folder_id);
CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date DESC);
CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
CREATE INDEX IF NOT EXISTS idx_emails_read ON emails(is_read);
CREATE INDEX IF NOT EXISTS idx_emails_flagged ON emails(is_flagged);

-- FTS5 virtual table for full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
  message_id UNINDEXED,
  subject,
  body_text,
  from_addresses,
  to_addresses,
  content='emails',
  content_rowid='rowid'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS emails_fts_insert AFTER INSERT ON emails BEGIN
  INSERT INTO emails_fts (rowid, message_id, subject, body_text, from_addresses, to_addresses)
  VALUES (new.rowid, new.message_id, new.subject, new.body_text, new.from_addresses, new.to_addresses);
END;

CREATE TRIGGER IF NOT EXISTS emails_fts_delete AFTER DELETE ON emails BEGIN
  INSERT INTO emails_fts (emails_fts, rowid, message_id, subject, body_text, from_addresses, to_addresses)
  VALUES ('delete', old.rowid, old.message_id, old.subject, old.body_text, old.from_addresses, old.to_addresses);
END;

CREATE TRIGGER IF NOT EXISTS emails_fts_update AFTER UPDATE ON emails BEGIN
  INSERT INTO emails_fts (emails_fts, rowid, message_id, subject, body_text, from_addresses, to_addresses)
  VALUES ('delete', old.rowid, old.message_id, old.subject, old.body_text, old.from_addresses, old.to_addresses);
  INSERT INTO emails_fts (rowid, message_id, subject, body_text, from_addresses, to_addresses)
  VALUES (new.rowid, new.message_id, new.subject, new.body_text, new.from_addresses, new.to_addresses);
END;

-- Schema version table
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
`;

/**
 * Legacy export. Kept as a re-export of the v1 DDL so callers that
 * import `CREATE_TABLES_SQL` still see the v1 baseline (which is what
 * they expect — it has not changed).
 */
export const CREATE_TABLES_SQL = CREATE_TABLES_V1_SQL;

export const DROP_TABLES_SQL = `
DROP TABLE IF EXISTS emails_fts;
DROP TABLE IF EXISTS emails;
DROP TABLE IF EXISTS folders;
DROP TABLE IF EXISTS accounts;
DROP TABLE IF EXISTS schema_version;
`;
