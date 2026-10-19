/**
 * Regression tests for preserving the folder-replacement invalidation signal
 * when a post-persistence read fails after `upsertMessages` has committed.
 *
 * A replacement that committed must still communicate its `replacedFolderIds`
 * so the TUI can drop stale in-memory search hits, even when the folder/message
 * reads that follow persistence fail. A replacement whose persistence failed
 * must NOT signal a committed replacement.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ImapServiceFactory,
  type SyncOutcome,
  SyncService,
} from '../../src/app/services/SyncService.js';
import { getConfigStore, resetConfigStore } from '../../src/core/config/ConfigStore.js';
import { getDatabase, resetDatabase } from '../../src/core/database/Database.js';
import { MessageRepository } from '../../src/core/database/MessageRepository.js';
import type { FolderSyncResult, SyncFolder } from '../../src/core/imap/folders.js';
import type { ImapService } from '../../src/core/imap/ImapService.js';
import type { MessageSyncResult, SyncMessage } from '../../src/core/imap/types.js';
import type { AccountConfig, AppConfig } from '../../src/core/types/config.js';
import { AuthenticationError, DatabaseError } from '../../src/core/utils/errors.js';

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

const bootstrapAccount: AccountConfig = {
  id: 'personal',
  name: 'Personal',
  email: 'me@gmail.com',
  enabled: true,
  host: 'imap.gmail.com',
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

/**
 * Seed a legacy/pre-v6 sync-state row: a checkpoint exists, but its
 * UIDVALIDITY generation was never observed, so the next successful sync
 * must replace the folder cache.
 */
function seedLegacyUnobservedState(
  database: ReturnType<typeof getDatabase>,
  accountId: string,
  folderId: string,
  email: string
): void {
  database
    .query(
      `INSERT INTO accounts (id, name, type, email, use_tls, auth_type)
       VALUES (?, ?, 'imap', ?, 1, 'password')`
    )
    .run(accountId, accountId === 'work' ? 'Work' : 'Personal', email);
  database
    .query(
      `INSERT INTO folders (id, account_id, name, full_name, type, delimiter)
       VALUES (?, ?, 'INBOX', 'INBOX', 'inbox', '/')`
    )
    .run(folderId, accountId);
  database
    .query(
      `INSERT INTO folder_sync_state
         (account_id, folder_id, highest_uid, last_sync_status, uid_validity, uid_validity_observed)
       VALUES (?, ?, 5, 'ok', NULL, 0)`
    )
    .run(accountId, folderId);
}

/** Swap the service's repository for one whose folder read fails. */
function installThrowingFolderRead(service: SyncService, error: unknown): void {
  const repo = (service as unknown as { repository: MessageRepository }).repository;
  const throwing = Object.create(repo) as MessageRepository;
  throwing.listFoldersForAccount = () => {
    throw error;
  };
  (service as unknown as { repository: MessageRepository }).repository = throwing;
}

/** Narrow an error outcome for message assertions. */
function expectErrorOutcome(outcome: SyncOutcome, kind: 'auth' | 'network', message: string): void {
  if (outcome.kind !== kind) {
    throw new Error(`expected ${kind} outcome, got ${outcome.kind}`);
  }
  expect(outcome.message).toBe(message);
}

/** Swap the service's repository for one whose persistence fails. */
function installFailingUpsert(service: SyncService): void {
  const repo = (service as unknown as { repository: MessageRepository }).repository;
  const failing = Object.create(repo) as MessageRepository;
  failing.upsertMessages = () => {
    throw new DatabaseError('forced persistence failure');
  };
  (service as unknown as { repository: MessageRepository }).repository = failing;
}

