/**
 * Credential resolution and redaction.
 *
 * Credentials never live in `config.json`. They are pulled from environment
 * variables at connect time so the config file stays safe to share and
 * there's a single, obvious place to inject secrets (CI, systemd unit,
 * shell session).
 *
 * Naming convention:
 *   TERMAIL_<ACCOUNT_ID_UPPER>_PASSWORD     (authType === 'password')
 *   TERMAIL_<ACCOUNT_ID_UPPER>_OAUTH_TOKEN  (authType === 'oauth2')
 *
 * The account id is uppercased and any non-alphanumeric character is
 * replaced with `_`, so an id like "work-mail" maps to
 * `TERMAIL_WORK_MAIL_PASSWORD`.
 */

import { AuthenticationError } from '../utils/errors.js';
import type { AccountConfig } from '../types/config.js';

export interface ResolvedCredentials {
  /** Username passed to the IMAP server. Falls back to the account email. */
  user: string;
  /** Password for password auth, or OAuth2 access token for oauth2. */
  secret: string;
  /** Type of credential that was resolved. */
  kind: 'password' | 'oauth2';
}

/** Convert an account id into the suffix used in env var names. */
export function getEnvSecretSuffix(accountId: string): string {
  return accountId.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/** Get the env var name for a given account. Exposed for diagnostics. */
export function getEnvSecretName(account: AccountConfig): string {
  const suffix = getEnvSecretSuffix(account.id);
  return account.authType === 'oauth2'
    ? `TERMAIL_${suffix}_OAUTH_TOKEN`
    : `TERMAIL_${suffix}_PASSWORD`;
}

/**
 * Resolve credentials from the environment. Throws `AuthenticationError`
 * with a non-secret message if the variable is missing or empty.
 */
export function resolveCredentials(
  account: AccountConfig,
  env: NodeJS.ProcessEnv = process.env
): ResolvedCredentials {
  const envName = getEnvSecretName(account);
  const value = env[envName];

  if (typeof value !== 'string' || value.length === 0) {
    throw new AuthenticationError(
      `Missing ${account.authType === 'oauth2' ? 'OAuth2 token' : 'password'} for account "${account.id}". ` +
        `Set the ${envName} environment variable.`
    );
  }

  return {
    user: account.username ?? account.email,
    secret: value,
    kind: account.authType,
  };
}

/**
 * Recursively replace occurrences of any secret string with a fixed
 * redaction marker. Walks plain objects, arrays, and strings. Non-plain
 * values (Date, Map, etc.) are returned unchanged.
 *
 * This is intentionally conservative: if any of the secret strings is found
 * inside a longer string, the whole string is replaced. That makes the
 * helper safe to use on log payloads that may concatenate the secret with
 * other text (e.g. an error message containing the password).
 */
export function redactSecrets<T>(value: T, secrets: ReadonlyArray<string>): T {
  const trimmed = secrets.filter((s) => s.length > 0);
  if (trimmed.length === 0) return value;

  const mask = '***';
  const visit = (input: unknown): unknown => {
    if (typeof input === 'string') {
      let out = input;
      for (const s of trimmed) {
        if (out.includes(s)) out = out.split(s).join(mask);
      }
      return out;
    }
    if (input === null || input === undefined) return input;
    if (Array.isArray(input)) return input.map(visit);
    if (typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        out[k] = visit(v);
      }
      return out;
    }
    return input;
  };

  return visit(value) as T;
}
