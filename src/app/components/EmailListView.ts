/**
 * Email list view - folder/search result list with selection highlight.
 * Selection is driven by `AppState.selectedEmailId` (keyboard via
 * `App.moveEmailSelection`, mouse via click). Empty states distinguish
 * no mail, no search results, query issues, and search errors.
 */

import {
  BoxRenderable,
  type RenderContext,
  type ScrollBoxRenderable,
  TextAttributes,
  TextRenderable,
} from '@opentui/core';
import type { PersistedEmail } from '../../core/database/index.js';
import { actions, selectors, subscribe } from '../../core/state/AppState.js';
import { sanitizeForTerminal } from '../../core/utils/terminal.js';
import type { Theme } from '../theme.js';
import { getTheme } from '../theme.js';

export interface EmailListViewOptions {
  themeMode: 'dark' | 'light';
  id?: string;
  /**
   * Scroll container the list lives in. Used to keep the highlighted
   * row visible on navigation. Optional so the view stays usable (and
   * testable) without a scroll parent.
   */
  scrollContainer?: ScrollBoxRenderable | null;
}

export class EmailListView extends BoxRenderable {
  private theme: Theme;
  private emptyState: BoxRenderable;
  private emptyTitle: TextRenderable;
  private emptySubtitle: TextRenderable;
  private list: BoxRenderable;
  private scrollContainer: ScrollBoxRenderable | null;
  /**
   * Stashed per-row content offsets from the last laid-out list, with the
   * exact email array and viewport width they were measured at. Content
   * offsets are independent of viewport position and scroll clamps, and
   * stay valid across rebuilds of identical content — so a list revealed
   * after being hidden (stale/zero geometry) can still scroll its
   * highlight into view. Cleared whenever the email array changes.
   */
  private lastRowOffsets: {
    emails: readonly PersistedEmail[];
    width: number;
    byId: Map<string, { offset: number; height: number }>;
  } | null = null;
  /**
   * Identity of the email array the rows were last fully built from, plus
   * which highlight they were painted with. When only the highlight moves
   * (same array, same row count), rows are repainted in place instead of
   * rebuilt: a full rebuild per keypress costs O(N) native create/destroy
   * + layout and stalls held-key repeat on long lists.
   */
  private lastBuiltEmails: readonly PersistedEmail[] | null = null;
  private lastBuiltTheme: Theme | null = null;
  private lastPaintedSelected: string | null = null;
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
    this.scrollContainer = options.scrollContainer ?? null;

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
    // While the reading view covers the list there is nothing to paint:
    // skip the rebuild so the frozen rows keep valid layout geometry (used
    // to restore highlight and scroll when the list is shown again) and so
    // navigating while reading costs no native churn. ContentPane calls
    // `refreshVisible()` on the hidden-to-visible transition.
    if (!this.visible) return;
    this.renderCurrent();
  }

  /**
   * Rebuild rows for a visible list and keep the highlight scrolled into
   * view. Called by ContentPane right after it reveals a previously hidden
   * list (same batch, frozen geometry).
   */
  refreshVisible(): void {
    this.renderCurrent();
  }

  private renderCurrent(): void {
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
          this.emptySubtitle.content = sanitizeForTerminal(selectors.searchError);
        } else if (selectors.searchIssues.length > 0) {
          this.emptyTitle.content = 'Query has issues';
          this.emptySubtitle.content = sanitizeForTerminal(
            selectors.searchIssues.map((i) => i.message).join('; ')
          );
        } else {
          this.emptyTitle.content = 'No search results';
          this.emptySubtitle.content = 'Try different terms or operators';
        }
      } else {
        this.emptyTitle.content = 'No emails';
        this.emptySubtitle.content = 'Select a folder or sync to load emails';
      }
      this.lastBuiltEmails = null;
      this.lastPaintedSelected = null;
      return;
    }

    // Selection-only change (same list, same rows, same theme): the live
    // rows already have valid layout, so refresh the offset stash, repaint
    // the old/new highlights in place and follow the highlight. Rebuilding
    // every row per keypress costs O(N) native create/destroy + layout and
    // stalls held-key repeat on long lists; colors mirror `buildItem`.
    if (
      this.lastBuiltEmails === emails &&
      this.lastBuiltTheme === this.theme &&
      this.list.getChildrenCount() === emails.length
    ) {
      this.updateRowOffsets(emails);
      if (selectedId !== this.lastPaintedSelected) {
        if (this.lastPaintedSelected) {
          this.paintRowHighlight(this.lastPaintedSelected, false, emails);
        }
        if (selectedId) {
          this.paintRowHighlight(selectedId, true, emails);
        }
        this.lastPaintedSelected = selectedId ?? null;
      }
      if (!selectedId) {
        this.scrollToTop();
      } else {
        this.ensureSelectedVisible();
      }
      return;
    }

    this.updateRowOffsets(emails);

    // Rebuild list items. `destroyRecursively` (not `remove` + `destroy`)
    // is required: `destroy` detaches children without destroying them,
    // leaking each TextRenderable's native handle. Repeated rebuilds then
    // exhaust the native table and crash with "Failed to create native
    // renderable" on the next navigation keypress.
    const items = this.list.getChildren().slice();
    for (const item of items) {
      item.destroyRecursively();
    }

    for (const email of emails) {
      this.list.add(this.buildItem(email, email.id === selectedId));
    }
    this.lastBuiltEmails = emails;
    this.lastBuiltTheme = this.theme;
    this.lastPaintedSelected = selectedId ?? null;

    if (!selectedId) {
      // Fresh list with no highlight (folder switch, reload): start at top.
      this.scrollToTop();
    } else {
      this.ensureSelectedVisible();
    }
    // Otherwise (unknown geometry): leave the viewport alone.
  }

  /**
   * Keep stashed per-row content offsets current while live rows have
   * valid layout. Content offset = laid-out y minus viewport origin plus
   * applied scroll (the space `scrollChildIntoView` uses), stable across
   * rebuilds of identical content. Zero-height rows have no layout yet
   * (hidden list, or a second refresh pass in one batch) and must not
   * overwrite the stash.
   */
  private updateRowOffsets(emails: readonly PersistedEmail[]): void {
    const box = this.scrollContainer;
    const viewport = box?.viewport;
    const viewportHeight = viewport?.height ?? 0;
    const viewportTop = viewport?.y ?? 0;
    const viewportWidth = viewport?.width ?? 0;
    if (
      this.lastRowOffsets &&
      (this.lastRowOffsets.emails !== emails || this.lastRowOffsets.width !== viewportWidth)
    ) {
      // New list content or a resized viewport: offsets may have shifted
      // (subject wrapping changes row heights), so re-measure below.
      this.lastRowOffsets = null;
    }
    if (box && viewportHeight > 0 && !this.lastRowOffsets) {
      const live = this.list.getChildren();
      const first = live[0];
      if (first && first.height > 0) {
        const byId = new Map<string, { offset: number; height: number }>();
        for (const child of live) {
          if (!child.id.startsWith('email-item-')) continue;
          byId.set(child.id.slice('email-item-'.length), {
            offset: child.y - viewportTop + box.scrollTop,
            height: child.height,
          });
        }
        this.lastRowOffsets = { emails, width: viewportWidth, byId };
      }
    }
  }

  /**
   * Keep the highlighted row scrolled into view using stashed content
   * offsets. Safe to call redundantly and from layout-driven callbacks:
   * unknown geometry leaves the viewport alone. Besides state updates,
   * ContentPane invokes this after content size changes (fresh metrics),
   * covering reveals from hidden and resizes.
   */
  ensureSelectedVisible(): void {
    if (!this.visible) return;
    const box = this.scrollContainer;
    if (!box) return;
    const viewportHeight = box.viewport.height;
    if (viewportHeight <= 0) return;
    const selectedId = selectors.selectedEmailId;
    if (!selectedId) return;
    const table = this.lastRowOffsets;
    if (!table || table.width !== box.viewport.width) return;
    const entry = table.byId.get(selectedId);
    if (!entry) return;
    this.scrollContentOffsetIntoView(entry.offset, entry.height);
  }

  /**
   * Keep a content offset visible with the smallest scroll adjustment.
   * Content coordinates are independent of viewport origin and scroll
   * clamps. No-op without a container or usable viewport.
   */
  private scrollContentOffsetIntoView(offset: number, height: number): void {
    const box = this.scrollContainer;
    if (!box) return;
    const viewportHeight = box.viewport.height;
    if (viewportHeight <= 0) return;
    // Assign directly without clamping against `scrollHeight`: it can be
    // stale mid-rebuild or after hidden layouts (which collapse content
    // metrics and would clamp a correct value down). The layout pass
    // re-clamps against real metrics when content genuinely shrinks.
    const current = box.scrollTop;
    if (offset < current) {
      box.scrollTop = Math.max(0, offset);
    } else if (offset + height > current + viewportHeight) {
      box.scrollTop = offset + height - viewportHeight;
    }
  }

  private scrollToTop(): void {
    const box = this.scrollContainer;
    if (!box) return;
    box.scrollTop = 0;
  }

  /**
   * Repaint one row's highlight in place (background + sender color),
   * mirroring `buildItem`. Used for selection-only changes so held-key
   * navigation never rebuilds rows.
   */
  private paintRowHighlight(
    emailId: string,
    isSelected: boolean,
    emails: readonly PersistedEmail[]
  ): void {
    const item = this.list.getChildren().find((c) => c.id === `email-item-${emailId}`) as
      | BoxRenderable
      | undefined;
    if (!item) return;
    item.backgroundColor = isSelected ? this.theme.surfaceHover : 'transparent';
    const email = emails.find((e) => e.id === emailId);
    const from = item.findDescendantById(`email-item-from-${emailId}`) as unknown as
      | TextRenderable
      | undefined;
    if (from && email) {
      from.fg = isSelected
        ? this.theme.textPrimary
        : email.isRead
          ? this.theme.textSecondary
          : this.theme.textPrimary;
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
    // Sender names/addresses and subjects are remote content: strip
    // terminal control bytes before rendering (see terminal.ts).
    const from = new TextRenderable(this.ctx, {
      id: `email-item-from-${email.id}`,
      content: sanitizeForTerminal(email.fromAddresses.map((a) => a.name || a.address).join(', ')),
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
      // Fixed date column: long sender names clip instead of pushing the
      // date off-screen.
      flexShrink: 0,
      paddingLeft: 1,
    });
    header.add(from);
    header.add(date);

    const subject = new TextRenderable(this.ctx, {
      id: `email-item-subject-${email.id}`,
      content: sanitizeForTerminal(email.subject) || '(no subject)',
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
