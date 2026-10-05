/**
 * B5 — concurrent sync race: global single-flight + stale-result guard.
 *
 * Deterministic deferred-fake tests:
 *  - first r starts sync
 *  - second r while first is pending => no second sync
 *  - change folder while first is pending
 *  - resolve first sync
 *  - stale result must not overwrite the newly selected folder
 */

import { existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigStore, resetConfigStore } from '../../src/core/config/ConfigStore.js';
import { getDatabase, resetDatabase } from '../../src/core/database/Database.js';
import { actions, selectors } from '../../src/core/state/AppState.js';
import type { SyncOutcome } from '../../src/app/services/SyncService.js';
import type { PersistedEmail, PersistedFolder } from '../../src/core/database/index.js';
import type { AppConfig, AccountConfig } from '../../src/core/types/config.js';

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

function makePersistedFolder(over: Partial<PersistedFolder> = {}): PersistedFolder {
  return {
    id: 'work:INBOX',
    accountId: 'work',
    name: 'INBOX',
    fullName: 'INBOX',
    type: 'inbox',
    parentId: null,
    delimiter: '/',
    attributes: [],
    unreadCount: 0,
    totalCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function makeEmail(over: Partial<PersistedEmail> = {}): PersistedEmail {
  const id = over.id ?? 'work:INBOX:1';
  return {
    id,
    accountId: 'work',
    folderId: 'work:INBOX',
    messageId: '<m@example.com>',
    fromAddresses: [],
    toAddresses: [],
    ccAddresses: [],
    subject: 'hi',
    date: 0,
    internalDate: 0,
    receivedAt: 0,
    isRead: false,
    isFlagged: false,
    isAnswered: false,
    isDraft: false,
    hasAttachments: false,
    size: 0,
    bodyText: null,
    bodyHtml: null,
    headers: {},
    attachments: [],
    flags: [],
    uid: 1,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe('B5 App.requestSync single-flight + stale guard', () => {
  let testDbPath: string;
  let testConfigPath: string;

  beforeEach(async () => {
    resetDatabase();
    resetConfigStore();
    actions.reset();
    testConfigPath = join(tmpdir(), `termail-b5-${Date.now()}-${Math.random()}-config.json`);
    testDbPath = join(tmpdir(), `termail-b5-${Date.now()}-${Math.random()}.sqlite`);

    const configStore = getConfigStore(testConfigPath);
    await configStore.initialize();
    await configStore.updateConfig({
      accounts: [makeAccountConfig()],
      database: { path: testDbPath },
    } as Partial<AppConfig>);
    const database = getDatabase(configStore.getConfig());
    await database.initialize();

    database.query(
      `INSERT INTO accounts (id, name, type, email, use_tls, auth_type)
       VALUES (?, ?, 'imap', ?, 1, 'password')`
    ).run('work', 'Work', 'me@example.com');
    database.query(
      `INSERT INTO folders (id, account_id, name, full_name, type, delimiter)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('work:INBOX', 'work', 'INBOX', 'INBOX', 'inbox', '/');
    database.query(
      `INSERT INTO folders (id, account_id, name, full_name, type, delimiter)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('work:Sent', 'work', 'Sent', 'Sent', 'sent', '/');
  });

  afterEach(() => {
    actions.reset();
    resetDatabase();
    resetConfigStore();
    for (const p of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`, testConfigPath]) {
      if (existsSync(p)) rmSync(p);
    }
  });

  async function makeApp(fake: { syncAccountFolder: ReturnType<typeof vi.fn> }) {
    const { App } = await import('../../src/app/App.js');
    const renderer = await import('@opentui/core').then((m) =>
      m.createCliRenderer({ useMouse: false, exitOnCtrlC: false })
    );
    const app = new App(renderer, {
      id: 'app-b5',
      initialTheme: 'dark',
      syncService: fake as never,
    });
    for (let i = 0; i < 50; i += 1) {
      if (app.isInitialized()) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    return { app, renderer };
  }

  it('second r while first is pending does not start a second sync (global single-flight)', async () => {
    const fake = { syncAccountFolder: vi.fn() };
    let resolveSync!: (o: SyncOutcome) => void;
    fake.syncAccountFolder.mockReturnValueOnce(
      new Promise<SyncOutcome>((resolve) => { resolveSync = resolve; })
    );
    const { app, renderer } = await makeApp(fake);
    try {
      expect(selectors.currentFolderId).toBe('work:INBOX');
      const first = app.requestSync();
      // Loading is set synchronously by the first sync.
      expect(selectors.isLoadingEmails).toBe(true);
      await app.requestSync();
      expect(fake.syncAccountFolder).toHaveBeenCalledTimes(1);
      // Still loading; the blocked second call did not clear it.
      expect(selectors.isLoadingEmails).toBe(true);
      resolveSync({ kind: 'no-account', message: 'noop' });
      await first;
      expect(selectors.isLoadingEmails).toBe(false);
      expect(fake.syncAccountFolder).toHaveBeenCalledTimes(1);
    } finally {
      renderer.stop();
      renderer.destroy();
    }
  });

  it('stale sync completion does not overwrite the newly selected folder', async () => {
    const fake = { syncAccountFolder: vi.fn() };
    let resolveSync!: (o: SyncOutcome) => void;
    fake.syncAccountFolder.mockReturnValueOnce(
      new Promise<SyncOutcome>((resolve) => { resolveSync = resolve; })
    );
    const { app, renderer } = await makeApp(fake);
    try {
      expect(selectors.currentFolderId).toBe('work:INBOX');

      const inboxEmail = makeEmail({ id: 'work:INBOX:9', folderId: 'work:INBOX', subject: 'stale inbox' });
      const sentEmail = makeEmail({ id: 'work:Sent:7', folderId: 'work:Sent', subject: 'current sent' });

      // First r starts a sync for INBOX.
      const first = app.requestSync();
      expect(fake.syncAccountFolder).toHaveBeenCalledTimes(1);

      // Second r while pending is blocked, even after switching folders.
      actions.setCurrentFolder('work:Sent');
      actions.setEmails([sentEmail]);
      await app.requestSync();
      expect(fake.syncAccountFolder).toHaveBeenCalledTimes(1);

      // Resolve the stale INBOX sync with INBOX data.
      resolveSync({
        kind: 'ok',
        folders: [
          makePersistedFolder({ id: 'work:INBOX', name: 'INBOX', fullName: 'INBOX', type: 'inbox' }),
          makePersistedFolder({ id: 'work:Sent', name: 'Sent', fullName: 'Sent', type: 'sent' }),
        ],
        messages: [inboxEmail],
      });
      await first;

      // Newly selected folder's messages preserved.
      expect(selectors.currentFolderId).toBe('work:Sent');
      expect(selectors.emails.map((e) => e.id)).toEqual(['work:Sent:7']);
      expect(selectors.emails[0]?.subject).toBe('current sent');
      expect(selectors.isLoadingEmails).toBe(false);
    } finally {
      renderer.stop();
      renderer.destroy();
    }
  });

  it('cross-folder second sync is blocked while first is pending', async () => {
    const fake = { syncAccountFolder: vi.fn() };
    let resolveSync!: (o: SyncOutcome) => void;
    fake.syncAccountFolder.mockReturnValueOnce(
      new Promise<SyncOutcome>((resolve) => { resolveSync = resolve; })
    );
    // Second slot (after first resolves) returns ok empty.
    fake.syncAccountFolder.mockResolvedValueOnce({
      kind: 'ok',
      folders: [
        makePersistedFolder({ id: 'work:INBOX', name: 'INBOX', fullName: 'INBOX', type: 'inbox' }),
        makePersistedFolder({ id: 'work:Sent', name: 'Sent', fullName: 'Sent', type: 'sent' }),
      ],
      messages: [],
    });
    const { app, renderer } = await makeApp(fake);
    try {
      const first = app.requestSync();
      expect(fake.syncAccountFolder).toHaveBeenCalledTimes(1);
      // Switch folder and try to sync the new folder while old sync pending.
      actions.setCurrentFolder('work:Sent');
      await app.requestSync();
      expect(fake.syncAccountFolder).toHaveBeenCalledTimes(1);
      resolveSync({ kind: 'no-account', message: 'noop' });
      await first;
      // After the first settles, a new sync may start.
      await app.requestSync();
      expect(fake.syncAccountFolder).toHaveBeenCalledTimes(2);
    } finally {
      renderer.stop();
      renderer.destroy();
    }
  });
});
