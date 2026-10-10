/**
 * ConfigStore tests
 */

import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConfigStore, resetConfigStore } from '../../src/core/config/ConfigStore.js';
import { getDefaultConfig } from '../../src/core/config/defaults.js';

const isPosix = process.platform !== 'win32';
// Strict mode assertions only run where POSIX bits are honored; on
// Windows they are skipped (not failed) to avoid brittle ACL checks.
const itPosix = isPosix ? it : it.skip;
const modeOf = (p: string): number => statSync(p).mode & 0o777;
import type { AppConfig } from '../../src/core/types/config.js';
import { DEFAULT_AI_CONFIG } from '../../src/core/types/config.js';

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
      ai: { ...DEFAULT_AI_CONFIG },
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

  describe('file permissions', () => {
    let nestedRoot: string | null = null;

    afterEach(() => {
      if (nestedRoot && existsSync(nestedRoot)) {
        rmSync(nestedRoot, { recursive: true, force: true });
      }
      nestedRoot = null;
    });

    itPosix('creates the config file with owner-only permissions', async () => {
      await configStore.initialize();
      expect(modeOf(testConfigPath)).toBe(0o600);
    });

    itPosix('creates the config directory with owner-only permissions', async () => {
      nestedRoot = join(tmpdir(), `termail-perm-${Date.now()}-${Math.random()}`);
      const nestedConfig = join(nestedRoot, 'nested', 'config.json');
      resetConfigStore();
      const store = getConfigStore(nestedConfig);
      await store.initialize();
      // Only the Termail-created leaf is asserted; shared parents (tmpdir) are untouched.
      expect(modeOf(dirname(nestedConfig))).toBe(0o700);
      expect(modeOf(nestedConfig)).toBe(0o600);
    });

    itPosix('hardens a pre-existing world-readable config file', async () => {
      writeFileSync(testConfigPath, JSON.stringify(getDefaultConfig()), 'utf-8');
      chmodSync(testConfigPath, 0o644);
      expect(modeOf(testConfigPath)).toBe(0o644);

      const loaded = await configStore.initialize();
      expect(modeOf(testConfigPath)).toBe(0o600);
      expect(loaded.version).toBe(1);
    });

    it('initializes regardless of platform permission support', async () => {
      const config = await configStore.initialize();
      expect(config.version).toBe(1);
      expect(existsSync(testConfigPath)).toBe(true);
    });
  });
});
