/**
 * Folder navigation integration test.
 *
 * Wires the keypress listener exactly as `main.ts` does — using
 * `routeKeypress` from `src/app/KeyRouter.ts` — and drives real
 * parsed key events through OpenTUI's mock keyboard input.
 *
 * This verifies the full path: raw terminal bytes → OpenTUI stdin
 * parser → KeyEvent → keypress event → routeKeypress → App method
 * → state change → UI update.
 *
 * Coverage:
 * - `l` / Right arrow moves to the next folder
 * - `h` / Left arrow moves to the previous folder
 * - Tab moves to the next folder
 * - Folder navigation is clamped at the ends (no wrap)
 * - Folder switch clears stale email selection
 * - The StatusBar folder label updates after navigation
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestRenderer, type MockInput } from '@opentui/core/testing';
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

describe('Folder navigation via real keypress events', () => {
  let renderer: Awaited<ReturnType<typeof createTestRenderer>>['renderer'] | null = null;
  let mockInput: MockInput | null = null;
  let app: App | null = null;
  let testDbPath = '';
  let testConfigPath = '';

  beforeEach(async () => {
    resetDatabase();
    resetConfigStore();
    actions.reset();
    testConfigPath = join(tmpdir(), `termail-fnav-${Date.now()}-${Math.random()}-config.json`);
    testDbPath = join(tmpdir(), `termail-fnav-${Date.now()}-${Math.random()}.sqlite`);
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

    const setup = await createTestRenderer({ width: 120, height: 40 });
    renderer = setup.renderer;
    mockInput = setup.mockInput;

    app = new App(renderer, { id: 'app-fnav', initialTheme: 'dark' });
    renderer.root.add(app);
    app.attach();

    // Wire the keypress listener exactly as main.ts does.
    renderer.keyInput.on('keypress', (key) => {
      routeKeypress(key, app!, { onShutdown: () => {} });
    });

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
    mockInput = null;
    resetDatabase();
    resetConfigStore();
    for (const p of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`, testConfigPath]) {
      if (p && existsSync(p)) rmSync(p);
    }
  });

  it('l moves from INBOX to Sent', async () => {
    expect(selectors.currentFolderId).toBe('work:INBOX');
    mockInput!.pressKey('l');
    await new Promise((r) => setTimeout(r, 10));
    expect(selectors.currentFolderId).toBe('work:Sent');
  });

  it('Right arrow moves from INBOX to Sent', async () => {
    expect(selectors.currentFolderId).toBe('work:INBOX');
    mockInput!.pressArrow('right');
    await new Promise((r) => setTimeout(r, 10));
    expect(selectors.currentFolderId).toBe('work:Sent');
  });

  it('h moves from Sent back to INBOX', async () => {
    mockInput!.pressKey('l');
    await new Promise((r) => setTimeout(r, 10));
    expect(selectors.currentFolderId).toBe('work:Sent');

    mockInput!.pressKey('h');
    await new Promise((r) => setTimeout(r, 10));
    expect(selectors.currentFolderId).toBe('work:INBOX');
  });

  it('Left arrow moves from Sent back to INBOX', async () => {
    mockInput!.pressKey('l');
    await new Promise((r) => setTimeout(r, 10));
    expect(selectors.currentFolderId).toBe('work:Sent');

    mockInput!.pressArrow('left');
    await new Promise((r) => setTimeout(r, 10));
    expect(selectors.currentFolderId).toBe('work:INBOX');
  });

  it('Tab moves from INBOX to Sent', async () => {
    expect(selectors.currentFolderId).toBe('work:INBOX');
    mockInput!.pressTab();
    await new Promise((r) => setTimeout(r, 10));
    expect(selectors.currentFolderId).toBe('work:Sent');
  });

  it('l is clamped at the last folder (Drafts)', async () => {
    mockInput!.pressKey('l');
    await new Promise((r) => setTimeout(r, 10));
    mockInput!.pressKey('l');
    await new Promise((r) => setTimeout(r, 10));
    expect(selectors.currentFolderId).toBe('work:Drafts');

    // Clamped — no wrap to INBOX.
    mockInput!.pressKey('l');
    await new Promise((r) => setTimeout(r, 10));
    expect(selectors.currentFolderId).toBe('work:Drafts');
  });

  it('h is clamped at the first folder (INBOX)', async () => {
    expect(selectors.currentFolderId).toBe('work:INBOX');
    mockInput!.pressKey('h');
    await new Promise((r) => setTimeout(r, 10));
    expect(selectors.currentFolderId).toBe('work:INBOX');
  });

  it('folder switch clears stale email selection', async () => {
    actions.setEmails([makeEmail('a', 'A'), makeEmail('b', 'B')]);
    mockInput!.pressKey('j');
    await new Promise((r) => setTimeout(r, 10));
    expect(selectors.selectedEmailId).toBe('a');

    mockInput!.pressKey('l');
    await new Promise((r) => setTimeout(r, 10));
    expect(selectors.selectedEmailId).toBeNull();
    expect(selectors.currentFolderId).toBe('work:Sent');
  });

  it('j still works for email navigation after folder switch', async () => {
    actions.setEmails([makeEmail('a', 'A'), makeEmail('b', 'B')]);
    mockInput!.pressKey('j');
    await new Promise((r) => setTimeout(r, 10));
    expect(selectors.selectedEmailId).toBe('a');

    mockInput!.pressKey('l');
    await new Promise((r) => setTimeout(r, 10));
    expect(selectors.currentFolderId).toBe('work:Sent');
    expect(selectors.selectedEmailId).toBeNull();

    // j should work in the new folder.
    actions.setEmails([makeEmail('s1', 'Sent email')]);
    mockInput!.pressKey('j');
    await new Promise((r) => setTimeout(r, 10));
    expect(selectors.selectedEmailId).toBe('s1');
  });
});

/**
 * Rendered-frame regression for the 68-col clipping bug.
 *
 * The state-level tests above prove `routeKeypress` updates
 * `currentFolderId` and private StyledText. These tests prove the update
 * is actually visible on the rendered terminal frame via
 * `captureCharFrame()` / `captureSpans()` (both verified to exist in the
 * installed @opentui/core@0.4.5 testing API):
 *
 * - at 68 cols the StatusBar previously shrank `Folder: <name>` to
 *   `Folder:` (value clipped to zero width) and `INBOX Sent` to
 *   `INBOXSent`. The responsive fix hides the left hint group when narrow
 *   so the folder value, Emails, and Unread stay readable.
 * - at 120 cols the full bar (hints + status) remains visible.
 *
 * Key events go through the same `renderer.keyInput.on('keypress')` +
 * `routeKeypress` listener that `main.ts` wires.
 */
