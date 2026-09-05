/**
 * Reactive application state using @preact/signals
 */

import { computed, signal } from '@preact/signals';
import type { PersistedEmail } from '../database/index.js';
import type { ParseIssue } from '../search/SearchQueryParser.js';
import type { Account, Folder } from '../types/index.js';

export interface AppState {
  // Accounts
  accounts: Account[];
  currentAccountId: string | null;

  // Folders
  folders: Folder[];
  currentFolderId: string | null;

  // Emails — the rich PersistedEmail shape carries body, CC, attachments,
  // and headers, so the detail view reads from this list directly without
  // a separate findById() call.
  emails: PersistedEmail[];
  selectedEmailId: string | null;

  // UI state
  sidebarCollapsed: boolean;
  paneRatio: number;

  // Sync status
  syncStatus: 'idle' | 'syncing' | 'error' | 'success';
  syncError: string | null;
  lastSyncAt: number | null;

  // Loading states
  isLoadingFolders: boolean;
  isLoadingEmails: boolean;

  // Error state
  lastError: string | null;

  // Search state (Phase 3.3)
  /**
   * Current search results, or `null` when no search is in progress.
   * The TUI's `EmailListView` reads from this list instead of
   * `emails` when `searchActive` is true and `searchHits` is non-null.
   */
  searchHits: PersistedEmail[] | null;
  /** Raw user input buffer for the search input bar. */
  searchQuery: string;
  /** True while the search input bar is visible. */
  searchActive: boolean;
  /**
   * Parser issues from the most recent submit. Empty when the
   * parser had no complaints. Surfaced as a "query has issues"
   * placeholder in the email list.
   */
  searchIssues: ParseIssue[];
  /**
   * Repository error from the most recent submit. Cleared on every
   * submit. Surfaced as a "search failed" placeholder.
   */
  searchError: string | null;
}

// Internal signals
const _accounts = signal<Account[]>([]);
const _currentAccountId = signal<string | null>(null);
const _folders = signal<Folder[]>([]);
const _currentFolderId = signal<string | null>(null);
const _emails = signal<PersistedEmail[]>([]);
const _selectedEmailId = signal<string | null>(null);
const _sidebarCollapsed = signal<boolean>(false);
const _paneRatio = signal<number>(0.3);
const _syncStatus = signal<'idle' | 'syncing' | 'error' | 'success'>('idle');
const _syncError = signal<string | null>(null);
const _lastSyncAt = signal<number | null>(null);
const _isLoadingFolders = signal<boolean>(false);
const _isLoadingEmails = signal<boolean>(false);
const _lastError = signal<string | null>(null);

// Search state (Phase 3.3)
const _searchHits = signal<PersistedEmail[] | null>(null);
const _searchQuery = signal<string>('');
const _searchActive = signal<boolean>(false);
const _searchIssues = signal<ParseIssue[]>([]);
const _searchError = signal<string | null>(null);

// Computed signals
const currentAccount = computed(() => {
  const id = _currentAccountId.value;
  return id ? _accounts.value.find((a) => a.id === id) || null : null;
});

const currentFolder = computed(() => {
  const id = _currentFolderId.value;
  return id ? _folders.value.find((f) => f.id === id) || null : null;
});

const selectedEmail = computed(() => {
  const id = _selectedEmailId.value;
  return id ? _emails.value.find((e) => e.id === id) || null : null;
});

const unreadCount = computed(() => {
  return _emails.value.filter((e) => !e.isRead).length;
});

const flaggedCount = computed(() => {
  return _emails.value.filter((e) => e.isFlagged).length;
});

const foldersWithUnread = computed(() => {
  return _folders.value.map((folder) => ({
    ...folder,
    unreadCount: _emails.value.filter((e) => e.folderId === folder.id && !e.isRead).length,
  }));
});

