/**
 * Keyboard-first navigation: email and folder selection.
 *
 * Covers the MVP TUI contract:
 * - j/k (delta +1/-1) moves the email highlight, clamped at the ends,
 *   without opening the reading view.
 * - Enter (openSelectedEmail) opens the highlighted email; Escape
 *   (closeOpenedEmail) returns to the list preserving the highlight.
 * - h/l moves the folder selection, clearing any stale email selection
 *   and any open-email state.
 * - Navigation respects the search-active visible list.
 * - Empty lists are no-ops.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliRenderer } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../src/app/App.js';
import { getConfigStore, resetConfigStore } from '../../src/core/config/ConfigStore.js';
import { getDatabase, resetDatabase } from '../../src/core/database/Database.js';
import type { PersistedEmail } from '../../src/core/database/index.js';
import { actions, selectors } from '../../src/core/state/AppState.js';
import type { AccountConfig, AppConfig } from '../../src/core/types/config.js';

function makeAccountConfig(): AccountConfig {
  return {
    id: 'work',
    name: 'Work',
    email: 'me@example.com',
    enabled: true,
    host: 'imap.example.com',
    port: 993,
    useTls: true,
    authType: 'password',
  };
}

function makeEmail(id: string, subject: string): PersistedEmail {
  return {
    id,
    accountId: 'work',
    folderId: 'work:INBOX',
    messageId: `<${id}@example.com>`,
    fromAddresses: [],
    toAddresses: [],
    ccAddresses: [],
    subject,
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

describe('App keyboard navigation', () => {
  let renderer: CliRenderer | null = null;
  let app: App | null = null;
  let testDbPath = '';
  let testConfigPath = '';

  beforeEach(async () => {
    resetDatabase();
    resetConfigStore();
    actions.reset();
    testConfigPath = join(tmpdir(), `termail-nav-${Date.now()}-${Math.random()}-config.json`);
    testDbPath = join(tmpdir(), `termail-nav-${Date.now()}-${Math.random()}.sqlite`);
    const store = getConfigStore(testConfigPath);
    await store.initialize();
    await store.updateConfig({
      accounts: [makeAccountConfig()],
      database: { path: testDbPath },
    } as Partial<AppConfig>);
    const db = getDatabase(store.getConfig());
    await db.initialize();
    db.query(
      `INSERT INTO accounts (id, name, type, email, use_tls, auth_type) VALUES (?, ?, 'imap', ?, 1, 'password')`
    ).run('work', 'Work', 'me@example.com');
    db.query(
      'INSERT INTO folders (id, account_id, name, full_name, type, delimiter) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('work:INBOX', 'work', 'INBOX', 'INBOX', 'inbox', '/');
    db.query(
      'INSERT INTO folders (id, account_id, name, full_name, type, delimiter) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('work:Sent', 'work', 'Sent', 'Sent', 'sent', '/');

    renderer = (await createTestRenderer({ width: 120, height: 40 })).renderer;
    app = new App(renderer, { id: 'app-nav', initialTheme: 'dark' });
    for (let i = 0; i < 50; i += 1) {
      if (app.isInitialized()) break;
      await new Promise((r) => setTimeout(r, 5));
    }
  });

  afterEach(() => {
    actions.reset();
    try {
      app?.destroy();
    } catch {
      /* ignore */
    }
    app = null;
    if (renderer) {
      try {
        renderer.stop();
        renderer.destroy();
      } catch {
        /* ignore */
      }
      renderer = null;
    }
    resetDatabase();
    resetConfigStore();
    for (const p of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`, testConfigPath]) {
      if (p && existsSync(p)) rmSync(p);
    }
  });

  it('j selects the first email when nothing is selected, then moves forward clamped', () => {
    actions.setEmails([makeEmail('a', 'A'), makeEmail('b', 'B'), makeEmail('c', 'C')]);
    expect(selectors.selectedEmailId).toBeNull();
    app!.moveEmailSelection(1);
    expect(selectors.selectedEmailId).toBe('a');
    app!.moveEmailSelection(1);
    expect(selectors.selectedEmailId).toBe('b');
    app!.moveEmailSelection(1);
    expect(selectors.selectedEmailId).toBe('c');
    // Clamped at the end.
    app!.moveEmailSelection(1);
    expect(selectors.selectedEmailId).toBe('c');
  });

  it('k moves backward clamped and selects last when nothing is selected', () => {
    actions.setEmails([makeEmail('a', 'A'), makeEmail('b', 'B')]);
    app!.moveEmailSelection(-1);
    expect(selectors.selectedEmailId).toBe('b');
    app!.moveEmailSelection(-1);
    expect(selectors.selectedEmailId).toBe('a');
    app!.moveEmailSelection(-1);
    expect(selectors.selectedEmailId).toBe('a');
  });

  it('j/k move the highlight without opening the reading view', () => {
    actions.setEmails([makeEmail('a', 'A'), makeEmail('b', 'B')]);
    expect(selectors.selectedEmailId).toBeNull();
    expect(selectors.openedEmailId).toBeNull();
    app!.moveEmailSelection(1);
    expect(selectors.selectedEmailId).toBe('a');
    expect(selectors.openedEmailId).toBeNull();
    app!.moveEmailSelection(1);
    expect(selectors.selectedEmailId).toBe('b');
    expect(selectors.openedEmailId).toBeNull();
  });

  it('openSelectedEmail opens the highlight; closeOpenedEmail preserves it', () => {
    actions.setEmails([makeEmail('a', 'A')]);
    app!.moveEmailSelection(1);
    expect(selectors.selectedEmailId).toBe('a');
    app!.openSelectedEmail();
    expect(selectors.openedEmailId).toBe('a');
    app!.closeOpenedEmail();
    expect(selectors.openedEmailId).toBeNull();
    expect(selectors.selectedEmailId).toBe('a');
    // Second close is a no-op.
    app!.closeOpenedEmail();
    expect(selectors.selectedEmailId).toBe('a');
  });

  it('clearEmailSelection clears both highlight and open state', () => {
    actions.setEmails([makeEmail('a', 'A')]);
    app!.moveEmailSelection(1);
    app!.openSelectedEmail();
    expect(selectors.selectedEmailId).toBe('a');
    expect(selectors.openedEmailId).toBe('a');
    app!.clearEmailSelection();
    expect(selectors.selectedEmailId).toBeNull();
    expect(selectors.openedEmailId).toBeNull();
  });

  it('h/l moves folders and clears stale email selection and open state', () => {
    expect(selectors.currentFolderId).toBe('work:INBOX');
    actions.setEmails([makeEmail('a', 'A')]);
    app!.moveEmailSelection(1);
    app!.openSelectedEmail();
    expect(selectors.selectedEmailId).toBe('a');
    expect(selectors.openedEmailId).toBe('a');
    app!.moveFolderSelection(1);
    expect(selectors.currentFolderId).toBe('work:Sent');
    expect(selectors.selectedEmailId).toBeNull();
    expect(selectors.openedEmailId).toBeNull();
    app!.moveFolderSelection(-1);
    expect(selectors.currentFolderId).toBe('work:INBOX');
    // Clamped at the start.
    app!.moveFolderSelection(-1);
    expect(selectors.currentFolderId).toBe('work:INBOX');
  });

  it('navigation is a no-op on empty lists', () => {
    actions.setEmails([]);
    app!.moveEmailSelection(1);
    expect(selectors.selectedEmailId).toBeNull();
    app!.clearEmailSelection();
    expect(selectors.selectedEmailId).toBeNull();
  });

  it('email navigation respects the search-active visible list', () => {
    const inboxMail = makeEmail('inbox-1', 'inbox');
    const hit = { ...makeEmail('hit-1', 'hit'), folderId: 'work:INBOX' };
    actions.setEmails([inboxMail]);
    actions.setSearchActive(true);
    actions.setSearchHits([hit]);
    app!.moveEmailSelection(1);
    expect(selectors.selectedEmailId).toBe('hit-1');
    app!.clearEmailSelection();
    actions.clearSearch();
    app!.moveEmailSelection(1);
    expect(selectors.selectedEmailId).toBe('inbox-1');
  });
});
