/**
 * Focused file-permission failure and directory-ownership tests.
 *
 * POSIX-only mode assertions are skipped on Windows (mode bits are ACLs
 * there); platform-independent ownership checks run everywhere.
 */

import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, getConfigPath, getDatabasePath } from '../../src/core/types/config.js';
import {
  ensureTermailDataDirSync,
  hardenDatabaseFiles,
  isTermailManagedDir,
  restrictFilePermissions,
} from '../../src/core/utils/filePermissions.js';

const isPosix = process.platform !== 'win32';
const itPosix = isPosix ? it : it.skip;
const modeOf = (p: string): number => statSync(p).mode & 0o777;

describe('filePermissions failure behavior', () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `termail-fileperm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itPosix('throws when the main file is missing instead of silently counting it as secured', () => {
    const missing = join(root, 'does-not-exist.sqlite');
    expect(() => restrictFilePermissions(missing)).toThrow();
    expect(() => hardenDatabaseFiles(missing)).toThrow();
  });

  itPosix('ignores missing -wal/-shm sidecars when the main file exists', () => {
    const main = join(root, 'exists.sqlite');
    writeFileSync(main, 'data');
    chmodSync(main, 0o644);
    expect(existsSync(`${main}-wal`)).toBe(false);
    expect(existsSync(`${main}-shm`)).toBe(false);
    expect(() => hardenDatabaseFiles(main)).not.toThrow();
    expect(modeOf(main)).toBe(0o600);
  });

  itPosix('missing-file errors include the path but never file contents', () => {
    const secret = `super-secret-${Date.now()}-${Math.random()}`;
    const missing = join(root, 'missing.sqlite');
    let message = '';
    try {
      restrictFilePermissions(missing);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(missing);
    expect(message).not.toContain(secret);
  });

  itPosix('throws on non-ENOENT filesystem errors instead of silently continuing', () => {
    // A regular file used as a parent yields ENOTDIR (not ENOENT) for children.
    const blocker = join(root, 'blocker');
    writeFileSync(blocker, 'x');
    const badPath = join(blocker, 'child.sqlite');
    expect(() => restrictFilePermissions(badPath)).toThrow();
  });

  itPosix('thrown permission errors include the path but never file contents', () => {
    const secret = `super-secret-${Date.now()}-${Math.random()}`;
    const secretFile = join(root, 'secret.txt');
    writeFileSync(secretFile, secret);
    // ENOTDIR via file-as-parent: deterministic non-ENOENT failure.
    const badPath = join(secretFile, 'child');
    let message = '';
    try {
      restrictFilePermissions(badPath);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).toContain(badPath);
    expect(message).not.toContain(secret);
  });

  itPosix('hardenDatabaseFiles surfaces non-ENOENT errors for the main file', () => {
    const blocker = join(root, 'blocker');
    writeFileSync(blocker, 'x');
    const badDb = join(blocker, 'db.sqlite');
    expect(() => hardenDatabaseFiles(badDb)).toThrow();
  });
});

describe('Termail-managed directories', () => {
  let root: string;
  let fakeHome: string;
  let savedHome: string | undefined;
  let savedProfile: string | undefined;

  beforeEach(() => {
    root = join(tmpdir(), `termail-dirs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
    fakeHome = join(root, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });
    savedHome = process.env.HOME;
    savedProfile = process.env.USERPROFILE;
  });

  afterEach(() => {
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    if (savedProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = savedProfile;
    }
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('classifies dedicated roots as managed and shared/custom parents as unmanaged', () => {
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    const configDir = dirname(getConfigPath());
    const dbDir = dirname(getDatabasePath(DEFAULT_CONFIG));
    expect(isTermailManagedDir(configDir)).toBe(true);
    expect(isTermailManagedDir(dbDir)).toBe(true);
    expect(isTermailManagedDir(join(configDir, 'subdir'))).toBe(true);
    // Shared parents and unrelated custom paths are never managed.
    expect(isTermailManagedDir(dirname(configDir))).toBe(false);
    expect(isTermailManagedDir(fakeHome)).toBe(false);
    expect(isTermailManagedDir(tmpdir())).toBe(false);
    expect(isTermailManagedDir(join(root, 'custom'))).toBe(false);
  });

  itPosix('hardens a pre-existing dedicated directory to 0700', () => {
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    const configDir = dirname(getConfigPath());
    const dbDir = dirname(getDatabasePath(DEFAULT_CONFIG));
    // Pre-create shared parents with loose perms to prove they are untouched.
    const sharedConfigParent = dirname(configDir);
    const sharedDbParent = dirname(dbDir);
    mkdirSync(sharedConfigParent, { recursive: true });
    mkdirSync(sharedDbParent, { recursive: true });
    chmodSync(sharedConfigParent, 0o755);
    chmodSync(sharedDbParent, 0o755);
    mkdirSync(configDir, { recursive: true });
    mkdirSync(dbDir, { recursive: true });
    chmodSync(configDir, 0o755);
    chmodSync(dbDir, 0o755);
    expect(modeOf(configDir)).toBe(0o755);
    expect(modeOf(dbDir)).toBe(0o755);

    ensureTermailDataDirSync(configDir);
    ensureTermailDataDirSync(dbDir);

    expect(modeOf(configDir)).toBe(0o700);
    expect(modeOf(dbDir)).toBe(0o700);
    // Shared parents (e.g. ~/.config, ~/.local/share) are never rechmodded.
    expect(modeOf(sharedConfigParent)).toBe(0o755);
    expect(modeOf(sharedDbParent)).toBe(0o755);
  });

  itPosix('leaves pre-existing custom directories untouched', () => {
    // Real HOME (restored): tmpdir custom paths are unmanaged.
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    if (savedProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = savedProfile;
    }
    const customDir = join(root, 'custom');
    mkdirSync(customDir, { recursive: true });
    chmodSync(customDir, 0o755);
    expect(isTermailManagedDir(customDir)).toBe(false);

    ensureTermailDataDirSync(customDir);

    expect(modeOf(customDir)).toBe(0o755);
  });

  itPosix('creates new directories with 0700 but never rechmods shared parents', () => {
    const sharedParent = join(root, 'shared');
    mkdirSync(sharedParent, { recursive: true });
    chmodSync(sharedParent, 0o755);
    const sharedBefore = modeOf(sharedParent);
    const leaf = join(sharedParent, 'leaf');
    // Leaf is custom (unmanaged) and does not exist yet: creation mode applies.
    ensureTermailDataDirSync(leaf);
    expect(modeOf(leaf)).toBe(0o700);
    expect(modeOf(sharedParent)).toBe(sharedBefore);
  });
});
