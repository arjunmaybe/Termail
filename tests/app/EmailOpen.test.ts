/**
 * Email open/navigation model regression tests.
 *
 * Selection (highlight) and opening (reading view) are distinct states:
 * - `j`/`k` move `selectedEmailId`; the list stays visible.
 * - Enter (`return`) opens the highlighted email (`openedEmailId`); it
 *   never advances to a different email.
 * - Escape closes the reading view and preserves the highlight.
 *
 * These tests drive raw terminal bytes through OpenTUI's mock keyboard
 * input and the same `renderer.keyInput.on('keypress')` + `routeKeypress`
 * wiring that `main.ts` uses, then assert both state and the actual
 * rendered frame (list subjects vs. `From:`/body detail markers).
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MockInput, createTestRenderer } from '@opentui/core/testing';
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
    isRead: false,
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

describe('Email open navigation via real keypress events', () => {
  let renderer: Awaited<ReturnType<typeof createTestRenderer>>['renderer'] | null = null;
  let mockInput: MockInput | null = null;
  let setup: Awaited<ReturnType<typeof createTestRenderer>> | null = null;
  let app: App | null = null;
  let testDbPath = '';
  let testConfigPath = '';

  async function setupApp(width = 120, height = 40): Promise<void> {
    resetDatabase();
    resetConfigStore();
    actions.reset();
    testConfigPath = join(tmpdir(), `termail-open-${Date.now()}-${Math.random()}-config.json`);
    testDbPath = join(tmpdir(), `termail-open-${Date.now()}-${Math.random()}.sqlite`);
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

    setup = await createTestRenderer({ width, height });
    renderer = setup.renderer;
    mockInput = setup.mockInput;

    app = new App(renderer, { id: 'app-open', initialTheme: 'dark' });
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

    actions.setEmails([
      makeEmail('a', 'Alpha subject', 'Body-alpha'),
      makeEmail('b', 'Beta subject', 'Body-beta'),
      makeEmail('c', 'Gamma subject', 'Body-gamma'),
    ]);
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

  async function press(kind: 'j' | 'k' | 'enter' | 'escape' | 'l' | 'down'): Promise<void> {
    if (kind === 'j') mockInput!.pressKey('j');
    else if (kind === 'k') mockInput!.pressKey('k');
    else if (kind === 'enter') mockInput!.pressEnter();
    else if (kind === 'escape') mockInput!.pressEscape();
    else if (kind === 'down') mockInput!.pressArrow('down');
    else mockInput!.pressKey('l');
    await new Promise((r) => setTimeout(r, 20));
    await setup!.renderOnce();
    await setup!.flush();
  }

  it('j highlights without opening; Enter opens; second Enter holds; Escape preserves highlight', async () => {
    await setupApp();

    // 1. List visible, nothing selected or opened.
    expect(selectors.selectedEmailId).toBeNull();
    expect(selectors.openedEmailId).toBeNull();
    expect(frame()).toContain('Alpha subject');
    expect(frame()).not.toContain('From:');

    // 2. j highlights the first email; the list remains visible.
    await press('j');
    expect(selectors.selectedEmailId).toBe('a');
    expect(selectors.openedEmailId).toBeNull();
    expect(frame()).toContain('Alpha subject');
    expect(frame()).toContain('Beta subject');
    expect(frame()).not.toContain('From:');

    // 3. j again moves the highlight; no reading view opens.
    await press('j');
    expect(selectors.selectedEmailId).toBe('b');
    expect(selectors.openedEmailId).toBeNull();
    expect(frame()).not.toContain('From:');

    // 4. Enter opens the highlighted email; subject and body are shown.
    await press('enter');
    expect(selectors.selectedEmailId).toBe('b');
    expect(selectors.openedEmailId).toBe('b');
    expect(frame()).toContain('Beta subject');
    expect(frame()).toContain('Body-beta');
    expect(frame()).toContain('From:');

    // 5. Enter again while reading does not advance.
    await press('enter');
    expect(selectors.selectedEmailId).toBe('b');
    expect(selectors.openedEmailId).toBe('b');
    expect(frame()).toContain('Body-beta');

    // 6. Escape returns to the list with the same email highlighted.
    await press('escape');
    expect(selectors.openedEmailId).toBeNull();
    expect(selectors.selectedEmailId).toBe('b');
    expect(frame()).toContain('Alpha subject');
    expect(frame()).toContain('Beta subject');
    expect(frame()).not.toContain('From:');
  });

  it('k moves the highlight backward without opening', async () => {
    await setupApp();
    await press('j');
    await press('j');
    expect(selectors.selectedEmailId).toBe('b');
    await press('k');
    expect(selectors.selectedEmailId).toBe('a');
    expect(selectors.openedEmailId).toBeNull();
    expect(frame()).not.toContain('From:');
  });

  it('switching folders clears the highlight and any open email', async () => {
    await setupApp();
    await press('j');
    await press('enter');
    expect(selectors.openedEmailId).toBe('a');

    await press('l');
    expect(selectors.currentFolderId).toBe('work:Sent');
    expect(selectors.selectedEmailId).toBeNull();
    expect(selectors.openedEmailId).toBeNull();
  });

  it('Enter is a no-op on an empty list', async () => {
    await setupApp();
    actions.setEmails([]);
    await setup!.renderOnce();
    await setup!.flush();
    await press('enter');
    expect(selectors.selectedEmailId).toBeNull();
    expect(selectors.openedEmailId).toBeNull();
  });

  it('search results follow the same highlight/open model', async () => {
    await setupApp();
    const hit = {
      ...makeEmail('hit-1', 'Hit subject', 'Hit-body'),
      folderId: 'work:INBOX',
    };
    actions.setSearchActive(true);
    actions.setSearchHits([hit]);

    // Highlight and open resolve against the search hits.
    app!.moveEmailSelection(1);
    expect(selectors.selectedEmailId).toBe('hit-1');
    expect(selectors.openedEmailId).toBeNull();
    app!.openSelectedEmail();
    expect(selectors.openedEmailId).toBe('hit-1');

    // Submission still owns Enter while the search bar is open.
    actions.setSelectedEmail(null);
    actions.setOpenedEmail(null);
    routeKeypress({ name: 'return' }, app!, { onShutdown: () => {} });
    expect(selectors.openedEmailId).toBeNull();
  });

  it('reading view renders at 68 columns', async () => {
    await setupApp(68, 30);
    await press('j');
    await press('enter');
    expect(selectors.openedEmailId).toBe('a');
    expect(frame()).toContain('Body-alpha');
    await press('enter');
    expect(selectors.openedEmailId).toBe('a');
    expect(frame()).toContain('Body-alpha');
  });
});

/**
 * Native-handle exhaustion regression.
 *
 * Each list rebuild creates native TextBuffer handles per row. The old
 * `remove()` + `destroy()` teardown detached child renderables without
 * destroying them, leaking every row's native handles; a few consecutive
 * navigation keypresses over a large list then crashed the renderer with
 * "Failed to create native renderable". Rebuilds must free subtrees via
 * `destroyRecursively()`.
 *
 * Sends consecutive real mock key events through the same keypress
 * routing as `main.ts`, rendering/flushing after each event.
 */
