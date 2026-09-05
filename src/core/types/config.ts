/**
 * Application configuration types
 */

export interface AppConfig {
  version: number;
  database: DatabaseConfig;
  ui: UiConfig;
  accounts: AccountConfig[];
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
}

/** Deep-partial type that allows nested fields to be omitted. */
export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

// Default configuration
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
