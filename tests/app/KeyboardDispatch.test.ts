/**
 * Keyboard dispatch regression tests.
 *
 * These tests exercise the real keypress routing function
 * (`routeKeypress` from `src/app/KeyRouter.ts`) — the same function
 * that `main.ts` calls from its `renderer.keyInput.on('keypress')`
 * handler. Each test simulates a keypress by calling `routeKeypress`
 * with a key name, then asserts the resulting state change.
 *
 * This verifies the actual key-to-action mappings, not just the
 * underlying `App` methods in isolation.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliRenderer } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../src/app/App.js';
import { routeKeypress } from '../../src/app/KeyRouter.js';
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

/**
 * Simulate a keypress by calling `routeKeypress` — the exact function
 * that `main.ts` wires to `renderer.keyInput.on('keypress')`.
 */
function press(keyName: string, app: App, onShutdown: () => void = () => {}): void {
  routeKeypress({ name: keyName }, app, { onShutdown });
}

describe('Keyboard dispatch via routeKeypress', () => {
  let renderer: CliRenderer | null = null;
  let app: App | null = null;
  let testDbPath = '';
  let testConfigPath = '';
  let shutdownCount = 0;

  beforeEach(async () => {
    resetDatabase();
    resetConfigStore();
    actions.reset();
    shutdownCount = 0;
    testConfigPath = join(tmpdir(), `termail-kbd-${Date.now()}-${Math.random()}-config.json`);
    testDbPath = join(tmpdir(), `termail-kbd-${Date.now()}-${Math.random()}.sqlite`);
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
    db.query(
      'INSERT INTO folders (id, account_id, name, full_name, type, delimiter) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('work:Drafts', 'work', 'Drafts', 'Drafts', 'drafts', '/');

    renderer = (await createTestRenderer({ width: 120, height: 40 })).renderer;
    app = new App(renderer, { id: 'app-kbd', initialTheme: 'dark' });
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

  // -----------------------------------------------------------------
  // Enter (return) — opens the highlighted email, never advances
  // -----------------------------------------------------------------

  describe('Enter (return) key', () => {
    it('selects the first email and opens it when nothing is selected', () => {
      actions.setEmails([makeEmail('a', 'A'), makeEmail('b', 'B')]);
      expect(selectors.selectedEmailId).toBeNull();
      expect(selectors.openedEmailId).toBeNull();

      press('return', app!);
      expect(selectors.selectedEmailId).toBe('a');
      expect(selectors.openedEmailId).toBe('a');
    });

    it('opens the highlighted email without advancing to the next one', () => {
      actions.setEmails([makeEmail('a', 'A'), makeEmail('b', 'B'), makeEmail('c', 'C')]);
      press('j', app!); // highlight 'a', list stays visible
      expect(selectors.selectedEmailId).toBe('a');
      expect(selectors.openedEmailId).toBeNull();

      // Press Enter — opens 'a', does not advance to 'b'.
      press('return', app!);
      expect(selectors.selectedEmailId).toBe('a');
      expect(selectors.openedEmailId).toBe('a');

      // Press Enter again while reading — still no advance.
      press('return', app!);
      expect(selectors.selectedEmailId).toBe('a');
      expect(selectors.openedEmailId).toBe('a');
    });

    it('return submits the search when search is active (does not open an email)', () => {
      const hit1 = { ...makeEmail('hit-1', 'first hit'), folderId: 'work:INBOX' };
      const hit2 = { ...makeEmail('hit-2', 'second hit'), folderId: 'work:INBOX' };
      actions.setEmails([makeEmail('inbox-1', 'inbox')]);
      actions.setSearchActive(true);
      actions.setSearchHits([hit1, hit2]);
      actions.setSelectedEmail(null);

      // While search is active, Enter submits the search query.
      // It does NOT open an email — the search-active branch handles
      // return as submitSearch, not as email opening.
      press('return', app!);
      expect(selectors.selectedEmailId).toBeNull();
      expect(selectors.openedEmailId).toBeNull();
    });

    it('is a no-op when the visible list is empty', () => {
      actions.setEmails([]);
      press('return', app!);
      expect(selectors.selectedEmailId).toBeNull();
      expect(selectors.openedEmailId).toBeNull();
    });
  });

  // -----------------------------------------------------------------
  // Escape key — closes the reading view, preserves the highlight
  // -----------------------------------------------------------------

  describe('escape key', () => {
    it('returns to the list with the same email highlighted', () => {
      actions.setEmails([makeEmail('a', 'A'), makeEmail('b', 'B')]);
      press('j', app!);
      press('return', app!);
      expect(selectors.openedEmailId).toBe('a');

      press('escape', app!);
      expect(selectors.openedEmailId).toBeNull();
      expect(selectors.selectedEmailId).toBe('a');
    });

    it('is a no-op when no email is open', () => {
      actions.setEmails([makeEmail('a', 'A')]);
      press('j', app!);
      expect(selectors.openedEmailId).toBeNull();

      press('escape', app!);
      expect(selectors.selectedEmailId).toBe('a');
      expect(selectors.openedEmailId).toBeNull();
    });
  });

  // -----------------------------------------------------------------
  // Reading mode — j/k/arrows/page keys scroll, never move selection
  // -----------------------------------------------------------------

  describe('reading mode', () => {
    function openFirst(): void {
      actions.setEmails([makeEmail('a', 'A'), makeEmail('b', 'B')]);
      press('j', app!);
      press('return', app!);
      expect(selectors.openedEmailId).toBe('a');
    }

    it('j and Down do not move the highlight while reading', () => {
      openFirst();
      press('j', app!);
      press('down', app!);
      expect(selectors.selectedEmailId).toBe('a');
      expect(selectors.openedEmailId).toBe('a');
    });

    it('k and Up do not move the highlight while reading', () => {
      openFirst();
      press('k', app!);
      press('up', app!);
      expect(selectors.selectedEmailId).toBe('a');
      expect(selectors.openedEmailId).toBe('a');
    });

    it('PageDown and PageUp do not move the highlight while reading', () => {
      openFirst();
      press('pagedown', app!);
      press('pageup', app!);
      expect(selectors.selectedEmailId).toBe('a');
      expect(selectors.openedEmailId).toBe('a');
    });

    it('other bindings still work while reading', () => {
      openFirst();
      press('q', app!, () => {
        shutdownCount++;
      });
      expect(shutdownCount).toBe(1);
      expect(selectors.openedEmailId).toBe('a');
    });
  });

  // -----------------------------------------------------------------
  // j / Down key — email forward navigation
  // -----------------------------------------------------------------

  describe('j / Down key', () => {
    it('selects first email when nothing selected, then advances', () => {
      actions.setEmails([makeEmail('a', 'A'), makeEmail('b', 'B'), makeEmail('c', 'C')]);

      press('j', app!);
      expect(selectors.selectedEmailId).toBe('a');

      press('down', app!);
      expect(selectors.selectedEmailId).toBe('b');

      press('j', app!);
      expect(selectors.selectedEmailId).toBe('c');

      // Clamped at the end.
      press('j', app!);
      expect(selectors.selectedEmailId).toBe('c');
    });

    it('down arrow behaves identically to j', () => {
      actions.setEmails([makeEmail('x', 'X'), makeEmail('y', 'Y')]);
      press('down', app!);
      expect(selectors.selectedEmailId).toBe('x');
      press('down', app!);
      expect(selectors.selectedEmailId).toBe('y');
    });
  });

  // -----------------------------------------------------------------
  // k / Up key — email backward navigation
  // -----------------------------------------------------------------

  describe('k / Up key', () => {
    it('moves backward and clamps at the start', () => {
      actions.setEmails([makeEmail('a', 'A'), makeEmail('b', 'B')]);

      press('k', app!); // selects last when nothing selected
      expect(selectors.selectedEmailId).toBe('b');

      press('up', app!);
      expect(selectors.selectedEmailId).toBe('a');

      // Clamped at the start.
      press('k', app!);
      expect(selectors.selectedEmailId).toBe('a');
    });

    it('up arrow behaves identically to k', () => {
      actions.setEmails([makeEmail('x', 'X'), makeEmail('y', 'Y')]);
      press('up', app!);
      expect(selectors.selectedEmailId).toBe('y');
      press('up', app!);
      expect(selectors.selectedEmailId).toBe('x');
    });
  });

  // -----------------------------------------------------------------
  // h / Left key — folder backward navigation
  // -----------------------------------------------------------------

  describe('h / Left key', () => {
    it('moves to the previous folder and clears email selection', () => {
      expect(selectors.currentFolderId).toBe('work:INBOX');

      actions.setEmails([makeEmail('a', 'A')]);
      press('j', app!);
      expect(selectors.selectedEmailId).toBe('a');

      press('l', app!); // go to Sent
      expect(selectors.currentFolderId).toBe('work:Sent');
      expect(selectors.selectedEmailId).toBeNull();

      press('h', app!); // back to INBOX
      expect(selectors.currentFolderId).toBe('work:INBOX');
    });

    it('left arrow behaves identically to h', () => {
      press('l', app!); // -> Sent
      press('left', app!); // -> INBOX
      expect(selectors.currentFolderId).toBe('work:INBOX');
    });

    it('is clamped at the first folder (h from INBOX is a no-op)', () => {
      expect(selectors.currentFolderId).toBe('work:INBOX');
      press('h', app!);
      expect(selectors.currentFolderId).toBe('work:INBOX');
    });
  });

  // -----------------------------------------------------------------
  // l / Right / Tab key — folder forward navigation
  // -----------------------------------------------------------------

  describe('l / Right / Tab key', () => {
    it('moves to the next folder', () => {
      expect(selectors.currentFolderId).toBe('work:INBOX');

      press('l', app!);
      expect(selectors.currentFolderId).toBe('work:Sent');

      press('right', app!);
      expect(selectors.currentFolderId).toBe('work:Drafts');
    });

    it('right arrow behaves identically to l', () => {
      press('right', app!);
      expect(selectors.currentFolderId).toBe('work:Sent');
    });

    it('is clamped at the last folder (l from Drafts is a no-op)', () => {
      press('l', app!); // -> Sent
      press('l', app!); // -> Drafts
      expect(selectors.currentFolderId).toBe('work:Drafts');

      press('l', app!); // clamped
      expect(selectors.currentFolderId).toBe('work:Drafts');
    });

    it('Tab moves forward and is clamped at the last folder (no wrap)', () => {
      press('tab', app!); // -> Sent
      press('tab', app!); // -> Drafts
      expect(selectors.currentFolderId).toBe('work:Drafts');

      press('tab', app!); // clamped, no wrap to INBOX
      expect(selectors.currentFolderId).toBe('work:Drafts');
    });
  });

  // -----------------------------------------------------------------
  // Folder switch clears stale email selection
  // -----------------------------------------------------------------

  describe('folder switch clears email selection', () => {
    it('switching folders resets selectedEmailId and openedEmailId to null', () => {
      actions.setEmails([makeEmail('a', 'A'), makeEmail('b', 'B')]);
      press('j', app!);
      press('return', app!);
      expect(selectors.selectedEmailId).toBe('a');
      expect(selectors.openedEmailId).toBe('a');

      press('l', app!); // switch to Sent
      expect(selectors.selectedEmailId).toBeNull();
      expect(selectors.openedEmailId).toBeNull();

      // Can select an email in the new folder.
      actions.setEmails([makeEmail('s1', 'Sent email')]);
      press('j', app!);
      expect(selectors.selectedEmailId).toBe('s1');
    });
  });

  // -----------------------------------------------------------------
  // q key — shutdown dispatch
  // -----------------------------------------------------------------

  describe('q key', () => {
    it('triggers the shutdown handler', () => {
      press('q', app!, () => {
        shutdownCount++;
      });
      expect(shutdownCount).toBe(1);
    });
  });

  // -----------------------------------------------------------------
  // Ctrl-modified keys are ignored
  // -----------------------------------------------------------------

  describe('Ctrl-modified keys', () => {
    it('Ctrl+j does not move email selection', () => {
      actions.setEmails([makeEmail('a', 'A'), makeEmail('b', 'B')]);
      routeKeypress({ name: 'j', ctrl: true }, app!, { onShutdown: () => {} });
      expect(selectors.selectedEmailId).toBeNull();
    });

    it('Ctrl+l does not move folder selection', () => {
      expect(selectors.currentFolderId).toBe('work:INBOX');
      routeKeypress({ name: 'l', ctrl: true }, app!, { onShutdown: () => {} });
      expect(selectors.currentFolderId).toBe('work:INBOX');
    });
  });

  // -----------------------------------------------------------------
  // Search-active mode — keypress routing goes to search controller
  // -----------------------------------------------------------------

  describe('search-active mode', () => {
    it('printable characters are pushed to the search buffer', () => {
      app!.openSearch();
      press('h', app!);
      press('i', app!);
      expect(selectors.searchQuery).toBe('hi');
    });

    it('backspace pops the last search character', () => {
      app!.openSearch();
      press('h', app!);
      press('i', app!);
      expect(selectors.searchQuery).toBe('hi');
      press('backspace', app!);
      expect(selectors.searchQuery).toBe('h');
    });

    it('space is pushed to the search buffer', () => {
      app!.openSearch();
      press('space', app!);
      expect(selectors.searchQuery).toBe(' ');
    });

    it('escape cancels the search', () => {
      app!.openSearch();
      press('h', app!);
      expect(selectors.searchActive).toBe(true);
      press('escape', app!);
      expect(selectors.searchActive).toBe(false);
    });

    it('Ctrl-modified keys are ignored during search', () => {
      app!.openSearch();
      routeKeypress({ name: 'h', ctrl: true }, app!, { onShutdown: () => {} });
      expect(selectors.searchQuery).toBe('');
    });
  });
});
