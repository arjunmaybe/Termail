/**
 * Tests for `MessageRepository.listFoldersForAccount` (Phase 2.5).
 *
 * Read-only. No schema change. No write path. Verifies that the method
 * returns the right rows in the Phase 2.2 deterministic order.
 */

import { existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConfigStore, resetConfigStore } from '../../src/core/config/ConfigStore.js';
import { getDatabase, resetDatabase } from '../../src/core/database/Database.js';
import { MessageRepository } from '../../src/core/database/MessageRepository.js';
import type { AppConfig } from '../../src/core/types/config.js';

describe('MessageRepository.listFoldersForAccount', () => {
  let testDbPath: string;
  let testConfigPath: string;
  let repo: MessageRepository;
  let db: ReturnType<typeof getDatabase>;

  beforeEach(async () => {
    resetDatabase();
    resetConfigStore();
    testConfigPath = join(tmpdir(), `termail-lfa-${Date.now()}-config.json`);
    testDbPath = join(tmpdir(), `termail-lfa-${Date.now()}.sqlite`);

    const configStore = getConfigStore(testConfigPath);
    await configStore.initialize();
    await configStore.updateConfig({ database: { path: testDbPath } } as Partial<AppConfig>);
    db = getDatabase(configStore.getConfig());
    await db.initialize();
    repo = new MessageRepository(db);

    // Seed an account row so the FK from folders → accounts is satisfied.
    db.query(
      `INSERT INTO accounts (id, name, type, email, use_tls, auth_type)
       VALUES (?, ?, 'imap', ?, 1, 'password')`
    ).run('acct', 'Acct', 'me@example.com');
  });

  afterEach(() => {
    resetDatabase();
    resetConfigStore();
    for (const p of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`, testConfigPath]) {
      if (existsSync(p)) rmSync(p);
    }
  });

  it('returns an empty list when the account has no folders', () => {
    expect(repo.listFoldersForAccount('acct')).toEqual([]);
  });

  it('returns an empty list for an unknown account id', () => {
    db.query(
      `INSERT INTO folders (id, account_id, name, full_name, type, delimiter)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('acct:INBOX', 'acct', 'INBOX', 'INBOX', 'inbox', '/');
    expect(repo.listFoldersForAccount('nobody')).toEqual([]);
  });

  it('orders folders by Phase 2.2 type precedence: inbox, sent, drafts, archive, spam, trash, then custom by name', () => {
    // Insert in a non-deterministic order to confirm the ORDER BY
    // (and not the insert order) is what produces the result.
    const rows: Array<[string, string, string, string, string, string]> = [
      ['acct:Custom-Z', 'acct', 'Zeta', 'Custom-Z', 'custom', '/'],
      ['acct:Trash', 'acct', 'Trash', 'Trash', 'trash', '/'],
      ['acct:Archive', 'acct', 'Archive', 'Archive', 'archive', '/'],
      ['acct:Custom-A', 'acct', 'Alpha', 'Custom-A', 'custom', '/'],
      ['acct:Sent', 'acct', 'Sent', 'Sent', 'sent', '/'],
      ['acct:Inbox', 'acct', 'INBOX', 'INBOX', 'inbox', '/'],
      ['acct:Spam', 'acct', 'Spam', 'Spam', 'spam', '/'],
      ['acct:Drafts', 'acct', 'Drafts', 'Drafts', 'drafts', '/'],
    ];
    for (const r of rows) {
      db.query(
        `INSERT INTO folders (id, account_id, name, full_name, type, delimiter)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(...r);
    }

    const folders = repo.listFoldersForAccount('acct');
    expect(folders.map((f) => f.name)).toEqual([
      'INBOX',
      'Sent',
      'Drafts',
      'Archive',
      'Spam',
      'Trash',
      'Alpha',
      'Zeta',
    ]);
  });

  it('returns full folder shape with fullName (IMAP path) intact', () => {
    db.query(
      `INSERT INTO folders (id, account_id, name, full_name, type, delimiter, attributes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('acct:Custom', 'acct', 'My Stuff', 'Path/To/My Stuff', 'custom', '/', '["HasNoChildren"]');
    const folders = repo.listFoldersForAccount('acct');
    expect(folders).toHaveLength(1);
    const f = folders[0]!;
    expect(f.id).toBe('acct:Custom');
    expect(f.accountId).toBe('acct');
    expect(f.name).toBe('My Stuff');
    expect(f.fullName).toBe('Path/To/My Stuff');
    expect(f.type).toBe('custom');
    expect(f.delimiter).toBe('/');
    expect(f.attributes).toEqual(['HasNoChildren']);
    expect(f.unreadCount).toBe(0);
    expect(f.totalCount).toBe(0);
  });
});
