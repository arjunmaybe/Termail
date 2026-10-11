/**
 * Application header - a compact title strip above the main content.
 *
 * Left side shows the application title; right side shows the current
 * account and folder context. Status details (counts, sync state) live in
 * the `StatusBar`; this strip is navigation context only.
 */

import { BoxRenderable, type RenderContext, TextAttributes, TextRenderable } from '@opentui/core';
import { selectors, subscribe } from '../../core/state/AppState.js';
import { sanitizeForTerminal } from '../../core/utils/terminal.js';
import type { Theme } from '../theme.js';
import { getTheme } from '../theme.js';

export interface HeaderOptions {
  themeMode: 'dark' | 'light';
  id?: string;
}

export class Header extends BoxRenderable {
  private theme: Theme;
  private titleText: TextRenderable;
  private contextText: TextRenderable;
  private unsubscribe: (() => void) | null = null;

  constructor(ctx: RenderContext, options: HeaderOptions) {
    const theme = getTheme(options.themeMode);
    super(ctx, {
      id: options.id ?? 'app-header',
      flexDirection: 'row',
      justifyContent: 'space-between',
      width: '100%',
      height: 1,
      backgroundColor: theme.surface,
      paddingLeft: 1,
      paddingRight: 1,
    });

    this.theme = theme;

    this.titleText = new TextRenderable(ctx, {
      id: 'app-header-title',
      content: 'TERMAIL',
      fg: theme.primary,
      attributes: TextAttributes.BOLD,
    });
    this.contextText = new TextRenderable(ctx, {
      id: 'app-header-context',
      content: '',
      fg: theme.textMuted,
    });

    this.add(this.titleText);
    this.add(this.contextText);

    this.unsubscribe = subscribe(() => this.refresh());
    this.refresh();
  }

  private refresh(): void {
    const account = selectors.currentAccount;
    const folder = selectors.currentFolder;
    // Account names come from local config and folder names from the IMAP
    // server: sanitize both before display.
    const accountName = account ? sanitizeForTerminal(account.name) : null;
    const folderName = folder ? sanitizeForTerminal(folder.name) : null;
    if (accountName && folderName) {
      this.contextText.content = `${accountName} / ${folderName}`;
    } else if (folderName) {
      this.contextText.content = folderName;
    } else {
      this.contextText.content = '';
    }
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.backgroundColor = theme.surface;
    this.titleText.fg = theme.primary;
    this.contextText.fg = theme.textMuted;
    this.refresh();
  }

  override destroy(): void {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    super.destroy();
  }
}
