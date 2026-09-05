/**
 * Phase 3.3 — `SearchInputBar`.
 *
 * A one-line input bar shown above the `StatusBar` when the search
 * is active. Renders the current query and a "Search:" prompt.
 * Owns no state of its own; everything is read from `AppState` and
 * the only way to change the buffer is through the `App` methods
 * (`pushChar`, `popChar`, `submitSearch`, `cancelSearch`).
 *
 * The component is intentionally passive. The `main.ts`
 * keypress handler does the actual key translation; this
 * component only renders. This keeps the controller logic out of
 * the view layer and makes the controller trivially testable.
 *
 * Layering reminder:
 *   - This component does NOT touch `Database`, `SearchRepository`,
 *     or any column name.
 *   - It does NOT parse the query.
 *   - It does NOT call `actions.setSearchQuery` directly — the
 *     controller owns that, so a single submit can replay through
 *     the same code path.
 */

import { BoxRenderable, type RenderContext, TextAttributes, TextRenderable } from '@opentui/core';
import { selectors, subscribe } from '../../core/state/AppState.js';
import type { Theme } from '../theme.js';
import { getTheme } from '../theme.js';

export interface SearchInputBarOptions {
  themeMode: 'dark' | 'light';
  id?: string;
}

/**
 * A one-line input bar. Visible only when `selectors.searchActive`
 * is true. Renders the current `searchQuery` next to a `Search:`
 * prompt. Submit and cancel are owned by the caller (`App`); the
 * bar never mutates the buffer on its own.
 */
export class SearchInputBar extends BoxRenderable {
  private theme: Theme;
  private prompt: TextRenderable;
  private input: TextRenderable;
  private unsubscribe: (() => void) | null = null;

  constructor(ctx: RenderContext, options: SearchInputBarOptions) {
    const theme = getTheme(options.themeMode);
    super(ctx, {
      id: options.id ?? 'search-input-bar',
      flexDirection: 'row',
      backgroundColor: theme.surface,
      width: '100%',
      height: 1,
      paddingLeft: 1,
      borderStyle: 'single',
      borderColor: theme.border,
    });

    this.theme = theme;

    this.prompt = new TextRenderable(ctx, {
      id: 'search-prompt',
      content: 'Search:',
      fg: theme.primary,
      attributes: TextAttributes.BOLD,
    });
    this.input = new TextRenderable(ctx, {
      id: 'search-input',
      content: '',
      fg: theme.textPrimary,
    });

    this.add(this.prompt);
    this.add(this.input);

    this.visible = false;

    this.unsubscribe = subscribe(() => this.refresh());
    this.refresh();
  }

  private refresh(): void {
    const active = selectors.searchActive;
    this.visible = active;
    this.input.content = active ? selectors.searchQuery : '';
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.backgroundColor = theme.surface;
    this.borderColor = theme.border;
    this.prompt.fg = theme.primary;
    this.input.fg = theme.textPrimary;
    this.refresh();
  }

  override destroy(): void {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    super.destroy();
  }
}
