/**
 * Folder list component - vertical list of folders for the sidebar.
 *
 * Each folder is one row: a selection marker, the folder name, and the
 * unread count right-aligned. The active folder is highlighted; long
 * names are clipped by the row width. Row node ids (`folder-tab-*`) are
 * kept stable for existing tests and mouse handling.
 */

import { BoxRenderable, type RenderContext, TextAttributes, TextRenderable } from '@opentui/core';
import { actions, selectors, subscribe } from '../../core/state/AppState.js';
import { sanitizeForTerminal } from '../../core/utils/terminal.js';
import type { Theme } from '../theme.js';
import { getTheme } from '../theme.js';

export interface FolderTabsOptions {
  themeMode: 'dark' | 'light';
  id?: string;
}

export class FolderTabs extends BoxRenderable {
  private theme: Theme;
  private themeMode: 'dark' | 'light';
  private placeholder: TextRenderable;
  private unsubscribe: (() => void) | null = null;

  constructor(ctx: RenderContext, options: FolderTabsOptions) {
    const theme = getTheme(options.themeMode);
    super(ctx, {
      id: options.id ?? 'folder-tabs',
      flexDirection: 'column',
      backgroundColor: theme.surface,
      width: '100%',
      flexGrow: 1,
      paddingLeft: 1,
      paddingRight: 1,
    });

    this.theme = theme;
    this.themeMode = options.themeMode;

    this.placeholder = new TextRenderable(ctx, {
      id: 'folder-tabs-placeholder',
      content: 'No folders',
      fg: theme.textMuted,
    });
    this.add(this.placeholder);

    this.rebuild();

    this.unsubscribe = subscribe(() => {
      this.rebuild();
    });
  }

  private rebuild(): void {
    const folders = selectors.folders;
    const currentFolderId = selectors.currentFolderId;

    if (folders.length === 0) {
      this.placeholder.visible = true;
      this.placeholder.content = 'No folders';
      // Remove any dynamic children (recursive: frees native handles).
      for (const c of this.getChildren().slice()) {
        if (c.id !== 'folder-tabs-placeholder') {
          c.destroyRecursively();
        }
      }
      return;
    }

    this.placeholder.visible = false;
    // Drop dynamic children, keep placeholder (recursive: frees handles).
    for (const c of this.getChildren().slice()) {
      if (c.id !== 'folder-tabs-placeholder') {
        c.destroyRecursively();
      }
    }

    for (let i = 0; i < folders.length; i += 1) {
      const folder = folders[i]!;
      const isActive = folder.id === currentFolderId;
      // `folder.unreadCount` is populated at read time from
      // persisted emails (`MessageRepository` GROUP BY folder_id), so it
      // is correct for non-current and large folders. `foldersWithUnread`
      // combines that DB truth with live in-memory counts for immediate
      // current-folder mark-as-read updates.
      const folderWithUnread = selectors.foldersWithUnread.find((f) => f.id === folder.id);
      const unread = folderWithUnread?.unreadCount ?? 0;
      // Folder names come from the IMAP server: sanitize before display.
      // The name node keeps the `folder-tab-<id>` id and the exact
      // sanitized name so existing text lookups keep working; marker and
      // count are separate nodes.
      const safeName = sanitizeForTerminal(folder.name);
      const row = new BoxRenderable(this.ctx, {
        id: `folder-row-${folder.id}`,
        flexDirection: 'row',
        width: '100%',
        height: 1,
      });
      const marker = new TextRenderable(this.ctx, {
        id: `folder-tab-marker-${folder.id}`,
        content: isActive ? '› ' : '  ',
        fg: isActive ? this.theme.primary : this.theme.textMuted,
        attributes: isActive ? TextAttributes.BOLD : 0,
        flexShrink: 0,
      });
      const name = new TextRenderable(this.ctx, {
        id: `folder-tab-${folder.id}`,
        content: safeName,
        fg: isActive ? this.theme.primary : this.theme.textSecondary,
        attributes: isActive ? TextAttributes.BOLD : 0,
        flexGrow: 1,
        flexShrink: 1,
      });
      const count = new TextRenderable(this.ctx, {
        id: `folder-tab-count-${folder.id}`,
        content: unread > 0 ? ` (${unread})` : '',
        fg: isActive ? this.theme.primary : this.theme.textMuted,
        flexShrink: 0,
      });
      row.onMouseUp = () => actions.setCurrentFolder(folder.id);
      row.add(marker);
      row.add(name);
      row.add(count);
      this.add(row);
    }
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.themeMode = theme === getTheme('dark') ? 'dark' : 'light';
    this.backgroundColor = theme.surface;
    this.placeholder.fg = theme.textMuted;
    this.rebuild();
  }

  override destroy(): void {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    super.destroy();
  }
}
