/**
 * Phase 3.1 / 3.3 — `SearchService`.
 *
 * Phase 3.1 introduced this thin orchestrator on top of
 * `SearchRepository`. Phase 3.3 adds a second public method
 * (`searchParsed`) that takes a `ParsedSearchQuery` from the
 * Phase 3.2 parser and routes the structured fields to
 * `SearchRepository.searchStructured`. The original Phase 3.1
 * `search()` method is preserved unchanged for back-compat.
 *
 * Layering reminder:
 *   - The service does NOT touch SQL. It translates a
 *     `ParsedSearchQuery` into `StructuredSearchOptions` and
 *     delegates to the repository. All SQL lives in
 *     `SearchRepository`.
 *   - The service never throws on user input. Repository
 *     errors are caught, logged, and surfaced as an
 *     `{ ok: true, hits: [], limit, error }` response so the
 *     TUI never has to handle a thrown search.
 */

import type { Database } from '../../core/database/Database.js';
import {
  type SearchHit,
  type SearchOptions,
  SearchRepository,
  type StructuredSearchOptions,
  clampLimit,
} from '../../core/database/SearchRepository.js';
import type { ParseIssue } from '../../core/search/SearchQueryParser.js';
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
  /**
   * Optional parser issues (Phase 3.3). Populated by `searchParsed`;
   * always `[]` or absent for the legacy `search` path.
   */
  issues?: ParseIssue[];
  /**
   * Optional error message (Phase 3.3). Populated when the underlying
   * repository threw; the service never throws on user input.
   */
  error?: string;
}

/**
 * Phase 3.3 — input shape for `searchParsed`. Mirrors
 * `ParsedSearchQuery` from the parser, but defined here so the
 * service module is importable from the TUI without pulling in the
 * parser module's full surface.
 */
export interface ParsedSearchRequest {
  /** Free-text remainder (the `text` field from the parser). */
  text: string;
  from?: string;
  to?: string;
  subject?: string;
  folder?: string;
  isUnread?: boolean;
  isRead?: boolean;
  hasAttachment?: boolean;
  /** ISO date `YYYY-MM-DD` (already validated by the parser). */
  after?: string;
  /** ISO date `YYYY-MM-DD` (already validated by the parser). */
  before?: string;
}

/**
 * Service-level facade over `SearchRepository`. The TUI calls
 * `search(request)`; everything else is plumbing.
 */
export class SearchService {
  private readonly repository: SearchRepository;

  constructor(database: Database) {
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

  /**
   * Phase 3.3 — run a structured search.
   *
   * Translates a `ParsedSearchQuery` (or a `ParsedSearchRequest`)
   * into a single `SearchRepository.searchStructured` call. No SQL
   * is constructed here; the service is a pure translator. The
   * repository owns all column names and parameter binding.
   *
   * Behaviour:
   *   - Empty / whitespace `parsed.text` AND no structured fields
   *     -> `{ ok: true, hits: [], limit }` without touching the
   *     database. (The parser already filters out non-meaningful
   *     queries, but the service is defensive.)
   *   - Date fields are converted from `YYYY-MM-DD` to epoch
   *     seconds via `isoDateToEpochSeconds` (already validated by
   *     the parser; the helper is a pure function).
   *   - `isUnread: true` translates to `isRead: false` so the
   *     repository's boolean filter is single-valued.
   *   - The returned `issues` is always an array (empty when the
   *     parser reported no problems).
   *   - Repository errors are caught, logged, and surfaced as
   *     `{ ok: true, hits: [], limit, error: <message>, issues: [] }`
   *     so the TUI never has to handle a thrown search.
   */
  searchParsed(parsed: ParsedSearchRequest, options: SearchOptions = {}): SearchResponse {
    const effectiveLimit = clampLimit(options.limit);

    // Build the structured repository call. Field-by-field copy;
    // no SQL strings, no column names here.
    const structured: StructuredSearchOptions = {
      ...(options.accountId !== undefined ? { accountId: options.accountId } : {}),
      ...(options.folderId !== undefined ? { folderId: options.folderId } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    };

    if (parsed.text.length > 0) {
      structured.text = parsed.text;
    }
    if (parsed.from !== undefined && parsed.from.length > 0) {
      structured.from = parsed.from;
    }
    if (parsed.to !== undefined && parsed.to.length > 0) {
      structured.to = parsed.to;
    }
    if (parsed.subject !== undefined && parsed.subject.length > 0) {
      structured.subject = parsed.subject;
    }
    if (parsed.folder !== undefined && parsed.folder.length > 0) {
      structured.folder = parsed.folder;
    }
    // `isUnread` wins over `isRead` (last valid flag wins, as
    // enforced by the parser; this branch is a defensive fallback).
    if (parsed.isUnread === true) {
      structured.isRead = false;
    } else if (parsed.isRead === true) {
      structured.isRead = true;
    }
    if (parsed.hasAttachment === true) {
      structured.hasAttachment = true;
    }
    if (parsed.after !== undefined) {
      structured.after = isoDateToEpochSeconds(parsed.after);
    }
    if (parsed.before !== undefined) {
      structured.before = isoDateToEpochSeconds(parsed.before);
    }

    // Short-circuit: if there's nothing to ask the repository,
    // return immediately without SQL.
    const hasAnyFilter =
      structured.text !== undefined ||
      structured.subject !== undefined ||
      structured.from !== undefined ||
      structured.to !== undefined ||
      structured.folder !== undefined ||
      structured.isRead !== undefined ||
      structured.hasAttachment !== undefined ||
      structured.after !== undefined ||
      structured.before !== undefined;
    if (!hasAnyFilter) {
      return { ok: true, hits: [], limit: effectiveLimit, issues: [] };
    }

    try {
      const hits = this.repository.searchStructured(structured);
      return { ok: true, hits, limit: effectiveLimit, issues: [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Structured search failed; returning empty result', { error: message });
      return { ok: true, hits: [], limit: effectiveLimit, issues: [], error: message };
    }
  }
}

/**
 * Convert a `YYYY-MM-DD` string to epoch seconds (UTC midnight).
 *
 * The parser already validates the format and that the date is
 * real, so this helper does NOT re-validate. It is a pure
 * function exported for unit tests.
 */
export function isoDateToEpochSeconds(iso: string): number {
  const [y, m, d] = iso.split('-').map((n) => Number.parseInt(n, 10));
  // Defensive defaults; the parser would never have let an invalid
  // string through.
  const yy = y ?? 1970;
  const mm = m ?? 1;
  const dd = d ?? 1;
  return Math.floor(Date.UTC(yy, mm - 1, dd) / 1000);
}
