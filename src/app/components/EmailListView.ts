/**
 * Email list view - placeholder for Phase 2
 */

import { BoxRenderable, type RenderContext, TextAttributes, TextRenderable } from '@opentui/core';
import { actions, selectors, subscribe } from '../../core/state/AppState.js';
import type { PersistedEmail } from '../../core/database/index.js';
import type { Theme } from '../theme.js';
import { getTheme } from '../theme.js';

export interface EmailListViewOptions {
  themeMode: 'dark' | 'light';
  id?: string;
}

export class EmailListView extends BoxRenderable {
  private theme: Theme;
  private emptyState: BoxRenderable;
  private emptyTitle: TextRenderable;
  private emptySubtitle: TextRenderable;
  private list: BoxRenderable;
  private unsubscribe: (() => void) | null = null;

  constructor(ctx: RenderContext, options: EmailListViewOptions) {
    const theme = getTheme(options.themeMode);
    super(ctx, {
      id: options.id ?? 'email-list-view',
      flexDirection: 'column',
      width: '100%',
      flexGrow: 1,
      backgroundColor: theme.background,
    });

    this.theme = theme;

    this.emptyState = new BoxRenderable(ctx, {
      id: 'email-list-empty',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      width: '100%',
      flexGrow: 1,
    });
    const emptyTitle = new TextRenderable(ctx, {
      id: 'email-list-empty-title',
      content: 'No emails',
      fg: theme.textPrimary,
      attributes: TextAttributes.BOLD,
    });
    const emptySubtitle = new TextRenderable(ctx, {
      id: 'email-list-empty-subtitle',
      content: 'Select a folder or sync to load emails',
      fg: theme.textMuted,
    });
    this.emptyTitle = emptyTitle;
    this.emptySubtitle = emptySubtitle;
    this.emptyState.add(emptyTitle);
    this.emptyState.add(emptySubtitle);

    this.list = new BoxRenderable(ctx, {
      id: 'email-list-items',
      flexDirection: 'column',
      width: '100%',
      flexGrow: 1,
    });

    this.add(this.emptyState);
    this.add(this.list);

    this.unsubscribe = subscribe(() => this.refresh());
    this.refresh();
  }

  private refresh(): void {
    // Phase 3.3: when a search is active and the repository has
    // returned hits, render those instead of the folder-bound
    // `emails` list. The default branch (no search) is unchanged.
    const isSearching = selectors.searchActive && selectors.searchHits !== null;
    const emails = isSearching ? (selectors.searchHits ?? []) : selectors.emails;
    const selectedId = selectors.selectedEmailId;

    this.emptyState.visible = emails.length === 0;
    this.list.visible = emails.length > 0;

    if (emails.length === 0) {
      // The empty-state copy changes based on the current state.
      if (isSearching) {
        if (selectors.searchError) {
          this.emptyTitle.content = 'Search failed';
          this.emptySubtitle.content = selectors.searchError;
        } else if (selectors.searchIssues.length > 0) {
          this.emptyTitle.content = 'Query has issues';
          this.emptySubtitle.content = selectors.searchIssues.map((i) => i.message).join('; ');
        } else {
          this.emptyTitle.content = 'No search results';
          this.emptySubtitle.content = 'Try different terms or operators';
        }
      } else {
        this.emptyTitle.content = 'No emails';
        this.emptySubtitle.content = 'Select a folder or sync to load emails';
      }
      return;
    }

    // Rebuild list items
    const items = this.list.getChildren().slice();
    for (const item of items) {
      this.list.remove(item);
      item.destroy();
    }

    for (const email of emails) {
      this.list.add(this.buildItem(email, email.id === selectedId));
    }
  }

  private buildItem(email: PersistedEmail, isSelected: boolean): BoxRenderable {
    const item = new BoxRenderable(this.ctx, {
      id: `email-item-${email.id}`,
      flexDirection: 'column',
      width: '100%',
      backgroundColor: isSelected ? this.theme.surfaceHover : 'transparent',
      paddingLeft: 1,
      paddingRight: 1,
    });
    const header = new BoxRenderable(this.ctx, {
      id: `email-item-header-${email.id}`,
      flexDirection: 'row',
      justifyContent: 'space-between',
      width: '100%',
    });
    const from = new TextRenderable(this.ctx, {
      id: `email-item-from-${email.id}`,
      content: email.fromAddresses.map((a) => a.name || a.address).join(', '),
      fg: isSelected
        ? this.theme.textPrimary
        : email.isRead
          ? this.theme.textSecondary
          : this.theme.textPrimary,
      attributes: email.isRead ? 0 : TextAttributes.BOLD,
    });
    const date = new TextRenderable(this.ctx, {
      id: `email-item-date-${email.id}`,
      content: formatDate(new Date(email.date * 1000)),
      fg: this.theme.textMuted,
    });
    header.add(from);
    header.add(date);

    const subject = new TextRenderable(this.ctx, {
      id: `email-item-subject-${email.id}`,
      content: email.subject || '(no subject)',
      fg: this.theme.textSecondary,
    });

    item.add(header);
    item.add(subject);
    item.onMouseUp = () => actions.setSelectedEmail(email.id);
    return item;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.backgroundColor = theme.background;
    this.refresh();
  }

  override destroy(): void {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    super.destroy();
  }
}

function formatDate(date: Date): string {
  const d = new Date(date);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (days < 7) {
    return d.toLocaleDateString([], { weekday: 'short' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
