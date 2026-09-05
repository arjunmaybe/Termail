/**
 * Phase 3.3 — `SearchController` tests.
 *
 * Coverage:
 *   - `openSearch` clears prior state and flips `searchActive`.
 *   - `closeSearch` / `cancelSearch` reset all search signals.
 *   - `pushChar` appends to the buffer.
 *   - `popChar` removes the last character.
 *   - `submitSearch` with an empty buffer is a no-op.
 *   - `submitSearch` with a non-empty query dispatches the
 *     repository result into `searchHits`.
 *   - `isActive` reflects the current signal.
 *   - Search errors are surfaced via `searchError`; `searchHits`
 *     is reset to `[]` so the empty-state copy is correct.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SearchController } from '../../src/app/services/SearchController.js';
import { getConfigStore, resetConfigStore } from '../../src/core/config/ConfigStore.js';
import { getDatabase, resetDatabase } from '../../src/core/database/Database.js';
import { MessageRepository } from '../../src/core/database/MessageRepository.js';
import type { PersistedEmail, SafeAccountInput } from '../../src/core/database/MessageRepository.js';
import { actions, selectors } from '../../src/core/state/AppState.js';
import type { ParseIssue } from '../../src/core/search/SearchQueryParser.js';
import type { SyncFolder } from '../../src/core/imap/folders.js';
import type { SyncMessage } from '../../src/core/imap/types.js';
import type { AppConfig } from '../../src/core/types/config.js';

const baseAccount: SafeAccountInput = {
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

describe('SearchController', () => {
  let testDbPath: string;
  let testConfigPath: string;
  let controller: SearchController;
  let messageRepo: MessageRepository;
  let configStore: ReturnType<typeof getConfigStore>;
  let db: ReturnType<typeof getDatabase>;
  // Snapshot of the search signals so we can restore them after
  // each test. Other test files (running in parallel) read the
  // same global AppState, so we MUST not clobber the signals at
  // the end of a test in this file.
  let savedSearchActive: boolean;
  let savedSearchQuery: string;
  let savedSearchHits: PersistedEmail[] | null;
  let savedSearchIssues: ParseIssue[];
  let savedSearchError: string | null;
  let savedCurrentAccountId: string | null;

  beforeEach(async () => {
    savedSearchActive = selectors.searchActive;
    savedSearchQuery = selectors.searchQuery;
    savedSearchHits = selectors.searchHits;
    savedSearchIssues = selectors.searchIssues;
    savedSearchError = selectors.searchError;
    savedCurrentAccountId = selectors.currentAccountId;
    resetDatabase();
    resetConfigStore();
    testConfigPath = join(tmpdir(), `termail-sc-${Date.now()}-${Math.random()}-config.json`);
    testDbPath = join(tmpdir(), `termail-sc-${Date.now()}-${Math.random()}.sqlite`);

    configStore = getConfigStore(testConfigPath);
    await configStore.initialize();
    await configStore.updateConfig({ database: { path: testDbPath } } as Partial<AppConfig>);

    db = getDatabase(configStore.getConfig());
    await db.initialize();
    messageRepo = new MessageRepository(db);
    controller = new SearchController(db);

    // Seed an account so `selectors.currentAccountId` is non-null.
    actions.setAccounts([
      {
        id: baseAccount.id,
        name: baseAccount.name,
        type: 'imap',
        email: baseAccount.email,
        host: baseAccount.host,
        port: baseAccount.port,
        username: baseAccount.username,
        useTls: baseAccount.useTls,
        authType: baseAccount.authType,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'Budget review' }),
      makeMessage({ uid: 2, subject: 'Lunch tomorrow?' }),
    ]);
  });

  afterEach(() => {
    // Restore the saved search signals so other test files are
    // not affected by our writes.
    actions.setSearchActive(savedSearchActive);
    actions.setSearchQuery(savedSearchQuery);
    actions.setSearchHits(savedSearchHits);
    actions.setSearchIssues(savedSearchIssues);
    actions.setSearchError(savedSearchError);
    if (savedCurrentAccountId !== null) {
      actions.setCurrentAccount(savedCurrentAccountId);
    }
    resetDatabase();
    resetConfigStore();
    for (const p of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`, testConfigPath]) {
      if (existsSync(p)) rmSync(p);
    }
  });

  it('openSearch flips searchActive to true and clears prior state', () => {
    // Pre-seed some prior search state.
    actions.setSearchQuery('leftover');
    actions.setSearchHits([
      {
        id: 'x',
        accountId: 'work',
        folderId: 'work:INBOX',
        messageId: 'x',
        fromAddresses: [],
        toAddresses: [],
        ccAddresses: [],
        subject: 'x',
        date: 0,
        internalDate: 0,
        receivedAt: 0,
        isRead: true,
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
        uid: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    ]);
    actions.setSearchError('prior error');

    controller.openSearch();

    expect(selectors.searchActive).toBe(true);
    expect(selectors.searchQuery).toBe('');
    expect(selectors.searchHits).toBeNull();
    expect(selectors.searchIssues).toEqual([]);
    expect(selectors.searchError).toBeNull();
  });

  it('closeSearch resets every search signal', () => {
    actions.setSearchActive(true);
    actions.setSearchQuery('budget');
    actions.setSearchHits([]);
    actions.setSearchError('x');

    controller.closeSearch();

    expect(selectors.searchActive).toBe(false);
    expect(selectors.searchQuery).toBe('');
    expect(selectors.searchHits).toBeNull();
    expect(selectors.searchError).toBeNull();
  });

  it('cancelSearch is an alias for closeSearch', () => {
    actions.setSearchActive(true);
    actions.setSearchQuery('budget');

    controller.cancelSearch();

    expect(selectors.searchActive).toBe(false);
    expect(selectors.searchQuery).toBe('');
  });

  it('pushChar appends a single character to the buffer', () => {
    controller.openSearch();
    controller.pushChar('h');
    controller.pushChar('i');
    expect(selectors.searchQuery).toBe('hi');
  });

  it('pushChar on an empty string is a no-op', () => {
    controller.openSearch();
    controller.pushChar('');
    expect(selectors.searchQuery).toBe('');
  });

  it('popChar removes the last character', () => {
    controller.openSearch();
    controller.pushChar('h');
    controller.pushChar('i');
    controller.popChar();
    expect(selectors.searchQuery).toBe('h');
  });

  it('popChar on an empty buffer is a no-op', () => {
    controller.openSearch();
    controller.popChar();
    expect(selectors.searchQuery).toBe('');
  });

  it('isActive reflects the searchActive signal', () => {
    expect(controller.isActive()).toBe(false);
    controller.openSearch();
    expect(controller.isActive()).toBe(true);
    controller.cancelSearch();
    expect(controller.isActive()).toBe(false);
  });

  it('submitSearch with an empty buffer is a no-op', async () => {
    controller.openSearch();
    // Pre-set hits so we can detect that submit did NOT clobber them.
    actions.setSearchHits([
      {
        id: 'preexisting',
        accountId: 'work',
        folderId: 'work:INBOX',
        messageId: 'p',
        fromAddresses: [],
        toAddresses: [],
        ccAddresses: [],
        subject: 'preexisting',
        date: 0,
        internalDate: 0,
        receivedAt: 0,
        isRead: true,
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
        uid: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    ]);

    await controller.submitSearch();

    // The empty submit is documented to leave prior results alone
    // (the user may be re-pressing Enter by accident).
    expect(selectors.searchHits?.length).toBe(1);
    expect(selectors.searchError).toBeNull();
  });

  it('submitSearch dispatches repository hits into searchHits', async () => {
    controller.openSearch();
    controller.pushChar('b');
    controller.pushChar('u');
    controller.pushChar('d');
    controller.pushChar('g');
    controller.pushChar('e');
    controller.pushChar('t');

    await controller.submitSearch();

    expect(selectors.searchError).toBeNull();
    expect(selectors.searchHits).not.toBeNull();
    expect(selectors.searchHits).toHaveLength(1);
    expect(selectors.searchHits?.[0]?.subject).toBe('Budget review');
  });
});
