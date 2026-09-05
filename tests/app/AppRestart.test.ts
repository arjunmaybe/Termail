/**
 * Phase 2.6 — App restart regression test.
 *
 * Verifies that a fresh `App` constructed against the same database
 * (after a previous App successfully synced and was torn down) sees:
 *   - the persisted accounts (from config + DB)
 *   - the persisted folders (from the DB)
 *   - the persisted messages (loaded by `loadEmailsForFolder` once
 *     the App attaches and a folder is selected)
 *
 * No network, no real IMAP. The first App uses a real `SyncService`
 * with a fake `ImapService` (via `ImapServiceFactory`) so the IMAP
 * round-trip is faked but the persistence layer is exercised
 * end-to-end. The second App uses the default (un-faked) `SyncService`
 * to verify the data survives.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncService } from '../../src/app/services/SyncService.js';
import type { ImapServiceFactory } from '../../src/app/services/SyncService.js';
import { getConfigStore, resetConfigStore } from '../../src/core/config/ConfigStore.js';
import { getDatabase, resetDatabase } from '../../src/core/database/Database.js';
import { MessageRepository } from '../../src/core/database/MessageRepository.js';
import type { ImapService } from '../../src/core/imap/ImapService.js';
import type { FolderSyncResult, SyncFolder } from '../../src/core/imap/folders.js';
import type { MessageSyncResult, SyncMessage } from '../../src/core/imap/types.js';
import { actions, selectors } from '../../src/core/state/AppState.js';
import type { AppConfig } from '../../src/core/types/config.js';
import type { AccountConfig } from '../../src/core/types/config.js';

function makeAccountConfig(over: Partial<AccountConfig> = {}): AccountConfig {
  return {
    id: 'work',
    name: 'Work',
    email: 'me@example.com',
    enabled: true,
    host: 'imap.example.com',
    port: 993,
    useTls: true,
    authType: 'password',
    ...over,
  };
}

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
    subject: 'persisted',
    date: new Date('2026-01-01T10:00:00Z'),
    internalDate: new Date('2026-01-01T10:00:00Z'),
    receivedAt: new Date('2026-01-01T10:00:05Z'),
    isRead: false,
    isFlagged: false,
    isAnswered: false,
    isDraft: false,
    size: 100,
    textBody: 'body text',
    hasHtmlBody: false,
    attachments: [],
    flags: [],
    ...over,
  };
}

async function makeApp(syncService?: SyncService): Promise<{
  app: { attach: () => () => void; requestSync: () => Promise<void>; isInitialized: () => boolean };
  renderer: { stop: () => void; destroy: () => void };
}> {
  const { App } = await import('../../src/app/App.js');
  const renderer = await import('@opentui/core').then((m) =>
    m.createCliRenderer({ useMouse: false, exitOnCtrlC: false })
  );
  const app = new App(renderer, {
    id: 'app-restart',
    initialTheme: 'dark',
    ...(syncService ? { syncService } : {}),
  }) as unknown as {
    attach: () => () => void;
    requestSync: () => Promise<void>;
    isInitialized: () => boolean;
  };
  for (let i = 0; i < 50; i += 1) {
    if (app.isInitialized()) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  return { app, renderer };
}

describe('App restart', () => {
  let testDbPath: string;
  let testConfigPath: string;

  beforeEach(async () => {
    resetDatabase();
    resetConfigStore();
    actions.reset();
    testConfigPath = join(tmpdir(), `termail-restart-${Date.now()}-${Math.random()}-config.json`);
    testDbPath = join(tmpdir(), `termail-restart-${Date.now()}-${Math.random()}.sqlite`);

    const configStore = getConfigStore(testConfigPath);
    await configStore.initialize();
    await configStore.updateConfig({
      accounts: [makeAccountConfig()],
      database: { path: testDbPath },
    } as Partial<AppConfig>);
    const database = getDatabase(configStore.getConfig());
    await database.initialize();

    // Pre-seed the account + INBOX folder so the App's initialize()
    // auto-selects INBOX and `requestSync` has a target to sync.
    database
      .query(
        `INSERT INTO accounts (id, name, type, email, use_tls, auth_type)
       VALUES (?, ?, 'imap', ?, 1, 'password')`
      )
      .run('work', 'Work', 'me@example.com');
    database
      .query(
        `INSERT INTO folders (id, account_id, name, full_name, type, delimiter)
       VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('work:INBOX', 'work', 'INBOX', 'INBOX', 'inbox', '/');
  });

  afterEach(() => {
    actions.reset();
    resetDatabase();
    resetConfigStore();
    for (const p of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`, testConfigPath]) {
      if (existsSync(p)) rmSync(p);
    }
  });

  it('a fresh App against the same DB sees persisted accounts and folders after a prior sync', async () => {
    // First app: use a real `SyncService` with a fake `ImapService` so
    // the IMAP round-trip is faked but `MessageRepository.upsertMessages`
    // actually writes the row to the DB.
    const fake = makeFakeImap();
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

    const database = getDatabase(getConfigStore().getConfig());
    const syncService1 = new SyncService(database, makeFactory(fake));
    const { app: app1, renderer: r1 } = await makeApp(syncService1);
    try {
      // The beforeEach pre-seeded INBOX so the App's initialize()
      // auto-selects it. The pre-existing folder has no emails yet
      // because we haven't synced.
      expect(selectors.currentFolderId).toBe('work:INBOX');
      expect(selectors.emails).toHaveLength(0);

      await app1.requestSync();
      expect(fake.connect).toHaveBeenCalledTimes(1);
      expect(selectors.syncStatus).toBe('success');
      expect(selectors.emails).toHaveLength(1);

      // Sanity check: the message was actually persisted to the DB.
      const repo = new MessageRepository(database);
      expect(repo.listByFolder('work', 'work:INBOX', 500)).toHaveLength(1);
    } finally {
      r1.stop();
      r1.destroy();
    }

    // Reset in-memory state to simulate a process restart, but keep
    // the DB and config singletons pointing at the same files.
    actions.reset();
    expect(selectors.accounts).toHaveLength(0);
    expect(selectors.folders).toHaveLength(0);
    expect(selectors.emails).toHaveLength(0);

    // Second app: reads from the same DB. No fake — uses the default
    // `SyncService` (which still talks to a real DB but never makes
    // an IMAP call because no `requestSync` is invoked here).
    const { renderer: r2 } = await makeApp();
    try {
      // Accounts and folders are reloaded from config + DB.
      expect(selectors.currentAccountId).toBe('work');
      expect(selectors.currentFolderId).toBe('work:INBOX');

      // `loadEmailsForFolder` is called inside `initialize()` when a
      // folder is auto-selected. Wait for it to settle.
      for (let i = 0; i < 50; i += 1) {
        if (selectors.emails.length > 0) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(selectors.emails).toHaveLength(1);
      expect(selectors.emails[0]!.subject).toBe('persisted');
      expect(selectors.emails[0]!.bodyText).toBe('body text');
    } finally {
      r2.stop();
      r2.destroy();
    }
  });

  it('a fresh App with a previously-error sync starts in idle (no stale error)', async () => {
    // First app: use a real `SyncService` with a fake `ImapService`
    // that fails to connect, so we get a real `NetworkError` outcome
    // path through the App's `requestSync` (rather than a fake
    // outcome). The App's try/catch still maps any thrown error to
    // a `network` outcome, so the user sees a graceful error either
    // way.
    const fake = makeFakeImap();
    fake.connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const database = getDatabase(getConfigStore().getConfig());
    const syncService1 = new SyncService(database, makeFactory(fake));
    const { app: app1, renderer: r1 } = await makeApp(syncService1);
    try {
      await app1.requestSync();
      expect(selectors.syncError).toMatch(/ECONNREFUSED/);
    } finally {
      r1.stop();
      r1.destroy();
    }

    // Reset in-memory state, keep DB.
    actions.reset();
    expect(selectors.syncError).toBeNull();

    // Second app: re-initialize from DB only (no network call).
    const { renderer: r2 } = await makeApp();
    try {
      expect(selectors.syncStatus).toBe('idle');
      expect(selectors.syncError).toBeNull();
    } finally {
      r2.stop();
      r2.destroy();
    }
  });
});
