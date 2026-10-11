/**
 * OS secret-store tests: key derivation, in-memory store, Windows vault
 * script contract (via injected runner — never the real vault here),
 * credential-resolution precedence, failure handling, and the one-time
 * setup flow. Fake secrets are distinctive dummy values; every assertion
 * that touches messages also asserts the secret never appears in them.
 */

import { describe, expect, it, vi } from 'vitest';
import { resolveCredentials } from '../../src/core/imap/credentials.js';
import {
  MemorySecretStore,
  SECRET_RESOURCE,
  type SecretStore,
  SecretStoreError,
  secretUsername,
} from '../../src/core/secretstore/SecretStore.js';
import {
  buildHiddenPromptScript,
  type CredentialSetupDeps,
  type CredentialSetupRequest,
  interpretPromptResult,
  type PromptSpawner,
  promptHiddenPowerShell,
  runCredentialSetup,
} from '../../src/core/secretstore/setupCredential.js';
import { psQuote, WindowsVaultSecretStore } from '../../src/core/secretstore/windowsVault.js';
import type { AccountConfig } from '../../src/core/types/config.js';
import { AuthenticationError } from '../../src/core/utils/errors.js';

const FAKE_SECRET = 's3cr3t-fake-zz9-not-real';

const baseAccount: AccountConfig = {
  id: 'work',
  name: 'Work',
  email: 'me@example.com',
  enabled: true,
  host: 'imap.example.com',
  port: 993,
  useTls: true,
  authType: 'password',
};

function setupDeps(over: Partial<CredentialSetupDeps> = {}): CredentialSetupDeps & {
  prints: string[];
  store: SecretStore | null;
} {
  const prints: string[] = [];
  const store = new MemorySecretStore();
  return {
    loadAccounts: async () => [baseAccount],
    promptHidden: () => FAKE_SECRET,
    store,
    isInteractive: true,
    print: (line: string) => {
      prints.push(line);
    },
    prints,
    ...over,
  };
}

function setupRequest(over: Partial<CredentialSetupRequest> = {}): CredentialSetupRequest {
  return { action: 'set', kind: 'password', ...over };
}

describe('secretUsername', () => {
  it('derives stable per-account, per-kind names', () => {
    expect(secretUsername('work', 'password')).toBe('work/password');
    expect(secretUsername('work', 'oauth2')).toBe('work/oauth-token');
    expect(secretUsername('personal', 'password')).toBe('personal/password');
  });

  it('uses a fixed resource name', () => {
    expect(SECRET_RESOURCE).toBe('Termail');
  });
});

describe('MemorySecretStore', () => {
  it('round-trips set/get and isolates accounts and kinds', () => {
    const store = new MemorySecretStore();
    store.setSecret('work', 'password', FAKE_SECRET);
    expect(store.getSecret('work', 'password')).toBe(FAKE_SECRET);
    expect(store.getSecret('work', 'oauth2')).toBeNull();
    expect(store.getSecret('personal', 'password')).toBeNull();
  });

  it('overwrites on re-set and deletes idempotently', () => {
    const store = new MemorySecretStore();
    store.setSecret('work', 'password', 'first');
    store.setSecret('work', 'password', 'second');
    expect(store.getSecret('work', 'password')).toBe('second');
    store.deleteSecret('work', 'password');
    expect(store.getSecret('work', 'password')).toBeNull();
    expect(() => store.deleteSecret('work', 'password')).not.toThrow();
  });

  it('refuses empty secrets', () => {
    const store = new MemorySecretStore();
    expect(() => store.setSecret('work', 'password', '')).toThrow(SecretStoreError);
    expect(store.getSecret('work', 'password')).toBeNull();
  });
});

