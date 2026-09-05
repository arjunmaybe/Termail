/**
 * Phase 3.3 — App-level search orchestration tests.
 *
 * Verifies that `app.openSearch / pushChar / popChar / submitSearch /
 * cancelSearch / isSearchActive` drive `AppState` correctly and that
 * the resulting `searchHits` come from a real `SearchService` over a
 * real `SearchRepository` against a real `Database`.
 *
 * We do NOT exercise `main.ts` here; the main.ts keypress switch is
 * covered by the dedicated end-to-end test for the TUI.
 */

import { existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../src/app/App.js';
import { getConfigStore, resetConfigStore } from '../../src/core/config/ConfigStore.js';
import { getDatabase, resetDatabase } from '../../src/core/database/Database.js';
import { MessageRepository } from '../../src/core/database/MessageRepository.js';
import type { PersistedEmail, SafeAccountInput } from '../../src/core/database/MessageRepository.js';
import { actions, selectors } from '../../src/core/state/AppState.js';
import type { ParseIssue } from '../../src/core/search/SearchQueryParser.js';
import type { SyncFolder } from '../../src/core/imap/folders.js';
import type { SyncMessage } from '../../src/core/imap/types.js';
import type { AccountConfig, AppConfig } from '../../src/core/types/config.js';
import type { Account } from '../../src/core/types/index.js';

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

const safeAccount: SafeAccountInput = {
  id: 'work',
  name: 'Work',
  email: 'me@example.com',
  host: 'imap.example.com',
  port: 993,
  username: 'me',
  useTls: true,
  authType: 'password',
};

const inboxFolder: SyncFolder = {
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
    messageId: `<msg-${uid}@example.com>`,
    folder: 'INBOX',
    accountId: 'work',
    from: [],
    to: [],
    cc: [],
    subject: 'Hello world',
    date: new Date('2026-01-01T10:00:00Z'),
    internalDate: new Date('2026-01-01T10:00:00Z'),
    receivedAt: new Date('2026-01-01T10:00:05Z'),
    isRead: false,
    isFlagged: false,
    isAnswered: false,
    isDraft: false,
    size: 1024,
    textBody: 'body',
    hasHtmlBody: false,
    attachments: [],
    flags: [],
    ...over,
  };
}

