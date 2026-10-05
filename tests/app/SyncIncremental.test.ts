/**
 * Incremental sync: SyncService must pass the persisted checkpoint
 * (`sinceUid`) to `ImapService.syncMessages` so only new UIDs are fetched.
 *
 * - First sync with no checkpoint performs a full sync (no limits).
 * - Second sync passes `{ limits: { sinceUid: <highestUid> } }`.
 * - Failed syncs never advance the checkpoint; recovery reuses it.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncService, type ImapServiceFactory } from '../../src/app/services/SyncService.js';
import { getConfigStore, resetConfigStore } from '../../src/core/config/ConfigStore.js';
import { getDatabase, resetDatabase } from '../../src/core/database/Database.js';
import { MessageRepository } from '../../src/core/database/MessageRepository.js';
import type { ImapService } from '../../src/core/imap/ImapService.js';
import type { FolderSyncResult, SyncFolder } from '../../src/core/imap/folders.js';
import type { MessageSyncResult, SyncMessage } from '../../src/core/imap/types.js';
import type { AccountConfig, AppConfig } from '../../src/core/types/config.js';

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

function makeMessage(uid: number): SyncMessage {
  return {
    uid,
    messageId: `<m-${uid}@example.com>`,
    folder: 'INBOX',
    accountId: 'work',
    from: [{ name: 'Alice', address: 'alice@example.com' }],
    to: [{ name: 'Bob', address: 'bob@example.com' }],
    cc: [],
    subject: `msg ${uid}`,
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
  };
}

describe('SyncService incremental sync', () => {
  let testDbPath = '';
  let testConfigPath = '';
  let fake: FakeImap;

  beforeEach(async () => {
    resetDatabase();
    resetConfigStore();
    testConfigPath = join(tmpdir(), `termail-inc-${Date.now()}-${Math.random()}-config.json`);
    testDbPath = join(tmpdir(), `termail-inc-${Date.now()}-${Math.random()}.sqlite`);
    const store = getConfigStore(testConfigPath);
    await store.initialize();
    await store.updateConfig({ database: { path: testDbPath } } as Partial<AppConfig>);
    const db = getDatabase(store.getConfig());
    await db.initialize();
    fake = makeFakeImap();
  });

  afterEach(() => {
    resetDatabase();
    resetConfigStore();
    for (const p of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`, testConfigPath]) {
      if (p && existsSync(p)) rmSync(p);
    }
  });

  it('first sync has no limits; second sync passes sinceUid from the checkpoint', async () => {
    const db = getDatabase(getConfigStore().getConfig());
    const service = new SyncService(db, makeFactory(fake));
    const folders: FolderSyncResult = { folders: [inboxSyncFolder], total: 1, skipped: 0 };

    fake.syncFolders.mockResolvedValue(folders);
    fake.syncMessages.mockResolvedValue({
      folder: 'INBOX',
      total: 1,
      parsed: 1,
      deduped: 0,
      messages: [makeMessage(5)],
    } satisfies MessageSyncResult);
    const first = await service.syncAccountFolder(baseAccount, 'INBOX');
    expect(first.kind).toBe('ok');
    // First call: full sync, no limits object.
    expect(fake.syncMessages).toHaveBeenCalledTimes(1);
    expect(fake.syncMessages.mock.calls[0]?.[1]).toEqual({});

    const repo = new MessageRepository(db);
    expect(repo.getSyncState('work', 'work:INBOX')?.highestUid).toBe(5);

    fake.syncFolders.mockResolvedValue(folders);
    fake.syncMessages.mockResolvedValue({
      folder: 'INBOX',
      total: 1,
      parsed: 1,
      deduped: 0,
      messages: [makeMessage(6)],
    } satisfies MessageSyncResult);
    const second = await service.syncAccountFolder(baseAccount, 'INBOX');
    expect(second.kind).toBe('ok');
    expect(fake.syncMessages).toHaveBeenCalledTimes(2);
    expect(fake.syncMessages.mock.calls[1]?.[1]).toEqual({ limits: { sinceUid: 5 } });
    expect(repo.getSyncState('work', 'work:INBOX')?.highestUid).toBe(6);
  });

  it('a failed incremental sync preserves the checkpoint for recovery', async () => {
    const db = getDatabase(getConfigStore().getConfig());
    const service = new SyncService(db, makeFactory(fake));
    const folders: FolderSyncResult = { folders: [inboxSyncFolder], total: 1, skipped: 0 };

    fake.syncFolders.mockResolvedValue(folders);
    fake.syncMessages.mockResolvedValue({
      folder: 'INBOX',
      total: 1,
      parsed: 1,
      deduped: 0,
      messages: [makeMessage(10)],
    } satisfies MessageSyncResult);
    await service.syncAccountFolder(baseAccount, 'INBOX');

    fake.syncFolders.mockResolvedValue(folders);
    fake.syncMessages.mockRejectedValueOnce(new Error('fetch exploded'));
    await expect(service.syncAccountFolder(baseAccount, 'INBOX')).rejects.toThrow('fetch exploded');

    const repo = new MessageRepository(db);
    const failed = repo.getSyncState('work', 'work:INBOX');
    expect(failed?.highestUid).toBe(10);
    expect(failed?.lastSyncStatus).toBe('error');

    // Recovery still uses the preserved checkpoint.
    fake.syncFolders.mockResolvedValue(folders);
    fake.syncMessages.mockResolvedValue({
      folder: 'INBOX',
      total: 1,
      parsed: 1,
      deduped: 0,
      messages: [makeMessage(11)],
    } satisfies MessageSyncResult);
    const recovered = await service.syncAccountFolder(baseAccount, 'INBOX');
    expect(recovered.kind).toBe('ok');
    const lastCall = fake.syncMessages.mock.calls[fake.syncMessages.mock.calls.length - 1]?.[1];
    expect(lastCall).toEqual({ limits: { sinceUid: 10 } });
    expect(repo.getSyncState('work', 'work:INBOX')?.highestUid).toBe(11);
  });
});
