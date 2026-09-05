/**
 * Root application component - OpenTUI 0.4.x class-based renderable
 */

import { BoxRenderable, type RenderContext, TextRenderable } from '@opentui/core';
import { getConfigStore } from '../core/config/ConfigStore.js';
import { getDatabase } from '../core/database/Database.js';
import { MessageRepository } from '../core/database/MessageRepository.js';
import type { PersistedEmail, PersistedFolder } from '../core/database/index.js';
import { actions, selectors, subscribe } from '../core/state/AppState.js';
import type { AccountConfig } from '../core/types/config.js';
import type { Account, Folder } from '../core/types/index.js';
import { logger } from '../core/utils/logger.js';
import { ContentPane } from './layout/ContentPane.js';
import { Sidebar } from './layout/Sidebar.js';
import { StatusBar } from './layout/StatusBar.js';
import { SyncService, type SyncOutcome } from './services/SyncService.js';
import { type Theme, getTheme } from './theme.js';

export interface AppOptions {
  /** Initial theme mode; defaults to dark. */
  initialTheme?: 'dark' | 'light';
  /** Optional injected `SyncService` (tests can supply a fake). */
  syncService?: SyncService;
}

export class App extends BoxRenderable {
  private theme: Theme;
  private themeMode: 'dark' | 'light';
  private sidebar: Sidebar;
  private content: ContentPane;
  private statusBar: StatusBar;
  private banner: TextRenderable;
  private errorBanner: TextRenderable;
  private initialized = false;
  private initError: string | null = null;
  private syncService: SyncService;
  private syncInFlight: Set<string> = new Set();
  private lastLoadedAccountId: string | null = null;
  private lastLoadedFolderId: string | null = null;

