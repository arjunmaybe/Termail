/**
 * Phase 4 — SMTP configuration resolution.
 *
 * Explicit `smtpMode` only. NEVER inferred from IMAP `useTls`.
 *
 * - no smtpPort + no smtpMode -> implicit-tls, port 465
 * - smtpPort only -> 465 means implicit-tls, any other port means starttls
 * - smtpMode only -> implicit-tls uses 465, starttls uses 587
 * - explicit smtpPort always wins
 *
 * Missing `smtpHost` fails safely with `NetworkError` before any socket is
 * opened. Port is validated as an integer in 1..65535.
 */

import { NetworkError } from '../utils/errors.js';
import type { AccountConfig, SmtpMode } from '../types/config.js';
import type { ResolvedSmtpConfig } from './types.js';

export function resolveSmtpMode(input: {
  smtpPort?: number;
  smtpMode?: SmtpMode;
}): SmtpMode {
  if (input.smtpMode !== undefined) return input.smtpMode;
  if (input.smtpPort !== undefined) return input.smtpPort === 465 ? 'implicit-tls' : 'starttls';
  return 'implicit-tls';
}

export function resolveSmtpPort(input: { smtpPort?: number; smtpMode?: SmtpMode }): number {
  if (input.smtpPort !== undefined) return input.smtpPort;
  const mode = resolveSmtpMode(input);
  return mode === 'implicit-tls' ? 465 : 587;
}

/**
 * Resolve an account's SMTP target. Throws `NetworkError` when `smtpHost`
 * is missing or when the port is out of range, before any connection.
 */
export function resolveSmtpConfig(account: AccountConfig): ResolvedSmtpConfig {
  const host = account.smtpHost?.trim();
  if (!host) {
    throw new NetworkError(
      `Account "${account.id}" is missing an SMTP host. Add a "smtpHost" field to the account config.`
    );
  }
  const port = resolveSmtpPort({ smtpPort: account.smtpPort, smtpMode: account.smtpMode });
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new NetworkError(`Account "${account.id}" has an invalid SMTP port "${port}".`);
  }
  return { host, port, mode: resolveSmtpMode({ smtpPort: account.smtpPort, smtpMode: account.smtpMode }) };
}
