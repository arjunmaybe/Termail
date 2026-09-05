/**
 * Database tests
 */

import { existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConfigStore, resetConfigStore } from '../../src/core/config/ConfigStore.js';
import { getDatabase, resetDatabase } from '../../src/core/database/Database.js';

describe('Database', () => {
  let testDbPath: string;
  let testConfigPath: string;
  let configStore: ReturnType<typeof getConfigStore>;
  let db: ReturnType<typeof getDatabase>;

  beforeEach(async () => {
    resetDatabase();
    resetConfigStore();

    testConfigPath = join(tmpdir(), `termail-test-${Date.now()}-config.json`);
    testDbPath = join(tmpdir(), `termail-test-${Date.now()}.sqlite`);

    configStore = getConfigStore(testConfigPath);
    await configStore.initialize();

    // Update config to use test database
    await configStore.updateConfig({
      database: { path: testDbPath },
    });

    const config = configStore.getConfig();
    db = getDatabase(config);
    await db.initialize();
  });

  afterEach(() => {
    resetDatabase();
    resetConfigStore();
    if (existsSync(testDbPath)) {
      rmSync(testDbPath);
    }
    if (existsSync(`${testDbPath}-wal`)) {
      rmSync(`${testDbPath}-wal`);
    }
    if (existsSync(`${testDbPath}-shm`)) {
      rmSync(`${testDbPath}-shm`);
    }
    if (existsSync(testConfigPath)) {
      rmSync(testConfigPath);
    }
  });

  it('should initialize and create tables', async () => {
    const instance = db.getInstance();

    // Check tables exist
    const tables = instance
      .query(`
      SELECT name FROM sqlite_master WHERE type='table'
    `)
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('accounts');
    expect(tableNames).toContain('folders');
    expect(tableNames).toContain('emails');
    expect(tableNames).toContain('emails_fts');
    expect(tableNames).toContain('schema_version');
  });

  it('should have correct schema version', async () => {
    const instance = db.getInstance();
    const version = instance.query('SELECT version FROM schema_version').get() as
      | { version: number }
      | undefined;
    expect(version?.version).toBe(2);
  });

  it('should support CRUD operations on accounts', async () => {
    const instance = db.getInstance();

    // Insert
    instance.exec(`
      INSERT INTO accounts (id, name, type, email, use_tls, auth_type)
      VALUES ('acc1', 'Test Account', 'imap', 'test@example.com', 1, 'password')
    `);

    // Query
    const account = instance.query('SELECT * FROM accounts WHERE id = ?').get('acc1') as any;
    expect(account).toBeDefined();
    expect(account.name).toBe('Test Account');
    expect(account.email).toBe('test@example.com');
  });

  it('should support CRUD operations on folders', async () => {
    const instance = db.getInstance();

    // Insert account first
    instance.exec(`
      INSERT INTO accounts (id, name, type, email, use_tls, auth_type)
      VALUES ('acc1', 'Test Account', 'imap', 'test@example.com', 1, 'password')
    `);

    // Insert folder
    instance.exec(`
      INSERT INTO folders (id, account_id, name, full_name, type, delimiter)
      VALUES ('folder1', 'acc1', 'Inbox', 'Inbox', 'inbox', '/')
    `);

    const folder = instance.query('SELECT * FROM folders WHERE id = ?').get('folder1') as any;
    expect(folder).toBeDefined();
    expect(folder.name).toBe('Inbox');
    expect(folder.type).toBe('inbox');
  });

  it('should support CRUD operations on emails', async () => {
    const instance = db.getInstance();

    // Insert account and folder
    instance.exec(`
      INSERT INTO accounts (id, name, type, email, use_tls, auth_type)
      VALUES ('acc1', 'Test Account', 'imap', 'test@example.com', 1, 'password')
    `);

    instance.exec(`
      INSERT INTO folders (id, account_id, name, full_name, type, delimiter)
      VALUES ('folder1', 'acc1', 'Inbox', 'Inbox', 'inbox', '/')
    `);

    // Insert email
    instance.exec(`
      INSERT INTO emails (id, account_id, folder_id, message_id, from_addresses, to_addresses, subject, date, is_read, is_flagged, size)
      VALUES ('email1', 'acc1', 'folder1', '<msg1@example.com>', '[]', '[]', 'Test Subject', ${Date.now()}, 0, 0, 1024)
    `);

    const email = instance.query('SELECT * FROM emails WHERE id = ?').get('email1') as any;
    expect(email).toBeDefined();
    expect(email.subject).toBe('Test Subject');
    expect(email.is_read).toBe(0);
  });

  it('should support FTS5 search', async () => {
    const instance = db.getInstance();

    // Insert test data
    instance.exec(`
      INSERT INTO accounts (id, name, type, email, use_tls, auth_type)
      VALUES ('acc1', 'Test Account', 'imap', 'test@example.com', 1, 'password')
    `);

    instance.exec(`
      INSERT INTO folders (id, account_id, name, full_name, type, delimiter)
      VALUES ('folder1', 'acc1', 'Inbox', 'Inbox', 'inbox', '/')
    `);

    instance.exec(`
      INSERT INTO emails (id, account_id, folder_id, message_id, from_addresses, to_addresses, subject, body_text, date, size)
      VALUES
        ('email1', 'acc1', 'folder1', '<msg1@example.com>', '[]', '[]', 'Hello World', 'This is a test email', ${Date.now()}, 100),
        ('email2', 'acc1', 'folder1', '<msg2@example.com>', '[]', '[]', 'Meeting Tomorrow', 'Do not forget the meeting', ${Date.now()}, 200)
    `);

    // Search
    const results = instance
      .query(`
      SELECT e.* FROM emails e
      JOIN emails_fts f ON e.rowid = f.rowid
      WHERE emails_fts MATCH ?
    `)
      .all('test') as any[];

    expect(results).toHaveLength(1);
    expect(results[0].subject).toBe('Hello World');
  });

  it('should support transactions', async () => {
    const instance = db.getInstance();

    // bun:sqlite's `db.transaction(fn)` returns a wrapped function that must
    // be invoked to actually run; the Database wrapper invokes it for us.
    db.transaction(() => {
      instance.exec(`
        INSERT INTO accounts (id, name, type, email, use_tls, auth_type)
        VALUES ('acc1', 'Test Account', 'imap', 'test@example.com', 1, 'password')
      `);
      instance.exec(`
        INSERT INTO accounts (id, name, type, email, use_tls, auth_type)
        VALUES ('acc2', 'Test Account 2', 'imap', 'test2@example.com', 1, 'password')
      `);
    });

    const count = instance.query('SELECT COUNT(*) as c FROM accounts').get() as { c: number };
    expect(count.c).toBe(2);
  });
});
