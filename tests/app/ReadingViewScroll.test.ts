/**
 * Reading-view scroll regression tests.
 *
 * While an email is open, `j`/Down and `k`/Up scroll the message body
 * instead of moving the list highlight; PageDown/PageUp scroll by
 * viewports. Scrolling never changes the selection or the open email, and
 * Escape still returns to the list with the highlight preserved.
 *
 * Drives raw terminal bytes through OpenTUI's mock keyboard input and the
 * same `renderer.keyInput.on('keypress')` + `routeKeypress` wiring that
 * `main.ts` uses, then asserts rendered viewport movement (body lines
 * entering/leaving the frame), not just handler invocation.
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

function makeEmail(id: string, subject: string, body: string | null): PersistedEmail {
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

function longBody(tag: string, lines: number): string {
  return Array.from({ length: lines }, (_, i) => `${tag} line ${String(i).padStart(2, '0')}`).join(
    '\n'
  );
}

describe('Reading view scrolling via real keypress events', () => {
  let renderer: Awaited<ReturnType<typeof createTestRenderer>>['renderer'] | null = null;
  let mockInput: MockInput | null = null;
  let setup: Awaited<ReturnType<typeof createTestRenderer>> | null = null;
  let app: App | null = null;
  let testDbPath = '';
  let testConfigPath = '';

  async function setupApp(): Promise<void> {
    resetDatabase();
    resetConfigStore();
    actions.reset();
    testConfigPath = join(tmpdir(), `termail-read-${Date.now()}-${Math.random()}-config.json`);
    testDbPath = join(tmpdir(), `termail-read-${Date.now()}-${Math.random()}.sqlite`);
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

    setup = await createTestRenderer({ width: 120, height: 18 });
    renderer = setup.renderer;
    mockInput = setup.mockInput;

    app = new App(renderer, { id: 'app-read', initialTheme: 'dark' });
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
      makeEmail('long', 'Long subject', longBody('LongBody', 60)),
      makeEmail('s1', 'Second subject', 'short body one'),
      makeEmail('s2', 'Third subject', 'short body two'),
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

  async function key(raw: string): Promise<void> {
    mockInput!.pressKey(raw as never);
    await new Promise((r) => setTimeout(r, 20));
    await setup!.renderOnce();
    await setup!.flush();
  }

  async function openLong(): Promise<void> {
    await key('j');
    expect(selectors.selectedEmailId).toBe('long');
    await key('\r');
    expect(selectors.openedEmailId).toBe('long');
    expect(frame()).toContain('LongBody line 00');
  }

  it('Down and j scroll the open message without moving the highlight', async () => {
    await setupApp();
    await openLong();

    // Ten single-row steps: the detail headers (9 rows) scroll out and the
    // viewport settles deep in the body.
    for (let i = 0; i < 10; i += 1) {
      await key('j');
    }
    expect(selectors.selectedEmailId).toBe('long');
    expect(selectors.openedEmailId).toBe('long');
    // Viewport moved down through the body.
    expect(frame()).toContain('LongBody line 10');
    expect(frame()).not.toContain('LongBody line 00');

    mockInput!.pressArrow('down');
    await new Promise((r) => setTimeout(r, 20));
    await setup!.renderOnce();
    await setup!.flush();
    expect(selectors.selectedEmailId).toBe('long');
    expect(selectors.openedEmailId).toBe('long');
  }, 30000);

  it('Up and k scroll back toward the beginning', async () => {
    await setupApp();
    await openLong();

    for (let i = 0; i < 12; i += 1) {
      await key('j');
    }
    expect(frame()).not.toContain('LongBody line 00');

    for (let i = 0; i < 4; i += 1) {
      await key('k');
    }
    expect(selectors.selectedEmailId).toBe('long');
    expect(selectors.openedEmailId).toBe('long');
    expect(frame()).toContain('LongBody line 00');

    mockInput!.pressArrow('up');
    await new Promise((r) => setTimeout(r, 20));
    await setup!.renderOnce();
    await setup!.flush();
    for (let i = 0; i < 10; i += 1) {
      await key('k');
    }
    expect(frame()).toContain('LongBody line 00');
  }, 30000);

  it('PageDown and PageUp move by larger increments', async () => {
    await setupApp();
    await openLong();

    // One line step keeps the top visible...
    await key('j');
    expect(frame()).toContain('LongBody line 00');

    // ...while one PageDown jumps well past it.
    await key('\x1B[6~');
    expect(selectors.selectedEmailId).toBe('long');
    expect(selectors.openedEmailId).toBe('long');
    expect(frame()).not.toContain('LongBody line 00');
    expect(frame()).toContain('LongBody line 20');

    await key('\x1B[5~');
    expect(frame()).toContain('LongBody line 00');
  }, 30000);

  it('Escape restores the list with the highlight preserved', async () => {
    await setupApp();
    await openLong();
    await key('j');
    await key('j');

    mockInput!.pressEscape();
    await new Promise((r) => setTimeout(r, 150));
    await setup!.renderOnce();
    await setup!.flush();
    expect(selectors.openedEmailId).toBeNull();
    expect(selectors.selectedEmailId).toBe('long');
    expect(frame()).toContain('Long subject');
    expect(frame()).not.toContain('From:');
  }, 30000);

  it('list navigation still moves the highlight when nothing is open', async () => {
    await setupApp();
    await key('j');
    expect(selectors.selectedEmailId).toBe('long');
    expect(selectors.openedEmailId).toBeNull();
    await key('j');
    expect(selectors.selectedEmailId).toBe('s1');
    expect(frame()).not.toContain('From:');
  }, 30000);

  it('sustained scrolling holds the open email without degrading', async () => {
    await setupApp();
    await openLong();

    for (let i = 0; i < 40; i += 1) {
      mockInput!.pressKey('j');
    }
    await setup!.renderOnce();
    await setup!.flush();
    expect(selectors.selectedEmailId).toBe('long');
    expect(selectors.openedEmailId).toBe('long');
    // Deep into the body, past the first screenful.
    expect(frame()).toContain('LongBody line 44');
    expect(frame()).not.toContain('LongBody line 00');
  }, 30000);
});