describe('resolveCredentials precedence', () => {
  it('prefers the environment variable over the store', () => {
    const store = new MemorySecretStore();
    store.setSecret('work', 'password', 'stored-value');
    const result = resolveCredentials(baseAccount, { TERMAIL_WORK_PASSWORD: 'env-value' }, store);
    expect(result.secret).toBe('env-value');
    expect(result.user).toBe('me@example.com');
  });

  it('falls back to the store when the env var is absent', () => {
    const store = new MemorySecretStore();
    store.setSecret('work', 'password', FAKE_SECRET);
    const result = resolveCredentials(baseAccount, {}, store);
    expect(result.secret).toBe(FAKE_SECRET);
    expect(result.kind).toBe('password');
  });

  it('falls back to the store when the env var is empty', () => {
    const store = new MemorySecretStore();
    store.setSecret('work', 'password', FAKE_SECRET);
    const result = resolveCredentials(baseAccount, { TERMAIL_WORK_PASSWORD: '' }, store);
    expect(result.secret).toBe(FAKE_SECRET);
  });

  it('uses a null store as environment-only without touching the OS', () => {
    const result = resolveCredentials(baseAccount, { TERMAIL_WORK_PASSWORD: 'env-value' }, null);
    expect(result.secret).toBe('env-value');
    expect(() => resolveCredentials(baseAccount, {}, null)).toThrow(AuthenticationError);
  });

  it('missing everywhere throws an actionable AuthenticationError without secrets', () => {
    const store = new MemorySecretStore();
    try {
      resolveCredentials(baseAccount, {}, store);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthenticationError);
      const message = (error as Error).message;
      expect(message).toContain('work');
      expect(message).toContain('TERMAIL_WORK_PASSWORD');
      expect(message).not.toContain(FAKE_SECRET);
    }
  });

  it('propagates store failures instead of masking or substituting', () => {
    const failing: SecretStore = {
      getSecret: () => {
        throw new SecretStoreError('vault is locked');
      },
      setSecret: () => {},
      deleteSecret: () => {},
    };
    try {
      resolveCredentials(baseAccount, {}, failing);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SecretStoreError);
      expect((error as Error).message).toContain('vault is locked');
      expect((error as Error).message).not.toContain(FAKE_SECRET);
    }
  });
});

