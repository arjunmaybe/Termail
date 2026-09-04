/**
 * Default configuration values and path helpers
 */

import type { AppConfig } from '../types/config.js';
import {
  DEFAULT_CONFIG,
  getConfigPath as _getConfigPath,
  getDatabasePath as _getDatabasePath,
} from '../types/config.js';

export function getDefaultConfig(): AppConfig {
  return { ...DEFAULT_CONFIG };
}

export function mergeWithDefaults(config: Partial<AppConfig>): AppConfig {
  return {
    version: config.version ?? DEFAULT_CONFIG.version,
    database: {
      ...DEFAULT_CONFIG.database,
      ...config.database,
    },
    ui: {
      ...DEFAULT_CONFIG.ui,
      ...(config.ui as Partial<AppConfig['ui']> | undefined),
    },
    accounts: config.accounts ?? DEFAULT_CONFIG.accounts,
  };
}

export const getConfigPath = _getConfigPath;
export const getDatabasePath = _getDatabasePath;
