/**
 * Keyboard-first navigation: email and folder selection.
 *
 * Covers the MVP TUI contract:
 * - j/k (delta +1/-1) moves the email selection, clamped at the ends.
 * - h/l moves the folder selection, clearing any stale email selection.
 * - Esc (clearEmailSelection) returns to the list view.
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

  it('clearEmailSelection returns to the list view', () => {
    actions.setEmails([makeEmail('a', 'A')]);
    app!.moveEmailSelection(1);
    expect(selectors.selectedEmailId).toBe('a');
    app!.clearEmailSelection();
    expect(selectors.selectedEmailId).toBeNull();
    // Second clear is a no-op.
    app!.clearEmailSelection();
    expect(selectors.selectedEmailId).toBeNull();
  });

  it('h/l moves folders and clears stale email selection', () => {
    expect(selectors.currentFolderId).toBe('work:INBOX');
    actions.setEmails([makeEmail('a', 'A')]);
    app!.moveEmailSelection(1);
    expect(selectors.selectedEmailId).toBe('a');
    app!.moveFolderSelection(1);
    expect(selectors.currentFolderId).toBe('work:Sent');
    expect(selectors.selectedEmailId).toBeNull();
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
