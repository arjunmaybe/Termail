/**
 * Email-list auto-scroll regression tests.
 *
 * The viewport must follow the highlight: `j`/Down scrolls down past the
 * last visible row, `k`/Up scrolls back up. Selection changes rebuild rows
 * without valid fresh layout, so the view tracks stashed content offsets
 * and follows up after layout-driven content size changes.
 *
 * Drives raw terminal bytes through OpenTUI's mock keyboard input and the
 * same `renderer.keyInput.on('keypress')` + `routeKeypress` wiring that
 * `main.ts` uses, then asserts rendered-frame visibility (not just IDs):
 * the highlighted subject must be present in the frame.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestRenderer, type MockInput } from '@opentui/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
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

function makeEmail(id: string, subject: string, body: string): PersistedEmail {
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
    isRead: true,
    isFlagged: false,
    isAnswered: false,
    isDraft: false,
    hasAttachments: false,
    size: 0,
    bodyText: body,
    bodyHtml: null,
    headers: {},
    attachments: [],
    flags: [],
    uid: 1,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('Email list auto-scroll via real keypress events', () => {
  let renderer: Awaited<ReturnType<typeof createTestRenderer>>['renderer'] | null = null;
  let mockInput: MockInput | null = null;
  let setup: Awaited<ReturnType<typeof createTestRenderer>> | null = null;
  let app: App | null = null;
  let testDbPath = '';
  let testConfigPath = '';

  async function setupScrollingList(count: number): Promise<void> {
    resetDatabase();
    resetConfigStore();
    actions.reset();
    testConfigPath = join(tmpdir(), `termail-scroll-${Date.now()}-${Math.random()}-config.json`);
    testDbPath = join(tmpdir(), `termail-scroll-${Date.now()}-${Math.random()}.sqlite`);
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

    // Short viewport (7 content rows) so 30 two-row emails overflow it.
    setup = await createTestRenderer({ width: 120, height: 16 });
    renderer = setup.renderer;
    mockInput = setup.mockInput;

    app = new App(renderer, { id: 'app-scroll', initialTheme: 'dark' });
    renderer.root.add(app);
    app.attach();

    // Same wiring as main.ts.
    renderer.keyInput.on('keypress', (key) => {
      routeKeypress(key, app!, { onShutdown: () => {} });
    });

    for (let i = 0; i < 100; i += 1) {
      if (app.isInitialized()) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(app.isInitialized()).toBe(true);

    actions.setEmails(
      Array.from({ length: count }, (_, i) => makeEmail(`e${i}`, `Subject-${i}`, `Body-${i}`))
    );
    await setup.renderOnce();
    await setup.flush();
  }

  /**
   * Seed two real folders in the database so `App.attach()`'s folder
   * navigation loads a fresh email array, exactly as it does in the app.
   * IDs differ per folder so stale offsets from the previous list cannot
   * accidentally match the new selection.
   */
  async function setupFolderSwitchScroll(count: number): Promise<void> {
    resetDatabase();
    resetConfigStore();
    actions.reset();
    testConfigPath = join(tmpdir(), `termail-fswitch-${Date.now()}-${Math.random()}-config.json`);
    testDbPath = join(tmpdir(), `termail-fswitch-${Date.now()}-${Math.random()}.sqlite`);
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

    const insertEmail = db.query(
      `INSERT INTO emails
         (id, account_id, folder_id, message_id, subject, date, internal_date,
          is_read, size, body_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`
    );
    for (let i = 0; i < count; i += 1) {
      // Newest first, matching listByFolder's ordering.
      const stamp = 1000 - i;
      insertEmail.run(
        `inbox-${i}`,
        'work',
        'work:INBOX',
        `<inbox-${i}@example.com>`,
        `Inbox-${i}`,
        stamp,
        stamp,
        `Body-inbox-${i}`
      );
      insertEmail.run(
        `sent-${i}`,
        'work',
        'work:Sent',
        `<sent-${i}@example.com>`,
        `Sent-${i}`,
        stamp,
        stamp,
        `Body-sent-${i}`
      );
    }

    // Short viewport (7 content rows) so 30 two-row emails overflow it.
    setup = await createTestRenderer({ width: 120, height: 16 });
    renderer = setup.renderer;
    mockInput = setup.mockInput;

    app = new App(renderer, { id: 'app-fswitch', initialTheme: 'dark' });
    renderer.root.add(app);
    app.attach();

    // Same wiring as main.ts.
    renderer.keyInput.on('keypress', (key) => {
      routeKeypress(key, app!, { onShutdown: () => {} });
    });

    for (let i = 0; i < 100; i += 1) {
      if (app.isInitialized()) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(app.isInitialized()).toBe(true);
    // The initial folder is loaded through the real DB path, not a manual
    // actions.setEmails() shortcut.
    expect(selectors.currentFolderId).toBe('work:INBOX');
    expect(selectors.emails[0]?.id).toBe('inbox-0');

    await setup.renderOnce();
    await setup.flush();
  }

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
    mockInput = null;
    setup = null;
    resetDatabase();
    resetConfigStore();
    for (const p of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`, testConfigPath]) {
      if (p && existsSync(p)) rmSync(p);
    }
  });

  function frame(): string {
    return setup!.captureCharFrame();
  }

  async function pressJ(): Promise<void> {
    mockInput!.pressKey('j');
    await new Promise((r) => setTimeout(r, 20));
    await setup!.renderOnce();
    await setup!.flush();
  }

  async function pressDown(): Promise<void> {
    mockInput!.pressArrow('down');
    await new Promise((r) => setTimeout(r, 20));
    await setup!.renderOnce();
    await setup!.flush();
  }

  async function pressK(): Promise<void> {
    mockInput!.pressKey('k');
    await new Promise((r) => setTimeout(r, 20));
    await setup!.renderOnce();
    await setup!.flush();
  }

  async function pressUp(): Promise<void> {
    mockInput!.pressArrow('up');
    await new Promise((r) => setTimeout(r, 20));
    await setup!.renderOnce();
    await setup!.flush();
  }

  async function pressFolderKey(key: 'l' | 'h'): Promise<void> {
    mockInput!.pressKey(key);
    await new Promise((r) => setTimeout(r, 20));
    await setup!.renderOnce();
    await setup!.flush();
  }

  async function pressEnter(): Promise<void> {
    mockInput!.pressEnter();
    await new Promise((r) => setTimeout(r, 20));
    await setup!.renderOnce();
    await setup!.flush();
  }

  async function pressEscape(): Promise<void> {
    mockInput!.pressEscape();
    // Bare ESC needs parser debounce time before the keypress fires.
    await new Promise((r) => setTimeout(r, 150));
    await setup!.renderOnce();
    await setup!.flush();
  }

  it('j scrolls past the last initially visible row', async () => {
    await setupScrollingList(30);
    expect(frame()).toContain('Subject-0');

    for (let i = 0; i < 10; i += 1) {
      await pressJ();
    }
    expect(selectors.selectedEmailId).toBe('e9');
    expect(selectors.openedEmailId).toBeNull();
    // Selected row followed into view; top rows scrolled out.
    expect(frame()).toContain('Subject-9');
    expect(frame()).not.toContain('Subject-0');
  }, 30000);

  it('Down Arrow scrolls the viewport like j', async () => {
    await setupScrollingList(30);
    for (let i = 0; i < 10; i += 1) {
      await pressDown();
    }
    expect(selectors.selectedEmailId).toBe('e9');
    expect(frame()).toContain('Subject-9');
  }, 30000);

  it('scrolling follows the highlight after INBOX -> Sent -> INBOX', async () => {
    await setupFolderSwitchScroll(30);
    expect(frame()).toContain('Inbox-0');

    // Establish a measured offset table in INBOX, then switch folders.
    await pressJ();
    expect(selectors.selectedEmailId).toBe('inbox-0');

    await pressFolderKey('l');
    expect(selectors.currentFolderId).toBe('work:Sent');
    expect(selectors.selectedEmailId).toBeNull();
    expect(frame()).toContain('Sent-0');

    // j must follow the Sent highlight past the visible rows.
    for (let i = 0; i < 10; i += 1) {
      await pressJ();
    }
    expect(selectors.selectedEmailId).toBe('sent-9');
    expect(frame()).toContain('Sent-9');
    expect(frame()).not.toContain('Sent-0');

    // Returning to INBOX loads a different ID set; Down Arrow must still
    // keep the selected subject in view.
    await pressFolderKey('h');
    expect(selectors.currentFolderId).toBe('work:INBOX');
    expect(selectors.selectedEmailId).toBeNull();
    expect(frame()).toContain('Inbox-0');

    for (let i = 0; i < 10; i += 1) {
      await pressDown();
    }
    expect(selectors.selectedEmailId).toBe('inbox-9');
    expect(frame()).toContain('Inbox-9');
    expect(frame()).not.toContain('Inbox-0');
  }, 30000);

  it('k scrolls back up toward the top', async () => {
    await setupScrollingList(30);
    for (let i = 0; i < 10; i += 1) {
      await pressJ();
    }
    expect(frame()).toContain('Subject-9');
    for (let i = 0; i < 5; i += 1) {
      await pressK();
    }
    expect(selectors.selectedEmailId).toBe('e4');
    expect(frame()).toContain('Subject-4');
  }, 30000);

  it('Up Arrow scrolls back up toward the top', async () => {
    await setupScrollingList(30);
    for (let i = 0; i < 10; i += 1) {
      await pressDown();
    }
    for (let i = 0; i < 5; i += 1) {
      await pressUp();
    }
    expect(selectors.selectedEmailId).toBe('e4');
    expect(frame()).toContain('Subject-4');
  }, 30000);

  it('j while reading scrolls the body; Escape restores the visible row', async () => {
    await setupScrollingList(30);
    for (let i = 0; i < 8; i += 1) {
      await pressJ();
    }
    expect(selectors.selectedEmailId).toBe('e7');
    await pressEnter();
    expect(selectors.openedEmailId).toBe('e7');
    expect(frame()).toContain('Body-7');

    // j scrolls the message instead of moving the highlight.
    for (let i = 0; i < 4; i += 1) {
      await pressJ();
    }
    expect(selectors.selectedEmailId).toBe('e7');
    expect(selectors.openedEmailId).toBe('e7');

    await pressEscape();
    expect(selectors.openedEmailId).toBeNull();
    expect(selectors.selectedEmailId).toBe('e7');
    // List is back and the preserved highlight is scrolled into view.
    expect(frame()).toContain('Subject-7');
    expect(frame()).not.toContain('From:');
  }, 30000);

  it('scrolling follows the highlight after narrowing the terminal', async () => {
    await setupScrollingList(30);
    for (let i = 0; i < 10; i += 1) {
      await pressJ();
    }
    expect(selectors.selectedEmailId).toBe('e9');
    expect(frame()).toContain('Subject-9');

    // Narrow the terminal and lay out at the new width first, as a live
    // resize would, then keep navigating.
    setup!.resize(68, 16);
    await setup!.renderOnce();
    await setup!.flush();
    await pressJ();
    await pressJ();
    expect(selectors.selectedEmailId).toBe('e11');
    expect(frame()).toContain('Subject-11');
  });

  it('scrolling follows the highlight after widening the terminal', async () => {
    await setupScrollingList(30);
    setup!.resize(68, 16);
    await setup!.renderOnce();
    await setup!.flush();
    for (let i = 0; i < 10; i += 1) {
      await pressJ();
    }
    expect(frame()).toContain('Subject-9');

    setup!.resize(120, 16);
    await setup!.renderOnce();
    await setup!.flush();
    await pressJ();
    await pressJ();
    expect(selectors.selectedEmailId).toBe('e11');
    expect(frame()).toContain('Subject-11');
  });
});

/**
 * Sustained key-hold regression tests.
 *
 * Holding a navigation key must keep advancing without stalling: events
 * arrive faster than frames render, so per-keypress work must stay small
 * (in-place highlight repaint, no row rebuilds). Sends bursts of real mock
 * key events with no intermediate render — the held-key backlog — then a
 * single flush, asserting every event advanced exactly once and the final
 * highlight is visible.
 */
describe('sustained navigation holds', () => {
  let renderer: Awaited<ReturnType<typeof createTestRenderer>>['renderer'] | null = null;
  let mockInput: MockInput | null = null;
  let setup: Awaited<ReturnType<typeof createTestRenderer>> | null = null;
  let app: App | null = null;
  let testDbPath = '';
  let testConfigPath = '';

  async function setupHoldList(count: number): Promise<void> {
    resetDatabase();
    resetConfigStore();
    actions.reset();
    testConfigPath = join(tmpdir(), `termail-hold-${Date.now()}-${Math.random()}-config.json`);
    testDbPath = join(tmpdir(), `termail-hold-${Date.now()}-${Math.random()}.sqlite`);
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

    setup = await createTestRenderer({ width: 120, height: 16 });
    renderer = setup.renderer;
    mockInput = setup.mockInput;

    app = new App(renderer, { id: 'app-hold', initialTheme: 'dark' });
    renderer.root.add(app);
    app.attach();

    // Same wiring as main.ts.
    renderer.keyInput.on('keypress', (key) => {
      routeKeypress(key, app!, { onShutdown: () => {} });
    });

    for (let i = 0; i < 100; i += 1) {
      if (app.isInitialized()) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(app.isInitialized()).toBe(true);

    actions.setEmails(
      Array.from({ length: count }, (_, i) => makeEmail(`e${i}`, `Subject-${i}`, `Body-${i}`))
    );
    await setup.renderOnce();
    await setup.flush();
  }

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
    mockInput = null;
    setup = null;
    resetDatabase();
    resetConfigStore();
    for (const p of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`, testConfigPath]) {
      if (p && existsSync(p)) rmSync(p);
    }
  });

  it('a burst of j presses advances once per event and stays visible', async () => {
    await setupHoldList(120);
    for (let i = 0; i < 40; i += 1) {
      mockInput!.pressKey('j');
    }
    await setup!.renderOnce();
    await setup!.flush();
    // No event skipped or coalesced; viewport followed to the final row.
    expect(selectors.selectedEmailId).toBe('e39');
    expect(selectors.openedEmailId).toBeNull();
    expect(setup!.captureCharFrame()).toContain('Subject-39');
  }, 30000);

  it('a burst of Down Arrow presses advances once per event', async () => {
    await setupHoldList(120);
    for (let i = 0; i < 40; i += 1) {
      mockInput!.pressArrow('down');
    }
    await setup!.renderOnce();
    await setup!.flush();
    expect(selectors.selectedEmailId).toBe('e39');
    expect(setup!.captureCharFrame()).toContain('Subject-39');
  }, 30000);

  it('a held Up direction returns symmetrically without skipping', async () => {
    await setupHoldList(120);
    for (let i = 0; i < 40; i += 1) {
      mockInput!.pressKey('j');
    }
    await setup!.renderOnce();
    await setup!.flush();
    expect(selectors.selectedEmailId).toBe('e39');

    for (let i = 0; i < 40; i += 1) {
      mockInput!.pressKey('k');
    }
    await setup!.renderOnce();
    await setup!.flush();
    expect(selectors.selectedEmailId).toBe('e0');
    expect(setup!.captureCharFrame()).toContain('Subject-0');
  }, 30000);
});
