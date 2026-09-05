/**
 * Phase 3.1 — `SearchRepository`.
 *
 * Thin data-access layer for the local full-text search backend.
 * Wraps the SQLite FTS5 virtual table `emails_fts` (defined in
 * `schema.ts` and rebuilt with the `cc_addresses` column in
 * `migrations/v3.sql.ts`) and exposes a single `search()` method
 * that returns ranked matches.
 *
 * The FTS5 contract in this phase:
 *   - Five indexed columns: `subject`, `body_text`, `from_addresses`,
 *     `to_addresses`, `cc_addresses`. `message_id` is `UNINDEXED`.
 *   - The default `unicode61` tokenizer splits tokens on whitespace,
 *     punctuation, and characters such as `@`, `*`, `:`, `(`, `)`.
 *   - The standard FTS5 implicit-AND: `alice example` matches rows
 *     that contain both `alice` AND `example`.
 *   - Quoted phrase: `"alice@example.com"` matches the literal
 *     sequence. Because `unicode61` also splits on `@`, the
 *     unquoted form already tokenizes to `alice` AND `example` AND
 *     `com` — quoted is a stricter match.
 *
 * Security / parameter binding:
 *   - All SQL is parameterized. The user-supplied query string is
 *     sanitized into FTS5 MATCH syntax by `buildMatchQuery` and
 *     bound at call time via `Statement.all(...)`. No string
 *     concatenation reaches the SQL.
 *
 * Ranking:
 *   - `bm25(emails_fts)` returns a relevance score; lower is better.
 *     The repository sorts ascending on `bm25` so the most relevant
 *     row comes first.
 *
 * Scoping:
 *   - The caller may scope the search to one `accountId` and / or
 *     one `folderId` (the local `${accountId}:${path}` id). When
 *     no scope is given, the search runs across every persisted
 *     email in the database.
 *
 * Limits:
 *   - Default cap is 50. The hard maximum is 500; values above 500
 *     are clamped. `limit <= 0` is clamped to the default.
 */

import type { Database } from './Database.js';
import { parseAddresses, parseAttachments, parseFlags } from './MessageRepository.js';
import type { PersistedEmail } from './MessageRepository.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Public options for a single `search()` call. */
export interface SearchOptions {
  /**
   * Restrict the search to one account. `undefined` means
   * "any account" (the default).
   */
  accountId?: string;

  /**
   * Restrict the search to one folder. The value is the local
   * folder id (e.g. `work:INBOX`). When set, the repository
   * automatically also matches the given `accountId`; passing
   * only `folderId` without an `accountId` is rejected with an
   * empty result (the `account_id` clause would be empty and
   * the SQL would degrade to a no-op or — worse — match rows
   * the caller did not expect).
   */
  folderId?: string;

  /**
   * Maximum number of results to return. Clamped to
   * `[1, SEARCH_MAX_LIMIT]`. Defaults to `SEARCH_DEFAULT_LIMIT`.
   */
  limit?: number;
}

/** A single search hit, with the BM25 score attached. */
export interface SearchHit {
  /** Relevance score from `bm25(emails_fts)`. Lower is more relevant. */
  score: number;
  /** The full persisted email row. */
  email: PersistedEmail;
}

/** Hard maximum results per query. */
export const SEARCH_MAX_LIMIT = 500;