// Actions
export const actions = {
  // Account actions
  setAccounts(accounts: Account[]) {
    _accounts.value = accounts;
    if (accounts.length > 0 && !_currentAccountId.value) {
      const first = accounts[0];
      if (first) _currentAccountId.value = first.id;
    }
  },

  setCurrentAccount(accountId: string | null) {
    _currentAccountId.value = accountId;
    if (accountId) {
      // Reset folder/email selection when switching accounts
      _currentFolderId.value = null;
      _selectedEmailId.value = null;
      _emails.value = [];
    }
  },

  addAccount(account: Account) {
    _accounts.value = [..._accounts.value, account];
  },

  updateAccount(accountId: string, updates: Partial<Account>) {
    _accounts.value = _accounts.value.map((a) => (a.id === accountId ? { ...a, ...updates } : a));
  },

  removeAccount(accountId: string) {
    _accounts.value = _accounts.value.filter((a) => a.id !== accountId);
    if (_currentAccountId.value === accountId) {
      _currentAccountId.value = _accounts.value[0]?.id || null;
    }
  },

  // Folder actions
  setFolders(folders: Folder[]) {
    _folders.value = folders;
    if (folders.length > 0 && !_currentFolderId.value) {
      // Prefer Inbox folder
      const inbox = folders.find((f) => f.type === 'inbox');
      const first = folders[0];
      if (inbox) {
        _currentFolderId.value = inbox.id;
      } else if (first) {
        _currentFolderId.value = first.id;
      }
    }
  },

  setCurrentFolder(folderId: string | null) {
    _currentFolderId.value = folderId;
    _selectedEmailId.value = null;
  },

  addFolder(folder: Folder) {
    _folders.value = [..._folders.value, folder];
  },

  updateFolder(folderId: string, updates: Partial<Folder>) {
    _folders.value = _folders.value.map((f) => (f.id === folderId ? { ...f, ...updates } : f));
  },

  removeFolder(folderId: string) {
    _folders.value = _folders.value.filter((f) => f.id !== folderId);
    if (_currentFolderId.value === folderId) {
      _currentFolderId.value = _folders.value[0]?.id || null;
    }
  },

  // Email actions
  setEmails(emails: PersistedEmail[]) {
    _emails.value = emails;
    _selectedEmailId.value = null;
  },

  addEmails(emails: PersistedEmail[]) {
    const existingIds = new Set(_emails.value.map((e) => e.id));
    const newEmails = emails.filter((e) => !existingIds.has(e.id));
    _emails.value = [...newEmails, ..._emails.value];
  },

  updateEmail(emailId: string, updates: Partial<PersistedEmail>) {
    _emails.value = _emails.value.map((e) => (e.id === emailId ? { ...e, ...updates } : e));
  },

  removeEmail(emailId: string) {
    _emails.value = _emails.value.filter((e) => e.id !== emailId);
    if (_selectedEmailId.value === emailId) {
      _selectedEmailId.value = _emails.value[0]?.id || null;
    }
  },

  setSelectedEmail(emailId: string | null) {
    _selectedEmailId.value = emailId;
  },

  markAsRead(emailId: string) {
    _emails.value = _emails.value.map((e) => (e.id === emailId ? { ...e, isRead: true } : e));
  },

  markAsUnread(emailId: string) {
    _emails.value = _emails.value.map((e) => (e.id === emailId ? { ...e, isRead: false } : e));
  },

  toggleFlag(emailId: string) {
    _emails.value = _emails.value.map((e) =>
      e.id === emailId ? { ...e, isFlagged: !e.isFlagged } : e
    );
  },

  // UI actions
  setSidebarCollapsed(collapsed: boolean) {
    _sidebarCollapsed.value = collapsed;
  },

  toggleSidebar() {
    _sidebarCollapsed.value = !_sidebarCollapsed.value;
  },

  setPaneRatio(ratio: number) {
    _paneRatio.value = Math.max(0.2, Math.min(0.5, ratio));
  },

  // Sync actions
  setSyncStatus(status: 'idle' | 'syncing' | 'error' | 'success') {
    _syncStatus.value = status;
    if (status === 'success') {
      _lastSyncAt.value = Date.now();
      _syncError.value = null;
    }
  },

  setSyncError(error: string | null) {
    _syncError.value = error;
    if (error) {
      _syncStatus.value = 'error';
    }
  },

  // Loading actions
  setLoadingFolders(loading: boolean) {
    _isLoadingFolders.value = loading;
  },

  setLoadingEmails(loading: boolean) {
    _isLoadingEmails.value = loading;
  },

  // Error actions
  setError(error: string | null) {
    _lastError.value = error;
  },

  clearError() {
    _lastError.value = null;
  },

  // Search actions (Phase 3.3)
  setSearchActive(active: boolean) {
    _searchActive.value = active;
  },

  setSearchQuery(query: string) {
    _searchQuery.value = query;
  },

  setSearchHits(hits: PersistedEmail[] | null) {
    _searchHits.value = hits;
  },

  setSearchIssues(issues: ParseIssue[]) {
    _searchIssues.value = issues;
  },

  setSearchError(error: string | null) {
    _searchError.value = error;
  },

  clearSearch() {
    _searchActive.value = false;
    _searchQuery.value = '';
    _searchHits.value = null;
    _searchIssues.value = [];
    _searchError.value = null;
  },

  // Reset all state
  reset() {
    _accounts.value = [];
    _currentAccountId.value = null;
    _folders.value = [];
    _currentFolderId.value = null;
    _emails.value = [];
    _selectedEmailId.value = null;
    _sidebarCollapsed.value = false;
    _syncStatus.value = 'idle';
    _syncError.value = null;
    _lastSyncAt.value = null;
    _isLoadingFolders.value = false;
    _isLoadingEmails.value = false;
    _lastError.value = null;
    // Search state (Phase 3.3)
    _searchHits.value = null;
    _searchQuery.value = '';
    _searchActive.value = false;
    _searchIssues.value = [];
    _searchError.value = null;
  },
};

