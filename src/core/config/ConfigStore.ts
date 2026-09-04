/**
 * Configuration store - handles loading/saving JSON config with Zod validation
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import type { AppConfig, DeepPartial } from '../types/config.js';
import { ConfigError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { getConfigPath, getDefaultConfig, mergeWithDefaults } from './defaults.js';
import { validateConfig, validateConfigSafe } from './schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class ConfigStore {
  private config: AppConfig;
  private configPath: string;
  private initialized = false;

  constructor(customPath?: string) {
    this.configPath = customPath || getConfigPath();
    this.config = getDefaultConfig();
  }

  /**
   * Initialize the config store - load existing or create default
   */
  async initialize(): Promise<AppConfig> {
    if (this.initialized) {
      return this.config;
    }

    try {
      await this.ensureConfigDir();
      this.config = await this.load();
      this.initialized = true;
      logger.info('Configuration loaded', { path: this.configPath });
      return this.config;
    } catch (error) {
      logger.error('Failed to initialize config', { error });
      throw new ConfigError(`Failed to initialize configuration: ${error}`);
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): AppConfig {
    if (!this.initialized) {
      throw new ConfigError('ConfigStore not initialized. Call initialize() first.');
    }
    return this.config;
  }

  /**
   * Update configuration and persist.
   *
   * `ui` is deep-merged so callers can update a single field (e.g.
   * `updateConfig({ ui: { theme: 'light' } })`) without having to
   * re-supply the rest of the UI config.
   */
  async updateConfig(updates: DeepPartial<AppConfig>): Promise<AppConfig> {
    if (!this.initialized) {
      throw new ConfigError('ConfigStore not initialized. Call initialize() first.');
    }

    const merged: AppConfig = {
      ...this.config,
      ...updates,
      database: { ...this.config.database, ...(updates.database ?? {}) },
      ui: { ...this.config.ui, ...(updates.ui ?? {}) },
      accounts: (updates.accounts as AppConfig['accounts'] | undefined) ?? this.config.accounts,
    };
    const validated = validateConfig(merged);
    await this.save(validated);
    this.config = validated;
    logger.info('Configuration updated');
    return this.config;
  }

  /**
   * Update UI configuration
   */
  async updateUiConfig(uiUpdates: Partial<AppConfig['ui']>): Promise<AppConfig> {
    return this.updateConfig({ ui: { ...this.config.ui, ...uiUpdates } });
  }

  /**
   * Add or update an account
   */
  async upsertAccount(account: AppConfig['accounts'][0]): Promise<AppConfig> {
    const accounts = this.config.accounts.filter((a) => a.id !== account.id);
    accounts.push(account);
    return this.updateConfig({
      accounts: accounts as AppConfig['accounts'],
    } as DeepPartial<AppConfig>);
  }

  /**
   * Remove an account
   */
  async removeAccount(accountId: string): Promise<AppConfig> {
    const accounts = this.config.accounts.filter((a) => a.id !== accountId);
    return this.updateConfig({
      accounts: accounts as AppConfig['accounts'],
    } as DeepPartial<AppConfig>);
  }

  /**
   * Load configuration from file
   */
  private async load(): Promise<AppConfig> {
    if (!existsSync(this.configPath)) {
      logger.info('No config file found, creating default', { path: this.configPath });
      const defaultConfig = getDefaultConfig();
      await this.save(defaultConfig);
      return defaultConfig;
    }

    try {
      const content = readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(content);
      const result = validateConfigSafe(parsed);

      if (!result.success) {
        logger.warn('Config validation failed, using defaults', { errors: result.error.errors });
        const defaultConfig = getDefaultConfig();
        await this.save(defaultConfig);
        return defaultConfig;
      }

      return result.data;
    } catch (error) {
      logger.error('Failed to parse config file', { error });
      const defaultConfig = getDefaultConfig();
      await this.save(defaultConfig);
      return defaultConfig;
    }
  }

  /**
   * Save configuration to file
   */
  private async save(config: AppConfig): Promise<void> {
    await this.ensureConfigDir();
    const content = JSON.stringify(config, null, 2);
    writeFileSync(this.configPath, content, 'utf-8');
  }

  /**
   * Ensure config directory exists
   */
  private async ensureConfigDir(): Promise<void> {
    const dir = dirname(this.configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

// Singleton instance
let configStoreInstance: ConfigStore | null = null;

export function getConfigStore(customPath?: string): ConfigStore {
  if (!configStoreInstance) {
    configStoreInstance = new ConfigStore(customPath);
  }
  return configStoreInstance;
}

export function resetConfigStore(): void {
  configStoreInstance = null;
}
