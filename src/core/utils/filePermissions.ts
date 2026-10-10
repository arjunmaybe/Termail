/**
 * Owner-only file permissions for Termail's local data.
 *
 * Termail keeps account metadata (hosts, usernames, addresses) in
 * `config.json` and full message bodies in SQLite. Passwords and API keys
 * live only in the environment, but these files still deserve owner-only
 * access on multi-user systems.
 *
 * Dedicated Termail data directories (established from
 * `src/core/config/defaults.ts` via `getConfigPath()` and the default
 * `database.path` expanded by `getDatabasePath()`):
 *   - `<home>/.config/termail` (config file)
 *   - `<home>/.local/share/termail` (default SQLite file)
 * plus any subdirectory inside those roots. Only these roots are
 * Termail-owned. Shared parents (`<home>`, `~/.config`, `~/.local/share`,
 * system temp dirs) and arbitrary parents of custom `database.path` /
 * custom config paths are never rechmodded.
 *
 * POSIX (`process.platform !== 'win32'`):
 *   - Newly created directories (including parents created by recursive
 *     `mkdir`) use mode `0700` via the creation mode. This applies to any
 *     path, including custom ones, and leaves pre-existing parents
 *     untouched.
 *   - Pre-existing dedicated Termail data directories are additionally
 *     chmodded to `0700` (leaf only, never parents) via
 *     `ensureTermailDataDirSync`. Pre-existing custom/shared directories
 *     are left untouched. Directory chmod failures on dedicated paths
 *     throw (fail closed) with the path and errno code only.
 *   - A `0700` directory is the primary control only when it is actually
 *     `0700`: sidecars SQLite creates later inside such a directory are
 *     unreachable by other users regardless of their own mode bits. No
 *     such claim is made for custom paths whose pre-existing directory
 *     was deliberately left untouched.
 *   - Config/database files are created with `0600`, and pre-existing
 *     files are chmodded to `0600` on every initialize/save, as are any
 *     SQLite `-wal`/`-shm` sidecars present at open. Only permission bits
 *     are changed; SQLite's lifecycle is never interfered with.
 *
 * Failure behavior (POSIX):
 *   - `restrictFilePermissions` fails on every filesystem error,
 *     including a missing file (`ENOENT`). A missing main database/config
 *     file during a required hardening operation must not silently count
 *     as secured.
 *   - `hardenDatabaseFiles` treats `ENOENT` as benign only for the
 *     `-wal`/`-shm` sidecars, which only exist in WAL mode / while the
 *     database is open. A missing main database file throws (fail
 *     closed).
 *   - Any other filesystem error while hardening an existing sensitive
 *     config/database file throws (fail closed). Callers abort
 *     initialization/save (surfaced as `ConfigError`/`DatabaseError`)
 *     rather than continuing with a world-readable file.
 *   - Thrown errors and log entries contain only the path and the errno
 *     code. File contents and secrets are never printed or logged.
 *
 * Windows:
 *   - Node's POSIX mode bits are accepted but ignored by the OS, which
 *     uses ACLs instead. These helpers therefore change nothing on
 *     Windows (apart from creating directories, as before) and must not
 *     be read as providing protection there. Users needing ACL hardening
 *     must configure it outside Termail.
 */

import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve, sep } from 'path';
import { DEFAULT_CONFIG, getConfigPath, getDatabasePath } from '../types/config.js';
import { logger } from './logger.js';

/** Owner-only directory mode (POSIX). */
export const PRIVATE_DIR_MODE = 0o700;

/** Owner-only file mode (POSIX). */
export const PRIVATE_FILE_MODE = 0o600;

/**
 * Whether the platform honors POSIX permission bits. Everything in this
 * module is a deliberate no-op for permissions on Windows.
 */
export function supportsPosixPermissions(): boolean {
  return process.platform !== 'win32';
}

function normalizeDir(dir: string): string {
  return resolve(dir);
}

/**
 * The Termail-owned directory roots. Computed on each call so tests can
 * redirect `HOME`/`USERPROFILE` to an isolated temp directory.
 */
function getDedicatedTermailRoots(): string[] {
  const roots = [dirname(getConfigPath()), dirname(getDatabasePath(DEFAULT_CONFIG))];
  return [...new Set(roots.map(normalizeDir))];
}

/**
 * Whether `dir` is Termail-owned: exactly a dedicated root or a
 * subdirectory inside one. Shared parents and arbitrary custom-path
 * parents return false and are never rechmodded.
 */
