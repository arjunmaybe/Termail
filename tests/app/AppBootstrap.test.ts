/**
 * App fresh-account bootstrap: `requestSync` with an account but no
 * persisted folders discovers via `SyncService.syncAccount`.
 *
 * - Success applies folders, selects INBOX, shows messages.
 * - Message failure preserves discovered folders while surfacing error.
 * - Concurrent second sync while bootstrapping is blocked (single-flight).
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigStore, resetConfigStore } from '../../src/core/config/ConfigStore.js';
import { getDatabase, resetDatabase } from '../../src/core/database/Database.js';
import type { PersistedEmail, PersistedFolder } from '../../src/core/database/index.js';
import { actions, selectors } from '../../src/core/state/AppState.js';
import type { SyncOutcome } from '../../src/app/services/SyncService.js';
import type { AccountConfig, AppConfig } from '../../src/core/types/config.js';

function makeAccountConfig(): AccountConfig {
  return {
    id: 'personal',
    name: 'Personal',
    email: 'me@gmail.com',
    enabled: true,
    host: 'imap.gmail.com',
    port: 993,
    useTls: true,
    authType: 'password',
  };
}

function makeFolder(over: Partial<PersistedFolder> = {}): PersistedFolder {
  return {
    id: 'personal:INBOX',
    accountId: 'personal',
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

function makeEmail(id: string): PersistedEmail {
  return {
    id,
    accountId: 'personal',
    folderId: 'personal:INBOX',
    messageId: `<${id}@gmail.com>`,
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
  };
}

describe('App.requestSync fresh-account bootstrap', () => {
  let testDbPath = '';
  let testConfigPath = '';

  beforeEach(async () => {
    resetDatabase();
    resetConfigStore();
    actions.reset();
    testConfigPath = join(tmpdir(), `termail-appboot-${Date.now()}-${Math.random()}-config.json`);
    testDbPath = join(tmpdir(), `termail-appboot-${Date.now()}-${Math.random()}.sqlite`);
    const store = getConfigStore(testConfigPath);
    await store.initialize();
    await store.updateConfig({
      accounts: [makeAccountConfig()],
      database: { path: testDbPath },
    } as Partial<AppConfig>);
    const db = getDatabase(store.getConfig());
    await db.initialize();
    // Seed account row only — no folders (fresh Gmail account).
    db.query(
      "INSERT INTO accounts (id, name, type, email, use_tls, auth_type) VALUES (?, ?, 'imap', ?, 1, 'password')"
    ).run('personal', 'Personal', 'me@gmail.com');
  });

  afterEach(() => {
    actions.reset();
    resetDatabase();
    resetConfigStore();
    for (const p of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`, testConfigPath]) {
      if (p && existsSync(p)) rmSync(p);
    }
  });

  async function makeApp(fake: {
    syncAccountFolder: ReturnType<typeof vi.fn>;
    syncAccount?: ReturnType<typeof vi.fn>;
  }) {
    const { App } = await import('../../src/app/App.js');
    const renderer = await import('@opentui/core').then((m) =>
      m.createCliRenderer({ useMouse: false, exitOnCtrlC: false })
    );
    const app = new App(renderer, {
      id: 'app-boot',
      initialTheme: 'dark',
      syncService: fake as never,
    });
    for (let i = 0; i < 50; i += 1) {
      if (app.isInitialized()) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    return { app, renderer };
  }

  it('bootstraps folders and messages on first r with no persisted folders', async () => {
    const inbox = makeFolder();
    const sent = makeFolder({
      id: 'personal:Sent',
      name: 'Sent',
      fullName: 'Sent',
      type: 'sent',
    });
    const fake = {
      syncAccountFolder: vi.fn(),
      syncAccount: vi.fn().mockResolvedValue({
        kind: 'ok',
        folders: [inbox, sent],
        messages: [makeEmail('personal:INBOX:1')],
      } satisfies SyncOutcome),
    };
    const { app, renderer } = await makeApp(fake);
    try {
      expect(selectors.currentAccountId).toBe('personal');
      expect(selectors.currentFolderId).toBeNull();
      await app.requestSync();
      expect(fake.syncAccount).toHaveBeenCalledTimes(1);
      expect(fake.syncAccountFolder).not.toHaveBeenCalled();
      // INBOX preferred as default.
      expect(selectors.currentFolderId).toBe('personal:INBOX');
      expect(selectors.folders.map((f) => f.fullName).sort()).toEqual(['INBOX', 'Sent']);
      expect(selectors.emails).toHaveLength(1);
      expect(selectors.syncStatus).toBe('success');
      expect(selectors.syncError).toBeNull();
    } finally {
      renderer.stop();
      renderer.destroy();
    }
  });

  it('preserves discovered folders when bootstrap message sync fails', async () => {
    const inbox = makeFolder();
    const fake = {
      syncAccountFolder: vi.fn(),
      // Simulate SyncService.syncAccount persisting INBOX before failing:
      // the fake writes the folder row directly, then returns network.
      syncAccount: vi.fn().mockImplementation(async () => {
        const { MessageRepository } = await import(
          '../../src/core/database/MessageRepository.js'
        );
        const db = getDatabase(getConfigStore().getConfig());
        const repo = new MessageRepository(db);
        repo.ensureAccountRow({
          id: 'personal',
          name: 'Personal',
          email: 'me@gmail.com',
          host: 'imap.gmail.com',
          port: 993,
          useTls: true,
          authType: 'password',
        });
        repo.ensureFolderRow('personal', {
          path: 'INBOX',
          displayName: 'INBOX',
          delimiter: '/',
          flags: [],
          specialUse: 'inbox',
          type: 'inbox',
          selectable: true,
          parentPath: null,
          depth: 0,
        });
        return { kind: 'network', message: 'fetch exploded' } satisfies SyncOutcome;
      }),
    };
    const { app, renderer } = await makeApp(fake);
    try {
      await app.requestSync();
      expect(selectors.syncStatus).toBe('error');
      expect(selectors.syncError).toBe('fetch exploded');
      // Folders preserved despite failure; no misleading messages.
      expect(selectors.folders.map((f) => f.fullName)).toEqual(['INBOX']);
      expect(selectors.emails).toEqual([]);
    } finally {
      renderer.stop();
      renderer.destroy();
    }
  });

  it('blocks a second r while bootstrapping (single-flight)', async () => {
    let resolveBoot!: (o: SyncOutcome) => void;
    const fake = {
      syncAccountFolder: vi.fn(),
      syncAccount: vi.fn().mockReturnValueOnce(
        new Promise<SyncOutcome>((resolve) => {
          resolveBoot = resolve;
        })
      ),
    };
    const { app, renderer } = await makeApp(fake);
    try {
      const first = app.requestSync();
      await app.requestSync();
      expect(fake.syncAccount).toHaveBeenCalledTimes(1);
      resolveBoot({ kind: 'no-folder', message: 'No folders found on server' });
      await first;
      expect(selectors.syncStatus).toBe('error');
      expect(selectors.syncError).toMatch(/folder/i);
    } finally {
      renderer.stop();
      renderer.destroy();
    }
  });
});