describe('WindowsVaultSecretStore script contract', () => {
  function fakeRunner(
    impl: (
      script: string,
      stdin: string
    ) => { status: number | null; stdout: string; stderr: string }
  ) {
    return vi.fn(impl);
  }

  it('reads by resource/username and returns null when absent', () => {
    const runner = fakeRunner(() => ({ status: 0, stdout: 'TERMAIL_NOT_FOUND', stderr: '' }));
    const store = new WindowsVaultSecretStore(runner);
    expect(store.getSecret('work', 'password')).toBeNull();
    const script = runner.mock.calls[0]![0] as string;
    expect(script).toContain('Termail');
    expect(script).toContain('work/password');
  });

  it('never places the secret in the command text when saving', () => {
    let seenScript = '';
    let seenStdin = '';
    const runner = fakeRunner((script: string, stdin: string) => {
      seenScript = script;
      seenStdin = stdin;
      return { status: 0, stdout: 'TERMAIL_STORED', stderr: '' };
    });
    const store = new WindowsVaultSecretStore(runner);
    store.setSecret('work', 'password', FAKE_SECRET);
    expect(seenStdin).toBe(FAKE_SECRET);
    expect(seenScript).not.toContain(FAKE_SECRET);
    expect(seenScript).toContain('Termail');
  });

  it('upsert lookup uses the narrow not-found filter, never a bare swallow', () => {
    const seen: string[] = [];
    const runner = fakeRunner((script: string) => {
      seen.push(script);
      return { status: 0, stdout: 'TERMAIL_STORED', stderr: '' };
    });
    const store = new WindowsVaultSecretStore(runner);
    store.setSecret('work', 'password', FAKE_SECRET);
    const script = seen.join('\n');
    expect(script).not.toContain('catch [System.Exception] {}');
    expect(script).toContain('else { throw }');
  });

  it('quotes absent markers so PowerShell parses them as strings', () => {
    const seen: string[] = [];
    const runner = fakeRunner((script: string) => {
      seen.push(script);
      return { status: 0, stdout: 'TERMAIL_NOT_FOUND', stderr: '' };
    });
    const store = new WindowsVaultSecretStore(runner);
    expect(store.getSecret('work', 'password')).toBeNull();
    expect(seen.join('\n')).toContain(`'TERMAIL_NOT_FOUND'`);
    const delSeen: string[] = [];
    const delRunner = fakeRunner((script: string) => {
      delSeen.push(script);
      return { status: 0, stdout: 'TERMAIL_ABSENT', stderr: '' };
    });
    new WindowsVaultSecretStore(delRunner).deleteSecret('work', 'password');
    expect(delSeen.join('\n')).toContain(`'TERMAIL_ABSENT'`);
  });

  it('treats delete of a missing entry as success', () => {
    const runner = fakeRunner(() => ({ status: 0, stdout: 'TERMAIL_ABSENT', stderr: '' }));
    const store = new WindowsVaultSecretStore(runner);
    expect(() => store.deleteSecret('work', 'password')).not.toThrow();
  });

  it('surfaces vault failures without secrets', () => {
    const runner = fakeRunner(() => ({ status: 1, stdout: '', stderr: 'Access is denied.' }));
    const store = new WindowsVaultSecretStore(runner);
    try {
      store.getSecret('work', 'password');
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SecretStoreError);
      expect((error as Error).message).not.toContain(FAKE_SECRET);
    }
  });

  it('failure messages name the operation, never raw output or secrets', () => {
    const hostileStderr = `boom ${FAKE_SECRET}\nAt line:1 char:5\n+ $v.BadCommand\n+ ~~~`;
    const runner = fakeRunner(() => ({
      status: 1,
      stdout: `prefix ${FAKE_SECRET} suffix`,
      stderr: hostileStderr,
    }));
    const store = new WindowsVaultSecretStore(runner);
    const failing = () => store.setSecret('work', 'password', FAKE_SECRET);
    expect(failing).toThrow(SecretStoreError);
    try {
      failing();
      throw new Error('expected throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('save');
      expect(message).toContain('work');
      expect(message).not.toContain(FAKE_SECRET);
      expect(message).not.toContain('boom');
      expect(message).not.toContain('BadCommand');
    }
  });

  it('refuses empty secrets without calling the shell', () => {
    const runner = fakeRunner(() => ({ status: 0, stdout: 'TERMAIL_STORED', stderr: '' }));
    const store = new WindowsVaultSecretStore(runner);
    expect(() => store.setSecret('work', 'password', '')).toThrow(SecretStoreError);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('runCredentialSetup', () => {
  it('saves the prompted value and verifies it', async () => {
    const deps = setupDeps({ promptHidden: () => FAKE_SECRET });
    const code = await runCredentialSetup(setupRequest(), deps);
    expect(code).toBe(0);
    expect(deps.store!.getSecret('work', 'password')).toBe(FAKE_SECRET);
    expect(deps.prints.join('\n')).toContain('work');
    expect(deps.prints.join('\n')).not.toContain(FAKE_SECRET);
  });

  it('aborts when confirmation does not match and saves nothing', async () => {
    let calls = 0;
    const deps = setupDeps({
      promptHidden: () => {
        calls += 1;
        return calls === 1 ? FAKE_SECRET : 'something-else';
      },
    });
    const code = await runCredentialSetup(setupRequest(), deps);
    expect(code).toBe(1);
    expect(deps.store!.getSecret('work', 'password')).toBeNull();
  });

  it('aborts on empty input without saving', async () => {
    const deps = setupDeps({ promptHidden: () => '' });
    const code = await runCredentialSetup(setupRequest(), deps);
    expect(code).toBe(1);
    expect(deps.store!.getSecret('work', 'password')).toBeNull();
  });

  it('requires an interactive terminal for saving', async () => {
    let prompted = false;
    const deps = setupDeps({
      isInteractive: false,
      promptHidden: () => {
        prompted = true;
        return FAKE_SECRET;
      },
    });
    const code = await runCredentialSetup(setupRequest(), deps);
    expect(code).toBe(2);
    expect(prompted).toBe(false);
    expect(deps.store!.getSecret('work', 'password')).toBeNull();
  });

  it('asks for an account id when several are configured', async () => {
    const deps = setupDeps({
      loadAccounts: async () => [
        { ...baseAccount, id: 'work' },
        { ...baseAccount, id: 'personal' },
      ],
    });
    const code = await runCredentialSetup({ action: 'set', kind: 'password' }, deps);
    expect(code).toBe(2);
    expect(deps.prints.join('\n')).toContain('personal');
    expect(deps.store!.getSecret('work', 'password')).toBeNull();
  });

  it('deletes an existing credential', async () => {
    const deps = setupDeps();
    deps.store!.setSecret('work', 'password', FAKE_SECRET);
    const code = await runCredentialSetup({ action: 'delete', kind: 'password' }, deps);
    expect(code).toBe(0);
    expect(deps.store!.getSecret('work', 'password')).toBeNull();
  });

  it('reports store failures without secrets', async () => {
    const failing: SecretStore = {
      getSecret: () => null,
      setSecret: () => {
        throw new SecretStoreError('vault write failed');
      },
      deleteSecret: () => {},
    };
    const deps = setupDeps({ store: failing, promptHidden: () => FAKE_SECRET });
    const code = await runCredentialSetup(setupRequest(), deps);
    expect(code).toBe(1);
    expect(deps.prints.join('\n')).not.toContain(FAKE_SECRET);
  });

  it('explains itself off Windows instead of failing obscurely', async () => {
    const deps = setupDeps({ store: null });
    const code = await runCredentialSetup(setupRequest(), deps);
    expect(code).toBe(2);
    expect(deps.prints.join('\n')).toMatch(/Windows/i);
  });
});

describe('psQuote', () => {
  it('wraps plain identifiers in single quotes', () => {
    expect(psQuote('Termail')).toBe("'Termail'");
    expect(psQuote('work/password')).toBe("'work/password'");
  });

  it('doubles embedded quotes so values cannot escape the string', () => {
    expect(psQuote("a'b")).toBe("'a''b'");
    expect(psQuote("x';bad")).toBe("'x'';bad'");
  });
});

describe('vault failure discrimination', () => {
  function fakeRunner(
    impl: (
      script: string,
      stdin: string
    ) => { status: number | null; stdout: string; stderr: string }
  ) {
    return vi.fn(impl);
  }

  it('scripts fail closed with strict errors and quoted identifiers', () => {
    const runner = fakeRunner(() => ({ status: 0, stdout: 'TERMAIL_NOT_FOUND', stderr: '' }));
    const store = new WindowsVaultSecretStore(runner);
    expect(store.getSecret("a'b", 'password')).toBeNull();
    const script = runner.mock.calls[0]![0] as string;
    // The quote is doubled inside its string context...
    expect(script).toContain("a''b");
    // ...and never closes the string early.
    expect(script).not.toContain("'a'b/");
    expect(script).toContain('$ErrorActionPreference');
    expect(script).toContain('-2147023728');
    // No message-substring fallback: only the confirmed HRESULT counts.
    expect(script).not.toContain('Element not found');
  });

  it('treats an unexpected vault failure as an error, not a miss', () => {
    // A nonzero exit (e.g. rethrown operational failure) must surface.
    const runner = fakeRunner(() => ({ status: 1, stdout: '', stderr: 'boom' }));
    const store = new WindowsVaultSecretStore(runner);
    expect(() => store.getSecret('work', 'password')).toThrow(SecretStoreError);
    expect(() => store.deleteSecret('work', 'password')).toThrow(SecretStoreError);
  });
});

describe('interpretPromptResult', () => {
  it('maps abort and empty outcomes to null', () => {
    expect(interpretPromptResult(2, '')).toBeNull();
    expect(interpretPromptResult(4, '')).toBeNull();
    expect(interpretPromptResult(0, '')).toBeNull();
  });

  it('returns captured values and fails closed on infrastructure errors', () => {
    expect(interpretPromptResult(0, 'typed-value\r\n')).toBe('typed-value');
    expect(() => interpretPromptResult(3, '')).toThrow(SecretStoreError);
    expect(() => interpretPromptResult(1, '')).toThrow(SecretStoreError);
  });
});

describe('promptHiddenPowerShell stdio contract', () => {
  it('inherits stdin for the real keyboard and captures piped stdout', () => {
    const seen: Array<{ args: string[]; options: unknown }> = [];
    const fakeSpawn: PromptSpawner = (command, args, options) => {
      seen.push({ args, options });
      expect(command).toBe('powershell.exe');
      return { status: 0, stdout: 'typed-value\r\n', stderr: '' };
    };
    const value = promptHiddenPowerShell('Enter secret', fakeSpawn);
    expect(value).toBe('typed-value');
    expect(seen).toHaveLength(1);
    const stdio = (seen[0]!.options as { stdio: unknown }).stdio;
    expect(stdio).toEqual(['inherit', 'pipe', 'pipe']);
  });

  it('surfaces spawn failures without secrets', () => {
    const fakeSpawn: PromptSpawner = () => {
      throw new Error('spawn ENOENT');
    };
    expect(() => promptHiddenPowerShell('Enter secret', fakeSpawn)).toThrow(/Secret prompt failed/);
  });
});

describe('buildHiddenPromptScript', () => {
  it('reads without echo and carries no secret', () => {
    const script = buildHiddenPromptScript();
    expect(script).toContain('[System.Console]::ReadKey($true)');
    expect(script).not.toContain(FAKE_SECRET);
  });
});
