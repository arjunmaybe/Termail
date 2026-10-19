/**
 * Root application component - OpenTUI 0.4.x class-based renderable
 */

import { BoxRenderable, type RenderContext, TextRenderable } from '@opentui/core';
import { AiService } from '../core/ai/AiService.js';
import { getConfigStore } from '../core/config/ConfigStore.js';
import { getDatabase } from '../core/database/Database.js';
import type { PersistedEmail, PersistedFolder } from '../core/database/index.js';
import { MessageRepository } from '../core/database/MessageRepository.js';
import { getImapService } from '../core/imap/ImapService.js';
import { getPlatformSecretStore } from '../core/secretstore/windowsVault.js';
import { parseRecipientList } from '../core/smtp/message.js';
import { SmtpService } from '../core/smtp/SmtpService.js';
import { actions, type ComposeField, selectors, subscribe } from '../core/state/AppState.js';
import type { AccountConfig } from '../core/types/config.js';
import type { Account, Folder } from '../core/types/index.js';
import { AuthenticationError } from '../core/utils/errors.js';
import { logger } from '../core/utils/logger.js';
import { sanitizeForTerminal } from '../core/utils/terminal.js';
import {
  COMPOSE_FIELD_ORDER,
  type ComposeEditableField,
  ComposeView,
} from './components/ComposeView.js';
import { SearchInputBar } from './components/SearchInputBar.js';
import { ContentPane } from './layout/ContentPane.js';
import { Header } from './layout/Header.js';
import { Sidebar } from './layout/Sidebar.js';
import { StatusBar } from './layout/StatusBar.js';
import { AiController } from './services/AiController.js';
import { ComposeController } from './services/ComposeController.js';
import { SearchController } from './services/SearchController.js';
import { type SyncOutcome, SyncService } from './services/SyncService.js';
import { getTheme, type Theme } from './theme.js';

export interface AppOptions {
  /** Initial theme mode; defaults to dark. */
  initialTheme?: 'dark' | 'light';
  /** Optional injected `SyncService` (tests can supply a fake). */
  syncService?: SyncService;
  /** Optional injected `SmtpService` (tests can supply a fake). */
  smtpService?: SmtpService;
  /** Optional injected `AiService` (tests can supply a fake). */
  aiService?: AiService;
}

export class App extends BoxRenderable {
  private theme: Theme;
  private themeMode: 'dark' | 'light';
  private header: Header;
  private mainRow: BoxRenderable;
  private sidebar: Sidebar;
  private content: ContentPane;
  private statusBar: StatusBar;
  private searchInputBar: SearchInputBar;
  private composeView: ComposeView;
  private banner: TextRenderable;
  private errorBanner: TextRenderable;
  private initialized = false;
  private initError: string | null = null;
  private syncService: SyncService;
  private searchController: SearchController | null = null;
  private smtpService: SmtpService | null = null;
  private composeController: ComposeController | null = null;
  private aiService: AiService | null = null;
  private aiController: AiController | null = null;
  /**
   * Reacts to `composeActive` to swap the whole shell for the full-screen
   * composer. Owned for the App's lifetime (not `attach()`), so the swap
   * is consistent in tests that build an `App` without the state wiring.
   */
  private shellUnsubscribe: (() => void) | null = null;
  /**
   * The `attach()` state subscription. Owned (not just returned) so a
   * destroyed App stops reacting to state changes — otherwise a stale
   * subscription would keep calling `applyTheme` on torn-down renderables.
   */
  private attachUnsubscribe: (() => void) | null = null;
  /**
   * Global single-flight guard. Only one manual synchronization
   * may be active at a time because the IMAP service is account-scoped
   * and reset between operations. Per-folder keys would allow
   * conflicting concurrent syncs.
   */
  private syncInFlight = false;
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

    // Main layout: a header strip on top, then a horizontal row with the
    // folder sidebar on the left and the content region filling the rest,
    // then the search bar and status bar at the bottom. Sidebar and content
    // share the same vertical region side by side (the sidebar used to be
    // stacked above the content, pushing the email list down).
    this.header = new Header(ctx, { id: 'app-header', themeMode: this.themeMode });
    this.mainRow = new BoxRenderable(ctx, {
      id: 'main-row',
      flexDirection: 'row',
      width: '100%',
      flexGrow: 1,
      backgroundColor: this.theme.background,
    });
    this.sidebar = new Sidebar(ctx, { id: 'sidebar', themeMode: this.themeMode });
    this.content = new ContentPane(ctx, { id: 'content-pane', themeMode: this.themeMode });
    this.statusBar = new StatusBar(ctx, { id: 'status-bar', themeMode: this.themeMode });
    this.searchInputBar = new SearchInputBar(ctx, {
      id: 'search-input-bar',
      themeMode: this.themeMode,
    });
    this.composeView = new ComposeView(ctx, {
      id: 'compose-view',
      themeMode: this.themeMode,
      onFieldInput: (field, text) => this.handleComposeFieldInput(field, text),
    });

