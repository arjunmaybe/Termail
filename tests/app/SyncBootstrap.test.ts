/**
 * Fresh-account bootstrap: `SyncService.syncAccount` discovers folders,
 * persists them, prefers INBOX, and syncs messages incrementally.
 *
 * No network, no real IMAP. The ImapService is faked; the repository uses
 * a real `bun:sqlite` DB.
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
import { AuthenticationError, NetworkError } from '../../src/core/utils/errors.js';

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
  id: 'personal',
  name: 'Personal',
  email: 'me@gmail.com',
  enabled: true,
  host: 'imap.gmail.com',
  port: 993,
  useTls: true,
  authType: 'password',
};

function makeFolder(over: Partial<SyncFolder> = {}): SyncFolder {
  return {
    path: 'INBOX',
    displayName: 'INBOX',
    delimiter: '/',
    flags: ['\\Inbox'],
    specialUse: 'inbox',
    type: 'inbox',
    selectable: true,
    parentPath: null,
    depth: 0,
    ...over,
  };
}

function makeMessage(uid: number, folder = 'INBOX'): SyncMessage {
  return {
    uid,
    messageId: `<m-${uid}@gmail.com>`,
    folder,
    accountId: 'personal',
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

describe('SyncService.syncAccount bootstrap', () => {
  let testDbPath = '';
  let testConfigPath = '';
  let fake: FakeImap;

  beforeEach(async () => {
    resetDatabase();
    resetConfigStore();
    testConfigPath = join(tmpdir(), `termail-boot-${Date.now()}-${Math.random()}-config.json`);
    testDbPath = join(tmpdir(), `termail-boot-${Date.now()}-${Math.random()}.sqlite`);
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

  it('discovers folders, prefers INBOX, persists messages and checkpoint', async () => {
    const db = getDatabase(getConfigStore().getConfig());
    const service = new SyncService(db, makeFactory(fake));
    const sent = makeFolder({ path: 'Sent', displayName: 'Sent', type: 'sent', specialUse: 'sent' });
    fake.syncFolders.mockResolvedValue({
      folders: [sent, makeFolder()],
      total: 2,
      skipped: 0,
    } satisfies FolderSyncResult);
    fake.syncMessages.mockResolvedValue({
      folder: 'INBOX',
      total: 1,
      parsed: 1,
      deduped: 0,
      messages: [makeMessage(1)],
    } satisfies MessageSyncResult);

    const outcome = await service.syncAccount(baseAccount);

    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.folders.map((f) => f.fullName)).toContain('INBOX');
    expect(outcome.messages).toHaveLength(1);
    expect(fake.syncMessages).toHaveBeenCalledTimes(1);
    // First bootstrap is a full sync (no limits).
    expect(fake.syncMessages.mock.calls[0]?.[1]).toEqual({});
    expect(fake.disconnect).toHaveBeenCalledTimes(1);

    const repo = new MessageRepository(db);
    expect(repo.listFoldersForAccount('personal')).toHaveLength(2);
    expect(repo.getSyncState('personal', 'personal:INBOX')?.highestUid).toBe(1);
  });

  it('second bootstrap is incremental via sinceUid', async () => {
    const db = getDatabase(getConfigStore().getConfig());
    const service = new SyncService(db, makeFactory(fake));
    const folders: FolderSyncResult = { folders: [makeFolder()], total: 1, skipped: 0 };
    fake.syncFolders.mockResolvedValue(folders);
    fake.syncMessages.mockResolvedValue({
      folder: 'INBOX',
      total: 1,
      parsed: 1,
      deduped: 0,
      messages: [makeMessage(5)],
    } satisfies MessageSyncResult);
    await service.syncAccount(baseAccount);

    fake.syncFolders.mockResolvedValue(folders);
    fake.syncMessages.mockResolvedValue({
      folder: 'INBOX',
      total: 1,
      parsed: 1,
      deduped: 0,
      messages: [makeMessage(6)],
    } satisfies MessageSyncResult);
    const second = await service.syncAccount(baseAccount);
    expect(second.kind).toBe('ok');
    expect(fake.syncMessages.mock.calls[1]?.[1]).toEqual({ limits: { sinceUid: 5 } });
  });

  it('message fetch failure preserves folders and returns network without advancing checkpoint', async () => {
    const db = getDatabase(getConfigStore().getConfig());
    const service = new SyncService(db, makeFactory(fake));
    fake.syncFolders.mockResolvedValue({
      folders: [makeFolder()],
      total: 1,
      skipped: 0,
    } satisfies FolderSyncResult);
    fake.syncMessages.mockRejectedValueOnce(new NetworkError('IMAP connection error: boom'));

    const outcome = await service.syncAccount(baseAccount);
    expect(outcome.kind).toBe('network');
    expect(fake.disconnect).toHaveBeenCalledTimes(1);

    const repo = new MessageRepository(db);
    // Folders discovered before the failure are preserved.
    expect(repo.listFoldersForAccount('personal')).toHaveLength(1);
    const state = repo.getSyncState('personal', 'personal:INBOX');
    expect(state?.lastSyncStatus).toBe('error');
    expect(state?.highestUid).toBe(0);
  });

  it('mid-sync AuthenticationError maps to auth', async () => {
    const db = getDatabase(getConfigStore().getConfig());
    const service = new SyncService(db, makeFactory(fake));
    fake.syncFolders.mockResolvedValue({
      folders: [makeFolder()],
      total: 1,
      skipped: 0,
    } satisfies FolderSyncResult);
    fake.syncMessages.mockRejectedValueOnce(
      new AuthenticationError('IMAP authentication failed: bad token')
    );
    const outcome = await service.syncAccount(baseAccount);
    expect(outcome.kind).toBe('auth');
  });

  it('connect AuthenticationError maps to auth and does not persist folders', async () => {
    const db = getDatabase(getConfigStore().getConfig());
    const service = new SyncService(db, makeFactory(fake));
    fake.connect.mockRejectedValueOnce(new AuthenticationError('bad password'));
    const outcome = await service.syncAccount(baseAccount);
    expect(outcome.kind).toBe('auth');
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
    const repo = new MessageRepository(db);
    expect(repo.listFoldersForAccount('personal')).toHaveLength(0);
  });

  it('no selectable folders returns no-folder gracefully', async () => {
    const db = getDatabase(getConfigStore().getConfig());
    const service = new SyncService(db, makeFactory(fake));
    fake.syncFolders.mockResolvedValue({
      folders: [makeFolder({ path: 'Parent', displayName: 'Parent', type: 'custom', selectable: false })],
      total: 1,
      skipped: 0,
    } satisfies FolderSyncResult);
    const outcome = await service.syncAccount(baseAccount);
    expect(outcome.kind).toBe('no-folder');
    expect(fake.syncMessages).not.toHaveBeenCalled();
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
  });

  it('empty server folder list returns no-folder', async () => {
    const db = getDatabase(getConfigStore().getConfig());
    const service = new SyncService(db, makeFactory(fake));
    fake.syncFolders.mockResolvedValue({ folders: [], total: 0, skipped: 0 });
    const outcome = await service.syncAccount(baseAccount);
    expect(outcome.kind).toBe('no-folder');
  });
});
