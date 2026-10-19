/**
 * v6 migration safety tests.
 *
 * v6 is additive: it only adds `uid_validity` and `uid_validity_observed`
 * to `folder_sync_state`. These tests build a genuine v5 database with the
 * real migration chain, seed sync-state and email rows, then open the file
 * through the real `Database` class so v6 runs. Everything uses isolated
 * temp files.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getConfigStore, resetConfigStore } from '../../src/core/config/ConfigStore.js';
import { getDatabase, resetDatabase } from '../../src/core/database/Database.js';
import { getMigrations, setVersion } from '../../src/core/database/migrations.js';
import { SCHEMA_VERSION } from '../../src/core/database/schema.js';
import type { AppConfig } from '../../src/core/types/config.js';

type SqlValue = string | number | null;

interface TableInfoRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

describe('v6 migration', () => {
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

  it('migrates a genuine v5 database additively without touching email rows or FTS', async () => {
    const v5Path = join(tmpdir(), `termail-v5-${Date.now()}-${Math.random()}.sqlite`);
    const configPath = join(tmpdir(), `termail-v5-cfg-${Date.now()}-${Math.random()}.json`);
    paths.push(v5Path, configPath);

    // Build a real v5 database using the historical migrations only.
    const { Database: BunDb } = await import('bun:sqlite');
    const raw = new BunDb(v5Path);
    raw.exec('PRAGMA foreign_keys = ON');
    for (const migration of getMigrations().filter((m) => m.version <= 5)) {
      migration.up(raw);
      setVersion(raw, migration.version);
    }

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
         id, account_id, folder_id, message_id, subject, date, body_text, uid
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insertEmail.run(
      'inbox-1',
      'work',
      'work:INBOX',
      '<a@example.com>',
      'Generation A inbox',
      1_700_000_000,
      'inbox body',
      10
    );
    insertEmail.run(
      'sent-1',
      'work',
      'work:Sent',
      '<b@example.com>',
      'Generation A sent',
      1_700_000_010,
      'sent body',
      11
    );

    // Two pre-existing checkpoints: one success, one error. v6 must leave
    // both generation-unobserved (legacy) and preserve their other fields.
    raw
      .query(
        `INSERT INTO folder_sync_state
           (account_id, folder_id, highest_uid, last_sync_at,
            last_sync_status, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('work', 'work:INBOX', 42, 1_700_000_100, 'ok', null, 1_700_000_000, 1_700_000_100);
    raw
      .query(
        `INSERT INTO folder_sync_state
           (account_id, folder_id, highest_uid, last_sync_at,
            last_sync_status, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'work',
        'work:Sent',
        7,
        1_700_000_200,
        'error',
        'previous failure',
        1_700_000_000,
        1_700_000_200
      );

    const beforeRows = raw.query('SELECT rowid AS rid, * FROM emails ORDER BY id').all() as Array<
      Record<string, SqlValue>
    >;
    const beforeFts = raw
      .query('SELECT rowid, message_id, subject, body_text FROM emails_fts ORDER BY rowid')
      .all() as Array<Record<string, SqlValue>>;
    expect(beforeRows).toHaveLength(2);
    expect(beforeFts).toHaveLength(2);
    raw.close();

    // Open through the real runner so v6 is applied in its normal transaction.
    const store = getConfigStore(configPath);
    await store.initialize();
    await store.updateConfig({ database: { path: v5Path } } as Partial<AppConfig>);
    const db = getDatabase(store.getConfig());
    await db.initialize();

    const version = db.query('SELECT version FROM schema_version').get() as { version: number };
    expect(version.version).toBe(SCHEMA_VERSION);
    expect(version.version).toBe(6);

    expect(db.query('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);

    // Existing emails (and their rowids) are untouched.
    const afterRows = db.query('SELECT rowid AS rid, * FROM emails ORDER BY id').all() as Array<
      Record<string, SqlValue>
    >;
    expect(afterRows).toEqual(beforeRows);

    // The FTS index is untouched and still queryable via MATCH.
    const afterFts = db
      .query('SELECT rowid, message_id, subject, body_text FROM emails_fts ORDER BY rowid')
      .all() as Array<Record<string, SqlValue>>;
    expect(afterFts).toEqual(beforeFts);
    const hits = db
      .query('SELECT subject FROM emails_fts WHERE emails_fts MATCH ?')
      .all('Generation') as { subject: string }[];
    expect(hits.map((row) => row.subject).sort()).toEqual([
      'Generation A inbox',
      'Generation A sent',
    ]);

    // New columns exist with the documented nullability/default.
    const columns = db
      .query(`PRAGMA table_info('folder_sync_state')`)
      .all() as unknown as TableInfoRow[];
    const uidValidity = columns.find((column) => column.name === 'uid_validity');
    const observed = columns.find((column) => column.name === 'uid_validity_observed');
    expect(uidValidity?.type).toBe('TEXT');
    expect(uidValidity?.notnull).toBe(0);
    expect(observed?.type).toBe('INTEGER');
    expect(observed?.notnull).toBe(1);
    expect(observed?.dflt_value).toBe('0');

    // Pre-existing rows are legacy: unobserved, null generation, and every
    // other field is preserved verbatim.
    const states = db
      .query(
        `SELECT account_id, folder_id, highest_uid, last_sync_status,
                last_error, uid_validity, uid_validity_observed
           FROM folder_sync_state
          ORDER BY folder_id`
      )
      .all() as Array<{
      account_id: string;
      folder_id: string;
      highest_uid: number;
      last_sync_status: string;
      last_error: string | null;
      uid_validity: string | null;
      uid_validity_observed: number;
    }>;
    expect(states).toEqual([
      {
        account_id: 'work',
        folder_id: 'work:INBOX',
        highest_uid: 42,
        last_sync_status: 'ok',
        last_error: null,
        uid_validity: null,
        uid_validity_observed: 0,
      },
      {
        account_id: 'work',
        folder_id: 'work:Sent',
        highest_uid: 7,
        last_sync_status: 'error',
        last_error: 'previous failure',
        uid_validity: null,
        uid_validity_observed: 0,
      },
    ]);
  });

  it('migrates a fresh database through v1 → v6 with the generation defaults', async () => {
    const freshPath = join(tmpdir(), `termail-v6-fresh-${Date.now()}-${Math.random()}.sqlite`);
    const configPath = join(tmpdir(), `termail-v6-fresh-cfg-${Date.now()}-${Math.random()}.json`);
    paths.push(freshPath, configPath);

    const store = getConfigStore(configPath);
    await store.initialize();
    await store.updateConfig({ database: { path: freshPath } } as Partial<AppConfig>);
    const db = getDatabase(store.getConfig());
    await db.initialize();

    const version = db.query('SELECT version FROM schema_version').get() as { version: number };
    expect(version.version).toBe(SCHEMA_VERSION);
    expect(version.version).toBe(6);

    const columns = db
      .query(`PRAGMA table_info('folder_sync_state')`)
      .all() as unknown as TableInfoRow[];
    expect(columns.map((column) => column.name)).toContain('uid_validity');
    expect(columns.map((column) => column.name)).toContain('uid_validity_observed');

    // A fresh row inserted without the new columns gets the safe defaults.
    db.exec(`
      INSERT INTO accounts (id, name, type, email, use_tls, auth_type)
      VALUES ('work', 'Work', 'imap', 'me@example.com', 1, 'password');
      INSERT INTO folders (id, account_id, name, full_name, type, delimiter)
      VALUES ('work:INBOX', 'work', 'INBOX', 'INBOX', 'inbox', '/');
      INSERT INTO folder_sync_state (account_id, folder_id, highest_uid)
      VALUES ('work', 'work:INBOX', 3);
    `);
    const state = db
      .query(
        `SELECT uid_validity, uid_validity_observed FROM folder_sync_state
          WHERE account_id = 'work' AND folder_id = 'work:INBOX'`
      )
      .get() as { uid_validity: string | null; uid_validity_observed: number };
    expect(state.uid_validity).toBeNull();
    expect(state.uid_validity_observed).toBe(0);

    // An explicit observation round-trips as the exact decimal string.
    db.query(
      `UPDATE folder_sync_state
          SET uid_validity = ?, uid_validity_observed = 1
        WHERE account_id = 'work' AND folder_id = 'work:INBOX'`
    ).run('18446744073709551615');
    const observed = db
      .query(
        `SELECT uid_validity, uid_validity_observed FROM folder_sync_state
          WHERE account_id = 'work' AND folder_id = 'work:INBOX'`
      )
      .get() as { uid_validity: string | null; uid_validity_observed: number };
    expect(observed).toEqual({
      uid_validity: '18446744073709551615',
      uid_validity_observed: 1,
    });
  });
});