describe('SyncService post-persistence read failure', () => {
  let testDbPath = '';
  let testConfigPath = '';
  let fake: FakeImap;

  beforeEach(async () => {
    resetDatabase();
    resetConfigStore();
    testConfigPath = join(tmpdir(), `termail-readfail-${Date.now()}-${Math.random()}-config.json`);
    testDbPath = join(tmpdir(), `termail-readfail-${Date.now()}-${Math.random()}.sqlite`);
    const store = getConfigStore(testConfigPath);
    await store.initialize();
    await store.updateConfig({ database: { path: testDbPath } } as Partial<AppConfig>);
    fake = makeFakeImap();
  });

  afterEach(() => {
    resetDatabase();
    resetConfigStore();
    for (const p of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`, testConfigPath]) {
      if (p && existsSync(p)) rmSync(p);
    }
  });

  it('preserves replacedFolderIds when the post-persistence folder read fails after a committed replacement', async () => {
    const database = getDatabase(getConfigStore().getConfig());
    await database.initialize();
    seedLegacyUnobservedState(database, 'work', 'work:INBOX', 'me@example.com');

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
      uidValidity: '7',
      messages: [makeMessage({ uid: 1 })],
    } satisfies MessageSyncResult);

    const service = new SyncService(database, makeFactory(fake));
    installThrowingFolderRead(service, new Error('folder read failed'));

    const outcome = await service.syncAccountFolder(baseAccount, 'INBOX');

    expectErrorOutcome(outcome, 'network', 'folder read failed');
    expect(outcome.replacedFolderIds).toEqual(['work:INBOX']);

    // The replacement committed before the read failed.
    const row = database
      .query('SELECT uid FROM emails WHERE account_id = ? AND folder_id = ? AND uid = 1')
      .get('work', 'work:INBOX') as { uid: number } | null;
    expect(row).not.toBeNull();
    const state = new MessageRepository(database).getSyncState('work', 'work:INBOX');
    expect(state?.uidValidity).toBe('7');
    expect(state?.uidValidityObserved).toBe(true);
    expect(state?.highestUid).toBe(1);
  });

  it('preserves replacedFolderIds when the post-persistence read fails with an auth error', async () => {
    const database = getDatabase(getConfigStore().getConfig());
    await database.initialize();
    seedLegacyUnobservedState(database, 'work', 'work:INBOX', 'me@example.com');

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
      uidValidity: '7',
      messages: [makeMessage({ uid: 1 })],
    } satisfies MessageSyncResult);

    const service = new SyncService(database, makeFactory(fake));
    installThrowingFolderRead(service, new AuthenticationError('db auth failed'));

    const outcome = await service.syncAccountFolder(baseAccount, 'INBOX');

    expectErrorOutcome(outcome, 'auth', 'db auth failed');
    expect(outcome.replacedFolderIds).toEqual(['work:INBOX']);
  });

  it('preserves replacedFolderIds through the bootstrap path when the post-persistence read fails', async () => {
    const database = getDatabase(getConfigStore().getConfig());
    await database.initialize();
    seedLegacyUnobservedState(database, 'personal', 'personal:INBOX', 'me@gmail.com');

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
      uidValidity: '9',
      messages: [makeMessage({ uid: 2, accountId: 'personal' })],
    } satisfies MessageSyncResult);

    const service = new SyncService(database, makeFactory(fake));
    installThrowingFolderRead(service, new Error('folder read failed'));

    const outcome = await service.syncAccount(bootstrapAccount);

    expectErrorOutcome(outcome, 'network', 'folder read failed');
    expect(outcome.replacedFolderIds).toEqual(['personal:INBOX']);

    const state = new MessageRepository(database).getSyncState('personal', 'personal:INBOX');
    expect(state?.uidValidity).toBe('9');
    expect(state?.uidValidityObserved).toBe(true);
  });

  it('does not signal a replacement when persistence fails', async () => {
    const database = getDatabase(getConfigStore().getConfig());
    await database.initialize();
    seedLegacyUnobservedState(database, 'work', 'work:INBOX', 'me@example.com');

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
      uidValidity: '7',
      messages: [makeMessage({ uid: 1 })],
    } satisfies MessageSyncResult);

    const service = new SyncService(database, makeFactory(fake));
    installFailingUpsert(service);

    // Persistence failures keep the pre-existing rethrow contract: no
    // outcome (and therefore no replacedFolderIds) reaches the caller.
    await expect(service.syncAccountFolder(baseAccount, 'INBOX')).rejects.toThrow(
      'forced persistence failure'
    );

    // The failed persistence left the legacy checkpoint untouched.
    const state = new MessageRepository(database).getSyncState('work', 'work:INBOX');
    expect(state?.highestUid).toBe(5);
    expect(state?.uidValidityObserved).toBe(false);
    expect(
      database.query('SELECT 1 AS x FROM emails WHERE folder_id = ?').get('work:INBOX')
    ).toBeNull();
  });
});
