/**
 * v5 migration safety tests.
 *
 * Builds a genuine v4 database with the real migration chain, seeds rows
 * with stable ids/rowids/timestamps, then opens the file through the real
 * `Database` class so v5 runs. Everything uses isolated temp files.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getConfigStore, resetConfigStore } from '../../src/core/config/ConfigStore.js';
import { getDatabase, resetDatabase } from '../../src/core/database/Database.js';
import { getMigrations, setVersion } from '../../src/core/database/migrations.js';
import type { AppConfig } from '../../src/core/types/config.js';

type SqlValue = string | number | null;

interface IndexListRow {
  name: string;
  unique: number;
  origin: string;
}

function indexColumns(db: ReturnType<typeof getDatabase>, indexName: string): string[] {
  return (db.query(`PRAGMA index_info('${indexName}')`).all() as Array<{ name: string }>).map(
    (row) => row.name
  );
}

describe('v5 migration', () => {
  const paths: string[] = [];

  afterEach(() => {
    resetDatabase();
    resetConfigStore();
    for (const path of paths.splice(0)) {
      for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
        if (existsSync(candidate)) rmSync(candidate);
      }
    }
  });

  it('migrates a genuine v4 database to v5 without changing rows or FTS state', async () => {
    const v4Path = join(tmpdir(), `termail-v4-${Date.now()}-${Math.random()}.sqlite`);
    const configPath = join(tmpdir(), `termail-v4-cfg-${Date.now()}-${Math.random()}.json`);
    paths.push(v4Path, configPath);

    // Build a real v4 database using the historical migrations only.
    const { Database: BunDb } = await import('bun:sqlite');
    const raw = new BunDb(v4Path);
    raw.exec('PRAGMA foreign_keys = ON');
    for (const migration of getMigrations().filter((m) => m.version <= 4)) {
      migration.up(raw);
      setVersion(raw, migration.version);
    }

    // There must be a real unique Message-ID autoindex before migrating.
    const v4Indexes = raw.query(`PRAGMA index_list('emails')`).all() as IndexListRow[];
    const v4MessageUnique = v4Indexes
      .filter((index) => index.unique === 1)
      .find(
        (index) =>
          indexColumnsByRaw(raw, index.name).join(',') === 'account_id,folder_id,message_id'
      );
    expect(v4MessageUnique).toBeDefined();
    expect(v4MessageUnique?.origin).toBe('u');

    const sharedMessageId = '<shared@example.com>';
    raw
      .query(
        `INSERT INTO accounts (id, name, type, email, use_tls, auth_type)
         VALUES (?, ?, 'imap', ?, 1, 'password')`
      )
      .run('work', 'Work', 'me@example.com');
    raw
      .query(
        `INSERT INTO folders (id, account_id, name, full_name, type, delimiter)
         VALUES (?, ?, 'INBOX', 'INBOX', 'inbox', '/')`
      )
      .run('work:INBOX', 'work');
    raw
      .query(
        `INSERT INTO folders (id, account_id, name, full_name, type, delimiter)
         VALUES (?, ?, 'Sent', 'Sent', 'sent', '/')`
      )
      .run('work:Sent', 'work');

    const insertEmail = raw.query(
      `INSERT INTO emails (
         id, account_id, folder_id, message_id,
         from_addresses, to_addresses, cc_addresses, subject, date,
         is_read, is_flagged, is_answered, is_draft, has_attachments,
         size, body_text, body_html, headers, attachments, flags,
         uid, internal_date, received_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const address = JSON.stringify([{ name: 'Alice', address: 'alice@example.com' }]);
    const headers = JSON.stringify({ 'x-test': 'yes' });
    const attachments = JSON.stringify([
      { filename: 'a.txt', contentType: 'text/plain', size: 3, disposition: 'attachment' },
    ]);
    insertEmail.run(
      'legacy-inbox',
      'work',
      'work:INBOX',
      sharedMessageId,
      address,
      address,
      '[]',
      'Legacy inbox',
      1_700_000_000,
      1,
      1,
      0,
      0,
      1,
      123,
      'legacy body',
      '<p>legacy html</p>',
      headers,
      attachments,
      '["\\\\Seen","\\\\Flagged"]',
      10,
      1_700_000_001,
      1_700_000_002,
      1_700_000_003,
      1_700_000_004
    );
    insertEmail.run(
      'legacy-sent',
      'work',
      'work:Sent',
      sharedMessageId,
      address,
      address,
      '[]',
      'Legacy sent',
      1_700_000_010,
      0,
      0,
      0,
      0,
      0,
      456,
      'sent body',
      null,
      '{}',
      '[]',
      '[]',
      10,
      null,
      null,
      1_700_000_011,
      1_700_000_012
    );
    insertEmail.run(
      'legacy-null-id',
      'work',
      'work:INBOX',
      null,
      '[]',
      '[]',
      '[]',
      'Legacy missing id',
      1_700_000_020,
      0,
      0,
      0,
      0,
      0,
      0,
      null,
      null,
      '{}',
      '[]',
      '[]',
      null,
      null,
      null,
      1_700_000_021,
      1_700_000_022
    );

    const beforeRows = raw.query('SELECT rowid AS rid, * FROM emails ORDER BY id').all() as Array<
      Record<string, SqlValue>
    >;
    const beforeFts = raw
      .query('SELECT rowid, message_id, subject, body_text FROM emails_fts ORDER BY rowid')
      .all() as Array<Record<string, SqlValue>>;
    expect(beforeRows).toHaveLength(3);
    expect(beforeFts).toHaveLength(3);

    // v4 rejects a same-folder duplicate Message-ID.
    expect(() =>
      raw
        .query(
          `INSERT INTO emails (id, account_id, folder_id, message_id, subject, date, uid)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run('would-collide', 'work', 'work:INBOX', sharedMessageId, 'Collision', 1, 11)
    ).toThrow();
    raw.close();

    // Open through the real runner so v5 is applied in its normal transaction.
    const store = getConfigStore(configPath);
    await store.initialize();
    await store.updateConfig({ database: { path: v4Path } } as Partial<AppConfig>);
    const db = getDatabase(store.getConfig());
    await db.initialize();

    const version = db.query('SELECT version FROM schema_version').get() as { version: number };
    expect(version.version).toBe(5);

    expect(db.query('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);

    const afterRows = db.query('SELECT rowid AS rid, * FROM emails ORDER BY id').all() as Array<
      Record<string, SqlValue>
    >;
    expect(afterRows).toEqual(beforeRows);

    const afterFts = db
      .query('SELECT rowid, message_id, subject, body_text FROM emails_fts ORDER BY rowid')
      .all() as Array<Record<string, SqlValue>>;
    expect(afterFts).toEqual(beforeFts);

    // MATCH exercises the rebuilt FTS index itself. Selecting columns from
    // an external-content table would only read the `emails` content table.
    const legacyHits = db
      .query('SELECT subject FROM emails_fts WHERE emails_fts MATCH ?')
      .all('Legacy') as { subject: string }[];
    expect(legacyHits).toHaveLength(3);
    expect(legacyHits.map((row) => row.subject).sort()).toEqual([
      'Legacy inbox',
      'Legacy missing id',
      'Legacy sent',
    ]);

    // UID uniqueness remains; Message-ID uniqueness is gone.
    const indexes = db.query(`PRAGMA index_list('emails')`).all() as unknown as IndexListRow[];
    const uidIndex = indexes.find((index) => index.name === 'uq_emails_account_folder_uid');
    expect(uidIndex?.unique).toBe(1);
    const messageIndex = indexes.find((index) => index.name === 'idx_emails_message_id');
    expect(messageIndex?.unique).toBe(0);
    const messageUniques = indexes
      .filter((index) => index.unique === 1)
      .filter(
        (index) => indexColumns(db, index.name).join(',') === 'account_id,folder_id,message_id'
      );
    expect(messageUniques).toEqual([]);

    // All three FTS triggers survive.
    const triggers = db.query(`SELECT name FROM sqlite_master WHERE type='trigger'`).all() as {
      name: string;
    }[];
    expect(triggers.map((trigger) => trigger.name).sort()).toEqual([
      'emails_fts_delete',
      'emails_fts_insert',
      'emails_fts_update',
    ]);

    // Two distinct UIDs may now share a Message-ID in one folder.
    db.exec(`
      INSERT INTO emails (id, account_id, folder_id, message_id, subject, date, uid)
      VALUES ('dup-1', 'work', 'work:INBOX', '${sharedMessageId}', 'Duplicate one', 1, 20),
             ('dup-2', 'work', 'work:INBOX', '${sharedMessageId}', 'Duplicate two', 2, 21)
    `);
    const duplicates = db
      .query('SELECT id FROM emails WHERE message_id = ? ORDER BY id')
      .all(sharedMessageId) as { id: string }[];
    expect(duplicates.map((row) => row.id)).toEqual([
      'dup-1',
      'dup-2',
      'legacy-inbox',
      'legacy-sent',
    ]);

    // FTS insert trigger works for the duplicate rows.
    const duplicateHits = db
      .query('SELECT rowid FROM emails_fts WHERE emails_fts MATCH ? ORDER BY rowid')
      .all('Duplicate') as { rowid: number }[];
    expect(duplicateHits).toHaveLength(2);

    // FTS update/delete triggers still work after the rebuild.
    db.exec(`UPDATE emails SET subject = 'Changed subject' WHERE id = 'dup-1'`);
    expect(
      db.query('SELECT rowid FROM emails_fts WHERE emails_fts MATCH ?').all('Duplicate')
    ).toHaveLength(1);
    expect(
      db.query('SELECT rowid FROM emails_fts WHERE emails_fts MATCH ?').all('Changed')
    ).toHaveLength(1);

    db.exec(`DELETE FROM emails WHERE id = 'dup-1'`);
    expect(
      db.query('SELECT rowid FROM emails_fts WHERE emails_fts MATCH ?').all('Changed')
    ).toHaveLength(0);

    // A duplicate UID in the same folder is still rejected.
    expect(() =>
      db
        .query(
          `INSERT INTO emails (id, account_id, folder_id, message_id, subject, date, uid)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run('uid-collision', 'work', 'work:INBOX', '<other@example.com>', 'UID collision', 3, 10)
    ).toThrow();
  });
});

/** Read index columns through a raw bun:sqlite handle during setup. */
function indexColumnsByRaw(
  db: { query: (sql: string) => { all: () => unknown[] } },
  indexName: string
): string[] {
  return (db.query(`PRAGMA index_info('${indexName}')`).all() as Array<{ name: string }>).map(
    (row) => row.name
  );
}