async function makeApp(): Promise<{ app: App; renderer: Awaited<ReturnType<typeof import('@opentui/core').createCliRenderer>> }> {
  const configStore = getConfigStore();
  const config = configStore.getConfig();
  const database = getDatabase(config);

  const rendererMod = await import('@opentui/core');
  const renderer = await rendererMod.createCliRenderer({
    useMouse: false,
    exitOnCtrlC: false,
  });
  const app = new App(renderer, { id: 'app', initialTheme: 'dark' });

  // Wait for `initialize()` to finish so the search controller is
  // available.
  for (let i = 0; i < 100; i += 1) {
    if (app.isInitialized()) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  return { app, renderer };
}

describe('App search orchestration', () => {
  let testDbPath: string;
  let testConfigPath: string;
  // Snapshot the search signals so parallel test files are not
  // clobbered by our writes.
  let savedSearchActive: boolean;
  let savedSearchQuery: string;
  let savedSearchHits: PersistedEmail[] | null;
  let savedSearchIssues: ParseIssue[];
  let savedSearchError: string | null;
  let savedAccounts: Account[];
  let savedCurrentAccountId: string | null;

  beforeEach(async () => {
    savedSearchActive = selectors.searchActive;
    savedSearchQuery = selectors.searchQuery;
    savedSearchHits = selectors.searchHits;
    savedSearchIssues = selectors.searchIssues;
    savedSearchError = selectors.searchError;
    savedAccounts = selectors.accounts;
    savedCurrentAccountId = selectors.currentAccountId;

    resetDatabase();
    resetConfigStore();
    testConfigPath = join(tmpdir(), `termail-appsearch-${Date.now()}-config.json`);
    testDbPath = join(tmpdir(), `termail-appsearch-${Date.now()}.sqlite`);

    const configStore = getConfigStore(testConfigPath);
    await configStore.initialize();
    await configStore.updateConfig({
      accounts: [baseAccount],
      database: { path: testDbPath },
    } as Partial<AppConfig>);

    const database = getDatabase(configStore.getConfig());
    await database.initialize();

    const messageRepo = new MessageRepository(database);
    messageRepo.upsertMessages(safeAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'Budget review', isRead: false }),
      makeMessage({ uid: 2, subject: 'Lunch tomorrow?', isRead: true }),
    ]);
  });

  afterEach(() => {
    actions.setSearchActive(savedSearchActive);
    actions.setSearchQuery(savedSearchQuery);
    actions.setSearchHits(savedSearchHits);
    actions.setSearchIssues(savedSearchIssues);
    actions.setSearchError(savedSearchError);
    actions.setAccounts(savedAccounts);
    if (savedCurrentAccountId !== null) {
      actions.setCurrentAccount(savedCurrentAccountId);
    }
    resetDatabase();
    resetConfigStore();
    for (const p of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`, testConfigPath]) {
      if (existsSync(p)) rmSync(p);
    }
  });

  it('isSearchActive() returns false before openSearch() and true after', async () => {
    const { app, renderer } = await makeApp();
    try {
      expect(app.isSearchActive()).toBe(false);
      app.openSearch();
      expect(app.isSearchActive()).toBe(true);
      app.cancelSearch();
      expect(app.isSearchActive()).toBe(false);
    } finally {
      app.destroy();
      renderer.stop();
      renderer.destroy();
    }
  });

  it('openSearch() clears any prior search state', async () => {
    const { app, renderer } = await makeApp();
    try {
      // Pre-seed state.
      actions.setSearchQuery('leftover');
      actions.setSearchError('prior error');

      app.openSearch();

      expect(selectors.searchActive).toBe(true);
      expect(selectors.searchQuery).toBe('');
      expect(selectors.searchError).toBeNull();
      expect(selectors.searchHits).toBeNull();
    } finally {
      app.destroy();
      renderer.stop();
      renderer.destroy();
    }
  });

  it('pushChar / popChar mutate the buffer via AppState', async () => {
    const { app, renderer } = await makeApp();
    try {
      app.openSearch();
      app.pushChar('b');
      app.pushChar('u');
      app.pushChar('d');
      app.pushChar('g');
      app.pushChar('e');
      app.pushChar('t');
      expect(selectors.searchQuery).toBe('budget');

      app.popChar();
      expect(selectors.searchQuery).toBe('budge');
    } finally {
      app.destroy();
      renderer.stop();
      renderer.destroy();
    }
  });

  it('submitSearch() with an empty buffer is a no-op', async () => {
    const { app, renderer } = await makeApp();
    try {
      app.openSearch();
      await app.submitSearch();
      expect(selectors.searchHits).toBeNull();
      expect(selectors.searchError).toBeNull();
    } finally {
      app.destroy();
      renderer.stop();
      renderer.destroy();
    }
  });

  it('submitSearch() dispatches repository hits into searchHits', async () => {
    const { app, renderer } = await makeApp();
    try {
      app.openSearch();
      for (const ch of 'budget') app.pushChar(ch);
      await app.submitSearch();

      expect(selectors.searchError).toBeNull();
      expect(selectors.searchHits).not.toBeNull();
      expect(selectors.searchHits).toHaveLength(1);
      expect(selectors.searchHits?.[0]?.subject).toBe('Budget review');
    } finally {
      app.destroy();
      renderer.stop();
      renderer.destroy();
    }
  });

  it('submitSearch() with is:unread operator narrows to one hit', async () => {
    const { app, renderer } = await makeApp();
    try {
      app.openSearch();
      for (const ch of 'is:unread') app.pushChar(ch);
      await app.submitSearch();

      expect(selectors.searchError).toBeNull();
      expect(selectors.searchHits).toHaveLength(1);
      expect(selectors.searchHits?.[0]?.isRead).toBe(false);
    } finally {
      app.destroy();
      renderer.stop();
      renderer.destroy();
    }
  });

  it('submitSearch() with a malformed query surfaces an issue', async () => {
    const { app, renderer } = await makeApp();
    try {
      app.openSearch();
      // An unterminated quote is a parser issue, not a throw.
      for (const ch of '"unterminated') app.pushChar(ch);
      await app.submitSearch();

      expect(selectors.searchError).toBeNull();
      expect(selectors.searchIssues.length).toBeGreaterThan(0);
    } finally {
      app.destroy();
      renderer.stop();
      renderer.destroy();
    }
  });

  it('cancelSearch() returns to the normal TUI', async () => {
    const { app, renderer } = await makeApp();
    try {
      app.openSearch();
      app.pushChar('h');
      app.pushChar('i');
      expect(selectors.searchQuery).toBe('hi');
      expect(selectors.searchActive).toBe(true);

      app.cancelSearch();
      expect(selectors.searchActive).toBe(false);
      expect(selectors.searchQuery).toBe('');
      expect(app.isSearchActive()).toBe(false);
    } finally {
      app.destroy();
      renderer.stop();
      renderer.destroy();
    }
  });

  it('a search run followed by a folder change preserves search state until cancel', async () => {
    const { app, renderer } = await makeApp();
    try {
      app.openSearch();
      for (const ch of 'budget') app.pushChar(ch);
      await app.submitSearch();
      expect(selectors.searchHits).toHaveLength(1);

      // Switch folders; the search stays active (the TUI keeps the
      // hits visible until the user cancels or starts a new search).
      actions.setCurrentFolder('work:INBOX');
      expect(selectors.searchActive).toBe(true);
      expect(selectors.searchHits).toHaveLength(1);

      app.cancelSearch();
      expect(selectors.searchHits).toBeNull();
    } finally {
      app.destroy();
      renderer.stop();
      renderer.destroy();
    }
  });

  it('submitSearch() reports an error string when the database is closed', async () => {
    const { app, renderer } = await makeApp();
    try {
      // Close the underlying database so the next SQL call throws.
      const configStore = getConfigStore();
      const config = configStore.getConfig();
      const database = getDatabase(config);
      database.close();

      app.openSearch();
      for (const ch of 'budget') app.pushChar(ch);
      await app.submitSearch();

      expect(typeof selectors.searchError).toBe('string');
      expect(selectors.searchHits).toEqual([]);
    } finally {
      app.destroy();
      renderer.stop();
      renderer.destroy();
    }
  });
});
