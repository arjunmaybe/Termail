/**
 * Folder tabs component - horizontal tab bar for folder switching
 */

import { BoxRenderable, type RenderContext, TextAttributes, TextRenderable } from '@opentui/core';
import { actions, selectors, subscribe } from '../../core/state/AppState.js';
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
      flexDirection: 'row',
      backgroundColor: theme.surface,
      width: '100%',
      height: 1,
      paddingLeft: 1,
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
      // Remove any dynamic children
      this.getChildren()
        .slice()
        .forEach((c) => {
          if (c.id !== 'folder-tabs-placeholder') {
            this.remove(c);
            c.destroy();
          }
        });
      return;
    }

    this.placeholder.visible = false;
    // Drop dynamic children, keep placeholder
    this.getChildren()
      .slice()
      .forEach((c) => {
        if (c.id !== 'folder-tabs-placeholder') {
          this.remove(c);
          c.destroy();
        }
      });

    for (const folder of folders) {
      const isActive = folder.id === currentFolderId;
      // Phase 2.4 never writes `unread_count` / `total_count`, so the
      // underlying `Folder` projection's `unreadCount` is always 0. Derive
      // the sidebar's count from the in-memory email list via the
      // `foldersWithUnread` computed signal (defined in `AppState`).
      const folderWithUnread = selectors.foldersWithUnread.find((f) => f.id === folder.id);
      const unread = folderWithUnread?.unreadCount ?? 0;
      const label = unread > 0 ? `${folder.name} (${unread})` : folder.name;
      const tab = new TextRenderable(this.ctx, {
        id: `folder-tab-${folder.id}`,
        content: label,
        fg: isActive ? this.theme.primary : this.theme.textSecondary,
        attributes: isActive ? TextAttributes.BOLD : 0,
        paddingRight: 1,
      });
      tab.onMouseUp = () => actions.setCurrentFolder(folder.id);
      this.add(tab);
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
