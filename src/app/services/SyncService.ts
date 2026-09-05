/**
 * Phase 2.5 — `SyncService`.
 *
 * Pure data-layer orchestrator that drives a single IMAP account / folder
 * sync: open the IMAP connection, fetch folders, fetch messages, persist
 * results through `MessageRepository`, and return a typed `SyncOutcome`.
 *
 * Design notes:
 *   - This module is intentionally independent of `AppState` / the TUI.
 *     The orchestrator returns a `SyncOutcome` discriminated union; the
 *     TUI maps each variant to a set of `actions.*` calls. The split
 *     keeps `SyncService` unit-testable without a state container.
 *   - Credentials are read by `ImapService.connect()` from environment
 *     variables; `SyncService` never sees a password, OAuth token, or
 *     refresh token. The `AccountConfig` it accepts does not have those
 *     fields.
 *   - The `IMAP folder path` is the IMAP-side identifier, distinct from
 *     the database `folders.id`. The TUI passes the `PersistedFolder`
 *     selected by the user and we read `.fullName` here; the UI never
 *     needs to know about `SyncFolder`.
 */

import type { Database } from '../../core/database/Database.js';
import type {
  PersistedEmail,
  PersistedFolder,
} from '../../core/database/index.js';
import { MessageRepository } from '../../core/database/MessageRepository.js';
import type { ImapService } from '../../core/imap/ImapService.js';
import { getImapService, resetImapService } from '../../core/imap/ImapService.js';
import type { AccountConfig } from '../../core/types/config.js';
import {
  AuthenticationError,
  NetworkError,
  getErrorMessage,
} from '../../core/utils/errors.js';
import { logger } from '../../core/utils/logger.js';

/** Factory that produces an `ImapService` for a given account. */
export type ImapServiceFactory = (account: AccountConfig) => ImapService;

/** The default factory uses the Phase 2.1 `getImapService` singleton. */
const defaultFactory: ImapServiceFactory = (account) => getImapService(account);

/**
 * Result of a single sync attempt. `kind` discriminates; only the `ok`
 * variant carries data; the failure variants carry a redacted message
 * (the IMAP layer strips any resolved secret before throwing).
 */
export type SyncOutcome =
  | {
      kind: 'ok';
      folders: PersistedFolder[];
      messages: PersistedEmail[];
    }
  | {
      kind: 'auth';
      message: string;
    }
  | {
      kind: 'network';
      message: string;
    }
  | {
      kind: 'no-account';
      message: string;
    }
  | {
      kind: 'no-folder';
      message: string;
    };

/**
 * Thin coordinator between `ImapService` and `MessageRepository`. The
 * service is constructed with a `Database` (for the repository) and an
 * `ImapServiceFactory` (so tests can inject a fake). Each public method
 * opens, syncs, persists, and disconnects in a `try / finally` so the
 * IMAP socket never leaks.
 */
export class SyncService {
  private readonly database: Database;
  private readonly factory: ImapServiceFactory;
  private readonly repository: MessageRepository;

  constructor(database: Database, factory: ImapServiceFactory = defaultFactory) {
    this.database = database;
    this.factory = factory;
    this.repository = new MessageRepository(database);
  }

  /**
   * Sync a single folder of an account. The IMAP folder is identified
   * by its server path (`PersistedFolder.fullName`); the account is
   * identified by `AccountConfig`.
   *
   * On a successful sync the IMAP socket is closed before returning.
   * The returned `folders` array is the full set of folders for the
   * account (so the caller can refresh the sidebar), and the
   * `messages` array is the freshly persisted batch for the requested
   * folder. The caller is responsible for mapping these to
   * `AppState` actions.
   */
  async syncAccountFolder(
    account: AccountConfig,
    imapFolderPath: string
  ): Promise<SyncOutcome> {
    if (!account || !account.id) {
      return { kind: 'no-account', message: 'No account configured' };
    }
    if (!imapFolderPath) {
      return { kind: 'no-folder', message: 'No folder selected' };
    }

    // Per-account singleton, so a previous test or stale connection is
    // discarded before we open a fresh one.
    resetImapService();
    const imap = this.factory(account);

    try {
      try {
        await imap.connect();
      } catch (error) {
        return mapConnectError(error);
      }

      let folders;
      try {
        const folderResult = await imap.syncFolders();
        folders = folderResult.folders;
      } catch (error) {
        return mapConnectError(error);
      }

      // Locate the target folder in the IMAP-side list and persist every
      // folder we just learned about. We use the IMAP `SyncFolder` (not
      // the DB id) for persistence so future reads via the repository
      // produce the same rows.
      const target = folders.find((f) => f.path === imapFolderPath);
      if (!target) {
        return {
          kind: 'no-folder',
          message: `Folder "${imapFolderPath}" not found on server`,
        };
      }

      // Ensure the account row is present (idempotent) and persist
      // every folder we just learned about.
      this.repository.ensureAccountRow(toSafeAccountInput(account));
      const persistedFolderIds = new Set<string>();
      for (const f of folders) {
        const id = this.repository.ensureFolderRow(account.id, f);
        persistedFolderIds.add(id);
      }

      // Fetch and persist the messages for the target folder.
      const result = await imap.syncMessages(imapFolderPath, {});
      this.repository.upsertMessages(toSafeAccountInput(account), target, result.messages);

      // Build the post-sync folder list straight from the DB so the
      // caller sees exactly what `MessageRepository.listFoldersForAccount`
      // would return, including any folders the server didn't list this
      // time but were already persisted from prior runs.
      const persistedFolders = this.repository.listFoldersForAccount(account.id);
      const targetId =
        persistedFolders.find((f) => f.fullName === imapFolderPath)?.id ?? null;
      const messages = targetId
        ? this.repository.listByFolder(account.id, targetId, 500)
        : [];

      logger.info('Sync completed', {
        accountId: account.id,
        folder: imapFolderPath,
        folders: persistedFolders.length,
        messages: messages.length,
      });

      return { kind: 'ok', folders: persistedFolders, messages };
    } finally {
      try {
        await imap.disconnect();
      } catch (error) {
        logger.warn('IMAP disconnect failed; ignoring', {
          accountId: account.id,
          error: getErrorMessage(error),
        });
      }
      // Drop the singleton so the next call gets a clean instance.
      resetImapService();
    }
  }
}

/** Map a low-level connect/sync error to a typed `SyncOutcome`. */
function mapConnectError(error: unknown): SyncOutcome {
  if (error instanceof AuthenticationError) {
    return { kind: 'auth', message: error.message };
  }
  if (error instanceof NetworkError) {
    return { kind: 'network', message: error.message };
  }
  // Anything else (unmapped IMAP error, etc.) is a network-level failure.
  return { kind: 'network', message: getErrorMessage(error) };
}

/** Project the `AccountConfig` down to the safe subset the repository sees. */
function toSafeAccountInput(account: AccountConfig): {
  id: string;
  name: string;
  email: string;
  host?: string;
  port: number;
  username?: string;
  useTls: boolean;
  authType: 'password' | 'oauth2';
} {
  return {
    id: account.id,
    name: account.name,
    email: account.email,
    host: account.host,
    port: account.port,
    username: account.username,
    useTls: account.useTls,
    authType: account.authType,
  };
}
