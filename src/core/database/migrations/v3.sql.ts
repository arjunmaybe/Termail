/**
 * Phase 3.1 — v3 migration: add `cc_addresses` to the FTS5 index.
 *
 * Background:
 *   The Phase 1 FTS5 virtual table `emails_fts` (defined in
 *   `schema.ts`) indexes `subject`, `body_text`, `from_addresses`,
 *   and `to_addresses` only. The Phase 3.1 search backend must
 *   support searching the CC field, but SQLite FTS5 column lists
 *   are part of the virtual table's schema and cannot be modified
 *   in place — the table must be dropped and recreated, and the
 *   index must be re-populated from the source `emails` table.
 *
 * What this migration does (in order):
 *   1. Drop the three FTS5 triggers (`emails_fts_insert`,
 *      `emails_fts_delete`, `emails_fts_update`). Dropping the
 *      triggers first is required because they reference the
 *      FTS5 column list explicitly; leaving them in place while
 *      dropping the virtual table is unsupported.
 *   2. Drop the `emails_fts` virtual table. The trigger
 *      definitions are removed as a side effect of `DROP TABLE`
 *      on the virtual table, but we drop them explicitly above
 *      to make the ordering obvious and to keep the v2→v3
 *      migration self-contained.
 *   3. Recreate `emails_fts` with the SAME five v1 columns plus
 *      the new `cc_addresses` column. External-content linkage
 *      (`content='emails'`, `content_rowid='rowid'`) is
 *      preserved so reads still join to the source `emails` row
 *      for non-FTS columns.
 *   4. Re-populate the FTS index from the current `emails`
 *      table. Every existing email row gets one FTS row.
 *   5. Recreate the three triggers, now with `cc_addresses`
 *      included in the column list.
 *
 * Safety:
 *   - This migration is destructive to the FTS5 index but
 *     NON-destructive to user data. No row in `emails` is
 *     modified, deleted, or duplicated.
 *   - It is forward-only: there is no `down` direction because
 *     dropping the new `cc_addresses` FTS column would require
 *     another full FTS5 rebuild. Rollback to a pre-v3 state
 *     therefore means creating a fresh database.
 *
 * FTS5 query syntax (Phase 3.1 contract):
 *   - The standard unicode61 tokenizer splits tokens on
 *     whitespace, punctuation, and characters such as `@`,
 *     `*`, `:`, `(`, `)`. A user searching for
 *     `alice@example.com` will find a row whose FTS5 column
 *     contains that string, because each of `alice`, `example`,
 *     `com` is an indexed token and FTS5 implicit-AND joins
 *     them. Exact phrase matching requires quoting with
 *     `"…"`. The repository layer tokenizes and sanitizes
 *     user input before binding it as the MATCH operand.
 */

export const MIGRATION_V3_UP_SQL = `
-- 1. Drop the old FTS5 triggers. They reference the FTS5
--    column list explicitly; recreating the FTS5 table without
--    dropping them first leaves the schema in an inconsistent
--    state. Re-created in step 5 below.
DROP TRIGGER IF EXISTS emails_fts_insert;
DROP TRIGGER IF EXISTS emails_fts_delete;
DROP TRIGGER IF EXISTS emails_fts_update;

-- 2. Drop the FTS5 virtual table. The v2 schema does not change
--    emails; only the FTS5 index is rebuilt.
DROP TABLE IF EXISTS emails_fts;

-- 3. Recreate emails_fts with cc_addresses added to the
--    indexed columns. The external-content linkage and the
--    message_id UNINDEXED column are preserved so callers
--    can still select message_id without scoring it.
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

-- 4. Re-populate the FTS5 index from the source emails
--    table. Every existing email becomes one FTS row.
INSERT INTO emails_fts (rowid, message_id, subject, body_text,
                        from_addresses, to_addresses, cc_addresses)
SELECT rowid, message_id, subject, body_text,
       from_addresses, to_addresses, cc_addresses
  FROM emails;

-- 5. Re-create the three triggers. The new triggers include
--    cc_addresses so future INSERT / UPDATE / DELETE
--    operations on emails keep the FTS5 index consistent.
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
