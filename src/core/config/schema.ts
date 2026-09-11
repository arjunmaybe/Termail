/**
 * Zod schema for configuration validation
 */

import { z } from 'zod';
import type {
  AccountConfig,
  AiConfig,
  AppConfig,
  DatabaseConfig,
  UiConfig,
} from '../types/config.js';

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

/**
 * Account config schema.
 *
 * IMAP fields (`host`, `port`, `username`) are optional at the input level so
 * the config file can be edited incrementally. After parsing, `port` is
 * defaulted to 993 (TLS) or 143 (plain) so the runtime always has a usable
 * port without callers re-checking.
 *
 * SMTP fields (`smtpHost`, `smtpPort`, `smtpMode`) are optional for backward
 * compatibility and are NEVER inferred from IMAP `useTls`. `smtpPort` /
 * `smtpMode` are defaulted together (see `resolveSmtpDefaults`); `smtpHost`
 * stays undefined when absent so sending can fail safely before connecting.
 *
 * Passwords / OAuth tokens are NEVER stored in the config file. The
 * `ImapService` / `SmtpService` resolve them from environment variables at
 * connect time.
 */
export const accountConfigSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    email: z.string().email(),
    enabled: z.boolean().default(true),
    host: z.string().min(1).optional(),
    port: z.number().int().positive().max(65535).optional(),
    username: z.string().min(1).optional(),
    useTls: z.boolean().default(true),
    authType: z.enum(['password', 'oauth2']).default('password'),
    smtpHost: z.string().min(1).optional(),
    smtpPort: z.number().int().min(1).max(65535).optional(),
    smtpMode: z.enum(['implicit-tls', 'starttls']).optional(),
  })
  .transform((account) => {
    // Default the IMAP port based on TLS so callers can rely on a number.
    const withImapPort =
      account.port === undefined ? { ...account, port: account.useTls ? 993 : 143 } : account;
    return {
      ...withImapPort,
      ...resolveSmtpDefaults({ smtpPort: withImapPort.smtpPort, smtpMode: withImapPort.smtpMode }),
    };
  });

/**
 * Resolve SMTP port/mode defaults without reading IMAP `useTls`.
 *
 * - no port + no mode -> implicit-tls, 465
 * - port only -> 465 means implicit-tls, any other port means starttls
 * - mode only -> implicit-tls uses 465, starttls uses 587
 * - explicit port always wins over the mode default.
 */
export function resolveSmtpDefaults(input: {
  smtpPort?: number;
  smtpMode?: 'implicit-tls' | 'starttls';
}): { smtpPort: number; smtpMode: 'implicit-tls' | 'starttls' } {
  const { smtpPort, smtpMode } = input;
  if (smtpPort !== undefined && smtpMode !== undefined) {
    return { smtpPort, smtpMode };
  }
  if (smtpPort !== undefined) {
    return { smtpPort, smtpMode: smtpPort === 465 ? 'implicit-tls' : 'starttls' };
  }
  if (smtpMode !== undefined) {
    return { smtpPort: smtpMode === 'implicit-tls' ? 465 : 587, smtpMode };
  }
  return { smtpPort: 465, smtpMode: 'implicit-tls' };
}

/**
 * AI assistance settings (Phase 5). Disabled by default; the user opts in
 * explicitly. The API key is NEVER stored here — it comes from the
 * `TERMAIL_AI_API_KEY` environment variable at request time.
 */
export const aiConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['openrouter']).default('openrouter'),
  model: z.string().min(1).default('meta-llama/llama-3.3-70b-instruct'),
  endpoint: z.string().url().default('https://openrouter.ai/api/v1/chat/completions'),
  maxBodyChars: z.number().int().min(500).max(100000).default(8000),
  requestTimeoutMs: z.number().int().min(1000).max(300000).default(30000),
});

export const appConfigSchema = z.object({
  version: z.number().int().positive().default(1),
  database: databaseConfigSchema,
  ui: uiConfigSchema,
  accounts: z.array(accountConfigSchema).default([]),
  ai: aiConfigSchema.default({
    enabled: false,
    provider: 'openrouter',
    model: 'meta-llama/llama-3.3-70b-instruct',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    maxBodyChars: 8000,
    requestTimeoutMs: 30000,
  }),
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
const _aiAssert: z.ZodType<AiConfig, z.ZodTypeDef, AiConfig> = aiConfigSchema as z.ZodType<
  AiConfig,
  z.ZodTypeDef,
  AiConfig
>;
const _appAssert: z.ZodType<AppConfig, z.ZodTypeDef, AppConfig> = appConfigSchema as z.ZodType<
  AppConfig,
  z.ZodTypeDef,
  AppConfig
>;
void _databaseAssert;
void _uiAssert;
void _accountAssert;
void _aiAssert;
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
