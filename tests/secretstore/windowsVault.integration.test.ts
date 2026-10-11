/**
 * Real Windows Credential Manager integration test (dummy entries only).
 *
 * Writes, reads back, and deletes uniquely-named DUMMY credentials through
 * the real `WindowsVaultSecretStore`, proving the PowerShell/PasswordVault
 * plumbing works on this machine. Skipped unless explicitly enabled with
 * `TERMAIL_TEST_WINDOWS_VAULT=1` so ordinary runs never touch the OS
 * vault. Values are random dummies; assertions compare in memory and the
 * file never prints a secret.
 */

import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  WindowsVaultSecretStore,
  catchVaultMiss,
} from '../../src/core/secretstore/windowsVault.js';

const enabled = process.env.TERMAIL_TEST_WINDOWS_VAULT === '1' && process.platform === 'win32';

const maybe = enabled ? describe : describe.skip;

const win32 = process.platform === 'win32' ? describe : describe.skip;

function runPowerShell(script: string): { status: number | null; stdout: string } {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      timeout: 30000,
    }
  );
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
  };
}

const TYPE_PREAMBLE =
  '$null = [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime];';

maybe('Windows vault integration (dummy entries)', () => {
  it('round-trips set/get/delete through Credential Manager', () => {
    const store = new WindowsVaultSecretStore();
    const accountId = `__termail_test_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
    const secret = `dummy-${Date.now()}-${Math.floor(Math.random() * 1e9)}-not-real`;
    try {
      store.setSecret(accountId, 'password', secret);
      expect(store.getSecret(accountId, 'password')).toBe(secret);
    } finally {
      store.deleteSecret(accountId, 'password');
    }
    expect(store.getSecret(accountId, 'password')).toBeNull();
  }, 30000);
});

win32('vault miss discrimination (no vault writes)', () => {
  it('maps a genuine vault miss to the absent marker with exit 0', () => {
    const script = `${TYPE_PREAMBLE} $v = New-Object Windows.Security.Credentials.PasswordVault; $termailMiss = $false; $c = $null; try { $c = $v.Retrieve('Termail', '__termail_test_absent_${Date.now()}') } ${catchVaultMiss()}; if ($termailMiss -or $null -eq $c) { 'TERMAIL_ABSENT' } else { 'FOUND-UNEXPECTED' }`;
    const result = runPowerShell(script);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('TERMAIL_ABSENT');
  });

  it('rethrows an operational failure instead of reporting absent', () => {
    const script = `$termailMiss = $false; try { throw 'operational boom' } ${catchVaultMiss()}; if ($termailMiss) { 'TERMAIL_ABSENT' } else { 'SURVIVED-THROW' }`;
    const result = runPowerShell(script);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('TERMAIL_ABSENT');
  });

  it('does not mistake a wrong-HRESULT Element-not-found for a miss', () => {
    // An operational failure whose message happens to contain the phrase
    // but whose HRESULT differs must rethrow, never resolve as absent.
    // `FileNotFoundException` carries 0x80070002, not 0x80070490.
    const script = `$termailMiss = $false; $inner = New-Object System.IO.FileNotFoundException('Element not found'); try { throw New-Object System.Exception('Retrieve failed', $inner) } ${catchVaultMiss()}; if ($termailMiss) { 'TERMAIL_ABSENT' } else { 'SURVIVED-THROW' }`;
    const result = runPowerShell(script);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('TERMAIL_ABSENT');
  });
});
