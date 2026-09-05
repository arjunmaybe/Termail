/**
 * Phase 2.5 — `App.requestSync()` end-to-end tests.
 *
 * Exercises the orchestrator (App) without rendering a real TUI. The
 * `SyncService` is faked so we can drive the success and failure
 * paths deterministically. The `ConfigStore` and `Database` are
 * real, against tmp-file paths, so the load-folder / load-email
 * reads go through the real repository.
 */

import { existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigStore, resetConfigStore } from '../../src/core/config/ConfigStore.js';
import { getDatabase, resetDatabase } from '../../src/core/database/Database.js';
import { actions, selectors } from '../../src/core/state/AppState.js';
import { SyncService, type SyncOutcome } from '../../src/app/services/SyncService.js';
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

interface FakeSyncService {
  syncAccountFolder: ReturnType<typeof vi.fn>;
}

function makeFakeSyncService(): FakeSyncService {
  return {
    syncAccountFolder: vi.fn(),
  };
}

describe('App.requestSync', () => {
  let testDbPath: string;
  let testConfigPath: string;

  beforeEach(async () => {
    resetDatabase();
    resetConfigStore();
    actions.reset();
    testConfigPath = join(tmpdir(), `termail-app-${Date.now()}-config.json`);
    testDbPath = join(tmpdir(), `termail-app-${Date.now()}.sqlite`);

    const configStore = getConfigStore(testConfigPath);
    await configStore.initialize();
    const account = makeAccountConfig();
    await configStore.updateConfig({
      accounts: [account],
      database: { path: testDbPath },
    } as Partial<AppConfig>);
    const database = getDatabase(configStore.getConfig());
    await database.initialize();

    // Seed an INBOX folder so the App's initialize() picks up a current
    // folder and `requestSync()` has a target to sync.
    database.query(
      `INSERT INTO accounts (id, name, type, email, use_tls, auth_type)
       VALUES (?, ?, 'imap', ?, 1, 'password')`
    ).run('work', 'Work', 'me@example.com');
    database.query(
      `INSERT INTO folders (id, account_id, name, full_name, type, delimiter)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('work:INBOX', 'work', 'INBOX', 'INBOX', 'inbox', '/');
  });

  afterEach(() => {
    actions.reset();
    resetDatabase();
    resetConfigStore();
    for (const p of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`, testConfigPath]) {
      if (existsSync(p)) rmSync(p);
    }
  });

  /** Spin up a fresh App with a fake SyncService. */
  async function makeApp(fake: FakeSyncService) {
    const { App } = await import('../../src/app/App.js');
    const configStore = getConfigStore();
    const config = configStore.getConfig();
    const database = getDatabase(config);
    const syncService = new SyncService(database) as unknown as SyncService;
    Object.assign(syncService, fake);
    // Constructing App triggers `initialize()` which itself calls
    // `setAccounts` and `setFolders` based on the config + DB.
    const renderer = await import('@opentui/core').then((m) =>
      m.createCliRenderer({ useMouse: false, exitOnCtrlC: false })
    );
    const app = new App(renderer, {
      id: 'app',
      initialTheme: 'dark',
      syncService: fake as unknown as SyncService,
    });
    // Wait for initialize() to finish.
    for (let i = 0; i < 50; i += 1) {
      if (app.isInitialized()) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    return { app, renderer };
  }

  /** Drive a `r` keypress through the real App, returning once async work settles. */
  async function pressR(app: { requestSync: () => Promise<void> }): Promise<void> {
    await app.requestSync();
  }

  it('calls setSyncStatus("syncing") then setSyncStatus("success") on a successful sync', async () => {
    const fake = makeFakeSyncService();
    const okOutcome: SyncOutcome = {
      kind: 'ok',
      folders: [
        {
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
        },
      ],
      messages: [],
    };
    fake.syncAccountFolder.mockResolvedValueOnce(okOutcome);

    const { app, renderer } = await makeApp(fake);
    try {
      // Pre-condition: status is idle, and a folder is selected by
      // default (setFolders auto-selects inbox).
      expect(selectors.currentAccountId).toBe('work');
      expect(selectors.currentFolderId).toBe('work:INBOX');

      await pressR(app);
      expect(fake.syncAccountFolder).toHaveBeenCalledTimes(1);
      expect(selectors.syncStatus).toBe('success');
      expect(selectors.syncError).toBeNull();
      expect(selectors.emails).toEqual([]);
    } finally {
      renderer.stop();
      renderer.destroy();
    }
  });

  it('is a no-op when a sync for the same (account, folder) is already in flight', async () => {
    const fake = makeFakeSyncService();
    let resolveSync!: (outcome: SyncOutcome) => void;
    fake.syncAccountFolder.mockReturnValueOnce(
      new Promise<SyncOutcome>((resolve) => {
        resolveSync = resolve;
      })
    );
    const { app, renderer } = await makeApp(fake);
    try {
      const first = app.requestSync();
      // Second press while the first is still pending.
      await app.requestSync();
      // Only one service call was made.
      expect(fake.syncAccountFolder).toHaveBeenCalledTimes(1);
      // Now resolve the first one so the test cleans up.
      resolveSync({ kind: 'no-account', message: 'noop' });
      await first;
    } finally {
      renderer.stop();
      renderer.destroy();
    }
  });

  it('sets sync error when there is no current account', async () => {
    const fake = makeFakeSyncService();
    // Start a fresh App with a config that has no accounts.
    resetConfigStore();
    resetDatabase();
    const tag = `empty-${Date.now()}-${Math.random()}`;
    const emptyConfigPath = join(tmpdir(), `termail-app-${tag}-config.json`);
    const emptyDbPath = join(tmpdir(), `termail-app-${tag}.sqlite`);
    const configStore = getConfigStore(emptyConfigPath);
    await configStore.initialize();
    await configStore.updateConfig({
      accounts: [],
      database: { path: emptyDbPath },
    } as Partial<AppConfig>);
    const emptyDb = getDatabase(configStore.getConfig());
    await emptyDb.initialize();
    const { App } = await import('../../src/app/App.js');
    const renderer = await import('@opentui/core').then((m) =>
      m.createCliRenderer({ useMouse: false, exitOnCtrlC: false })
    );
    const app = new App(renderer, {
      id: 'app-empty',
      initialTheme: 'dark',
      syncService: fake as unknown as SyncService,
    });
    for (let i = 0; i < 50; i += 1) {
      if (app.isInitialized()) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    try {
      expect(selectors.currentAccountId).toBeNull();
      await pressR(app);
      expect(fake.syncAccountFolder).not.toHaveBeenCalled();
      expect(selectors.syncStatus).toBe('error');
      expect(selectors.syncError).toMatch(/account/i);
    } finally {
      renderer.stop();
      renderer.destroy();
      resetDatabase();
      for (const p of [emptyDbPath, `${emptyDbPath}-wal`, `${emptyDbPath}-shm`, emptyConfigPath]) {
        if (existsSync(p)) rmSync(p);
      }
    }
  });

  it('sets sync error when there is no current folder', async () => {
    const fake = makeFakeSyncService();
    // Start a fresh App with a config that has an account but no folders.
    resetConfigStore();
    resetDatabase();
    const tag = `nof-${Date.now()}-${Math.random()}`;
    const noFolderConfigPath = join(tmpdir(), `termail-app-${tag}-config.json`);
    const noFolderDbPath = join(tmpdir(), `termail-app-${tag}.sqlite`);
    const configStore = getConfigStore(noFolderConfigPath);
    await configStore.initialize();
    await configStore.updateConfig({
      accounts: [makeAccountConfig()],
      database: { path: noFolderDbPath },
    } as Partial<AppConfig>);
    const noFolderDb = getDatabase(configStore.getConfig());
    await noFolderDb.initialize();
    // Seed the account row but no folders.
    noFolderDb.query(
      `INSERT INTO accounts (id, name, type, email, use_tls, auth_type)
       VALUES (?, ?, 'imap', ?, 1, 'password')`
    ).run('work', 'Work', 'me@example.com');
    const { App } = await import('../../src/app/App.js');
    const renderer = await import('@opentui/core').then((m) =>
      m.createCliRenderer({ useMouse: false, exitOnCtrlC: false })
    );
    const app = new App(renderer, {
      id: 'app-nofolder',
      initialTheme: 'dark',
      syncService: fake as unknown as SyncService,
    });
    for (let i = 0; i < 50; i += 1) {
      if (app.isInitialized()) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    try {
      expect(selectors.currentAccountId).toBe('work');
      expect(selectors.currentFolderId).toBeNull();
      await pressR(app);
      expect(fake.syncAccountFolder).not.toHaveBeenCalled();
      expect(selectors.syncError).toMatch(/folder/i);
    } finally {
      renderer.stop();
      renderer.destroy();
      resetDatabase();
      for (const p of [noFolderDbPath, `${noFolderDbPath}-wal`, `${noFolderDbPath}-shm`, noFolderConfigPath]) {
        if (existsSync(p)) rmSync(p);
      }
    }
  });

  it('maps a service "auth" outcome to syncError', async () => {
    const fake = makeFakeSyncService();
    fake.syncAccountFolder.mockResolvedValueOnce({
      kind: 'auth',
      message: 'bad password',
    });
    const { app, renderer } = await makeApp(fake);
    try {
      await pressR(app);
      expect(selectors.syncError).toBe('bad password');
      expect(selectors.syncStatus).toBe('error');
    } finally {
      renderer.stop();
      renderer.destroy();
    }
  });

  it('maps a service "network" outcome to syncError', async () => {
    const fake = makeFakeSyncService();
    fake.syncAccountFolder.mockResolvedValueOnce({
      kind: 'network',
      message: 'ECONNREFUSED',
    });
    const { app, renderer } = await makeApp(fake);
    try {
      await pressR(app);
      expect(selectors.syncError).toBe('ECONNREFUSED');
      expect(selectors.syncStatus).toBe('error');
    } finally {
      renderer.stop();
      renderer.destroy();
    }
  });
});
