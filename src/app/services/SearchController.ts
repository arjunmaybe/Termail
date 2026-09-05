/**
 * Phase 3.3 — `SearchController`.
 *
 * TUI-side orchestrator for search. Owns the input buffer and
 * "search active" flag. On submit, it:
 *
 *   1. Reads the raw query from `selectors.searchQuery`.
 *   2. Calls the Phase 3.2 `parseSearchQuery` (pure).
 *   3. Calls `SearchService.searchParsed` (the only consumer of
 *      the repository's structured path).
 *   4. Dispatches the result into `AppState` via `actions.*` so
 *      the existing components re-render via their state
 *      subscriptions.
 *
 * This class is intentionally small and dependency-light. It does
 * NOT know about:
 *   - SQLite, FTS5, or any SQL strings.
 *   - Column names.
 *   - The OpenTUI renderer.
 *   - Keypresses (the `main.ts` dispatcher owns the keys; this
 *     controller exposes a small, testable surface).
 *
 * The only `Database` reference is passed through to the
 * `SearchService` constructor and held by the service. The
 * controller itself never queries the database.
 */

import type { Database } from '../../core/database/Database.js';
import { SEARCH_DEFAULT_LIMIT } from '../../core/database/SearchRepository.js';
import type { ParseIssue, ParsedSearchQuery } from '../../core/search/SearchQueryParser.js';
import { parseSearchQuery } from '../../core/search/SearchQueryParser.js';
import { actions, selectors } from '../../core/state/AppState.js';
import { logger } from '../../core/utils/logger.js';
import { SearchService } from './SearchService.js';
import type { SearchResponse } from './SearchService.js';

/**
 * Orchestrates a single search interaction. The TUI calls
 * `openSearch / pushChar / popChar / submitSearch / cancelSearch`;
 * the controller dispatches into `AppState` and the
 * `SearchService`. One instance per `App`.
 */
export class SearchController {
  private readonly service: SearchService;

  constructor(database: Database) {
    this.service = new SearchService(database);
  }

  /** Open the search input bar. Clears any prior search state. */
  openSearch(): void {
    actions.setSearchActive(true);
    actions.setSearchQuery('');
    actions.setSearchHits(null);
    actions.setSearchIssues([]);
    actions.setSearchError(null);
  }

  /** Close the search input bar and return to the normal TUI. */
  closeSearch(): void {
    actions.clearSearch();
  }

  /**
   * Append a single character to the input buffer. Does NOT run
   * a search; the TUI only submits on `Enter`.
   */
  pushChar(ch: string): void {
    if (ch.length === 0) return;
    actions.setSearchQuery(selectors.searchQuery + ch);
  }

  /** Remove the last character from the input buffer. No-op when empty. */
  popChar(): void {
    const current = selectors.searchQuery;
    if (current.length === 0) return;
    actions.setSearchQuery(current.slice(0, -1));
  }

  /**
   * Run a search. No-op when the input is empty / whitespace. The
   * parser is non-throwing; the service swallows repository errors
   * and surfaces them as `searchError`. Returns a Promise so the
   * TUI's keypress handler can fire-and-forget.
   */
  async submitSearch(): Promise<void> {
    const raw = selectors.searchQuery;
    if (raw.trim().length === 0) {
      // Empty submit is intentionally a no-op (does not touch the
      // database, does not change searchHits, does not clear prior
      // results — the user might be re-pressing Enter by accident).
      return;
    }

    let parsed: ParsedSearchQuery;
    let issues: ParseIssue[];
    try {
      const result = parseSearchQuery(raw);
      parsed = result.query;
      issues = result.issues;
    } catch (error) {
      // The parser is documented as non-throwing; this is a
      // defense-in-depth branch.
      logger.warn('Search parser threw unexpectedly', { error });
      actions.setSearchIssues([]);
      actions.setSearchError(error instanceof Error ? error.message : String(error));
      actions.setSearchHits([]);
      return;
    }

    // Surface parser issues immediately so the empty-state copy
    // updates even before the repository call returns.
    actions.setSearchIssues(issues);
    actions.setSearchError(null);

    const accountId = selectors.currentAccountId;
    let response: SearchResponse;
    try {
      response = this.service.searchParsed(parsed, {
        ...(accountId !== null ? { accountId } : {}),
        limit: SEARCH_DEFAULT_LIMIT,
      });
    } catch (error) {
      // The service is documented as never throwing on user input;
      // this is a defense-in-depth branch.
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Search service threw unexpectedly', { error: message });
      actions.setSearchError(message);
      actions.setSearchHits([]);
      return;
    }

    // The service already returns `{ ok: true, error? }` on caught
    // errors; mirror that into AppState.
    if (response.error !== undefined) {
      actions.setSearchError(response.error);
      actions.setSearchHits([]);
      return;
    }

    // The repository returned rows; collapse `SearchHit[]` down to
    // `PersistedEmail[]` for the existing `EmailListView`.
    actions.setSearchError(null);
    actions.setSearchHits(response.hits.map((h) => h.email));
  }

  /**
   * Alias for `closeSearch` — used by the keypress handler when
   * the user presses `Escape` from within search.
   */
  cancelSearch(): void {
    this.closeSearch();
  }

  /** Snapshot of the "is search open" flag. */
  isActive(): boolean {
    return selectors.searchActive;
  }
}
