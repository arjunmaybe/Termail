/**
 * B2 — AI draft must not clobber active compose.
 *
 * Regression coverage:
 *  1. active compose + d => compose unchanged, AI not called
 *  2. inactive compose + d => existing draft flow works
 *  3. active compose + s => compose and AI state remain unaffected
 *  4. compose opened while AI is in flight => stale AI result does not
 *     overwrite the newly opened buffer (post-await guard)
 */

import { existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigStore, resetConfigStore } from '../../src/core/config/ConfigStore.js';
import { getDatabase, resetDatabase } from '../../src/core/database/Database.js';
import { actions, selectors } from '../../src/core/state/AppState.js';
import type { PersistedEmail } from '../../src/core/database/index.js';
import type { AiService } from '../../src/core/ai/AiService.js';
import type { AppConfig, AccountConfig } from '../../src/core/types/config.js';

function makeAccountConfig(over: Partial<AccountConfig> = {}): AccountConfig {
  return {
    id: 'work',
    name: 'Work',
    email: 'me@example.com',
    enabled: true,
    host: 'imap.example.com',
    port: 993,
    useTls: true,
    authType: 'password',
    ...over,
  };
}

function makeEmail(over: Partial<PersistedEmail> = {}): PersistedEmail {
  return {
    id: 'work:INBOX:1',
    accountId: 'work',
    folderId: 'work:INBOX',
    messageId: '<m-1@example.com>',
    fromAddresses: [{ name: 'Alice', address: 'alice@example.com' }],
    toAddresses: [{ name: '', address: 'me@example.com' }],
    ccAddresses: [],
    subject: 'Q3 planning',
    date: 1788295200,
    internalDate: 1788295200,
    receivedAt: 1788295200,
    isRead: false,
    isFlagged: false,
    isAnswered: false,
    isDraft: false,
    hasAttachments: false,
    size: 100,
    bodyText: 'Please review by Friday.',
    bodyHtml: null,
    headers: {},
    attachments: [],
    flags: [],
    uid: 1,
    createdAt: 1788295200,
    updatedAt: 1788295200,
    ...over,
  };
}