// Selectors for external use
export const selectors = {
  get accounts() {
    return _accounts.value;
  },
  get currentAccountId() {
    return _currentAccountId.value;
  },
  get currentAccount() {
    return currentAccount.value;
  },
  get folders() {
    return _folders.value;
  },
  get currentFolderId() {
    return _currentFolderId.value;
  },
  get currentFolder() {
    return currentFolder.value;
  },
  get emails() {
    return _emails.value;
  },
  get selectedEmailId() {
    return _selectedEmailId.value;
  },
  get selectedEmail() {
    return selectedEmail.value;
  },
  get unreadCount() {
    return unreadCount.value;
  },
  get flaggedCount() {
    return flaggedCount.value;
  },
  get foldersWithUnread() {
    return foldersWithUnread.value;
  },
  get sidebarCollapsed() {
    return _sidebarCollapsed.value;
  },
  get paneRatio() {
    return _paneRatio.value;
  },
  get syncStatus() {
    return _syncStatus.value;
  },
  get syncError() {
    return _syncError.value;
  },
  get lastSyncAt() {
    return _lastSyncAt.value;
  },
  get isLoadingFolders() {
    return _isLoadingFolders.value;
  },
  get isLoadingEmails() {
    return _isLoadingEmails.value;
  },
  get lastError() {
    return _lastError.value;
  },
  // Search selectors (Phase 3.3)
  get searchHits() {
    return _searchHits.value;
  },
  get searchQuery() {
    return _searchQuery.value;
  },
  get searchActive() {
    return _searchActive.value;
  },
  get searchIssues() {
    return _searchIssues.value;
  },
  get searchError() {
    return _searchError.value;
  },
  subscribe(fn: () => void): () => void {
    return subscribe(fn);
  },
};

// Subscribe to changes
export function subscribe(fn: (state: AppState) => void): () => void {
  const signals = [
    _accounts,
    _currentAccountId,
    _folders,
    _currentFolderId,
    _emails,
    _selectedEmailId,
    _sidebarCollapsed,
    _paneRatio,
    _syncStatus,
    _syncError,
    _lastSyncAt,
    _isLoadingFolders,
    _isLoadingEmails,
    _lastError,
    // Search state (Phase 3.3)
    _searchHits,
    _searchQuery,
    _searchActive,
    _searchIssues,
    _searchError,
  ];

  // Each signal has a strongly-typed subscribe parameter, but the
  // callback contract here is the generic AppState consumer.
  const unsubscribers = signals.map((s) => s.subscribe(fn as (value: unknown) => void));
  return () => unsubscribers.forEach((unsub) => unsub());
}
