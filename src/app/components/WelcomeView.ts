/**
 * Welcome view - shown when no emails are loaded
 */

import { BoxRenderable, type RenderContext, TextAttributes, TextRenderable } from '@opentui/core';
import { selectors, subscribe } from '../../core/state/AppState.js';
import type { Theme } from '../theme.js';
import { getTheme } from '../theme.js';

export interface WelcomeViewOptions {
  themeMode: 'dark' | 'light';
  id?: string;
}

export class WelcomeView extends BoxRenderable {
  private theme: Theme;
  private themeMode: 'dark' | 'light';
  private titleText: TextRenderable;
  private subtitle: TextRenderable;
  private hint: TextRenderable;
  private unsubscribe: (() => void) | null = null;

  constructor(ctx: RenderContext, options: WelcomeViewOptions) {
    const theme = getTheme(options.themeMode);
    super(ctx, {
      id: options.id ?? 'welcome-view',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      width: '100%',
      flexGrow: 1,
      backgroundColor: theme.background,
    });

    this.theme = theme;
    this.themeMode = options.themeMode;

    this.titleText = new TextRenderable(ctx, {
      id: 'welcome-title',
      content: 'TERMAIL',
      fg: theme.textPrimary,
      attributes: TextAttributes.BOLD,
    });
    this.subtitle = new TextRenderable(ctx, {
      id: 'welcome-subtitle',
      content: 'No emails synced yet',
      fg: theme.textMuted,
    });
    this.hint = new TextRenderable(ctx, {
      id: 'welcome-hint',
      content: "Press 'r' to sync (Phase 2)",
      fg: theme.textMuted,
    });

    this.add(this.titleText);
    this.add(this.subtitle);
    this.add(this.hint);

    this.unsubscribe = subscribe(() => this.refresh());
    this.refresh();
  }

  private refresh(): void {
    const folder = selectors.currentFolder;
    this.subtitle.content = folder ? `No emails in ${folder.name} yet` : 'No emails synced yet';
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.themeMode = theme === getTheme('dark') ? 'dark' : 'light';
    this.backgroundColor = theme.background;
    this.titleText.fg = theme.textPrimary;
    this.subtitle.fg = theme.textMuted;
    this.hint.fg = theme.textMuted;
  }

  override destroy(): void {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    super.destroy();
  }
}
