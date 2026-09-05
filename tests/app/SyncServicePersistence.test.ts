/**
 * Phase 2.6 — `SyncService` persistence regression tests.
 *
 * Exercises the persistence guarantees of the sync pipeline end-to-end:
 *   - Re-syncing the same folder does not create duplicate rows.
 *   - Re-syncing the same folder updates existing rows (e.g. read state).
 *   - A fresh `SyncService` over the same DB sees the previously persisted
 *     folders and messages.
 *   - Same Message-ID can exist in different folders (not collapsed).
 *   - The identity `(account_id, folder_id, uid)` is the real primary key;
 *     two distinct UIDs with the same Message-ID in the same folder are
 *     rejected by the legacy `UNIQUE (account, folder, message_id)`.
 *   - Persistence is independent of the in-memory `ImapService` fake.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ImapServiceFactory, SyncService } from '../../src/app/services/SyncService.js';
import { getConfigStore, resetConfigStore } from '../../src/core/config/ConfigStore.js';
import { getDatabase, resetDatabase } from '../../src/core/database/Database.js';
import { MessageRepository } from '../../src/core/database/MessageRepository.js';
import type { ImapService } from '../../src/core/imap/ImapService.js';
import type { FolderSyncResult, SyncFolder } from '../../src/core/imap/folders.js';
import type { MessageSyncResult, SyncMessage } from '../../src/core/imap/types.js';
import type { AppConfig } from '../../src/core/types/config.js';
import type { AccountConfig } from '../../src/core/types/config.js';
import { DatabaseError } from '../../src/core/utils/errors.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeImap {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  syncFolders: ReturnType<typeof vi.fn>;
  syncMessages: ReturnType<typeof vi.fn>;
}

function makeFakeImap(): FakeImap {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    syncFolders: vi.fn(),
    syncMessages: vi.fn(),
  };
}

function makeFactory(fake: FakeImap): ImapServiceFactory {
  return ((_account: AccountConfig): ImapService =>
    fake as unknown as ImapService) as ImapServiceFactory;
}

const baseAccount: AccountConfig = {
  id: 'work',
  name: 'Work',
  email: 'me@example.com',
  enabled: true,
  host: 'imap.example.com',
  port: 993,
  useTls: true,
  authType: 'password',
};

const inboxSyncFolder: SyncFolder = {
  path: 'INBOX',
  displayName: 'INBOX',
  delimiter: '/',
  flags: ['\\Inbox'],
  specialUse: 'inbox',
  type: 'inbox',
  selectable: true,
  parentPath: null,
  depth: 0,
};

const sentSyncFolder: SyncFolder = {
  path: 'Sent',
  displayName: 'Sent',
  delimiter: '/',
  flags: ['\\Sent'],
  specialUse: 'sent',
  type: 'sent',
  selectable: true,
  parentPath: null,
  depth: 0,
};

function makeMessage(over: Partial<SyncMessage> = {}): SyncMessage {
  const uid = over.uid ?? 1;
  return {
    uid,
    messageId: `<m-${uid}@example.com>`,
    folder: 'INBOX',
    accountId: 'work',
    from: [{ name: 'Alice', address: 'alice@example.com' }],
    to: [{ name: 'Bob', address: 'bob@example.com' }],
    cc: [],
    subject: 'Hi',
    date: new Date('2026-01-01T10:00:00Z'),
    internalDate: new Date('2026-01-01T10:00:00Z'),
    receivedAt: new Date('2026-01-01T10:00:05Z'),
    isRead: false,
    isFlagged: false,
    isAnswered: false,
    isDraft: false,
    size: 100,
    textBody: 'hello',
    hasHtmlBody: false,
    attachments: [],
    flags: [],
    ...over,
  };
}

describe('SyncService persistence', () => {
  let testDbPath: string;
  let testConfigPath: string;
  let fake: FakeImap;
  let factory: ImapServiceFactory;

  beforeEach(async () => {
    resetDatabase();
    resetConfigStore();
    testConfigPath = join(tmpdir(), `termail-syncp-${Date.now()}-config.json`);
    testDbPath = join(tmpdir(), `termail-syncp-${Date.now()}.sqlite`);

    const configStore = getConfigStore(testConfigPath);
    await configStore.initialize();
    await configStore.updateConfig({ database: { path: testDbPath } } as Partial<AppConfig>);

    fake = makeFakeImap();
    factory = makeFactory(fake);
  });

  afterEach(() => {
    resetDatabase();
    resetConfigStore();
    for (const p of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`, testConfigPath]) {
      if (existsSync(p)) rmSync(p);
    }
  });

  it('re-syncing the same folder does not create duplicate rows', async () => {
    const database = getDatabase(getConfigStore().getConfig());
    await database.initialize();
    const service = new SyncService(database, factory);

    fake.syncFolders.mockResolvedValue({
      folders: [inboxSyncFolder],
      total: 1,
      skipped: 0,
    } satisfies FolderSyncResult);
    fake.syncMessages.mockResolvedValue({
      folder: 'INBOX',
      total: 1,
      parsed: 1,
      deduped: 0,
      messages: [makeMessage({ uid: 1 })],
    } satisfies MessageSyncResult);

    await service.syncAccountFolder(baseAccount, 'INBOX');
    await service.syncAccountFolder(baseAccount, 'INBOX');

    const repo = new MessageRepository(database);
    expect(repo.listByFolder('work', 'work:INBOX')).toHaveLength(1);
    expect(database.query('SELECT COUNT(*) AS c FROM emails').get() as { c: number }).toEqual({
      c: 1,
    });
  });

  it('re-syncing the same folder with different isRead updates the existing row', async () => {
    const database = getDatabase(getConfigStore().getConfig());
    await database.initialize();
    const service = new SyncService(database, factory);

    fake.syncFolders.mockResolvedValue({
      folders: [inboxSyncFolder],
      total: 1,
      skipped: 0,
    } satisfies FolderSyncResult);
    fake.syncMessages
      .mockResolvedValueOnce({
        folder: 'INBOX',
        total: 1,
        parsed: 1,
        deduped: 0,
        messages: [makeMessage({ uid: 1, isRead: false })],
      } satisfies MessageSyncResult)
      .mockResolvedValueOnce({
        folder: 'INBOX',
        total: 1,
        parsed: 1,
        deduped: 0,
        messages: [makeMessage({ uid: 1, isRead: true })],
      } satisfies MessageSyncResult);

    await service.syncAccountFolder(baseAccount, 'INBOX');
    await service.syncAccountFolder(baseAccount, 'INBOX');

    const repo = new MessageRepository(database);
    const got = repo.findById('work:work:INBOX:1');
    expect(got).not.toBeNull();
    expect(got!.isRead).toBe(true);
    expect(repo.listByFolder('work', 'work:INBOX')).toHaveLength(1);
  });

  it('a fresh SyncService over the same DB sees previously persisted messages', async () => {
    const database = getDatabase(getConfigStore().getConfig());
    await database.initialize();

    // First service: write.
    const fake1 = makeFakeImap();
    const factory1 = makeFactory(fake1);
    fake1.syncFolders.mockResolvedValue({
      folders: [inboxSyncFolder, sentSyncFolder],
      total: 2,
      skipped: 0,
    } satisfies FolderSyncResult);
    fake1.syncMessages.mockResolvedValue({
      folder: 'INBOX',
      total: 1,
      parsed: 1,
      deduped: 0,
      messages: [makeMessage({ uid: 7, subject: 'persisted-1' })],
    } satisfies MessageSyncResult);
    const service1 = new SyncService(database, factory1);
    await service1.syncAccountFolder(baseAccount, 'INBOX');

    // Second service: read through the repository directly.
    const fake2 = makeFakeImap();
    const factory2 = makeFactory(fake2);
    const service2 = new SyncService(database, factory2);
    const repo = new MessageRepository(database);
    const persisted = repo.listByFolder('work', 'work:INBOX');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.subject).toBe('persisted-1');

    // service2 hasn't connected yet.
    expect(fake2.connect).not.toHaveBeenCalled();
    expect(service2).toBeDefined();
  });

  it('same Message-ID can coexist in different folders', async () => {
    const database = getDatabase(getConfigStore().getConfig());
    await database.initialize();
    const service = new SyncService(database, factory);

    // Sync INBOX with the same Message-ID, different UIDs.
    fake.syncFolders.mockResolvedValue({
      folders: [inboxSyncFolder, sentSyncFolder],
      total: 2,
      skipped: 0,
    } satisfies FolderSyncResult);
    fake.syncMessages
      .mockResolvedValueOnce({
        folder: 'INBOX',
        total: 1,
        parsed: 1,
        deduped: 0,
        messages: [makeMessage({ uid: 1, messageId: '<same@example.com>', folder: 'INBOX' })],
      } satisfies MessageSyncResult)
      .mockResolvedValueOnce({
        folder: 'Sent',
        total: 1,
        parsed: 1,
        deduped: 0,
        messages: [makeMessage({ uid: 1, messageId: '<same@example.com>', folder: 'Sent' })],
      } satisfies MessageSyncResult);

    await service.syncAccountFolder(baseAccount, 'INBOX');
    await service.syncAccountFolder(baseAccount, 'Sent');

    const rows = database.query('SELECT id, folder_id FROM emails ORDER BY folder_id').all() as {
      id: string;
      folder_id: string;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.folder_id).sort()).toEqual(['work:INBOX', 'work:Sent']);
  });

  it('two distinct UIDs with same Message-ID in same folder are rejected by the legacy UNIQUE constraint', async () => {
    const database = getDatabase(getConfigStore().getConfig());
    await database.initialize();
    const service = new SyncService(database, factory);

    fake.syncFolders.mockResolvedValue({
      folders: [inboxSyncFolder],
      total: 1,
      skipped: 0,
    } satisfies FolderSyncResult);
    // Two messages with the same Message-ID, different UIDs in the
    // same folder. The legacy `UNIQUE (account_id, folder_id, message_id)`
    // constraint must reject the second one. `syncMessages` returns
    // both; `upsertMessages` runs the inserts in a single transaction
    // and the SQLite error is re-thrown as a `DatabaseError`. The
    // `SyncService` does not currently catch this — the rejection
    // surfaces to the caller, and the IMAP socket is still released
    // by the `finally` block. The `App.requestSync()` wrapper maps
    // any thrown error to a `'network'` outcome, so the user sees a
    // graceful error either way.
    fake.syncMessages.mockResolvedValue({
      folder: 'INBOX',
      total: 2,
      parsed: 2,
      deduped: 0,
      messages: [
        makeMessage({ uid: 1, messageId: '<dup@example.com>' }),
        makeMessage({ uid: 2, messageId: '<dup@example.com>' }),
      ],
    } satisfies MessageSyncResult);

    await expect(service.syncAccountFolder(baseAccount, 'INBOX')).rejects.toBeInstanceOf(
      DatabaseError
    );
    // IMAP was still disconnected.
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
  });

  it('a repeated sync on the same folder does not call connect/disconnect twice per request', async () => {
    const database = getDatabase(getConfigStore().getConfig());
    await database.initialize();
    const service = new SyncService(database, factory);

    fake.syncFolders.mockResolvedValue({
      folders: [inboxSyncFolder],
      total: 1,
      skipped: 0,
    } satisfies FolderSyncResult);
    fake.syncMessages.mockResolvedValue({
      folder: 'INBOX',
      total: 1,
      parsed: 1,
      deduped: 0,
      messages: [makeMessage({ uid: 1 })],
    } satisfies MessageSyncResult);

    await service.syncAccountFolder(baseAccount, 'INBOX');
    await service.syncAccountFolder(baseAccount, 'INBOX');

    // Each sync opens and closes the IMAP connection exactly once.
    expect(fake.connect).toHaveBeenCalledTimes(2);
    expect(fake.disconnect).toHaveBeenCalledTimes(2);
  });
});