describe('Folder navigation rendered frames', () => {
  let renderer: Awaited<ReturnType<typeof createTestRenderer>>['renderer'] | null = null;
  let mockInput: MockInput | null = null;
  let setup: Awaited<ReturnType<typeof createTestRenderer>> | null = null;
  let app: App | null = null;
  let testDbPath = '';
  let testConfigPath = '';

  async function setupFrameApp(width: number): Promise<void> {
    resetDatabase();
    resetConfigStore();
    actions.reset();
    testConfigPath = join(
      tmpdir(),
      `termail-fnav-frame-${width}-${Date.now()}-${Math.random()}-config.json`
    );
    testDbPath = join(
      tmpdir(),
      `termail-fnav-frame-${width}-${Date.now()}-${Math.random()}.sqlite`
    );
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

    setup = await createTestRenderer({ width, height: 30 });
    renderer = setup.renderer;
    mockInput = setup.mockInput;

    app = new App(renderer, { id: `app-fnav-frame-${width}`, initialTheme: 'dark' });
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
    await setup.renderOnce();
    await setup.flush();
  }

  // oxlint-disable-next-line no-hooks
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

  function frameLines(): string[] {
    return setup!.captureCharFrame().split('\n');
  }

  function statusRow(): string {
    const row = frameLines().find((l) => l.includes('Folder:'));
    expect(row).toBeDefined();
    return row!;
  }

  /** Sidebar row for one folder (excludes header and status-bar rows). */
  function folderLine(name: string): string {
    const row = frameLines().find(
      (l) => l.includes(name) && !l.includes('Folder:') && !l.includes('TERMAIL')
    );
    expect(row).toBeDefined();
    return row!;
  }

  /** Attributes of the folder-name span on a sidebar row, or null. */
  function tabSpanAttributes(text: string): number | null {
    const captured = setup!.captureSpans();
    for (const line of captured.lines) {
      const spans = (line as unknown as { spans: Array<{ text: string; attributes: number }> })
        .spans;
      const joined = spans.map((s) => s.text).join('');
      // Skip header and status rows; the active marker shares the name
      // span's style, so it merges into e.g. `› Sent`.
      if (joined.includes('Folder:') || joined.includes('TERMAIL')) continue;
      if (!joined.includes(text)) continue;
      const hit = spans.find((s) => s.text === text || s.text.endsWith(` ${text}`));
      if (hit) return hit.attributes;
    }
    return null;
  }

  async function pressAndRender(key: 'l' | 'h'): Promise<void> {
    mockInput!.pressKey(key);
    await new Promise((r) => setTimeout(r, 20));
    await setup!.renderOnce();
    await setup!.flush();
  }

  it('at 68 cols the status row shows INBOX, then Sent after l, then INBOX after h', async () => {
    await setupFrameApp(68);

    // Initial: INBOX visible in both the sidebar and the status row;
    // essential status fields present; optional hints hidden to save space.
    expect(selectors.currentFolderId).toBe('work:INBOX');
    expect(statusRow()).toContain('INBOX');
    expect(statusRow()).toContain('Emails:');
    expect(statusRow()).toContain('Unread:');
    expect(statusRow()).not.toContain('Quit');
    // Vertical sidebar: one row per folder, active row marked.
    expect(folderLine('INBOX')).toContain('›');
    expect(folderLine('Sent')).not.toContain('›');
    expect(folderLine('Drafts')).toBeDefined();

    await pressAndRender('l');
    expect(selectors.currentFolderId).toBe('work:Sent');
    expect(statusRow()).toContain('Sent');
    expect(statusRow()).not.toContain('INBOX');
    expect(statusRow()).toContain('Emails:');
    expect(folderLine('Sent')).toContain('›');
    expect(folderLine('INBOX')).not.toContain('›');
    // Active row is BOLD (attr 1), inactive is plain (attr 0).
    expect(tabSpanAttributes('Sent')).toBe(1);
    expect(tabSpanAttributes('INBOX')).toBe(0);

    await pressAndRender('h');
    expect(selectors.currentFolderId).toBe('work:INBOX');
    expect(statusRow()).toContain('INBOX');
    expect(statusRow()).not.toContain('Sent');
    expect(folderLine('INBOX')).toContain('›');
    expect(tabSpanAttributes('INBOX')).toBe(1);
    expect(tabSpanAttributes('Sent')).toBe(0);
  });

  it('at 120 cols the full bar stays visible and navigation is reflected', async () => {
    await setupFrameApp(120);

    expect(selectors.currentFolderId).toBe('work:INBOX');
    expect(statusRow()).toContain('INBOX');
    expect(statusRow()).toContain('Quit');
    expect(folderLine('INBOX')).toContain('›');

    await pressAndRender('l');
    expect(selectors.currentFolderId).toBe('work:Sent');
    expect(statusRow()).toContain('Sent');
    expect(statusRow()).toContain('Quit');
    expect(folderLine('Sent')).toContain('›');
    expect(tabSpanAttributes('Sent')).toBe(1);

    await pressAndRender('h');
    expect(selectors.currentFolderId).toBe('work:INBOX');
    expect(statusRow()).toContain('INBOX');
    expect(folderLine('INBOX')).toContain('›');
    expect(tabSpanAttributes('INBOX')).toBe(1);
  });
});