describe('large-list navigation stays renderable', () => {
  let renderer: Awaited<ReturnType<typeof createTestRenderer>>['renderer'] | null = null;
  let mockInput: MockInput | null = null;
  let setup: Awaited<ReturnType<typeof createTestRenderer>> | null = null;
  let app: App | null = null;
  let testDbPath = '';
  let testConfigPath = '';

  async function setupLargeList(count: number): Promise<void> {
    resetDatabase();
    resetConfigStore();
    actions.reset();
    testConfigPath = join(
      tmpdir(),
      `termail-open-large-${Date.now()}-${Math.random()}-config.json`
    );
    testDbPath = join(tmpdir(), `termail-open-large-${Date.now()}-${Math.random()}.sqlite`);
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

    setup = await createTestRenderer({ width: 120, height: 40 });
    renderer = setup.renderer;
    mockInput = setup.mockInput;

    app = new App(renderer, { id: 'app-open-large', initialTheme: 'dark' });
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
      Array.from({ length: count }, (_, i) => makeEmail(`e${i}`, `Subject ${i}`, `Body-${i}`))
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

  async function pressAndRender(kind: 'j' | 'down'): Promise<void> {
    if (kind === 'j') mockInput!.pressKey('j');
    else mockInput!.pressArrow('down');
    await new Promise((r) => setTimeout(r, 20));
    await setup!.renderOnce();
    await setup!.flush();
  }

  it('repeated j presses advance without crashing', async () => {
    await setupLargeList(200);
    await pressAndRender('j');
    expect(selectors.selectedEmailId).toBe('e0');
    expect(selectors.openedEmailId).toBeNull();
    await pressAndRender('j');
    expect(selectors.selectedEmailId).toBe('e1');
    expect(selectors.openedEmailId).toBeNull();
    // Still renderable: the highlighted row is visible.
    expect(setup!.captureCharFrame()).toContain('Subject 1');
    // Sustained navigation keeps freeing row resources.
    for (let i = 0; i < 6; i += 1) {
      mockInput!.pressKey('j');
      await setup!.renderOnce();
      await setup!.flush();
    }
    expect(selectors.selectedEmailId).toBe('e7');
    expect(selectors.openedEmailId).toBeNull();
    expect(setup!.captureCharFrame()).toContain('Subject 7');
  }, 30000);

  it('repeated Down Arrow presses advance without crashing', async () => {
    await setupLargeList(200);
    await pressAndRender('down');
    expect(selectors.selectedEmailId).toBe('e0');
    await pressAndRender('down');
    expect(selectors.selectedEmailId).toBe('e1');
    expect(selectors.openedEmailId).toBeNull();
    expect(setup!.captureCharFrame()).toContain('Subject 1');
    for (let i = 0; i < 6; i += 1) {
      mockInput!.pressArrow('down');
      await setup!.renderOnce();
      await setup!.flush();
    }
    expect(selectors.selectedEmailId).toBe('e7');
    expect(selectors.openedEmailId).toBeNull();
    expect(setup!.captureCharFrame()).toContain('Subject 7');
  }, 30000);

  it('j while reading scrolls instead of moving the highlight', async () => {
    await setupLargeList(200);
    mockInput!.pressKey('j');
    await new Promise((r) => setTimeout(r, 20));
    mockInput!.pressEnter();
    await new Promise((r) => setTimeout(r, 20));
    await setup!.renderOnce();
    await setup!.flush();
    expect(selectors.openedEmailId).toBe('e0');

    // j/Down scroll the open message; selection and open email hold.
    await pressAndRender('j');
    await pressAndRender('j');
    expect(selectors.selectedEmailId).toBe('e0');
    expect(selectors.openedEmailId).toBe('e0');
    expect(setup!.captureCharFrame()).toContain('Body-0');
  }, 30000);
});