describe('B2 App AI/compose guard', () => {
  let testDbPath: string;
  let testConfigPath: string;

  beforeEach(async () => {
    resetDatabase();
    resetConfigStore();
    actions.reset();
    testConfigPath = join(tmpdir(), `termail-b2-${Date.now()}-${Math.random()}-config.json`);
    testDbPath = join(tmpdir(), `termail-b2-${Date.now()}-${Math.random()}.sqlite`);

    const configStore = getConfigStore(testConfigPath);
    await configStore.initialize();
    const account = makeAccountConfig();
    await configStore.updateConfig({
      accounts: [account],
      database: { path: testDbPath },
    } as Partial<AppConfig>);
    const database = getDatabase(configStore.getConfig());
    await database.initialize();

    database.query(
      `INSERT INTO accounts (id, name, type, email, use_tls, auth_type)
       VALUES (?, ?, 'imap', ?, 1, 'password')`
    ).run('work', 'Work', 'me@example.com');
    database.query(
      `INSERT INTO folders (id, account_id, name, full_name, type, delimiter)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('work:INBOX', 'work', 'INBOX', 'INBOX', 'inbox', '/');
  });

  afterEach(() => {
    actions.reset();
    resetDatabase();
    resetConfigStore();
    for (const p of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`, testConfigPath]) {
      if (existsSync(p)) rmSync(p);
    }
  });

  async function makeAppWithFakeAi(fakeAi: unknown) {
    const { App } = await import('../../src/app/App.js');
    const renderer = (await import('@opentui/core/testing').then((m) =>
      m.createTestRenderer({ width: 120, height: 40 })
    )).renderer;
    try {
      const app = new App(renderer, {
        id: 'app-b2',
        initialTheme: 'dark',
        aiService: fakeAi as AiService,
      });
      for (let i = 0; i < 50; i += 1) {
        if (app.isInitialized()) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      return { app, renderer };
    } catch (e) {
      try {
        renderer.stop();
      } catch {
        /* ignore */
      }
      try {
        renderer.destroy();
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  it('active compose + d => compose unchanged, AI not called', async () => {
    const draftReply = vi.fn(async () => ({ kind: 'ok' as const, text: 'AI DRAFT' }));
    const summarizeEmail = vi.fn(async () => ({ kind: 'ok' as const, text: 'SUMMARY' }));
    const fakeAi = { draftReply, summarizeEmail };
    const { app, renderer } = await makeAppWithFakeAi(fakeAi);
    try {
      const email = makeEmail();
      actions.setEmails([email]);
      actions.setSelectedEmail(email.id);

      // Activate compose with a known buffer.
      actions.openCompose();
      actions.setComposeTo(['bob@example.com']);
      actions.setComposeSubject('My subject');
      actions.setComposeBody('My body');

      await app.draftReplyWithAi();

      expect(draftReply).not.toHaveBeenCalled();
      expect(selectors.composeActive).toBe(true);
      expect(selectors.composeTo).toEqual(['bob@example.com']);
      expect(selectors.composeSubject).toBe('My subject');
      expect(selectors.composeBody).toBe('My body');
      // AI state untouched.
      expect(selectors.aiResult).toBeNull();
      expect(selectors.aiLoading).toBe(false);
    } finally {
      renderer.stop();
      renderer.destroy();
    }
  });

  it('inactive compose + d => existing draft flow works', async () => {
    const draftReply = vi.fn(async () => ({ kind: 'ok' as const, text: 'AI DRAFT BODY' }));
    const summarizeEmail = vi.fn(async () => ({ kind: 'ok' as const, text: 'SUMMARY' }));
    const fakeAi = { draftReply, summarizeEmail };
    const { app, renderer } = await makeAppWithFakeAi(fakeAi);
    try {
      const email = makeEmail();
      actions.setEmails([email]);
      actions.setSelectedEmail(email.id);
      expect(selectors.composeActive).toBe(false);

      await app.draftReplyWithAi();

      expect(draftReply).toHaveBeenCalledTimes(1);
      expect(selectors.composeActive).toBe(true);
      expect(selectors.composeTo).toEqual(['alice@example.com']);
      expect(selectors.composeSubject).toBe('Re: Q3 planning');
      expect(selectors.composeBody).toBe('AI DRAFT BODY');
    } finally {
      renderer.stop();
      renderer.destroy();
    }
  });

  it('active compose + s => compose and AI state remain unaffected', async () => {
    const draftReply = vi.fn(async () => ({ kind: 'ok' as const, text: 'DRAFT' }));
    const summarizeEmail = vi.fn(async () => ({ kind: 'ok' as const, text: 'SUMMARY' }));
    const fakeAi = { draftReply, summarizeEmail };
    const { app, renderer } = await makeAppWithFakeAi(fakeAi);
    try {
      const email = makeEmail();
      actions.setEmails([email]);
      actions.setSelectedEmail(email.id);

      actions.openCompose();
      actions.setComposeTo(['bob@example.com']);
      actions.setComposeSubject('My subject');
      actions.setComposeBody('My body');

      await app.summarizeSelectedEmail();

      expect(summarizeEmail).not.toHaveBeenCalled();
      expect(selectors.composeActive).toBe(true);
      expect(selectors.composeTo).toEqual(['bob@example.com']);
      expect(selectors.composeSubject).toBe('My subject');
      expect(selectors.composeBody).toBe('My body');
      expect(selectors.aiResult).toBeNull();
      expect(selectors.aiError).toBeNull();
      expect(selectors.aiLoading).toBe(false);
    } finally {
      renderer.stop();
      renderer.destroy();
    }
  });

  it('compose opened while AI is in flight => does not overwrite the new buffer', async () => {
    let resolveDraft!: (v: { kind: 'ok'; text: string }) => void;
    const draftReply = vi.fn(
      () => new Promise<{ kind: 'ok'; text: string }>((resolve) => { resolveDraft = resolve; })
    );
    const summarizeEmail = vi.fn(async () => ({ kind: 'ok' as const, text: 'SUMMARY' }));
    const fakeAi = { draftReply, summarizeEmail };
    const { app, renderer } = await makeAppWithFakeAi(fakeAi);
    try {
      const email = makeEmail();
      actions.setEmails([email]);
      actions.setSelectedEmail(email.id);
      expect(selectors.composeActive).toBe(false);

      const pending = app.draftReplyWithAi();
      // AI is now in flight; user opens compose manually.
      actions.openCompose();
      actions.setComposeTo(['carol@example.com']);
      actions.setComposeSubject('Manual subject');
      actions.setComposeBody('Manual body');

      resolveDraft({ kind: 'ok', text: 'STALE AI DRAFT' });
      await pending;

      // New buffer preserved, not clobbered by stale AI.
      expect(selectors.composeTo).toEqual(['carol@example.com']);
      expect(selectors.composeSubject).toBe('Manual subject');
      expect(selectors.composeBody).toBe('Manual body');
    } finally {
      renderer.stop();
      renderer.destroy();
    }
  });
});
