/**
 * Zod schema for configuration validation
 */

import { z } from 'zod';
import type { AccountConfig, AppConfig, DatabaseConfig, UiConfig } from '../types/config.js';

export const databaseConfigSchema = z.object({
  path: z.string().min(1),
});

export const uiConfigSchema = z.object({
  theme: z.enum(['dark', 'light']).default('dark'),
  paneRatio: z.number().min(0.2).max(0.5).default(0.3),
  showStatusBar: z.boolean().default(true),
  showFolderIcons: z.boolean().default(true),
  compactMode: z.boolean().default(false),
});

export const accountConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  enabled: z.boolean().default(true),
  host: z.string().optional(),
  port: z.number().int().positive().optional(),
  username: z.string().optional(),
  useTls: z.boolean().default(true),
  authType: z.enum(['password', 'oauth2']).default('password'),
});

export const appConfigSchema = z.object({
  version: z.number().int().positive().default(1),
  database: databaseConfigSchema,
  ui: uiConfigSchema,
  accounts: z.array(accountConfigSchema).default([]),
});

// Type assertion: Zod's input/output types differ (defaults are optional in
// input, required in output); runtime behaviour matches our interfaces.
const _databaseAssert: z.ZodType<DatabaseConfig, z.ZodTypeDef, DatabaseConfig> =
  databaseConfigSchema as z.ZodType<DatabaseConfig, z.ZodTypeDef, DatabaseConfig>;
const _uiAssert: z.ZodType<UiConfig, z.ZodTypeDef, UiConfig> = uiConfigSchema as z.ZodType<
  UiConfig,
  z.ZodTypeDef,
  UiConfig
>;
const _accountAssert: z.ZodType<AccountConfig, z.ZodTypeDef, AccountConfig> =
  accountConfigSchema as z.ZodType<AccountConfig, z.ZodTypeDef, AccountConfig>;
const _appAssert: z.ZodType<AppConfig, z.ZodTypeDef, AppConfig> = appConfigSchema as z.ZodType<
  AppConfig,
  z.ZodTypeDef,
  AppConfig
>;
void _databaseAssert;
void _uiAssert;
void _accountAssert;
void _appAssert;

export function validateConfig(config: unknown): AppConfig {
  return appConfigSchema.parse(config) as AppConfig;
}

export function validateConfigSafe(
  config: unknown
): { success: true; data: AppConfig } | { success: false; error: z.ZodError } {
  const result = appConfigSchema.safeParse(config);
  if (result.success) {
    return { success: true, data: result.data as AppConfig };
  }
  return { success: false, error: result.error };
}