    this.sidebar.visible = false;
    this.content.visible = false;
    this.header.visible = false;
    this.mainRow.visible = false;
    this.statusBar.visible = false;
    this.searchInputBar.visible = false;
    this.composeView.visible = false;
    this.errorBanner.visible = false;

    this.add(this.banner);
    this.add(this.errorBanner);
    this.add(this.header);
    this.mainRow.add(this.sidebar);
    this.mainRow.add(this.content);
    this.add(this.mainRow);
    this.add(this.searchInputBar);
    this.add(this.statusBar);
    this.add(this.composeView);

    // The `SyncService` is constructed lazily inside `initialize()` once
    // the database is ready, unless the caller injected one (tests).
    this.syncService = options.syncService as SyncService | undefined as SyncService;
    // Phase 4 — optional injected `SmtpService` (tests). Built lazily below.
    this.smtpService = options.smtpService ?? null;
    // Phase 5 — optional injected `AiService` (tests). Built lazily below.
    this.aiService = options.aiService ?? null;

    // Keep the shell/composer swap in sync with `composeActive`.
    this.shellUnsubscribe = subscribe(() => this.applyShellVisibility());

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
      // The factory attaches the platform secret store so a configured
      // OS-stored credential is used when the env var is absent.
      if (!this.syncService) {
        const secretStore = getPlatformSecretStore();
        this.syncService = new SyncService(database, (account) =>
          getImapService(account, { secretStore })
        );
      }

      // Phase 3.3 — the `SearchController` is built here, after the
      // database is ready, so it can hand the connection to the
      // `SearchService`. There is no test fake; the controller is a
      // pure dispatcher on top of the real service.
      this.searchController = new SearchController(database);

      // Phase 4 — compose stack (no DB, no background work). The service
      // is stateless; the controller reads the current account from state.
      if (!this.smtpService) {
        this.smtpService = new SmtpService({ secretStore: getPlatformSecretStore() });
      }
      this.composeController = new ComposeController(this.smtpService, () => {
        const accountId = selectors.currentAccountId;
        if (!accountId) return null;
        const account = selectors.accounts.find((a) => a.id === accountId);
        return account ? toAccountConfig(account) : null;
      });

