/**
 * Phase 3.1 — `SearchService`.
 *
 * Thin orchestrator on top of `SearchRepository`. Mirrors the
 * `SyncService` shape: takes a `Database`, builds a `SearchRepository`
 * internally, and exposes a single public method that the TUI will
 * call from a future "search" view (the UI is not part of this
 * phase). The service is the only thing the TUI is allowed to
 * talk to; it is a no-op for empty / whitespace queries and never
 * throws on user input — it returns an empty result instead.
 *
 * Design notes (Phase 3.1 review):
 *   - No new dependencies, no network calls, no I/O beyond a
 *     single FTS5 query.
 *   - Input is sanitized inside the repository
 *     (`SearchRepository.buildMatchQuery`). This service just
 *     passes the user string through.
 *   - The result shape is identical to the repository's
 *     `SearchHit[]` — there is no transformation step.
 *   - The default `limit` and the hard cap are owned by the
 *     repository (`SEARCH_DEFAULT_LIMIT` / `SEARCH_MAX_LIMIT`).
 *     The service does not redefine them.
 *
 * Out of scope for Phase 3.1 (explicitly deferred):
 *   - Highlighting matched terms in `body_text` / `subject`.
 *   - Snippet extraction (`snippet(emails_fts, ...)`).
 *   - Filters by date, has-attachments, is-read.
 *   - Caching.
 *   - Search history / persistence of recent queries.
 */

import type { Database } from '../../core/database/Database.js';
import {
  clampLimit,
  type SearchHit,
  type SearchOptions,
  SearchRepository,
} from '../../core/database/SearchRepository.js';
import { logger } from '../../core/utils/logger.js';

/** A normalized request: what the TUI actually wants. */
export interface SearchRequest {
  /** Free-text user query. May be empty / whitespace. */
  query: string;
  /** Optional account id scope. */
  accountId?: string;
  /** Optional folder id scope. Requires `accountId`. */
  folderId?: string;
  /** Optional result cap. Clamped by the repository. */
  limit?: number;
}

/** Result of a search invocation. `ok: false` is reserved for future use. */
export interface SearchResponse {
  ok: true;
  /** Ranked hits; empty when the query is empty. */
  hits: SearchHit[];
  /** Echo of the effective limit (after clamping). */
  limit: number;
}

/**
 * Service-level facade over `SearchRepository`. The TUI calls
 * `search(request)`; everything else is plumbing.
 */
export class SearchService {
  private readonly database: Database;
  private readonly repository: SearchRepository;

  constructor(database: Database) {
    this.database = database;
    this.repository = new SearchRepository(database);
  }

  /**
   * Run a search and return ranked hits.
   *
   * An empty / whitespace-only `request.query` returns
   * `{ ok: true, hits: [], limit: <clamped> }` without touching
   * the database. The TUI uses this to render an empty state
   * instead of firing a useless SQL query.
   *
   * Errors from the FTS5 layer (malformed query, db closed, etc.)
   * are caught and logged; an empty hit list is returned so the
   * UI never has to handle a thrown search. Phase 3.1 is the
   * foundation; richer error reporting is a follow-up.
   */
  search(request: SearchRequest): SearchResponse {
    const trimmed = request.query.trim();

    // The effective limit is computed once, up front, and reused
    // for every return path. `clampLimit` is the single source of
    // truth for "what is the user actually asking for" — it
    // substitutes the default for undefined / NaN / zero / negative
    // and clamps overly-large values to `SEARCH_MAX_LIMIT`.
    const effectiveLimit = clampLimit(request.limit);

    if (trimmed.length === 0) {
      return { ok: true, hits: [], limit: effectiveLimit };
    }

    const options: SearchOptions = {
      ...(request.accountId !== undefined ? { accountId: request.accountId } : {}),
      ...(request.folderId !== undefined ? { folderId: request.folderId } : {}),
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
    };

    try {
      const hits = this.repository.search(trimmed, options);
      return { ok: true, hits, limit: effectiveLimit };
    } catch (error) {
      logger.warn('Search failed; returning empty result', { error });
      return { ok: true, hits: [], limit: effectiveLimit };
    }
  }
}
