/**
 * One-time credential setup flow.
 *
 * Saves (or deletes) an account credential in the OS secret store so sync
 * and sending work across restarts without re-entering secrets. Never
 * prints, logs, or otherwise discloses a secret: prompts read with console
 * echo disabled, values travel in memory, and all user-facing text names
 * only the account and the storage location.
 *
 * Pure orchestration over injected dependencies (`CredentialSetupDeps`) so
 * the whole flow is unit-testable without a console or a vault.
 */

import { spawnSync } from 'node:child_process';
import { getConfigStore } from '../config/ConfigStore.js';
import type { AccountConfig } from '../types/config.js';
import { type SecretKind, type SecretStore, SecretStoreError } from './SecretStore.js';
import { getPlatformSecretStore } from './windowsVault.js';

export type CredentialSetupAction = 'set' | 'delete';
export type CredentialSetupKind = 'password' | 'oauth2';

export interface CredentialSetupRequest {
  action: CredentialSetupAction;
  accountId?: string;
  kind: CredentialSetupKind;
}

export interface CredentialSetupDeps {
  loadAccounts(): Promise<AccountConfig[]>;
  /**
   * Read one secret line with terminal echo disabled. Returns `null` when
   * the user aborts (Escape), enters nothing, or input is unavailable.
   * Throws `SecretStoreError` on infrastructure failure.
   */
  promptHidden(prompt: string): string | null;
  /** `null` where no OS store is implemented (non-Windows). */
  store: SecretStore | null;
  isInteractive: boolean;
  print(line: string): void;
}

function kindLabel(kind: CredentialSetupKind): string {
  return kind === 'oauth2' ? 'OAuth2 token' : 'App Password';
}

/** Pure script for the hidden single-line prompt (no secret involved). */
export function buildHiddenPromptScript(): string {
  return [
    '$buf = New-Object System.Text.StringBuilder;',
    'try {',
    '  while ($true) {',
    '    $k = [System.Console]::ReadKey($true);',
    '    if ($k.Key -eq [System.ConsoleKey]::Enter) { break; }',
    '    if ($k.Key -eq [System.ConsoleKey]::Escape) { exit 2; }',
    '    if ($k.Key -eq [System.ConsoleKey]::Backspace) { if ($buf.Length -gt 0) { $buf.Length = $buf.Length - 1 } }',
    '    elseif ($k.KeyChar -ne [char]0) { [void]$buf.Append($k.KeyChar) }',
    '  }',
    '} catch { exit 3; }',
    'if ($buf.Length -eq 0) { exit 4; }',
    'Write-Output $buf.ToString()',
  ].join('\n');
}

export interface PromptSpawnResult {
  status: number | null;
  stdout: unknown;
  stderr: unknown;
}

export interface PromptSpawnOptions {
  encoding: 'utf8';
  timeout: number;
  stdio: ['inherit', 'pipe', 'pipe'];
}

export type PromptSpawner = (
  command: string,
  args: string[],
  options: PromptSpawnOptions
) => PromptSpawnResult;

/** Map a finished prompt process to a value, abort, or infrastructure error. */
export function interpretPromptResult(status: number | null, stdout: unknown): string | null {
  if (status === 2 || status === 4) return null;
  if (status !== 0) {
    throw new SecretStoreError(
      'Secret prompt is unavailable (needs an interactive Windows console).'
    );
  }
  const out = typeof stdout === 'string' ? stdout.replace(/\r?\n$/, '') : '';
  return out.length > 0 ? out : null;
}

/** Real hidden prompt: PowerShell `ReadKey(intercept)` loop, no echo. */
export function promptHiddenPowerShell(
  prompt: string,
  spawnFn: PromptSpawner = (command, args, options) =>
    spawnSync(command, args, options) as unknown as PromptSpawnResult
): string | null {
  // Visible prompt from the parent (non-secret). The child inherits stdin
  // so `[Console]::ReadKey` reads the real keyboard; stdout stays piped so
  // the typed value is captured in memory and never displayed.
  process.stdout.write(`${prompt} (input hidden; Esc aborts)\n`);
  let result: PromptSpawnResult;
  try {
    result = spawnFn('powershell.exe', ['-NoProfile', '-Command', buildHiddenPromptScript()], {
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new SecretStoreError(
      `Secret prompt failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return interpretPromptResult(result.status, result.stdout);
}

export function defaultSetupDeps(
  print: (line: string) => void = (line) => console.log(line)
): CredentialSetupDeps {
  return {
    loadAccounts: async () => {
      const store = getConfigStore();
      const config = await store.initialize();
      return config.accounts ?? [];
    },
    promptHidden: promptHiddenPowerShell,
    store: getPlatformSecretStore(),
    isInteractive: !!process.stdin.isTTY,
    print,
  };
}

export async function runCredentialSetup(
  request: CredentialSetupRequest,
  deps: CredentialSetupDeps
): Promise<number> {
  const label = kindLabel(request.kind);

  if (!deps.store) {
    deps.print(
      'OS credential storage is implemented on Windows only. ' +
        'Set the account environment variable instead (see README).'
    );
    return 2;
  }

  const accounts = await deps.loadAccounts();
  const account =
    request.accountId !== undefined
      ? accounts.find((a) => a.id === request.accountId)
      : accounts.length === 1
        ? accounts[0]
        : undefined;
  if (!account) {
    if (accounts.length === 0) {
      deps.print('No accounts are configured. Add one to config.json first.');
    } else {
      const ids = accounts.map((a) => `"${a.id}"`).join(', ');
      deps.print(`Specify an account id. Configured accounts: ${ids}.`);
    }
    return 2;
  }

  const secretKind: SecretKind = request.kind;
  try {
    if (request.action === 'delete') {
      deps.store.deleteSecret(account.id, secretKind);
      deps.print(`Removed stored ${label} for account "${account.id}".`);
      return 0;
    }

    if (!deps.isInteractive) {
      deps.print(
        'Saving a credential needs an interactive terminal (input is hidden). ' +
          'Run this command in a console, or set the environment variable instead.'
      );
      return 2;
    }
    const first = deps.promptHidden(`Enter ${label} for account "${account.id}"`);
    if (!first) {
      deps.print('Aborted; nothing was saved.');
      return 1;
    }
    const second = deps.promptHidden('Confirm the value');
    if (second === null || second !== first) {
      deps.print('Entries did not match; nothing was saved.');
      return 1;
    }
    deps.store.setSecret(account.id, secretKind, first);
    // Read back and compare in memory only: proves the save worked
    // without ever displaying the value.
    if (deps.store.getSecret(account.id, secretKind) !== first) {
      deps.print('Verification read-back failed; nothing was saved.');
      return 1;
    }
    deps.print(`Saved ${label} for account "${account.id}" in the OS credential store.`);
    return 0;
  } catch (error) {
    deps.print(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
