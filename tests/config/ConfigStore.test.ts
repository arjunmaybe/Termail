/**
 * ConfigStore tests
 */

import { existsSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConfigStore, resetConfigStore } from '../../src/core/config/ConfigStore.js';
import type { AppConfig } from '../../src/core/types/config.js';

describe('ConfigStore', () => {
  let testConfigPath: string;
  let configStore: ReturnType<typeof getConfigStore>;

  beforeEach(() => {
    resetConfigStore();
    testConfigPath = join(tmpdir(), `termail-test-${Date.now()}-config.json`);
    configStore = getConfigStore(testConfigPath);
  });

  afterEach(() => {
    resetConfigStore();
    if (existsSync(testConfigPath)) {
      rmSync(testConfigPath);
    }
  });

  it('should initialize with default config when no file exists', async () => {
    const config = await configStore.initialize();

    expect(config).toBeDefined();
    expect(config.version).toBe(1);
    expect(config.database.path).toBeDefined();
    expect(config.ui.theme).toBe('dark');
    expect(config.ui.paneRatio).toBe(0.3);
    expect(config.accounts).toEqual([]);
  });

  it('should load existing config from file', async () => {
    const customConfig: AppConfig = {
      version: 1,
      database: { path: '/custom/path/db.sqlite' },
      ui: {
        theme: 'light',
        paneRatio: 0.4,
        showStatusBar: false,
        showFolderIcons: false,
        compactMode: true,
      },
      accounts: [
        {
          id: 'acc1',
          name: 'Test',
          email: 'test@example.com',
          enabled: true,
          port: 993,
          useTls: true,
          authType: 'password',
        },
      ],
    };

    // Create config store, initialize, then create a new one with same path
    await configStore.initialize();
    await configStore.updateConfig(customConfig);

    resetConfigStore();
    const newStore = getConfigStore(testConfigPath);
    const loaded = await newStore.initialize();

    expect(loaded.ui.theme).toBe('light');
    expect(loaded.ui.paneRatio).toBe(0.4);
    expect(loaded.accounts).toHaveLength(1);
    const firstAccount = loaded.accounts[0];
    expect(firstAccount).toBeDefined();
    expect(firstAccount?.email).toBe('test@example.com');
  });

  it('should merge updates with defaults', async () => {
    await configStore.initialize();
    const updated = await configStore.updateConfig({
      ui: { theme: 'light' },
    });

    expect(updated.ui.theme).toBe('light');
    expect(updated.ui.paneRatio).toBe(0.3); // default preserved
    expect(updated.database.path).toBeDefined(); // default preserved
  });

  it('should validate config with Zod', async () => {
    await configStore.initialize();

    // Valid update
    await expect(configStore.updateConfig({ ui: { paneRatio: 0.4 } })).resolves.toBeDefined();

    // Invalid update - paneRatio out of bounds
    await expect(configStore.updateConfig({ ui: { paneRatio: 0.6 } })).rejects.toThrow();
  });

  it('should upsert accounts', async () => {
    await configStore.initialize();

    await configStore.upsertAccount({
      id: 'acc1',
      name: 'Account 1',
      email: 'acc1@example.com',
      enabled: true,
      port: 993,
      useTls: true,
      authType: 'password',
    });

    const config = configStore.getConfig();
    expect(config.accounts).toHaveLength(1);

    // Update existing
    await configStore.upsertAccount({
      id: 'acc1',
      name: 'Account 1 Updated',
      email: 'acc1@example.com',
      enabled: true,
      port: 993,
      useTls: true,
      authType: 'password',
    });

    const updated = configStore.getConfig();
    expect(updated.accounts).toHaveLength(1);
    const updatedAccount = updated.accounts[0];
    expect(updatedAccount).toBeDefined();
    expect(updatedAccount?.name).toBe('Account 1 Updated');
  });

  it('should remove accounts', async () => {
    await configStore.initialize();

    await configStore.upsertAccount({
      id: 'acc1',
      name: 'Account 1',
      email: 'acc1@example.com',
      enabled: true,
      port: 993,
      useTls: true,
      authType: 'password',
    });

    await configStore.removeAccount('acc1');
    const config = configStore.getConfig();
    expect(config.accounts).toHaveLength(0);
  });
});
