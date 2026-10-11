/**
 * Operating-system secret storage.
 *
 * Credentials never live in `config.json`, SQLite, source code, or logs.
 * This module defines a small synchronous `SecretStore` interface plus the
 * platform implementations. Resolution precedence (see
 * `resolveCredentials` in `../imap/credentials.js`):
 *
 *   1. `TERMAIL_<ACCOUNT>_PASSWORD` / `TERMAIL_<ACCOUNT>_OAUTH_TOKEN`
 *      environment variables (override for development and headless use).
 *   2. The OS credential store (persistence across restarts).
 *   3. An `AuthenticationError` naming the account and the setup action.
 *
 * Only Windows is implemented (`PasswordVault` via PowerShell, no new
 * dependencies). Every other platform resolves to `null` from
 * `getPlatformSecretStore()`, which keeps environment-only behavior
 * exactly as before. Callers must never substitute empty or dummy
 * secrets: store failures throw `SecretStoreError`.
 */

export type SecretKind = 'password' | 'oauth2';

/** Storage key derivation shared by every backend. */
export function secretUsername(accountId: string, kind: SecretKind): string {
  return `${accountId}/${kind === 'oauth2' ? 'oauth-token' : 'password'}`;
}

/** Credential Manager resource under which Termail entries are stored. */
export const SECRET_RESOURCE = 'Termail';

export interface SecretStore {
  /**
   * Return the stored secret, or `null` when absent. Throws
   * `SecretStoreError` when the store itself fails. Never returns an
   * empty or placeholder value.
   */
  getSecret(accountId: string, kind: SecretKind): string | null;
  /**
   * Insert or overwrite a secret. Refuses empty values. Throws
   * `SecretStoreError` on failure.
   */
  setSecret(accountId: string, kind: SecretKind, secret: string): void;
  /**
   * Remove a secret. Missing entries are a successful no-op. Throws
   * `SecretStoreError` on failure.
   */
  deleteSecret(accountId: string, kind: SecretKind): void;
}

/** The OS credential store failed (locked vault, missing shell, ...). */
export class SecretStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretStoreError';
  }
}

/**
 * In-memory `SecretStore` for tests. Never touches the OS store.
 * Rejects empty values like the real backends do.
 */
export class MemorySecretStore implements SecretStore {
  private readonly secrets = new Map<string, string>();

  private static key(accountId: string, kind: SecretKind): string {
    return `${SECRET_RESOURCE}\0${secretUsername(accountId, kind)}`;
  }

  getSecret(accountId: string, kind: SecretKind): string | null {
    return this.secrets.get(MemorySecretStore.key(accountId, kind)) ?? null;
  }

  setSecret(accountId: string, kind: SecretKind, secret: string): void {
    if (secret.length === 0) {
      throw new SecretStoreError('Refusing to store an empty secret.');
    }
    this.secrets.set(MemorySecretStore.key(accountId, kind), secret);
  }

  deleteSecret(accountId: string, kind: SecretKind): void {
    this.secrets.delete(MemorySecretStore.key(accountId, kind));
  }
}