  constructor(ctx: RenderContext, options: AppOptions & { id?: string } = {}) {
    super(ctx, {
      id: 'app-root',
      flexDirection: 'column',
      width: '100%',
      height: '100%',
      backgroundColor: '#000000',
      ...options,
    });

    this.themeMode = options.initialTheme ?? 'dark';
    this.theme = getTheme(this.themeMode);

    // Banner shown during init or on error (replaced once initialized)
    this.banner = new TextRenderable(ctx, {
      id: 'init-banner',
      content: 'Initializing termail...',
      fg: this.theme.textPrimary,
      width: '100%',
      height: 1,
    });
    this.errorBanner = new TextRenderable(ctx, {
      id: 'error-banner',
      content: '',
      fg: this.theme.error,
      width: '100%',
      height: 1,
    });

    // Main three-pane layout: sidebar + content + status bar
    this.sidebar = new Sidebar(ctx, { id: 'sidebar', themeMode: this.themeMode });
    this.content = new ContentPane(ctx, { id: 'content-pane', themeMode: this.themeMode });
    this.statusBar = new StatusBar(ctx, { id: 'status-bar', themeMode: this.themeMode });

    this.sidebar.visible = false;
    this.content.visible = false;
    this.statusBar.visible = false;
    this.errorBanner.visible = false;

    this.add(this.banner);
    this.add(this.errorBanner);
    this.add(this.sidebar);
    this.add(this.content);
    this.add(this.statusBar);

    // The `SyncService` is constructed lazily inside `initialize()` once
    // the database is ready, unless the caller injected one (tests).
    this.syncService = options.syncService as SyncService | undefined as SyncService;

    this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      logger.info('Initializing application...');

      const configStore = getConfigStore();
      const config = await configStore.initialize();
      this.themeMode = config.ui.theme;
      this.theme = getTheme(this.themeMode);

      const database = getDatabase(config);
      await database.initialize();

      // Default to a fresh `SyncService` if no test fake was injected.
      if (!this.syncService) {
        this.syncService = new SyncService(database);
      }

      // Seed state from config + DB.
      const configAccounts = config.accounts ?? [];
      const accounts: Account[] = configAccounts.map(toAccountProjection);
      actions.setAccounts(accounts);
      actions.setSyncStatus('idle');

      if (accounts.length > 0) {
        const firstAccount = accounts[0];
        if (firstAccount) {
          // Pre-load folders and (if a folder is selected by default) emails.
          const repository = new MessageRepository(database);
          const persistedFolders = repository.listFoldersForAccount(firstAccount.id);
          const folders: Folder[] = persistedFolders.map(toFolderProjection);
          actions.setFolders(folders);
          if (folders.length > 0) {
            const currentFolderId = selectors.currentFolderId;
            if (currentFolderId) {
              this.loadEmailsForFolder(currentFolderId);
            }
          }
        }
      }

      this.initialized = true;
      this.banner.visible = false;
      this.sidebar.visible = true;
      this.content.visible = true;
      this.statusBar.visible = true;
      this.errorBanner.visible = false;
      this.applyTheme(this.theme);
      logger.info('Application initialized successfully');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Initialization failed', { error: message });
      this.initError = message;
      this.errorBanner.content = `Initialization Error: ${message}  (press q to quit)`;
      this.banner.visible = false;
      this.errorBanner.visible = true;
    }
  }

  /** Re-paint children with the current theme. */
  private applyTheme(theme: Theme): void {
    this.theme = theme;
    this.backgroundColor = theme.background;
    this.sidebar.setTheme(theme);
    this.content.setTheme(theme);
    this.statusBar.setTheme(theme);
  }

  /**
   * Public entry point so main.ts can wire up state subscriptions.
   * Subscribes to state changes; on `currentFolderId` changes it reloads
   * the email list for the newly selected folder.
   */
  attach(): () => void {
    return subscribe(() => {
      // Re-apply theme if it changed via actions
      const newTheme = getTheme(this.themeMode);
      this.applyTheme(newTheme);
      // React to folder selection changes by reloading emails.
      const folderId = selectors.currentFolderId;
      if (folderId && folderId !== this.lastLoadedFolderId) {
        this.loadEmailsForFolder(folderId);
      }
    });
  }

  /**
   * Trigger a sync of the current account/folder. No-op if either is
   * missing or if a sync for the same target is already in flight.
   * Maps the `SyncOutcome` to AppState actions.
   */
  async requestSync(): Promise<void> {
    if (!this.initialized || !this.syncService) {
      actions.setSyncError('Not ready');
      return;
    }
    const accountId = selectors.currentAccountId;
    const folderId = selectors.currentFolderId;
    if (!accountId) {
      actions.setSyncError('No account selected. Configure an account to sync.');
      return;
    }
    if (!folderId) {
      actions.setSyncError('No folder selected. Press r after folders load.');
      return;
    }
    const folder = selectors.folders.find((f) => f.id === folderId);
    if (!folder) {
      actions.setSyncError('Folder not found in current account');
      return;
    }
    const key = `${accountId}:${folderId}`;
    if (this.syncInFlight.has(key)) return;
    this.syncInFlight.add(key);

    const accounts = selectors.accounts;
    const account = accounts.find((a) => a.id === accountId);
    if (!account) {
      this.syncInFlight.delete(key);
      actions.setSyncError('Account not found in state');
      return;
    }
    const accountConfig = toAccountConfig(account);

    actions.setLoadingFolders(true);
    actions.setLoadingEmails(true);
    actions.setSyncStatus('syncing');

    let outcome: SyncOutcome;
    try {
      outcome = await this.syncService.syncAccountFolder(accountConfig, folder.fullName);
    } catch (error) {
      outcome = {
        kind: 'network',
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.syncInFlight.delete(key);
      actions.setLoadingFolders(false);
      actions.setLoadingEmails(false);
    }

    switch (outcome.kind) {
      case 'ok': {
        const folders: Folder[] = outcome.folders.map(toFolderProjection);
        const messages: PersistedEmail[] = outcome.messages;
        actions.setFolders(folders);
        actions.setEmails(messages);
        actions.setSyncStatus('success');
        break;
      }
      case 'auth':
        actions.setSyncError(outcome.message);
        break;
      case 'network':
        actions.setSyncError(outcome.message);
        break;
      case 'no-account':
        actions.setSyncError('No account configured');
        break;
      case 'no-folder':
        actions.setSyncError(outcome.message);
        break;
    }
  }

  /** Load the email list for a folder from the local DB. */
  private loadEmailsForFolder(folderId: string): void {
    const accountId = selectors.currentAccountId;
    if (!accountId) return;
    const configStore = getConfigStore();
    const config = configStore.getConfig();
    const database = getDatabase(config);
    const repository = new MessageRepository(database);
    const emails = repository.listByFolder(accountId, folderId, 500);
    this.lastLoadedFolderId = folderId;
    this.lastLoadedAccountId = accountId;
    actions.setEmails(emails);
  }

  isInitialized(): boolean {
    return this.initialized;
  }
  getInitError(): string | null {
    return this.initError;
  }
  getThemeMode(): 'dark' | 'light' {
    return this.themeMode;
  }
  getSidebar(): Sidebar {
    return this.sidebar;
  }
  getContent(): ContentPane {
    return this.content;
  }
  getStatusBar(): StatusBar {
    return this.statusBar;
  }
  getSyncService(): SyncService {
    return this.syncService;
  }
}

/** Project an `AccountConfig` to the UI-side `Account` shape. */
function toAccountProjection(config: AccountConfig): Account {
  return {
    id: config.id,
    name: config.name,
    type: 'imap',
    email: config.email,
    host: config.host,
    port: config.port,
    username: config.username,
    useTls: config.useTls,
    authType: config.authType,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** Reverse projection: UI-side `Account` back to the `AccountConfig` shape. */
function toAccountConfig(account: Account): AccountConfig {
  return {
    id: account.id,
    name: account.name,
    email: account.email,
    enabled: true,
    host: account.host,
    port: account.port ?? (account.useTls ? 993 : 143),
    username: account.username,
    useTls: account.useTls,
    authType: account.authType,
  };
}

/** Project a DB `PersistedFolder` to the UI-side `Folder` shape. */
function toFolderProjection(persisted: PersistedFolder): Folder {
  return {
    id: persisted.id,
    accountId: persisted.accountId,
    name: persisted.name,
    fullName: persisted.fullName,
    type: persisted.type as Folder['type'],
    parentId: persisted.parentId ?? undefined,
    delimiter: persisted.delimiter,
    attributes: persisted.attributes as Folder['attributes'],
    unreadCount: persisted.unreadCount,
    totalCount: persisted.totalCount,
    createdAt: new Date(persisted.createdAt * 1000),
    updatedAt: new Date(persisted.updatedAt * 1000),
  };
}
