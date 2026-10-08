/**
 * Thrown sync errors preserve auth vs network semantics.
 *
 * `SyncService.syncAccountFolder` rethrows fetch/persist failures; the App
 * must map a thrown `AuthenticationError` to the auth path (not a generic
 * network error) so the user sees the real cause and the IMAP socket is
 * still released by the service `finally` block.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigStore, resetConfigStore } from '../../src/core/config/ConfigStore.js';
import { getDatabase, resetDatabase } from '../../src/core/database/Database.js';
import { actions, selectors } from '../../src/core/state/AppState.js';
import { AuthenticationError } from '../../src/core/utils/errors.js';
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

describe('App.requestSync thrown auth mapping', () => {
  let testDbPath = '';
  let testConfigPath = '';

  beforeEach(async () => {
    resetDatabase();
    resetConfigStore();
    actions.reset();
    testConfigPath = join(tmpdir(), `termail-autht-${Date.now()}-${Math.random()}-config.json`);
    testDbPath = join(tmpdir(), `termail-autht-${Date.now()}-${Math.random()}.sqlite`);
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
      `INSERT INTO folders (id, account_id, name, full_name, type, delimiter) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('work:INBOX', 'work', 'INBOX', 'INBOX', 'inbox', '/');
  });

  afterEach(() => {
    actions.reset();
    resetDatabase();
    resetConfigStore();
    for (const p of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`, testConfigPath]) {
      if (p && existsSync(p)) rmSync(p);
    }
  });

  async function makeApp(fake: { syncAccountFolder: ReturnType<typeof vi.fn> }) {
    const { App } = await import('../../src/app/App.js');
    const renderer = (await import('@opentui/core/testing').then((m) =>
      m.createTestRenderer({ width: 120, height: 40 })
    )).renderer;
    try {
      const app = new App(renderer, {
        id: 'app-autht',
        initialTheme: 'dark',
        syncService: fake as never,
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

  it('a thrown AuthenticationError surfaces its message as a sync error', async () => {
    const fake = { syncAccountFolder: vi.fn() };
    fake.syncAccountFolder.mockRejectedValueOnce(
      new AuthenticationError('IMAP authentication failed: bad token')
    );
    const { app, renderer } = await makeApp(fake);
    try {
      await app.requestSync();
      expect(selectors.syncStatus).toBe('error');
      expect(selectors.syncError).toMatch(/authentication/i);
      expect(selectors.syncError).toMatch(/bad token/);
    } finally {
      renderer.stop();
      renderer.destroy();
    }
  });

  it('a thrown generic Error surfaces as a network-style sync error', async () => {
    const fake = { syncAccountFolder: vi.fn() };
    fake.syncAccountFolder.mockRejectedValueOnce(new Error('fetch exploded'));
    const { app, renderer } = await makeApp(fake);
    try {
      await app.requestSync();
      expect(selectors.syncStatus).toBe('error');
      expect(selectors.syncError).toBe('fetch exploded');
    } finally {
      renderer.stop();
      renderer.destroy();
    }
  });
});
