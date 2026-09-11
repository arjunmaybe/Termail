/**
 * Application configuration types
 */

export interface AppConfig {
  version: number;
  database: DatabaseConfig;
  ui: UiConfig;
  accounts: AccountConfig[];
  ai: AiConfig;
}

export interface DatabaseConfig {
  path: string;
}

export interface UiConfig {
  theme: 'dark' | 'light';
  paneRatio: number; // sidebar width ratio (0.2 - 0.5)
  showStatusBar: boolean;
  showFolderIcons: boolean;
  compactMode: boolean;
}

export type SmtpMode = 'implicit-tls' | 'starttls';

/** AI assistance settings (Phase 5). Disabled by default; opt-in per user. */
export interface AiConfig {
  /** Master switch. When false, no AI request is ever issued. */
  enabled: boolean;
  /** Provider id. Only 'openrouter' is supported in Phase 5. */
  provider: 'openrouter';
  /** Model id passed to the provider. Configurable; no free-tier assumption. */
  model: string;
  /** Chat-completions endpoint. Defaults to OpenRouter; overridable for gateways. */
  endpoint: string;
  /** Max email body characters sent per request (cost/privacy bound). */
  maxBodyChars: number;
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs: number;
}

export interface AccountConfig {
  id: string;
  name: string;
  email: string;
  enabled: boolean;
  // IMAP settings. `port` is always present after validation (defaults to
  // 993 for TLS or 143 for plain). `host` and `username` are required to
  // actually connect; the schema leaves them optional so the config file
  // can be edited incrementally, but the IMAP service will surface a
  // descriptive error if they're missing.
  host?: string;
  port: number;
  username?: string;
  useTls: boolean;
  authType: 'password' | 'oauth2';
  // SMTP settings (Phase 4). All optional for backward compatibility.
  // `smtpMode` is explicit and is NEVER inferred from IMAP `useTls`.
  // Resolution (see `resolveSmtpConfig`):
  //   - no smtpPort + no smtpMode -> implicit-tls, port 465
  //   - smtpPort only -> 465 means implicit-tls, any other port means starttls
  //   - smtpMode only -> implicit-tls uses 465, starttls uses 587
  //   - explicit smtpPort always wins.
  smtpHost?: string;
  smtpPort?: number;
  smtpMode?: SmtpMode;
}

/** Deep-partial type that allows nested fields to be omitted. */
export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

// Default configuration
export const DEFAULT_AI_CONFIG: AiConfig = {
  enabled: false,
  provider: 'openrouter',
  model: 'meta-llama/llama-3.3-70b-instruct',
  endpoint: 'https://openrouter.ai/api/v1/chat/completions',
  maxBodyChars: 8000,
  requestTimeoutMs: 30000,
};

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  database: {
    path: '~/.local/share/termail/db.sqlite',
  },
  ui: {
    theme: 'dark',
    paneRatio: 0.3,
    showStatusBar: true,
    showFolderIcons: true,
    compactMode: false,
  },
  accounts: [],
  ai: { ...DEFAULT_AI_CONFIG },
};

// Config file paths
export function getConfigPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const sep = home.includes('\\') ? '\\' : '/';
  return `${home}${sep}.config${sep}termail${sep}config.json`;
}

export function getDatabasePath(config: AppConfig): string {
  const path = config.database.path;
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return home + path.slice(1);
  }
  return path;
}