/** Default result cap when none is supplied. */
export const SEARCH_DEFAULT_LIMIT = 50;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Build the FTS5 MATCH operand from a free-text user query.
 *
 * The contract here is deliberately minimal: we do NOT implement
 * the FTS5 query language (no `NEAR`, no `column:term`, no `^boost`,
 * no quoted phrases, no `OR`). Phase 3.1 is a foundation milestone.
 *
 * Multi-term semantics: the result is the FTS5 "implicit AND"
 * operand — a list of whitespace-separated terms, e.g.
 * `budget review`. FTS5 treats a bare space-separated list as
 * "every term must match", so `budget review` matches a row that
 * contains both words in any order and at any distance. This is
 * exactly what the user expects from a plain-text search box.
 *
 * Per-term safety:
 *   1. Trim and collapse internal whitespace.
 *   2. Strip every FTS5 operator / control character:
 *      `"`, `'`, `(`, `)`, `*`, `:`, `^`, `+`, `,`, `.`,
 *      `;`, `!`, `?`, `[`, `]`, `{`, `}`, `~`, `|`, `&`, `/`, `\`,
 *      and any character that the FTS5 parser treats as syntax.
 *   3. Drop any token that becomes empty after stripping.
 *
 * We deliberately KEEP `-` because the unicode61 tokenizer treats
 * it as a token-internal character (e.g. "hello-world" is one
 * token, not two). Stripping it would make hyphenated words
 * unsearchable, and the FTS5 "NOT" prefix form only kicks in
 * when `-` is the first character of a token — a case we never
 * produce from this sanitizer.
 *
 * An empty or whitespace-only input returns `null` so the caller
 * can short-circuit the SQL and return `[]`. The same is true
 * for an input made up entirely of operator characters.
 *
 * Exported for unit tests.
 */
export function buildMatchQuery(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  // 1. Trim and collapse internal whitespace.
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const collapsed = trimmed.replace(/\s+/g, ' ');

  // 2. Strip FTS5 operator / control characters. The full list of
  //    characters FTS5 treats specially is documented at
  //    https://www.sqlite.org/fts5.html#fts5_strings — we strip
  //    them all defensively. Anything left is a sequence of
  //    unicode61-tokens joined by spaces.
  const stripped = collapsed.replace(/["'()*^:+,.;!?[\]{}~|/\\]/g, ' ');

  // 3. Re-collapse whitespace after stripping and drop empty
  //    tokens. FTS5's implicit-AND treats a whitespace-separated
  //    list of bare terms as "all terms must match", which is
  //    exactly the AND semantics Phase 3.1 requires.
  const tokens = stripped
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;

  return tokens.join(' ');
}

/** Clamp the requested limit to the supported range. */
export function clampLimit(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value) || value <= 0) {
    return SEARCH_DEFAULT_LIMIT;
  }
  if (value > SEARCH_MAX_LIMIT) return SEARCH_MAX_LIMIT;
  return Math.floor(value);
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/**
 * Read-only repository over `emails_fts`. Holds no state beyond
 * a reference to the `Database` (and through it, the underlying
 * `bun:sqlite` connection). One instance is cheap; callers can
 * construct it freely.
 */
export class SearchRepository {
  private readonly database: Database;

  constructor(database: Database) {
    this.database = database;
  }

  /**
   * Run a full-text search and return ranked matches.
   *
   * Behaviour:
   *   - `query` empty / whitespace-only / null  -> `[]` (no SQL).
   *   - All input is sanitized via `buildMatchQuery`; only FTS5-safe
   *     text is bound into the SQL.
   *   - The score column comes from `bm25(emails_fts)`.
   *   - Results are sorted by ascending score (most relevant first).
   *   - The cap is clamped via `clampLimit`.
   *
   * Note: `bm25()` returns a `REAL` value. `bun:sqlite` returns it
   * as a `number` here; we coerce defensively.
   */
  search(query: string | null | undefined, options: SearchOptions = {}): SearchHit[] {
    const match = buildMatchQuery(query);
    if (match === null) return [];

    const limit = clampLimit(options.limit);

    // Build the WHERE clause. We always include `account_id` in the
    // SELECT list so the caller gets a typed `PersistedEmail` back
    // without an extra round-trip. The join is the natural one on
    // `rowid` (FTS5 external-content linkage).
    const params: (string | number)[] = [match];
    let scopeClause = '';
    if (options.accountId !== undefined) {
      scopeClause += ' AND e.account_id = ?';
      params.push(options.accountId);
    }
    if (options.folderId !== undefined) {
      if (options.accountId === undefined) {
        // A folderId without an accountId is rejected: the
        // folderId alone is not unique across accounts, and
        // surfacing rows from the wrong account would be a
        // security bug. We return an empty result.
        return [];
      }
      scopeClause += ' AND e.folder_id = ?';
      params.push(options.folderId);
    }
    params.push(limit);

    const sql = `
      SELECT
        e.id, e.account_id, e.folder_id, e.message_id,
        e.from_addresses, e.to_addresses, e.cc_addresses,
        e.subject, e.date, e.internal_date, e.received_at,
        e.is_read, e.is_flagged, e.is_answered, e.is_draft,
        e.has_attachments, e.size, e.body_text, e.body_html,
        e.headers, e.attachments, e.flags, e.uid,
        e.created_at, e.updated_at,
        bm25(emails_fts) AS score
      FROM emails_fts
      JOIN emails AS e ON e.rowid = emails_fts.rowid
      WHERE emails_fts MATCH ?${scopeClause}
      ORDER BY score ASC
      LIMIT ?
    `;

    type Row = {
      id: string;
      account_id: string;
      folder_id: string;
      message_id: string;
      from_addresses: string;
      to_addresses: string;
      cc_addresses: string;
      subject: string;
      date: number;
      internal_date: number | null;
      received_at: number | null;
      is_read: number;
      is_flagged: number;
      is_answered: number;
      is_draft: number;
      has_attachments: number;
      size: number;
      body_text: string | null;
      body_html: string | null;
      headers: string;
      attachments: string;
      flags: string;
      uid: number | null;
      created_at: number;
      updated_at: number;
      score: number;
    };

    const rows = this.database.query<Row>(sql).all(...params);

    return rows.map((row) => ({
      score: row.score,
      email: {
        id: row.id,
        accountId: row.account_id,
        folderId: row.folder_id,
        messageId: row.message_id,
        fromAddresses: parseAddresses(row.from_addresses) as never,
        toAddresses: parseAddresses(row.to_addresses) as never,
        ccAddresses: parseAddresses(row.cc_addresses) as never,
        subject: row.subject,
        date: row.date,
        internalDate: row.internal_date,
        receivedAt: row.received_at,
        isRead: row.is_read === 1,
        isFlagged: row.is_flagged === 1,
        isAnswered: row.is_answered === 1,
        isDraft: row.is_draft === 1,
        hasAttachments: row.has_attachments === 1,
        size: row.size,
        bodyText: row.body_text,
        bodyHtml: row.body_html,
        headers: row.headers ? safeParseJsonRecord(row.headers) : {},
        attachments: parseAttachments(row.attachments) as never,
        flags: parseFlags(row.flags),
        uid: row.uid,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    }));
  }
}

/** Parse the headers JSON column into a string->string map, tolerating malformed input. */
function safeParseJsonRecord(raw: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}