      // Phase 5 — AI stack (no DB, no background work). Reads the AI
      // section of the already-loaded config; the controller reads the
      // selected email from state, mirroring the detail pane lookup.
      if (!this.aiService) {
        this.aiService = new AiService({ config: config.ai });
      }
      this.aiController = new AiController(this.aiService, () => getSelectedEmail());

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
      this.header.visible = true;
      this.mainRow.visible = true;
      this.sidebar.visible = true;
      this.content.visible = true;
      this.statusBar.visible = true;
      this.errorBanner.visible = false;
      this.applyTheme(this.theme);
      this.applyShellVisibility();
      logger.info('Application initialized successfully');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Initialization failed', { error: message });
      this.initError = message;
      // Init failures can surface server/library error text: sanitize
      // the display string (the stored/logged message is untouched).
      this.errorBanner.content = sanitizeForTerminal(
        `Initialization Error: ${message}  (press q to quit)`
      );
      this.banner.visible = false;
      this.errorBanner.visible = true;
    }
  }

  /** Re-paint children with the current theme. */
  private applyTheme(theme: Theme): void {
    this.theme = theme;
    this.backgroundColor = theme.background;
    this.mainRow.backgroundColor = theme.background;
    this.header.setTheme(theme);
    this.sidebar.setTheme(theme);
    this.content.setTheme(theme);
    this.statusBar.setTheme(theme);
    this.searchInputBar.setTheme(theme);
    this.composeView.setTheme(theme);
  }

  /**
   * Swap between the normal shell and the full-screen composer. While
   * composing, the header, sidebar/content row, search bar and status bar
   * are all hidden and the composer occupies the whole root area; closing
   * restores them. Only touches the shell once initialization has
   * completed, so the init banner is never clobbered.
   */
  private applyShellVisibility(): void {
    const composing = selectors.composeActive;
    this.composeView.visible = composing;
    if (composing) {
      this.header.visible = false;
      this.mainRow.visible = false;
      this.searchInputBar.visible = false;
      this.statusBar.visible = false;
      this.errorBanner.visible = false;
      return;
    }
    if (this.initialized) {
      this.header.visible = true;
      this.mainRow.visible = true;
      this.sidebar.visible = true;
      this.content.visible = true;
      this.statusBar.visible = true;
    }
  }

  /**
   * Map raw composer field text to state. Recipient fields are parsed
   * with the shared `parseRecipientList` so the field text and the
   * structured arrays always agree.
   */
  private handleComposeFieldInput(field: ComposeEditableField, text: string): void {
    switch (field) {
      case 'to':
        this.composeController?.setTo(parseRecipientList(text));
        break;
      case 'cc':
        this.composeController?.setCc(parseRecipientList(text));
        break;
      case 'bcc':
        this.composeController?.setBcc(parseRecipientList(text));
        break;
      case 'subject':
        this.composeController?.setSubject(text);
        break;
      case 'body':
        this.composeController?.setBody(text);
        break;
    }
  }

  /**
   * Public entry point so main.ts can wire up state subscriptions.
   * Subscribes to state changes; on `currentFolderId` changes it reloads
   * the email list for the newly selected folder.
   */
  attach(): () => void {
    // Re-attaching replaces any previous subscription so only one is live.
    if (this.attachUnsubscribe) this.attachUnsubscribe();
    const unsubscribe = subscribe(() => {
      // Re-apply theme if it changed via actions
      const newTheme = getTheme(this.themeMode);
      this.applyTheme(newTheme);
      // React to folder selection changes by reloading emails.
      const folderId = selectors.currentFolderId;
      if (folderId && folderId !== this.lastLoadedFolderId) {
        this.loadEmailsForFolder(folderId);
      }
    });
    this.attachUnsubscribe = unsubscribe;
    return unsubscribe;
  }

  /**
   * Trigger a sync of the current account/folder. No-op if either is
   * missing or if any sync is already in flight (global single-flight).
   * Maps the `SyncOutcome` to AppState actions.
   *
   * Captures account/folder before awaiting and only applies
   * folder-specific UI data when still relevant, so a stale completion
   * after a folder switch never overwrites the newly selected folder.
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
      await this.requestBootstrapSync(accountId);
      return;
    }
    const folder = selectors.folders.find((f) => f.id === folderId);
    if (!folder) {
      actions.setSyncError('Folder not found in current account');
      return;
    }
    // Global single-flight: only one manual sync at a time.
    if (this.syncInFlight) return;
    this.syncInFlight = true;

    const accounts = selectors.accounts;
    const account = accounts.find((a) => a.id === accountId);
    if (!account) {
      this.syncInFlight = false;
      actions.setSyncError('Account not found in state');
      return;
    }
    const accountConfig = toAccountConfig(account);

    // Capture the request target before awaiting for stale-result checks.
    const requestAccountId = accountId;
    const requestFolderId = folderId;

    actions.setLoadingFolders(true);
    actions.setLoadingEmails(true);
    actions.setSyncStatus('syncing');

    let outcome: SyncOutcome;
    try {
      outcome = await this.syncService.syncAccountFolder(accountConfig, folder.fullName);
    } catch (error) {
      // Preserve auth vs network: a mid-sync AuthenticationError (e.g. token
      // expiry during fetch, or a DB-wrapped auth failure) must surface as
      // `auth`, not as a generic network error. Anything else stays `network`.
      const message = error instanceof Error ? error.message : String(error);
      outcome =
        error instanceof AuthenticationError
          ? { kind: 'auth', message }
          : { kind: 'network', message };
    }

    const accountStillRelevant = selectors.currentAccountId === requestAccountId;
    const stillRelevant = accountStillRelevant && selectors.currentFolderId === requestFolderId;

    switch (outcome.kind) {
      case 'ok': {
        // Folders are account-scoped: apply when the account is still
        // selected. Messages are folder-specific: apply only when the
        // originally requested folder is still selected. Success status
        // is global (sync did succeed), so always report it to avoid a
        // stuck "syncing" indicator after a folder/account switch.
        if (accountStillRelevant) {
          const folders: Folder[] = outcome.folders.map(toFolderProjection);
          actions.setFolders(folders);
        }
        if (stillRelevant) {
          const messages: PersistedEmail[] = outcome.messages;
          actions.setEmails(messages);
        }
        if (outcome.replacedFolderIds.length > 0) {
          // The previous UID generation's rows were deleted from the DB;
          // in-memory search hits may still reference them.
          actions.clearSearch();
        }
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

    this.syncInFlight = false;
    actions.setLoadingFolders(false);
    actions.setLoadingEmails(false);
  }

  /**
   * Bootstrap a fresh account with no persisted folders. Discovers folders
   * over IMAP via `SyncService.syncAccount`, persists them, selects the
   * default (INBOX preferred), and syncs its messages.
   *
   * Folder discovery is persisted before message fetch, so when message
   * sync fails the discovered folders are reloaded from the DB into the
   * sidebar while the outcome stays an explicit failure (never a
   * misleading success, never an advanced checkpoint).
   */
  private async requestBootstrapSync(accountId: string): Promise<void> {
    const accounts = selectors.accounts;
    const account = accounts.find((a) => a.id === accountId);
    if (!account) {
      actions.setSyncError('Account not found in state');
      return;
    }
    if (this.syncInFlight) return;
    this.syncInFlight = true;

    const accountConfig = toAccountConfig(account);
    const requestAccountId = accountId;

    actions.setLoadingFolders(true);
    actions.setLoadingEmails(true);
    actions.setSyncStatus('syncing');

    let outcome: SyncOutcome;
    try {
      const svc = this.syncService as SyncService & {
        syncAccount?: (a: AccountConfig) => Promise<SyncOutcome>;
      };
      if (typeof svc.syncAccount !== 'function') {
        outcome = { kind: 'no-folder', message: 'No folder selected' };
      } else {
        outcome = await svc.syncAccount(accountConfig);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome =
        error instanceof AuthenticationError
          ? { kind: 'auth', message }
          : { kind: 'network', message };
    }

    const accountStillRelevant = selectors.currentAccountId === requestAccountId;

    switch (outcome.kind) {
      case 'ok': {
        if (accountStillRelevant) {
          const folders: Folder[] = outcome.folders.map(toFolderProjection);
          actions.setFolders(folders);
          actions.setEmails(outcome.messages);
        }
        if (outcome.replacedFolderIds.length > 0) {
          // The previous UID generation's rows were deleted from the DB;
          // in-memory search hits may still reference them.
          actions.clearSearch();
        }
        actions.setSyncStatus('success');
        break;
      }
      case 'auth':
      case 'network':
      case 'no-folder':
      case 'no-account': {
        // Preserve discovered folders: folder discovery is persisted before
        // message fetch, so reload from the DB even on failure. Best-effort;
        // a reload failure must not mask the original sync error.
        if (accountStillRelevant) {
          this.reloadFoldersForAccount(accountId);
        }
        actions.setSyncError(
          outcome.kind === 'no-account' ? 'No account configured' : outcome.message
        );
        break;
      }
    }

    this.syncInFlight = false;
    actions.setLoadingFolders(false);
    actions.setLoadingEmails(false);
  }

  /** Reload persisted folders into state. Best-effort; never throws. */
  private reloadFoldersForAccount(accountId: string): void {
    try {
      const config = getConfigStore().getConfig();
      const database = getDatabase(config);
      const repository = new MessageRepository(database);
      const persisted = repository.listFoldersForAccount(accountId);
      if (persisted.length > 0) {
        actions.setFolders(persisted.map(toFolderProjection));
      }
    } catch (error) {
      logger.warn('Failed to reload folders after sync; ignoring', {
        accountId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // -----------------------------------------------------------------
  // Keyboard-first navigation. Pure state transitions over the current
  // visible list (search hits when a search is active, else folder emails).
  // No I/O, no IMAP, no DB writes. Folder moves go through
  // `actions.setCurrentFolder`, so the existing `attach()` subscription
  // reloads emails for the newly selected folder.
  // -----------------------------------------------------------------

  /**
   * Move the email selection by `delta` (+1 next, -1 previous).
   * Clamped: staying at the ends is a no-op, never wraps. When nothing
   * is selected, +1 selects the first row and -1 selects the last row.
   * No-op when the visible list is empty.
   */
  moveEmailSelection(delta: 1 | -1): void {
    const visible = selectors.searchActive ? (selectors.searchHits ?? []) : selectors.emails;
    if (visible.length === 0) return;
    const currentId = selectors.selectedEmailId;
    if (!currentId) {
      const target = delta > 0 ? visible[0] : visible[visible.length - 1];
      if (target) actions.setSelectedEmail(target.id);
      return;
    }
    const idx = visible.findIndex((e) => e.id === currentId);
    if (idx === -1) {
      const target = delta > 0 ? visible[0] : visible[visible.length - 1];
      if (target) actions.setSelectedEmail(target.id);
      return;
    }
    const next = idx + delta;
    if (next < 0 || next >= visible.length) return;
    const target = visible[next];
    if (target) actions.setSelectedEmail(target.id);
  }

  /**
   * Move the folder selection by `delta` (+1 next, -1 previous).
   * Clamped, never wraps. Clears the email selection via
   * `actions.setCurrentFolder` so the detail view never shows a stale
   * message from the previous folder.
   */
  moveFolderSelection(delta: 1 | -1): void {
    const folders = selectors.folders;
    if (folders.length === 0) return;
    const currentId = selectors.currentFolderId;
    if (!currentId) {
      const first = folders[0];
      if (first) actions.setCurrentFolder(first.id);
      return;
    }
    const idx = folders.findIndex((f) => f.id === currentId);
    if (idx === -1) {
      const first = folders[0];
      if (first) actions.setCurrentFolder(first.id);
      return;
    }
    const next = idx + delta;
    if (next < 0 || next >= folders.length) return;
    const target = folders[next];
    if (target) actions.setCurrentFolder(target.id);
  }

  /**
   * Open the highlighted email in the reading/detail view. Never advances
   * to a different email: when a visible email is already highlighted it
   * opens exactly that one. When nothing is highlighted, the first visible
   * email is highlighted and opened. No-op on an empty visible list.
   */
  openSelectedEmail(): void {
    const visible = selectors.searchActive ? (selectors.searchHits ?? []) : selectors.emails;
    if (visible.length === 0) return;
    const currentId = selectors.selectedEmailId;
    if (currentId && visible.some((e) => e.id === currentId)) {
      actions.setOpenedEmail(currentId);
      return;
    }
    const first = visible[0];
    if (first) {
      actions.setSelectedEmail(first.id);
      actions.setOpenedEmail(first.id);
    }
  }

  /**
   * Close the reading/detail view and return to the email list. The
   * highlight is preserved so the user lands back on the same email.
   */
  closeOpenedEmail(): void {
    if (selectors.openedEmailId !== null) {
      actions.setOpenedEmail(null);
    }
  }

  /** True while the reading/detail view is actually shown. */
  isReadingViewOpen(): boolean {
    return selectors.openedEmailId !== null && this.content.isShowingDetail();
  }

  /**
   * Scroll the open message by rows. List selection and the open email
   * are untouched.
   */
  scrollReadingView(delta: 1 | -1): void {
    this.content.scrollDetailByRows(delta);
  }

  /**
   * Scroll the open message by viewports. List selection and the open
   * email are untouched.
   */
  scrollReadingViewPage(delta: 1 | -1): void {
    this.content.scrollDetailByViewport(delta);
  }

  /**
   * Clear both the highlight and any open-email state (e.g. the list was
   * invalidated). Prefer `closeOpenedEmail` for Escape, which preserves
   * the highlight.
   */
  clearEmailSelection(): void {
    if (selectors.selectedEmailId !== null) {
      actions.setSelectedEmail(null);
    }
    if (selectors.openedEmailId !== null) {
      actions.setOpenedEmail(null);
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
  getHeader(): Header {
    return this.header;
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

  // -----------------------------------------------------------------
  // Phase 3.3 — Search (TUI-facing API; keypress dispatcher lives
  // in `main.ts` and calls these methods).
  // -----------------------------------------------------------------

  /**
   * Snapshot of "is the search input bar open right now". The
   * `main.ts` keypress dispatcher calls this to decide between
   * the search-active branch and the regular branch.
   */
  isSearchActive(): boolean {
    return this.searchController?.isActive() ?? false;
  }

  /** Open the search input bar and clear any prior search state. */
  openSearch(): void {
    this.searchController?.openSearch();
  }

  /**
   * Append a single printable character to the input buffer. The
   * `main.ts` dispatcher filters out non-printable / modifier
   * keys before calling this.
   */
  pushChar(ch: string): void {
    this.searchController?.pushChar(ch);
  }

  /** Remove the last character from the input buffer. */
  popChar(): void {
    this.searchController?.popChar();
  }

  /** Run the current search query. No-op on an empty buffer. */
  async submitSearch(): Promise<void> {
    await this.searchController?.submitSearch();
  }

  /** Cancel and close the search input bar. */
  cancelSearch(): void {
    this.searchController?.cancelSearch();
  }

  // -----------------------------------------------------------------
  // Phase 4 — Compose (TUI-facing API; no background sending).
  // -----------------------------------------------------------------

  isComposeActive(): boolean {
    return this.composeController?.isActive() ?? false;
  }

  isComposeSending(): boolean {
    return this.composeController?.isSending() ?? false;
  }

  /** True while the composer's discard-confirmation prompt is showing. */
  isComposeConfirmingDiscard(): boolean {
    return selectors.composeConfirmDiscard;
  }

  /** Which composer field currently owns focus. */
  getComposeFocus(): ComposeField {
    return selectors.composeFocus;
  }

  /** Transient status-bar message, or null when none is showing. */
  getStatusMessage(): string | null {
    return selectors.statusMessage;
  }

  clearStatusMessage(): void {
    if (selectors.statusMessage !== null) actions.setStatusMessage(null);
  }

  openCompose(): void {
    this.composeController?.openCompose();
  }

  cancelCompose(): void {
    this.composeController?.cancelCompose();
  }

  setComposeTo(to: string[]): void {
    this.composeController?.setTo(to);
  }

  setComposeCc(cc: string[]): void {
    this.composeController?.setCc(cc);
  }

  setComposeBcc(bcc: string[]): void {
    this.composeController?.setBcc(bcc);
  }

  setComposeSubject(subject: string): void {
    this.composeController?.setSubject(subject);
  }

  setComposeBody(body: string): void {
    this.composeController?.setBody(body);
  }

  /**
   * Move focus through the composer field order (To → Cc → Bcc → Subject →
   * Body → Send) and wrap. The view reacts to `composeFocus` and moves the
   * native editor focus to match.
   */
  cycleComposeFocus(direction: 1 | -1): void {
    const order = COMPOSE_FIELD_ORDER;
    const current = selectors.composeFocus;
    const idx = order.indexOf(current);
    const nextIdx = (idx + direction + order.length) % order.length;
    const next = order[nextIdx];
    if (next) actions.setComposeFocus(next);
  }

  /**
   * Discard-safety entry point for Escape and Ctrl+C. An empty composer
   * closes immediately; a non-empty one asks for confirmation first. The
   * editors are flushed into state first so content typed since the last
   * content-change callback still counts as "non-empty".
   */
  requestComposeDiscard(): void {
    if (!this.isComposeActive()) return;
    // Never discard out from under an in-flight send.
    if (this.isComposeSending()) return;
    this.composeView.syncStateFromEditors();
    if (this.composeController?.hasContent()) {
      actions.setComposeConfirmDiscard(true);
      return;
    }
    this.composeController?.cancelCompose();
  }

  /** Confirmed discard: close and clear the composer. */
  confirmComposeDiscard(): void {
    this.composeController?.cancelCompose();
  }

  /** Cancel the discard prompt and resume editing. */
  cancelComposeDiscard(): void {
    if (selectors.composeConfirmDiscard) actions.setComposeConfirmDiscard(false);
  }

  /**
   * Request a send (Ctrl+Enter, or Enter/Space on the Send target).
   * Single-flight: ignored while a send is already in flight.
   */
  requestComposeSend(): void {
    if (!this.isComposeActive()) return;
    if (this.isComposeSending()) return;
    void this.submitCompose();
  }

  /**
   * Send the current composer buffer. Flushes editor text into state so
   * the sent body/recipients always match what is on screen. On success
   * the composer closes (restoring the normal shell) and a `Message sent`
   * status is shown; on failure the composer stays open with a sanitized
   * error and no status message.
   */
  async submitCompose(): Promise<void> {
    const controller = this.composeController;
    if (!controller) return;
    this.composeView.syncStateFromEditors();
    const outcome = await controller.submitCompose();
    if (outcome.kind === 'ok') {
      controller.cancelCompose();
      actions.setStatusMessage('Message sent');
    }
  }

  getComposeView(): ComposeView {
    return this.composeView;
  }

  getSmtpService(): SmtpService | null {
    return this.smtpService;
  }

  // -----------------------------------------------------------------
  // Phase 5 — AI assistance (TUI-facing API; display text only, never
  // auto-sends; drafts are routed into the compose flow for review).
  // -----------------------------------------------------------------

  /** True while an AI request is in flight. */
  isAiLoading(): boolean {
    return this.aiController?.isLoading() ?? false;
  }

  /**
   * Summarize the currently selected email into the detail pane.
   *
   * Guard: never start summarization while compose is active. The
   * existing compose buffer must remain unchanged and AI state must
   * remain unaffected, so this returns early without calling the
   * controller when compose is active. No confirmation dialog.
   */
  async summarizeSelectedEmail(): Promise<void> {
    if (this.isComposeActive()) return;
    await this.aiController?.summarizeSelected();
  }

  /**
   * Draft a reply to the currently selected email. On success the draft
   * is loaded into compose (To = original sender, Subject = Re: …) for
   * user review/editing. Never sends.
   *
   * Guard: if compose is already active, AI draft generation must
   * not destroy it. Returns early without calling the AI controller so
   * the buffer remains unchanged. After awaiting AI, re-checks compose
   * so a buffer opened while AI was in flight is never clobbered.
   * `openCompose()` semantics are unchanged globally.
   *
   * Stale-selection guard: the email the AI drafts for is captured when
   * the request starts (the same selection `AiController` reads), and
   * re-checked after the await. If the selection moved while the request
   * was in flight, the draft is dropped rather than combined with a
   * different email's recipient/subject.
   */
  async draftReplyWithAi(): Promise<void> {
    if (this.isComposeActive()) return;
    // Identity of the email the AI is drafting for. `AiController` reads
    // the same selection synchronously, so this is the email the
    // generated text describes.
    const requestedEmailId = getSelectedEmail()?.id ?? null;
    const outcome = await this.aiController?.draftReplySelected();
    if (outcome?.kind !== 'ok') return;
    if (this.isComposeActive()) return;
    const email = getSelectedEmail();
    if (!email) return;
    if (email.id !== requestedEmailId) {
      // The selection changed mid-generation: never pair the old email's
      // AI body with the new email's recipient/subject.
      actions.setStatusMessage('AI draft cancelled: the selected email changed');
      return;
    }
    const sender = email.fromAddresses[0]?.address;
    const subject = email.subject;
    // Single atomic open: recipients, subject and body land together and
    // the Body field takes focus once the editors hold them.
    this.composeController?.openComposeDraft({
      to: sender !== undefined ? [sender] : [],
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      body: outcome.text,
    });
  }

  /** Clear any AI result/error. */
  cancelAi(): void {
    this.aiController?.clearAi();
  }

  getAiService(): AiService | null {
    return this.aiService;
  }

  /**
   * Tear down the App and its child components. Used by tests to
   * release signal subscriptions before destroying the renderer.
   * Not normally called by `main.ts`; that path exits the process.
   */
  override destroy(): void {
    if (this.shellUnsubscribe) this.shellUnsubscribe();
    this.shellUnsubscribe = null;
    if (this.attachUnsubscribe) this.attachUnsubscribe();
    this.attachUnsubscribe = null;
    this.header.destroy();
    this.sidebar.destroy();
    this.content.destroy();
    this.statusBar.destroy();
    this.searchInputBar.destroy();
    this.composeView.destroy();
    this.errorBanner.destroy();
    this.banner.destroy();
  }
}

/**
 * Resolve the currently selected email from state, checking the search
 * hits first when a search is active. Mirrors the `ContentPane` lookup so
 * the AI controller and the detail pane always agree on "selected".
 */
function getSelectedEmail(): PersistedEmail | null {
  const selectedId = selectors.selectedEmailId;
  if (!selectedId) return null;
  const source = selectors.searchActive ? (selectors.searchHits ?? []) : selectors.emails;
  return source.find((e) => e.id === selectedId) ?? null;
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
    smtpHost: config.smtpHost,
    smtpPort: config.smtpPort,
    smtpMode: config.smtpMode,
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
    smtpHost: account.smtpHost,
    smtpPort: account.smtpPort,
    smtpMode: account.smtpMode,
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
