/**
 * App layout regression tests.
 *
 * Verifies the structural interface hierarchy on rendered frames: a header
 * strip, a horizontal main row with a fixed folder sidebar on the left and
 * the content region filling the rest, plus the search/status bars below.
 * Folders render as vertical rows inside the sidebar; email rows keep
 * sender/date/subject aligned inside the content region at 120 and 68
 * columns.
 *
 * Drives raw terminal bytes through OpenTUI's mock keyboard input and the
 * same `renderer.keyInput.on('keypress')` + `routeKeypress` wiring that
 * `main.ts` uses, then asserts on `captureCharFrame()` output.
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

function makeEmail(
  id: string,
  subject: string,
  body: string,
  senderName: string,
  date: number
): PersistedEmail {
  return {
    id,
    accountId: 'work',
    folderId: 'work:INBOX',
    messageId: `<${id}@example.com>`,
    fromAddresses: [{ address: `${id}@example.com`, name: senderName }],
    toAddresses: [],
    ccAddresses: [],
    subject,
    date,
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

describe('App layout via rendered frames', () => {
  let renderer: Awaited<ReturnType<typeof createTestRenderer>>['renderer'] | null = null;
  let mockInput: MockInput | null = null;
  let setup: Awaited<ReturnType<typeof createTestRenderer>> | null = null;
  let app: App | null = null;
  let testDbPath = '';
  let testConfigPath = '';

  async function setupApp(width: number, height: number, count = 3): Promise<void> {
    resetDatabase();
    resetConfigStore();
    actions.reset();
    testConfigPath = join(tmpdir(), `termail-layout-${Date.now()}-${Math.random()}-config.json`);
    testDbPath = join(tmpdir(), `termail-layout-${Date.now()}-${Math.random()}.sqlite`);
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

    setup = await createTestRenderer({ width, height });
    renderer = setup.renderer;
    mockInput = setup.mockInput;

    app = new App(renderer, { id: 'app-layout', initialTheme: 'dark' });
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

    const senders = ['Al', 'A Very Long Sender Name That Exceeds Narrow Content Widths', 'Bo'];
    const emails: PersistedEmail[] = [];
    for (let i = 0; i < count; i += 1) {
      emails.push(
        makeEmail(`e${i}`, `Subject-${i}`, `Body-${i}`, senders[i % senders.length]!, 1750300000)
      );
    }
    actions.setEmails(emails);
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

  function frameLines(): string[] {
    return setup!.captureCharFrame().split('\n');
  }

  /** Sidebar content row (excludes header and status-bar rows). */
  function contentRowWith(text: string): string | undefined {
    return frameLines().find(
      (l) => l.includes(text) && !l.includes('Folder:') && !l.includes('TERMAIL')
    );
  }

  /** Right edge (exclusive) of the sidebar, derived from its top border. */
  function sidebarWidth(): number {
    const top = frameLines().find((l) => l.startsWith('┌'));
    expect(top).toBeDefined();
    return top!.indexOf('┐') + 1;
  }

  function lastNonSpace(line: string): number {
    return line.search(/\S\s*$/);
  }

  async function pressKey(key: string): Promise<void> {
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

  it('at 120 cols the sidebar and list share rows with the list top-aligned', async () => {
    await setupApp(120, 40);
    const lines = frameLines();

    // Header strip on the first row.
    expect(lines[0]).toContain('TERMAIL');

    // Sidebar and message list occupy the same rows side by side.
    const shared = lines.filter((l) => l.includes('│') && l.includes('Subject-'));
    expect(shared.length).toBeGreaterThan(0);

    // No huge blank area above the emails: first subject near the top.
    const firstSubject = lines.findIndex((l) => l.includes('Subject-'));
    expect(firstSubject).toBeGreaterThanOrEqual(0);
    expect(firstSubject).toBeLessThanOrEqual(6);
  });

  it('at 120 cols folder labels stay inside the sidebar', async () => {
    await setupApp(120, 40);
    const sbw = sidebarWidth();
    for (const name of ['INBOX', 'Sent', 'Drafts']) {
      const row = contentRowWith(name);
      expect(row).toBeDefined();
      expect(row!.indexOf(name)).toBeLessThan(sbw);
    }
  });

  it('at 120 cols sender rows keep the date inside the content region', async () => {
    await setupApp(120, 40);
    const lines = frameLines();
    const width = lines[0]!.length;
    // Short sender: date right-aligned at the content edge.
    const shortRow = lines.find((l) => l.includes('Al ') || l.includes('Al\u2502'));
    expect(shortRow).toBeDefined();
    const end = lastNonSpace(shortRow!);
    expect(end).toBeGreaterThan(width - 12);
  });

  it('at 68 cols the layout stays side by side without overlap', async () => {
    await setupApp(68, 30);
    const lines = frameLines();
    const sbw = sidebarWidth();
    expect(lines[0]).toContain('TERMAIL');

    const shared = lines.filter((l) => l.includes('│') && l.includes('Subject-'));
    expect(shared.length).toBeGreaterThan(0);

    // Folder names live in the sidebar (or the header/status rows),
    // never in the content region.
    for (const row of lines) {
      if (row.includes('Folder:') || row.includes('TERMAIL')) continue;
      for (const name of ['INBOX', 'Sent', 'Drafts']) {
        const at = row.indexOf(name);
        if (at >= 0) expect(at).toBeLessThan(sbw);
      }
    }
  });

  it('at 68 cols a long sender does not push the date off-screen', async () => {
    await setupApp(68, 30);
    const lines = frameLines();
    const width = lines[0]!.length;
    const longRow = lines.find((l) => l.includes('A Very Long Sender'));
    expect(longRow).toBeDefined();
    // Date survives at the right edge even though the sender is clipped.
    expect(lastNonSpace(longRow!)).toBeGreaterThan(width - 12);
  });

  it('opening an email keeps the sidebar visible in the same region', async () => {
    await setupApp(120, 40);
    await pressKey('j');
    await pressKey('j');
    await pressEnter();
    expect(selectors.openedEmailId).toBe('e1');

    const lines = frameLines();
    const text = lines.join('\n');
    // Sidebar still rendered alongside the reading view.
    expect(text).toContain('Folders');
    expect(text).toContain('INBOX');
    expect(text).toContain('Body-1');
    expect(text).toContain('From:');
    const shared = lines.filter((l) => l.includes('│') && l.includes('Body-1'));
    expect(shared.length).toBeGreaterThan(0);
  });

  it('resizing preserves scrolling to the highlight', async () => {
    await setupApp(120, 16, 30);
    for (let i = 0; i < 10; i += 1) {
      await pressKey('j');
    }
    expect(frameLines().join('\n')).toContain('Subject-9');

    setup!.resize(68, 16);
    await setup!.renderOnce();
    await setup!.flush();
    await pressKey('j');
    await pressKey('j');
    expect(selectors.selectedEmailId).toBe('e11');
    expect(frameLines().join('\n')).toContain('Subject-11');

    setup!.resize(120, 16);
    await setup!.renderOnce();
    await setup!.flush();
    await pressKey('j');
    expect(selectors.selectedEmailId).toBe('e12');
    expect(frameLines().join('\n')).toContain('Subject-12');
  });
});
