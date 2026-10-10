/**
 * Status bar component - shows key bindings and status info
 */

import { BoxRenderable, type RenderContext, TextAttributes, TextRenderable } from '@opentui/core';
import { selectors, subscribe } from '../../core/state/AppState.js';
import { sanitizeForTerminal } from '../../core/utils/terminal.js';
import type { Theme } from '../theme.js';
import { getTheme } from '../theme.js';

export interface StatusBarOptions {
  themeMode: 'dark' | 'light';
  id?: string;
}

export class StatusBar extends BoxRenderable {
  private theme: Theme;
  private leftGroup: BoxRenderable;
  private rightGroup: BoxRenderable;
  private folderLabel: TextRenderable;
  private emailCount: TextRenderable;
  private unreadLabel: TextRenderable;
  private syncLabel: TextRenderable;
  private unsubscribe: (() => void) | null = null;

  constructor(ctx: RenderContext, options: StatusBarOptions) {
    const theme = getTheme(options.themeMode);
    super(ctx, {
      id: options.id ?? 'status-bar',
      flexDirection: 'row',
      justifyContent: 'space-between',
      width: '100%',
      height: 1,
      backgroundColor: theme.surface,
      borderStyle: 'single',
      borderColor: theme.border,
      paddingLeft: 1,
      paddingRight: 1,
    });

    this.theme = theme;

    this.leftGroup = new BoxRenderable(ctx, {
      id: 'status-left',
      flexDirection: 'row',
      flexGrow: 1,
    });
    this.rightGroup = new BoxRenderable(ctx, {
      id: 'status-right',
      flexDirection: 'row',
    });

    // Primary shortcuts intentionally advertised here (q, /, r, s, d).
    // Navigation keys (j/k, h/l, arrows, Tab, Enter, Esc) are
    // implemented in main.ts but intentionally not shown to keep this
    // one-line bar dense.
    this.leftGroup.add(this.kbdHint(ctx, 'q', 'Quit'));
    this.leftGroup.add(this.kbdHint(ctx, '/', 'Search'));
    this.leftGroup.add(this.kbdHint(ctx, 'r', 'Sync'));
    this.leftGroup.add(this.kbdHint(ctx, 's', 'AI summary'));
    this.leftGroup.add(this.kbdHint(ctx, 'd', 'AI draft'));

    this.folderLabel = new TextRenderable(ctx, {
      id: 'status-folder',
      content: 'Folder: None',
      fg: theme.textSecondary,
    });
    this.emailCount = new TextRenderable(ctx, {
      id: 'status-emails',
      content: 'Emails: 0',
      fg: theme.textSecondary,
    });
    this.unreadLabel = new TextRenderable(ctx, {
      id: 'status-unread',
      content: 'Unread: 0',
      fg: theme.textSecondary,
    });
    this.syncLabel = new TextRenderable(ctx, {
      id: 'status-sync',
      content: '● Idle',
      fg: theme.textMuted,
    });

    this.rightGroup.add(this.folderLabel);
    this.rightGroup.add(this.emailCount);
    this.rightGroup.add(this.unreadLabel);
    this.rightGroup.add(this.syncLabel);

    this.add(this.leftGroup);
    this.add(this.rightGroup);

    this.unsubscribe = subscribe(() => this.refresh());
    this.refresh();
  }

  private kbdHint(ctx: RenderContext, key: string, label: string): BoxRenderable {
    const group = new BoxRenderable(ctx, {
      id: `kbd-${key}`,
      flexDirection: 'row',
      paddingRight: 2,
    });
    const keyText = new TextRenderable(ctx, {
      id: `kbd-key-${key}`,
      content: key,
      fg: this.theme.primary,
      attributes: TextAttributes.BOLD,
    });
    const desc = new TextRenderable(ctx, {
      id: `kbd-desc-${key}`,
      content: `: ${label}`,
      fg: this.theme.textSecondary,
    });
    group.add(keyText);
    group.add(desc);
    return group;
  }

  private refresh(): void {
    const folder = selectors.currentFolder;
    // Folder names come from the IMAP server: sanitize before display.
    this.folderLabel.content = sanitizeForTerminal(`Folder: ${folder?.name ?? 'None'}`);

    const emails = selectors.emails;
    this.emailCount.content = `Emails: ${emails.length}`;

    this.unreadLabel.content = `Unread: ${selectors.unreadCount}`;

    const status = selectors.syncStatus;
    if (status === 'syncing') {
      this.syncLabel.content = '● Syncing';
      this.syncLabel.fg = this.theme.warning;
    } else if (status === 'error') {
      // Surface the actual sanitized sync error (first line,
      // length-limited) instead of a generic indicator.
      this.syncLabel.content = formatSyncError(selectors.syncError);
      this.syncLabel.fg = this.theme.error;
    } else if (status === 'success') {
      this.syncLabel.content = '● Synced';
      this.syncLabel.fg = this.theme.success;
    } else {
      this.syncLabel.content = '● Idle';
      this.syncLabel.fg = this.theme.textMuted;
    }
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.backgroundColor = theme.surface;
    this.borderColor = theme.border;
    this.folderLabel.fg = theme.textSecondary;
    this.emailCount.fg = theme.textSecondary;
    this.unreadLabel.fg = theme.textSecondary;
    this.refresh();
  }

  override destroy(): void {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    super.destroy();
  }
}

/**
 * Format a sync error for the status bar. Shows the first line of
 * the sanitized error, length-limited, with a generic fallback when no
 * message exists. No new panel; existing status UI only.
 *
 * Sync errors can carry IMAP server response text, so the display
 * string is stripped of terminal control bytes before it is returned.
 */
export function formatSyncError(syncError: string | null): string {
  const MAX_MESSAGE_LENGTH = 80;
  if (!syncError) return '● Error';
  const firstLine = syncError.split('\n')[0]?.trim() ?? '';
  if (firstLine.length === 0) return '● Error';
  const clipped =
    firstLine.length > MAX_MESSAGE_LENGTH
      ? firstLine.slice(0, MAX_MESSAGE_LENGTH)
      : firstLine;
  return sanitizeForTerminal(`● Error: ${clipped}`);
}
