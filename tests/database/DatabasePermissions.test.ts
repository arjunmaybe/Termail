/**
 * Database file-permission tests (owner-only on POSIX).
 *
 * Strict mode assertions are POSIX-only and skipped on Windows, where
 * Node's mode bits do not map to ACLs. A platform-independent test
 * verifies initialization still works everywhere.
 */

import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConfigStore, resetConfigStore } from '../../src/core/config/ConfigStore.js';
import { getDatabase, resetDatabase } from '../../src/core/database/Database.js';
import { hardenDatabaseFiles } from '../../src/core/utils/filePermissions.js';

const isPosix = process.platform !== 'win32';
const itPosix = isPosix ? it : it.skip;
const modeOf = (p: string): number => statSync(p).mode & 0o777;

describe('Database file permissions', () => {
  let root: string;
  let dbPath: string;
  let configPath: string;

  beforeEach(() => {
    resetDatabase();
    resetConfigStore();
    root = join(tmpdir(), `termail-dbperm-${Date.now()}-${Math.random()}`);
    dbPath = join(root, 'db.sqlite');
    configPath = join(root, 'config.json');
  });

  afterEach(() => {
    resetDatabase();
    resetConfigStore();
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  async function initDbAtPath() {
    const store = getConfigStore(configPath);
    await store.initialize();
    await store.updateConfig({ database: { path: dbPath } });
    const db = getDatabase(store.getConfig());
    await db.initialize();
    return db;
  }

  itPosix('creates the database directory and file with owner-only permissions', async () => {
    await initDbAtPath();
    // Only the Termail-created leaf is asserted; shared parents (tmpdir) are untouched.
    expect(modeOf(root)).toBe(0o700);
    expect(modeOf(dbPath)).toBe(0o600);
  });

  itPosix('hardens a pre-existing world-readable database file', async () => {
    const db = await initDbAtPath();
    db.close();
    resetDatabase();
    resetConfigStore();

    chmodSync(dbPath, 0o644);
    expect(modeOf(dbPath)).toBe(0o644);

    // Reopen the SAME config/database files created above (not defaults).
    const store = getConfigStore(configPath);
    await store.initialize();
    expect(store.getConfig().database.path).toBe(dbPath);
    const reopened = getDatabase(store.getConfig());
    expect(reopened.getPath()).toBe(dbPath);
    await reopened.initialize();
    expect(modeOf(dbPath)).toBe(0o600);
  });

  itPosix('hardenDatabaseFiles chmods existing sidecars and ignores missing ones', async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(dbPath, 'db-bytes');
    chmodSync(dbPath, 0o644);
    const wal = `${dbPath}-wal`;
    const shm = `${dbPath}-shm`;
    writeFileSync(wal, 'wal-bytes', { mode: 0o644 });
    chmodSync(wal, 0o644);

    // Main and -wal exist, -shm is absent: must not throw (-shm ignored).
    hardenDatabaseFiles(dbPath);
    expect(modeOf(dbPath)).toBe(0o600);
    expect(modeOf(wal)).toBe(0o600);
    expect(existsSync(shm)).toBe(false);
  });

  itPosix('hardenDatabaseFiles throws when the main database file is missing', () => {
    mkdirSync(root, { recursive: true });
    expect(existsSync(dbPath)).toBe(false);
    expect(() => hardenDatabaseFiles(dbPath)).toThrow();
  });

  itPosix('hardens SQLite sidecars present after initialize, when they exist', async () => {
    await initDbAtPath();
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${dbPath}${suffix}`;
      if (existsSync(sidecar)) {
        expect(modeOf(sidecar)).toBe(0o600);
      }
    }
  });

  it('initializes regardless of platform permission support', async () => {
    const db = await initDbAtPath();
    expect(db.isInitialized()).toBe(true);
    expect(existsSync(dbPath)).toBe(true);
  });
});