export function isTermailManagedDir(dir: string): boolean {
  const normalized = normalizeDir(dir);
  return getDedicatedTermailRoots().some((root) => {
    if (process.platform === 'win32') {
      const lower = normalized.toLowerCase();
      const lowerRoot = root.toLowerCase();
      return lower === lowerRoot || lower.startsWith(lowerRoot + sep);
    }
    return normalized === root || normalized.startsWith(root + sep);
  });
}

/**
 * Create a directory (and parents) with owner-only permissions. The mode
 * applies at creation time; pre-existing directories are left untouched.
 * Safe for arbitrary/custom paths because it never rechmods existing
 * directories. The mode option is ignored on Windows, preserving prior
 * behavior.
 */
export function ensurePrivateDirSync(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
}

/**
 * Create a Termail data directory with owner-only permissions, hardening
 * the leaf when it is Termail-owned. New directories get `0700` at
 * creation time (any path). A pre-existing leaf is chmodded to `0700`
 * only when `isTermailManagedDir(dir)` is true; shared parents and
 * arbitrary custom-path parents are never rechmodded. Failures hardening
 * a dedicated leaf throw (fail closed) with path and errno only.
 * No-op for permissions on Windows (directories are still created).
 */
export function ensureTermailDataDirSync(dir: string): void {
  ensurePrivateDirSync(dir);
  if (!supportsPosixPermissions()) return;
  if (!isTermailManagedDir(dir)) return;
  try {
    chmodSync(dir, PRIVATE_DIR_MODE);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code ?? 'unknown';
    logger.error('Failed to secure Termail data directory; refusing to continue', {
      path: dir,
      code,
    });
    throw new Error(`Failed to secure Termail data directory "${dir}" (${code})`);
  }
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/**
 * Harden a sensitive file to owner-only permissions. Every filesystem
 * error — including a missing file (`ENOENT`) — throws (fail closed)
 * with the path and errno code only; file contents are never included.
 * Callers abort rather than continuing with insecure permissions.
 * No-op on Windows.
 */
export function restrictFilePermissions(path: string, mode: number = PRIVATE_FILE_MODE): void {
  if (!supportsPosixPermissions()) return;
  try {
    chmodSync(path, mode);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code ?? 'unknown';
    logger.error('Failed to restrict file permissions; refusing to continue with insecure file', {
      path,
      code,
    });
    throw new Error(`Failed to secure sensitive file "${path}" (${code})`);
  }
}

/**
 * Write a text file with owner-only permissions, hardening pre-existing
 * files too (`writeFileSync` applies `mode` only to newly created files).
 * Chmod failures throw (see `restrictFilePermissions`) with path only.
 * Paths and no content are logged by callers; nothing is logged here.
 */
export function writePrivateFileSync(path: string, content: string): void {
  writeFileSync(path, content, { encoding: 'utf-8', mode: PRIVATE_FILE_MODE });
  restrictFilePermissions(path, PRIVATE_FILE_MODE);
}

/**
 * Harden a SQLite database file and any `-wal`/`-shm` sidecars present at
 * call time. A missing main file (`ENOENT`) throws (fail closed) via
 * `restrictFilePermissions`; absent sidecars (`ENOENT`) are skipped
 * silently without logging, and any other sidecar error throws with path
 * and errno only. Only permission bits are touched; files are never
 * created, deleted, or renamed, so SQLite's lifecycle is unaffected. Sidecars SQLite creates
 * later inherit the process umask: they are unreachable only when the
 * containing directory is actually `0700` (dedicated Termail directories
 * and newly created directories; pre-existing custom directories are
 * deliberately left untouched and carry no such guarantee). No-op on
 * Windows.
 */
export function hardenDatabaseFiles(dbPath: string): void {
  restrictFilePermissions(dbPath, PRIVATE_FILE_MODE);
  if (!supportsPosixPermissions()) return;
  for (const suffix of ['-wal', '-shm'] as const) {
    const sidecar = `${dbPath}${suffix}`;
    try {
      chmodSync(sidecar, PRIVATE_FILE_MODE);
    } catch (error) {
      if (isMissingFileError(error)) continue;
      const code = (error as NodeJS.ErrnoException)?.code ?? 'unknown';
      logger.error('Failed to restrict file permissions; refusing to continue with insecure file', {
        path: sidecar,
        code,
      });
      throw new Error(`Failed to secure sensitive file "${sidecar}" (${code})`);
    }
  }
}
