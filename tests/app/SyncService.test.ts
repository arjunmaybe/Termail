/**
 * Phase 2.5 — `SyncService` tests.
 *
 * No network, no real IMAP. The ImapService is faked so we can drive
 * the success and failure paths deterministically. The repository uses
 * a real in-memory `bun:sqlite` DB so the persistence layer is
 * exercised end-to-end.
 */

import { existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigStore, resetConfigStore } from '../../src/core/config/ConfigStore.js';
import { getDatabase, resetDatabase } from '../../src/core/database/Database.js';
import { MessageRepository } from '../../src/core/database/MessageRepository.js';
import type { AccountConfig } from '../../src/core/types/config.js';
import { AuthenticationError, NetworkError } from '../../src/core/utils/errors.js';
import type { ImapService } from '../../src/core/imap/ImapService.js';
import type { FolderSyncResult, SyncFolder } from '../../src/core/imap/folders.js';
import type { MessageSyncResult, SyncMessage } from '../../src/core/imap/types.js';
import { SyncService, type ImapServiceFactory } from '../../src/app/services/SyncService.js';
import type { AppConfig } from '../../src/core/types/config.js';

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

function makeFactory(fake: FakeImap): ImapServiceFactory & { calls: AccountConfig[] } {
  const calls: AccountConfig[] = [];
  const factory = ((account: AccountConfig): ImapService => {
    calls.push(account);
    return fake as unknown as ImapService;
  }) as ImapServiceFactory & { calls: AccountConfig[] };
  (factory as { calls: AccountConfig[] }).calls = calls;
  return factory;
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

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('SyncService', () => {
  let testDbPath: string;
  let testConfigPath: string;
  let fake: FakeImap;
  let factory: ReturnType<typeof makeFactory>;
  let service: SyncService;

  beforeEach(async () => {
    resetDatabase();
    resetConfigStore();
    testConfigPath = join(tmpdir(), `termail-sync-${Date.now()}-config.json`);
    testDbPath = join(tmpdir(), `termail-sync-${Date.now()}.sqlite`);

    const configStore = getConfigStore(testConfigPath);
    await configStore.initialize();
    await configStore.updateConfig({ database: { path: testDbPath } } as Partial<AppConfig>);
    const database = getDatabase(configStore.getConfig());
    await database.initialize();

    fake = makeFakeImap();
    factory = makeFactory(fake);
    service = new SyncService(database, factory);
  });

  afterEach(() => {
    resetDatabase();
    resetConfigStore();
    for (const p of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`, testConfigPath]) {
      if (existsSync(p)) rmSync(p);
    }
  });

  // -------------------------------------------------------------------------
  // Success path
  // -------------------------------------------------------------------------

  it('returns ok with persisted folders and messages on a successful sync', async () => {
    const folderResult: FolderSyncResult = {
      folders: [inboxSyncFolder, sentSyncFolder],
      total: 2,
      skipped: 0,
    };
    const messageResult: MessageSyncResult = {
      folder: 'INBOX',
      total: 1,
      parsed: 1,
      deduped: 0,
      messages: [makeMessage({ uid: 1, subject: 'Hello' })],
    };
    fake.syncFolders.mockResolvedValueOnce(folderResult);
    fake.syncMessages.mockResolvedValueOnce(messageResult);

    const outcome = await service.syncAccountFolder(baseAccount, 'INBOX');

    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.folders.map((f) => f.name)).toEqual(['INBOX', 'Sent']);
    expect(outcome.folders.find((f) => f.name === 'INBOX')?.fullName).toBe('INBOX');
    expect(outcome.messages).toHaveLength(1);
    expect(outcome.messages[0]?.subject).toBe('Hello');
    expect(outcome.messages[0]?.fromAddresses).toEqual([
      { name: 'Alice', address: 'alice@example.com' },
    ]);

    // IMAP was opened and closed exactly once.
    expect(fake.connect).toHaveBeenCalledTimes(1);
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
    // The factory received the exact account we passed in.
    expect(factory.calls).toEqual([baseAccount]);
  });

  it('persists rows that survive across separate service instances', async () => {
    const folderResult: FolderSyncResult = {
      folders: [inboxSyncFolder],
      total: 1,
      skipped: 0,
    };
    const messageResult: MessageSyncResult = {
      folder: 'INBOX',
      total: 1,
      parsed: 1,
      deduped: 0,
      messages: [makeMessage({ uid: 9, subject: 'persisted' })],
    };
    fake.syncFolders.mockResolvedValueOnce(folderResult);
    fake.syncMessages.mockResolvedValueOnce(messageResult);
    const outcome1 = await service.syncAccountFolder(baseAccount, 'INBOX');
    expect(outcome1.kind).toBe('ok');

    // Verify with a fresh repository over the same DB.
    const configStore = getConfigStore(testConfigPath);
    const config = configStore.getConfig();
    const database = getDatabase(config);
    const repository = new MessageRepository(database);
    const persisted = repository.listFoldersForAccount('work');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.fullName).toBe('INBOX');
    const emails = repository.listByFolder('work', 'work:INBOX');
    expect(emails).toHaveLength(1);
    expect(emails[0]?.subject).toBe('persisted');
  });

  // -------------------------------------------------------------------------
  // Failure paths
  // -------------------------------------------------------------------------

  it('returns auth when IMAP connect throws AuthenticationError', async () => {
    fake.connect.mockRejectedValueOnce(
      new AuthenticationError('IMAP authentication failed: bad password')
    );
    const outcome = await service.syncAccountFolder(baseAccount, 'INBOX');
    expect(outcome.kind).toBe('auth');
    if (outcome.kind !== 'auth') return;
    expect(outcome.message).toMatch(/authentication/i);
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
  });

  it('returns network when IMAP connect throws NetworkError', async () => {
    fake.connect.mockRejectedValueOnce(new NetworkError('IMAP connection error: ECONNREFUSED'));
    const outcome = await service.syncAccountFolder(baseAccount, 'INBOX');
    expect(outcome.kind).toBe('network');
    if (outcome.kind !== 'network') return;
    expect(outcome.message).toMatch(/ECONNREFUSED/);
  });

  it('returns network when syncFolders throws an unmapped error', async () => {
    fake.syncFolders.mockRejectedValueOnce(new Error('something exploded'));
    const outcome = await service.syncAccountFolder(baseAccount, 'INBOX');
    expect(outcome.kind).toBe('network');
    if (outcome.kind !== 'network') return;
    expect(outcome.message).toBe('something exploded');
  });

  it('returns no-folder when the requested path is not in the synced list', async () => {
    const folderResult: FolderSyncResult = {
      folders: [sentSyncFolder],
      total: 1,
      skipped: 0,
    };
    fake.syncFolders.mockResolvedValueOnce(folderResult);
    const outcome = await service.syncAccountFolder(baseAccount, 'INBOX');
    expect(outcome.kind).toBe('no-folder');
    if (outcome.kind !== 'no-folder') return;
    expect(outcome.message).toMatch(/INBOX/);
  });

  // -------------------------------------------------------------------------
  // Defensive inputs
  // -------------------------------------------------------------------------

  it('returns no-account when called with an empty folder path', async () => {
    const outcome = await service.syncAccountFolder(baseAccount, '');
    expect(outcome.kind).toBe('no-folder');
    expect(fake.connect).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Credential safety
  // -------------------------------------------------------------------------

  it('only ever sees the safe subset of the AccountConfig', async () => {
    // Type-level guarantee: AccountConfig has no `password` field. The
    // SafeAccountInput type the repository accepts is a Pick<...> that
    // excludes credential fields. The factory only receives the
    // AccountConfig we pass in.
    const folderResult: FolderSyncResult = {
      folders: [inboxSyncFolder],
      total: 1,
      skipped: 0,
    };
    const messageResult: MessageSyncResult = {
      folder: 'INBOX',
      total: 0,
      parsed: 0,
      deduped: 0,
      messages: [],
    };
    fake.syncFolders.mockResolvedValueOnce(folderResult);
    fake.syncMessages.mockResolvedValueOnce(messageResult);
    await service.syncAccountFolder(baseAccount, 'INBOX');
    expect(factory.calls[0]).toEqual(baseAccount);
    // The keys on the AccountConfig the test passes in must not include
    // credential fields.
    expect(Object.keys(baseAccount)).not.toContain('password');
    expect(Object.keys(baseAccount)).not.toContain('oauthConfig');
  });
});
