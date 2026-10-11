/**
 * Windows Credential Manager backend via `PasswordVault`.
 *
 * Implemented without new dependencies by shelling out to the inbox
 * `powershell.exe` (Windows PowerShell 5.1+): `PasswordVault` Store,
 * Retrieve, and Remove. Secrets travel to PowerShell over stdin — never
 * inside the `-Command` text — so failing commands cannot echo them into
 * captured stderr. Retrieved secrets are returned in memory to the caller
 * and must never be logged there.
 *
 * The runner is injectable so unit tests can assert the exact scripts
 * (in particular: no secret in the command text) without touching the
 * real vault.
 */

import { spawnSync } from 'node:child_process';
import {
  SECRET_RESOURCE,
  type SecretKind,
  type SecretStore,
  SecretStoreError,
  secretUsername,
} from './SecretStore.js';

export interface VaultRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type VaultRunner = (script: string, stdin: string) => VaultRunResult;

/**
 * Quote an identifier for embedding in a single-quoted PowerShell string.
 * Account ids come from local config but are still treated as untrusted:
 * doubling the quote keeps any value inside its string context.
 */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function defaultRunner(script: string, stdin: string): VaultRunResult {
  try {
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        input: stdin,
        encoding: 'utf8',
        timeout: 30000,
      }
    );
    return {
      status: result.status,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
    };
  } catch (error) {
    throw new SecretStoreError(
      `Windows credential store is unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

const TYPE_PREAMBLE =
  '$null = [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime];';

/**
 * `$ErrorActionPreference = 'Stop'` makes every failure terminating so
 * the not-found discrimination below sees uniform catchable errors
 * instead of silent non-terminating ones.
 */
const STRICT_PREAMBLE = "$ErrorActionPreference = 'Stop'; ";

/**
 * PowerShell catch filter shared by every vault call (exported for tests).
 * Records a genuine vault miss in `$termailMiss` and rethrows anything
 * else. A miss is exactly Win32 `ERROR_NOT_FOUND` (`-2147023728`,
 * confirmed against the live vault) on the inner exception — message
 * substrings are never consulted, so an operational failure that merely
 * mentions a missing element still surfaces as `SecretStoreError`.
 * Callers only ever wrap the `Retrieve` lookup itself. Failing closed:
 * runtimes that do not propagate a usable code report store errors
 * rather than guessing absence.
 */
export function catchVaultMiss(): string {
  return 'catch { $inner = $_.Exception.InnerException; $code = if ($null -ne $inner) { $inner.HResult } else { 0 }; if ($code -eq -2147023728) { $termailMiss = $true } else { throw } }';
}

/** Strip PowerShell formatting noise; the payload is the last non-empty line. */
export function vaultOutputPayload(stdout: string): string {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines[lines.length - 1] ?? '';
}

export class WindowsVaultSecretStore implements SecretStore {
  private readonly runner: VaultRunner;

  constructor(runner: VaultRunner = defaultRunner) {
    this.runner = runner;
  }

  getSecret(accountId: string, kind: SecretKind): string | null {
    const resource = psQuote(SECRET_RESOURCE);
    const username = psQuote(secretUsername(accountId, kind));
    const script = `${TYPE_PREAMBLE} ${STRICT_PREAMBLE} $v = New-Object Windows.Security.Credentials.PasswordVault; $termailMiss = $false; $c = $null; try { $c = $v.Retrieve(${resource},${username}) } ${catchVaultMiss()}; if ($termailMiss -or $null -eq $c) { 'TERMAIL_NOT_FOUND' } else { $c.RetrievePassword(); $c.Password }`;
    const result = this.runChecked(script, '', 'retrieve', accountId);
    const payload = vaultOutputPayload(result.stdout);
    if (payload === '' || payload === 'TERMAIL_NOT_FOUND') return null;
    return payload;
  }

  setSecret(accountId: string, kind: SecretKind, secret: string): void {
    if (secret.length === 0) {
      throw new SecretStoreError('Refusing to store an empty secret.');
    }
    const resource = psQuote(SECRET_RESOURCE);
    const username = psQuote(secretUsername(accountId, kind));
    // Upsert: Retrieve+Remove first because Add throws on duplicates. An
    // absent entry simply skips the removal; any other lookup failure
    // aborts via `catchVaultMiss` instead of silently continuing.
    // The secret itself arrives over stdin, never in the command text.
    const script = `${TYPE_PREAMBLE} ${STRICT_PREAMBLE} $v = New-Object Windows.Security.Credentials.PasswordVault; $termailMiss = $false; try { $old = $v.Retrieve(${resource},${username}) } ${catchVaultMiss()}; if (-not $termailMiss) { $v.Remove($old) }; $s = $input | Out-String; $v.Add((New-Object Windows.Security.Credentials.PasswordCredential -ArgumentList ${resource},${username},(($s -replace '\\r?\\n$', '')))); 'TERMAIL_STORED'`;
    const result = this.runChecked(script, secret, 'save', accountId);
    if (vaultOutputPayload(result.stdout) !== 'TERMAIL_STORED') {
      throw new SecretStoreError(
        `Windows credential store did not confirm saving the secret for account "${accountId}".`
      );
    }
  }

  deleteSecret(accountId: string, kind: SecretKind): void {
    const resource = psQuote(SECRET_RESOURCE);
    const username = psQuote(secretUsername(accountId, kind));
    const script = `${TYPE_PREAMBLE} ${STRICT_PREAMBLE} $v = New-Object Windows.Security.Credentials.PasswordVault; $termailMiss = $false; $c = $null; try { $c = $v.Retrieve(${resource},${username}) } ${catchVaultMiss()}; if ($termailMiss -or $null -eq $c) { 'TERMAIL_ABSENT' } else { $v.Remove($c); 'TERMAIL_DELETED' }`;
    const result = this.runChecked(script, '', 'delete', accountId);
    const payload = vaultOutputPayload(result.stdout);
    if (payload !== 'TERMAIL_DELETED' && payload !== 'TERMAIL_ABSENT') {
      throw new SecretStoreError(
        `Windows credential store did not confirm deleting the secret for account "${accountId}".`
      );
    }
  }

  /**
   * Convert a finished PowerShell call into success or a safe,
   * operation-identifying `SecretStoreError`. Raw stderr/stdout are
   * never included: scripts never interpolate secrets, and failure
   * details could echo command fragments. The account id is
   * configuration, not a secret.
   */
  private runChecked(
    script: string,
    stdin: string,
    action: 'retrieve' | 'save' | 'delete',
    accountId: string
  ): VaultRunResult {
    const result = this.runner(script, stdin);
    if (result.status !== 0) {
      throw new SecretStoreError(
        `Windows credential store failed to ${action} the secret for account "${accountId}".`
      );
    }
    return result;
  }
}

/** The platform store, or `null` where persistence is not implemented. */
export function getPlatformSecretStore(): SecretStore | null {
  if (process.platform === 'win32') return new WindowsVaultSecretStore();
  return null;
}
