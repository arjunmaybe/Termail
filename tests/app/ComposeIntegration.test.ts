/**
 * Full-screen composer — end-to-end key-routing and editing tests.
 *
 * These drive the real pipeline that `main.ts` builds:
 *
 *   mockInput bytes -> renderer parser -> `routeKeypress` (global
 *   listener) -> focused native editor (Input/Textarea)
 *
 * so they verify the approved composer behaviour against the actual
 * OpenTUI 0.4.x event model, not against mocks:
 *
 *   - `c` opens a blank compose and the composer replaces the whole shell.
 *   - The opening `c` does not leak into the freshly focused To field.
 *   - Enter advances To/Cc/Bcc/Subject; Enter in Body inserts a newline
 *     and never sends.
 *   - Tab / Shift+Tab cycle To -> ... -> Send and wrap.
 *   - Enter/Space on the focused Send target sends (portable fallback).
 *   - Ctrl+Enter sends when the terminal reports the modifier.
 *   - Escape/Ctrl+C follow the discard policy (empty closes, non-empty
 *     confirms; `y` discards, `n`/Escape cancels).
 *   - Composer keystrokes never reach the inbox shortcuts, and Ctrl+C
 *     outside composition still quits (the renderer does not self-destroy).
 *   - A successful send closes the composer, restores the shell and shows
 *     `Message sent`; a failed send keeps the composer open with a
 *     sanitized error and no status message.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliRenderer } from '@opentui/core';
import { createTestRenderer, type MockInput, type TestRendererSetup } from '@opentui/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App.js';
import { routeKeypress } from '../../src/app/KeyRouter.js';
import type { AiService } from '../../src/core/ai/AiService.js';
import { getConfigStore, resetConfigStore } from '../../src/core/config/ConfigStore.js';
import { getDatabase, resetDatabase } from '../../src/core/database/Database.js';
import type { PersistedEmail } from '../../src/core/database/index.js';
import type { SmtpService } from '../../src/core/smtp/SmtpService.js';
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
    smtpHost: 'smtp.example.com',
    smtpPort: 465,
    smtpMode: 'implicit-tls',
  };
}

function makeEmail(id: string, subject: string, from = 'alice@example.com'): PersistedEmail {
  return {
    id,
    accountId: 'work',
    folderId: 'work:INBOX',
    messageId: `<${id}@example.com>`,
    fromAddresses: [{ name: 'Alice', address: from }],
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

describe('full-screen composer', () => {
  let setup: TestRendererSetup;
  let renderer: CliRenderer;
  let mockInput: MockInput;
  let app: App;
  let testDbPath = '';
  let testConfigPath = '';
  let shutdownCount = 0;
  let sendMail: ReturnType<typeof vi.fn>;
  let draftReply: ReturnType<typeof vi.fn>;

  function child(id: string) {
    return app.getChildren().find((c) => (c as { id?: string }).id === id);
  }

  function editor(field: 'to' | 'cc' | 'bcc' | 'subject' | 'body') {
    return app.getComposeView().getEditor(field);
  }

  /** Let native content-change events and a render pass settle. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await setup.renderOnce();
    await setup.flush();
  }

  async function openCompose(): Promise<void> {
    mockInput.pressKey('c');
    await settle();
  }

  async function type(text: string): Promise<void> {
    await mockInput.typeText(text);
    await settle();
  }

  /** Deterministically push the editors' text into state. */
  function syncState(): void {
    app.getComposeView().syncStateFromEditors();
  }

  beforeEach(async () => {
    resetDatabase();
    resetConfigStore();
    actions.reset();
    shutdownCount = 0;

    testConfigPath = join(tmpdir(), `termail-cmp-${Date.now()}-${Math.random()}-config.json`);
    testDbPath = join(tmpdir(), `termail-cmp-${Date.now()}-${Math.random()}.sqlite`);
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

    sendMail = vi.fn(async () => ({ kind: 'ok' as const }));
    draftReply = vi.fn(async () => ({ kind: 'ok' as const, text: 'AI BODY' }));

    setup = await createTestRenderer({ width: 120, height: 40, exitOnCtrlC: false });
    renderer = setup.renderer;
    mockInput = setup.mockInput;

    app = new App(renderer, {
      id: 'app-compose',
      initialTheme: 'dark',
      smtpService: { sendMail } as unknown as SmtpService,
      aiService: { draftReply } as unknown as AiService,
    });
    renderer.root.add(app);
    app.attach();

    for (let i = 0; i < 100; i += 1) {
      if (app.isInitialized()) break;
      await new Promise((r) => setTimeout(r, 5));
    }

    // Same wiring as main.ts.
    renderer.keyInput.on('keypress', (key) => {
      routeKeypress(key, app, { onShutdown: () => shutdownCount++ });
    });
  });

  afterEach(() => {
    actions.reset();
    try {
      app?.destroy();
    } catch {
      /* ignore */
    }
    if (renderer) {
      try {
        renderer.stop();
        renderer.destroy();
      } catch {
        /* ignore */
      }
    }
    resetDatabase();
    resetConfigStore();
    for (const p of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`, testConfigPath]) {
      if (p && existsSync(p)) rmSync(p);
    }
  });

  // -----------------------------------------------------------------
  // Open + full-screen swap
  // -----------------------------------------------------------------

  it('opens a blank compose with `c` and focuses To', async () => {
    expect(selectors.composeActive).toBe(false);

    await openCompose();

    expect(selectors.composeActive).toBe(true);
    expect(selectors.composeFocus).toBe('to');
    expect(editor('to')?.focused).toBe(true);
  });

  it('replaces the whole shell while composing and restores it on close', async () => {
    expect(app.getHeader().visible).toBe(true);
    expect(app.getStatusBar().visible).toBe(true);
    expect(child('search-input-bar')?.visible).toBe(false);
    expect(app.getComposeView().visible).toBe(false);

    await openCompose();

    expect(app.getHeader().visible).toBe(false);
    expect(app.getStatusBar().visible).toBe(false);
    expect(child('main-row')?.visible).toBe(false);
    expect(app.getComposeView().visible).toBe(true);

    // Close via Escape (empty composer closes immediately).
    mockInput.pressEscape();
    await settle();

    expect(selectors.composeActive).toBe(false);
    expect(app.getHeader().visible).toBe(true);
    expect(app.getStatusBar().visible).toBe(true);
    expect(child('main-row')?.visible).toBe(true);
    expect(app.getComposeView().visible).toBe(false);
  });

  it('does not leak the opening `c` into the To field', async () => {
    await openCompose();
    syncState();
    expect(editor('to')?.plainText ?? '').toBe('');
    expect(selectors.composeTo).toEqual([]);
  });

  // -----------------------------------------------------------------
  // Native editing + field navigation
  // -----------------------------------------------------------------

  it('routes typed text into the focused native editor', async () => {
    await openCompose();
    await type('bob@example.com');
    syncState();

    expect(editor('to')?.plainText).toBe('bob@example.com');
    expect(selectors.composeTo).toEqual(['bob@example.com']);
  });

  it('parses comma- and semicolon-separated recipients consistently', async () => {
    await openCompose();
    await type('a@x.com, b@y.com; c@z.com');
    syncState();

    expect(selectors.composeTo).toEqual(['a@x.com', 'b@y.com', 'c@z.com']);
  });

  it('advances To -> Cc -> Bcc -> Subject -> Body on Enter', async () => {
    await openCompose();
    expect(selectors.composeFocus).toBe('to');

    mockInput.pressEnter();
    await settle();
    expect(selectors.composeFocus).toBe('cc');

    mockInput.pressEnter();
    await settle();
    expect(selectors.composeFocus).toBe('bcc');

    mockInput.pressEnter();
    await settle();
    expect(selectors.composeFocus).toBe('subject');

    mockInput.pressEnter();
    await settle();
    expect(selectors.composeFocus).toBe('body');
    expect(editor('body')?.focused).toBe(true);

    expect(sendMail).not.toHaveBeenCalled();
  });

  it('cycles focus with Tab and Shift+Tab and wraps through Send', async () => {
    await openCompose();
    expect(selectors.composeFocus).toBe('to');

    mockInput.pressTab();
    await settle();
    expect(selectors.composeFocus).toBe('cc');

    mockInput.pressTab({ shift: true });
    await settle();
    expect(selectors.composeFocus).toBe('to');

    mockInput.pressTab({ shift: true });
    await settle();
    expect(selectors.composeFocus).toBe('send');

    mockInput.pressTab();
    await settle();
    expect(selectors.composeFocus).toBe('to');
  });

  it('inserts a newline in Body on Enter and never sends', async () => {
    await openCompose();
    // Move to Body.
    for (let i = 0; i < 4; i += 1) {
      mockInput.pressEnter();
      await settle();
    }
    expect(selectors.composeFocus).toBe('body');

    await type('hello');
    mockInput.pressEnter();
    await settle();
    await type('world');

    expect(editor('body')?.plainText).toBe('hello\nworld');
    expect(selectors.composeActive).toBe(true);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('keeps composer keystrokes away from the inbox shortcuts', async () => {
    await openCompose();
    // Focus Body so the keys are unambiguously "editing" keys.
    for (let i = 0; i < 4; i += 1) {
      mockInput.pressEnter();
      await settle();
    }

    await type('qjk/');
    syncState();

    expect(shutdownCount).toBe(0);
    expect(selectors.searchActive).toBe(false);
    expect(editor('body')?.plainText).toBe('qjk/');
  });

  // -----------------------------------------------------------------
  // Send
  // -----------------------------------------------------------------

  it('sends via the focused Send target (Enter fallback)', async () => {
    await openCompose();
    await type('bob@example.com');
    // To -> Cc -> Bcc -> Subject -> Body -> Send
    for (let i = 0; i < 5; i += 1) {
      mockInput.pressTab();
      await settle();
    }
    expect(selectors.composeFocus).toBe('send');

    mockInput.pressEnter();
    await settle();
    await settle();

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(selectors.composeActive).toBe(false);
  });

  it('sends via Ctrl+Enter when the terminal reports the modifier', async () => {
    await openCompose();
    await type('bob@example.com');

    // Ctrl+Enter is indistinguishable from Enter on legacy terminals; this
    // synthesizes the key the parser produces on modifier-reporting ones.
    routeKeypress({ name: 'return', ctrl: true, preventDefault: () => {} }, app, {
      onShutdown: () => shutdownCount++,
    });
    await settle();
    await settle();

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(selectors.composeActive).toBe(false);
  });

  it('closes the composer, restores the shell and shows "Message sent" on success', async () => {
    await openCompose();
    await type('bob@example.com');

    routeKeypress({ name: 'return', ctrl: true, preventDefault: () => {} }, app, {
      onShutdown: () => shutdownCount++,
    });
    await settle();
    await settle();

    expect(selectors.statusMessage).toBe('Message sent');
    expect(app.getHeader().visible).toBe(true);
    expect(app.getStatusBar().visible).toBe(true);
    expect(app.getComposeView().visible).toBe(false);
  });

  it('keeps the composer open with a sanitized error on failure', async () => {
    sendMail.mockResolvedValueOnce({
      kind: 'auth',
      message: 'auth failed: \u001b[31mboom\u001b[0m user@example.com ***',
    });

    await openCompose();
    await type('bob@example.com');

    routeKeypress({ name: 'return', ctrl: true, preventDefault: () => {} }, app, {
      onShutdown: () => shutdownCount++,
    });
    await settle();
    await settle();

    expect(selectors.composeActive).toBe(true);
    expect(selectors.composeError).not.toBeNull();
    expect(selectors.statusMessage).toBeNull();

    const rendered = app.getComposeView().getStatusText();
    expect(rendered).toContain('Error:');
    expect(rendered).not.toContain('\u001b');
  });

  it('is single-flight: a second send request while sending is ignored', async () => {
    let resolveSend!: (v: { kind: 'ok' }) => void;
    sendMail.mockImplementationOnce(
      () =>
        new Promise<{ kind: 'ok' }>((resolve) => {
          resolveSend = resolve;
        })
    );

    await openCompose();
    await type('bob@example.com');

    // First request starts the in-flight send.
    routeKeypress({ name: 'return', ctrl: true, preventDefault: () => {} }, app, {
      onShutdown: () => shutdownCount++,
    });
    expect(selectors.composeSending).toBe(true);

    // Second request while still sending must be ignored.
    routeKeypress({ name: 'return', ctrl: true, preventDefault: () => {} }, app, {
      onShutdown: () => shutdownCount++,
    });

    expect(sendMail).toHaveBeenCalledTimes(1);
    resolveSend({ kind: 'ok' });
    await settle();
    await settle();
  });

  // -----------------------------------------------------------------
  // Discard safety
  // -----------------------------------------------------------------

  it('closes an empty composer on Escape without confirming', async () => {
    await openCompose();
    mockInput.pressEscape();
    await settle();

    expect(selectors.composeActive).toBe(false);
    expect(selectors.composeConfirmDiscard).toBe(false);
  });

  it('asks for confirmation before discarding a non-empty composer', async () => {
    await openCompose();
    await type('draft');

    mockInput.pressEscape();
    await settle();
    expect(selectors.composeActive).toBe(true);
    expect(selectors.composeConfirmDiscard).toBe(true);

    // `n` cancels and resumes editing.
    mockInput.pressKey('n');
    await settle();
    expect(selectors.composeConfirmDiscard).toBe(false);
    expect(selectors.composeActive).toBe(true);

    // Escape again, then `y` discards.
    mockInput.pressEscape();
    await settle();
    expect(selectors.composeConfirmDiscard).toBe(true);

    mockInput.pressKey('y');
    await settle();
    expect(selectors.composeActive).toBe(false);
    expect(selectors.composeConfirmDiscard).toBe(false);
  });

  it('Ctrl+C follows the same discard policy and never self-destroys', async () => {
    await openCompose();
    // Non-empty: Ctrl+C asks for confirmation.
    await type('draft');

    mockInput.pressCtrlC();
    await settle();
    expect(selectors.composeConfirmDiscard).toBe(true);
    expect(renderer.isDestroyed).toBe(false);

    // Escape cancels the confirmation.
    mockInput.pressEscape();
    await settle();
    expect(selectors.composeConfirmDiscard).toBe(false);
    expect(selectors.composeActive).toBe(true);

    // Empty the composer via the editors (the user's real affordance),
    // then Ctrl+C closes it immediately.
    for (let i = 0; i < 5; i += 1) {
      mockInput.pressBackspace();
      await settle();
    }
    mockInput.pressCtrlC();
    await settle();
    expect(selectors.composeActive).toBe(false);
    expect(renderer.isDestroyed).toBe(false);
  });

  it('Ctrl+C outside composition still quits', async () => {
    mockInput.pressCtrlC();
    await settle();

    expect(shutdownCount).toBe(1);
    // The renderer-owned Ctrl+C destroy handler is disabled; the app is
    // what tears down, and only through `onShutdown`.
    expect(renderer.isDestroyed).toBe(false);
  });

  // -----------------------------------------------------------------
  // AI reply drafting
  // -----------------------------------------------------------------

  it('opens an AI draft atomically with Body focused', async () => {
    actions.setEmails([makeEmail('e1', 'Project update')]);
    actions.setSelectedEmail('e1');

    await app.draftReplyWithAi();
    await settle();

    expect(draftReply).toHaveBeenCalledTimes(1);
    expect(selectors.composeActive).toBe(true);
    expect(selectors.composeTo).toEqual(['alice@example.com']);
    expect(selectors.composeSubject).toBe('Re: Project update');
    expect(selectors.composeBody).toBe('AI BODY');
    expect(selectors.composeFocus).toBe('body');
    expect(editor('body')?.focused).toBe(true);

    // The editors received the values (single activation transition).
    expect(editor('to')?.plainText).toBe('alice@example.com');
    expect(editor('body')?.plainText).toBe('AI BODY');
  });

  it('does not open an AI draft over an already-active composer', async () => {
    actions.setEmails([makeEmail('e1', 'Project update')]);
    actions.setSelectedEmail('e1');
    await openCompose();
    await type('typed-by-hand');
    syncState();

    await app.draftReplyWithAi();
    await settle();

    expect(draftReply).not.toHaveBeenCalled();
    expect(selectors.composeTo).toEqual(['typed-by-hand']);
  });
});
