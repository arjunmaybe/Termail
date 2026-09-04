/**
 * Sidebar component - folder list with tabs
 */

import { BoxRenderable, type RenderContext, TextAttributes, TextRenderable } from '@opentui/core';
import { actions, selectors, subscribe } from '../../core/state/AppState.js';
import { FolderTabs } from '../components/FolderTabs.js';
import type { Theme } from '../theme.js';
import { getTheme } from '../theme.js';

export interface SidebarOptions {
  themeMode: 'dark' | 'light';
  id?: string;
  /** When true, only a thin vertical bar is shown. */
  collapsed?: boolean;
}

export class Sidebar extends BoxRenderable {
  private theme: Theme;
  private themeMode: 'dark' | 'light';
  private header: BoxRenderable;
  private titleText: TextRenderable;
  private collapseBtn: TextRenderable;
  private collapsedLabel: TextRenderable;
  private folderTabs: FolderTabs;
  private footer: TextRenderable;
  private unsubscribe: (() => void) | null = null;

  constructor(ctx: RenderContext, options: SidebarOptions) {
    const theme = getTheme(options.themeMode);
    super(ctx, {
      id: options.id ?? 'sidebar',
      flexDirection: 'column',
      width: '30%',
      minWidth: 20,
      height: '100%',
      backgroundColor: theme.surface,
      borderStyle: 'single',
      borderColor: theme.border,
      shouldFill: true,
    });

    this.theme = theme;
    this.themeMode = options.themeMode;
    const collapsed = options.collapsed ?? false;

    this.header = new BoxRenderable(ctx, {
      id: 'sidebar-header',
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: theme.surface,
      width: '100%',
      height: 1,
    });
    this.titleText = new TextRenderable(ctx, {
      id: 'sidebar-title',
      content: 'Folders',
      fg: theme.textPrimary,
      attributes: TextAttributes.BOLD,
    });
    this.collapseBtn = new TextRenderable(ctx, {
      id: 'sidebar-collapse-btn',
      content: '◀', // ◀
      fg: theme.textMuted,
    });
    this.header.add(this.titleText);
    this.header.add(this.collapseBtn);

    this.collapsedLabel = new TextRenderable(ctx, {
      id: 'sidebar-collapsed-label',
      content: 'F',
      fg: theme.textMuted,
    });

    this.folderTabs = new FolderTabs(ctx, { id: 'folder-tabs', themeMode: this.themeMode });
    this.folderTabs.width = '100%';
    this.folderTabs.flexGrow = 1;

    this.footer = new TextRenderable(ctx, {
      id: 'sidebar-footer',
      content: '0 folders',
      fg: theme.textMuted,
      width: '100%',
      height: 1,
      paddingLeft: 1,
    });

    this.add(this.header);
    this.add(this.folderTabs);
    this.add(this.footer);

    if (collapsed) {
      this.setCollapsed(true);
    }

    // React to state changes
    this.unsubscribe = subscribe(() => {
      this.footer.content = `${selectors.folders.length} folder${selectors.folders.length === 1 ? '' : 's'}`;
    });

    this.collapseBtn.onMouseUp = () => actions.toggleSidebar();
  }

  setCollapsed(collapsed: boolean): void {
    if (collapsed) {
      this.width = 1;
      this.folderTabs.visible = false;
      this.footer.visible = false;
      this.header.visible = false;
      this.collapsedLabel.visible = true;
      this.remove(this.header);
      this.remove(this.folderTabs);
      this.remove(this.footer);
      this.add(this.collapsedLabel);
    } else {
      this.width = '30%';
      this.collapsedLabel.visible = false;
      this.remove(this.collapsedLabel);
      this.header.visible = true;
      this.folderTabs.visible = true;
      this.footer.visible = true;
      this.add(this.header);
      this.add(this.folderTabs);
      this.add(this.footer);
    }
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.themeMode = theme === getTheme('dark') ? 'dark' : 'light';
    this.backgroundColor = theme.surface;
    this.borderColor = theme.border;
    this.header.backgroundColor = theme.surface;
    this.titleText.fg = theme.textPrimary;
    this.collapseBtn.fg = theme.textMuted;
    this.collapsedLabel.fg = theme.textMuted;
    this.footer.fg = theme.textMuted;
    this.folderTabs.setTheme(theme);
  }

  override destroy(): void {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    super.destroy();
  }
}
