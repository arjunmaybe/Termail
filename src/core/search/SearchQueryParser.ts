/**
 * Phase 3.2 — `SearchQueryParser`.
 *
 * Pure, deterministic, non-throwing parser for the Termail search
 * query language. Phase 3.1 added the FTS5 data layer
 * (`SearchRepository`) and the service (`SearchService`). Phase 3.2
 * adds the parser that turns a free-text query string into a
 * `ParsedSearchQuery` so the execution layer (Phase 3.3+) can pass
 * the structured fields down to the repository.
 *
 * Layering reminder:
 *   - This module is **parser-only**. It does NOT issue SQL, does
 *     NOT touch FTS5, does NOT understand the email schema beyond
 *     the supported operators listed below, and does NOT redact
 *     secrets. It is a pure function: input string -> structured
 *     result + diagnostic issues.
 *   - FTS5 sanitization stays in `SearchRepository.buildMatchQuery`.
 *     The parser preserves the free-text remainder verbatim; the
 *     repository strips FTS5 operator characters before binding.
 *   - The execution layer is responsible for date range
 *     interpretation, address normalization, and folder matching.
 *     The parser only validates shape (`YYYY-MM-DD` and a real
 *     date); it does not perform comparisons.
 *
 * Supported operators (exactly nine, keyword case-insensitive):
 *
 *   - `from:<value>`       string.    Non-empty value preserved.
 *   - `to:<value>`         string.    Non-empty value preserved.
 *   - `subject:<value>`    string.    Non-empty value preserved.
 *                                The parser does NOT implement FTS5
 *                                phrase matching; it just records
 *                                the value. The execution layer
 *                                wraps it in quotes if it needs to.
 *   - `is:read`            boolean.   Sets `isRead = true`.
 *   - `is:unread`          boolean.   Sets `isUnread = true`.
 *                                `is:read` and `is:unread` are
 *                                mutually exclusive; a
 *                                contradiction is reported as a
 *                                `'contradictory-flag'` issue and
 *                                the last valid flag wins.
 *   - `has:attachment`     boolean.   Sets `hasAttachment = true`.
 *                                The only value accepted is the
 *                                literal string `attachment`;
 *                                anything else is an
 *                                `'invalid-flag'` issue.
 *   - `folder:<value>`     string.    Non-empty value preserved
 *                                verbatim. No whitelist, no enum;
 *                                the execution layer is responsible
 *                                for case-folding and comparison.
 *   - `after:YYYY-MM-DD`   date.      Must be a real Gregorian date.
 *   - `before:YYYY-MM-DD`  date.      Must be a real Gregorian date.
 *
 * Anything outside this nine-keyword set is treated as free text
 * and recorded as an `'unknown-operator'` issue; the keyword AND
 * its value both fall through to free text. `cc:` is intentionally
 * absent in Phase 3.2 and will be added in a later phase if and
 * when it is required.
 *
 * Repeated-operator semantics (single deterministic rule):
 *
 *   1. Last valid value wins for repeated scalar operators.
 *      `from:a from:b` -> `from = "b"`, no issue recorded.
 *      `subject:foo subject:bar` -> `subject = "bar"`, no issue.
 *      `folder:Work folder:Personal` -> `folder = "Personal"`.
 *      `after:2026-01-01 after:2026-02-01` -> `after = "2026-02-01"`.
 *      `before:2026-09-01 before:2026-10-01` -> `before = "2026-10-01"`.
 *   2. Repeated identical boolean operators are idempotent.
 *      `is:unread is:unread` -> `isUnread = true`, no issue.
 *      `has:attachment has:attachment` -> `hasAttachment = true`.
 *   3. Contradictory boolean operators (`is:read` + `is:unread`)
 *      produce a `'contradictory-flag'` issue, and the last valid
 *      flag wins.
 *   4. Invalid boolean flags (`is:something`, `has:something`) are
 *      a separate failure mode. They produce an `'invalid-flag'`
 *      issue, leave the field `undefined`, and discard the value
 *      (it does NOT leak into `text`). A subsequent valid flag
 *      overwrites the field normally.
 *
 * Malformed input is non-throwing. Every problem is returned as a
 * `ParseIssue` record so the UI can render it later. The parser
 * does not raise, does not panic, and does not log.
 *
 * The parser is **pure**: no I/O, no clock, no randomness, no
 * singletons, no globals. Given the same input string it produces
 * the same output and the same issue list every time. (Date
 * validation uses `Date.UTC(...)` which depends only on the input.)
 */

import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Structured representation of a single search query, produced by
 * `parseSearchQuery`. All structured fields are optional; `text` is
 * the free-text remainder that the execution layer (Phase 3.3+) will
 * pass to `SearchRepository.buildMatchQuery`.
 *
 * The parser does NOT perform FTS5 sanitization. Free-text values
 * are preserved verbatim; the repository's `buildMatchQuery` strips
 * FTS5 operator characters before binding.
 */
export interface ParsedSearchQuery {
  /**
   * Whitespace-normalized free-text remainder. The execution layer
   * passes this to `SearchRepository.buildMatchQuery`. The parser
   * does not perform FTS5 sanitization.
   */
  text: string;

  /** `from:<value>` — non-empty value preserved as typed. */
  from?: string;
  /** `to:<value>` — non-empty value preserved as typed. */
  to?: string;
  /**
   * `subject:<value>` — non-empty value preserved as typed. The
   * parser does not implement FTS5 phrase matching; that is the
   * execution layer's job. The parser only records the value.
   */
  subject?: string;

  /** `is:unread` only. Mutually exclusive with `isRead`. */
  isUnread?: boolean;
  /** `is:read` only. Mutually exclusive with `isUnread`. */
  isRead?: boolean;
  /** `has:attachment` only. The only accepted value is `attachment`. */
  hasAttachment?: boolean;

  /**
   * `folder:<value>` — non-empty value preserved verbatim. No
   * whitelist, no enum. Execution is responsible for case-folding
   * and comparison.
   */
  folder?: string;

  /** `after:YYYY-MM-DD` — the value the user typed (validation passed). */
  after?: string;
  /** `before:YYYY-MM-DD` — the value the user typed (validation passed). */
  before?: string;
}

/** Issue categories the parser can surface. */
export type ParseIssueKind =
  /** e.g. `cc:bob` — keyword outside the supported nine-operator set. */
  | 'unknown-operator'
  /** e.g. `from:` with no value following the colon. */
  | 'missing-value'
  /** e.g. `after:not-a-date` — not a real Gregorian date. */
  | 'invalid-date'
  /** e.g. `is:something`, `has:something` — unrecognized boolean. */
  | 'invalid-flag'
  /** e.g. `is:read is:unread` — the user typed both, last valid wins. */
  | 'contradictory-flag'
  /** A quoted string with no closing quote; the rest of input falls through. */
  | 'unclosed-quote'
  /** A quoted string that is empty (e.g. `""` or `''`). */
  | 'empty-quoted-value';

/** A single diagnostic emitted by the parser. */
export interface ParseIssue {
  /** 0-indexed offset into the **trimmed** input where the issue starts. */
  position: number;
  /** The offending token or operator name (e.g. `from`, `is`, `""`). */
  token: string;
  /** Human-readable, non-secret message. Safe to log. */
  message: string;
  /** Issue category. */
  kind: ParseIssueKind;
}

/** The result returned by `parseSearchQuery`. */
export interface ParseResult {
  /** Structured fields. Always present, possibly with only `text` set. */
  query: ParsedSearchQuery;
  /** Zero or more diagnostic issues, in input order. */
  issues: ParseIssue[];
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface Token {
  /** 0-indexed offset into the **trimmed** input. */
  position: number;
  /** The raw token text (with quotes if it was quoted). */
  raw: string;
  /**
   * The unquoted value. For `from:"alice example"` this is
   * `alice example` (whitespace preserved). For an unquoted token
   * this is the same as `raw`.
   */
  value: string;
  /** Whether the token was a quoted string. */
  quoted: boolean;
  /** For unclosed quotes, marks the token so we can emit a diagnostic. */
  unclosed: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Set of recognized operator keywords (lower-case for case-insensitive lookup). */
const KNOWN_OPERATORS: ReadonlySet<string> = new Set([
  'from',
  'to',
  'subject',
  'is',
  'has',
  'folder',
  'after',
  'before',
]);

/** The exact set of values accepted for the `is:` operator. */
const IS_VALUES: ReadonlySet<string> = new Set(['read', 'unread']);

/** The exact set of values accepted for the `has:` operator. */
const HAS_VALUES: ReadonlySet<string> = new Set(['attachment']);

/**
 * Validate that `s` is a Gregorian calendar date in the form
 * `YYYY-MM-DD` AND that it represents a real date (so e.g.
 * `2026-02-30` is rejected). The parser does not perform timezone
 * conversion; the execution layer is responsible for that.
 */
export function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const parts = s.split('-').map((n) => Number.parseInt(n, 10));
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (
    y === undefined ||
    m === undefined ||
    d === undefined ||
    !Number.isFinite(y) ||
    !Number.isFinite(m) ||
    !Number.isFinite(d) ||
    m < 1 ||
    m > 12 ||
    d < 1 ||
    d > 31
  ) {
    return false;
  }
  // Round-trip through Date.UTC; a malformed date yields NaN.
  const utc = Date.UTC(y, m - 1, d);
  if (Number.isNaN(utc)) return false;
  // Reject silent overflow: e.g. 2026-02-30 -> 2026-03-02.
  const roundtrip = new Date(utc);
  return (
    roundtrip.getUTCFullYear() === y &&
    roundtrip.getUTCMonth() === m - 1 &&
    roundtrip.getUTCDate() === d
  );
}

/**
 * Split the input into tokens. Tokens are either:
 *   - Quoted: `"..."` or `'...'`, including internal whitespace.
 *   - Unquoted: a maximal run of non-whitespace characters.
 *
 * Unclosed quotes are returned as a single token with `unclosed = true`.
 *
 * The input is trimmed of leading and trailing whitespace; positions
 * returned in tokens are relative to the trimmed input.
 */
export function tokenize(input: string): Token[] {
  const out: Token[] = [];
  const len = input.length;
  let i = 0;

  while (i < len) {
    // Skip whitespace.
    while (i < len && /\s/.test(input[i] ?? '')) i++;
    if (i >= len) break;

    const start = i;
    const ch = input[i];

    // Pure quoted string: starts with a quote at the beginning of
    // a token.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const valueStart = i + 1;
      let j = valueStart;
      while (j < len && input[j] !== quote) j++;
      const unclosed = j >= len;
      const value = input.slice(valueStart, unclosed ? j : j);
      const raw = unclosed ? input.slice(start, j) : input.slice(start, j + 1);
      out.push({
        position: start,
        raw,
        value,
        quoted: true,
        unclosed,
      });
      i = unclosed ? j : j + 1;
      continue;
    }

    // Unquoted run, possibly followed by a quoted segment. e.g.
    // `subject:"project meeting"` must be ONE token, not two. The
    // unquoted run consumes the `subject:` prefix, then we see a
    // `"` and switch into quoted mode; the quoted segment is
    // appended to the same token's `raw` and `value`.
    let j = i;
    const rawParts: string[] = [];
    const valueParts: string[] = [];
    let sawQuote = false;
    let anyUnclosed = false;
    // Phase 1: unquoted prefix.
    while (j < len && !/\s/.test(input[j] ?? '')) {
      const c = input[j];
      if (c === '"' || c === "'") {
        // Transition into quoted mode.
        sawQuote = true;
        break;
      }
      rawParts.push(c ?? '');
      valueParts.push(c ?? '');
      j++;
    }
    // Phase 2: optional quoted suffix (only if a quote was seen).
    if (sawQuote) {
      const quote = input[j];
      rawParts.push(quote ?? '');
      const valueStart = j + 1;
      let k = valueStart;
      while (k < len && input[k] !== quote) k++;
      if (k >= len) {
        anyUnclosed = true;
      }
      const quotedValue = input.slice(valueStart, k);
      valueParts.push(quotedValue);
      if (anyUnclosed) {
        rawParts.push(quotedValue);
      } else {
        rawParts.push(input.slice(j, k + 1));
      }
      j = anyUnclosed ? k : k + 1;
    }
    const raw = rawParts.join('');
    const value = valueParts.join('');
    out.push({
      position: start,
      raw,
      value,
      quoted: sawQuote,
      unclosed: anyUnclosed,
    });
    i = j;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Parse a free-text search query into a structured form.
 *
 * The parser is pure, deterministic, and never throws. Issues are
 * returned as data. An empty / whitespace input yields an empty
 * result with no issues.
 *
 * @param raw - The user's query string. `null` and `undefined` are
 *   treated the same as the empty string.
 */
export function parseSearchQuery(raw: string | null | undefined): ParseResult {
  if (raw === null || raw === undefined) {
    return { query: { text: '' }, issues: [] };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { query: { text: '' }, issues: [] };
  }

  const tokens = tokenize(trimmed);
  const query: ParsedSearchQuery = { text: '' };
  const issues: ParseIssue[] = [];
  const textParts: string[] = [];

  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx]!;

    // Quoted string with no closing quote -> unclosed-quote issue, then
    // fall through: the unquoted value becomes a free-text token.
    if (tok.quoted && tok.unclosed) {
      issues.push({
        position: tok.position,
        token: tok.raw,
        message: `Unclosed quoted string starting with ${tok.raw[0] ?? '"'}`,
        kind: 'unclosed-quote',
      });
      // The value (the part after the opening quote) is treated as
      // a single free-text token.
      if (tok.value.length > 0) textParts.push(tok.value);
      continue;
    }

    // Empty quoted string -> empty-quoted-value issue, contributes nothing.
    if (tok.quoted && tok.value.length === 0) {
      issues.push({
        position: tok.position,
        token: tok.raw,
        message: 'Empty quoted string',
        kind: 'empty-quoted-value',
      });
      continue;
    }

    // Detect `<keyword>:<value>` shape. The keyword must be
    // alphanumeric+underscore (so a colon inside a value is not
    // mistakenly taken as an operator). A token like `from` with
    // no colon is free text.
    const colonMatch = /^[A-Za-z_][A-Za-z0-9_]*:(.*)$/.exec(tok.value);
    if (colonMatch === null) {
      // Plain free text.
      textParts.push(tok.value);
      continue;
    }

    // The regex has one capturing group: the value after the colon.
    // The keyword is the literal text matched before the colon. We
    // compute it as a straightforward prefix split because the
    // regex's group 1 is the value (not the keyword).
    const colonIdx = tok.value.indexOf(':');
    const keyword = colonIdx >= 0 ? tok.value.slice(0, colonIdx) : '';
    const value = colonMatch[1] ?? '';

    if (!KNOWN_OPERATORS.has(keyword.toLowerCase())) {
      // Unknown operator -> unknown-operator issue; the whole token
      // (including the colon) falls through to free text.
      issues.push({
        position: tok.position,
        token: tok.raw,
        message: `Unknown operator "${keyword}:"`,
        kind: 'unknown-operator',
      });
      textParts.push(tok.value);
      continue;
    }

    // Known operator. Branch on the keyword.
    const kw = keyword.toLowerCase();

    if (value.length === 0) {
      // `from:` with no value. If a follow-up token exists, we could
      // try to consume it as the value, but that would be ambiguous
      // (`from: to: bob` — is the second `to:` a continuation?).
      // The deterministic rule is: a missing value is a missing
      // value. The keyword is consumed, the value is not.
      issues.push({
        position: tok.position,
        token: tok.raw,
        message: `Operator "${keyword}:" is missing a value`,
        kind: 'missing-value',
      });
      continue;
    }

    switch (kw) {
      case 'from':
        query.from = value;
        break;
      case 'to':
        query.to = value;
        break;
      case 'subject':
        query.subject = value;
        break;
      case 'folder':
        query.folder = value;
        break;
      case 'is': {
        if (!IS_VALUES.has(value.toLowerCase())) {
          issues.push({
            position: tok.position,
            token: tok.raw,
            message: `Invalid value for "is:": expected "read" or "unread", got "${value}"`,
            kind: 'invalid-flag',
          });
          // Discard the value: do not leak it into `text`.
          break;
        }
        const v = value.toLowerCase();
        if (v === 'read') {
          // Contradiction: if the user previously set isUnread, this is
          // a contradictory-flag; last valid flag wins, so isRead
          // overrides. We still need to check the previous state to
          // decide whether to emit the issue.
          if (query.isUnread === true) {
            issues.push({
              position: tok.position,
              token: tok.raw,
              message: 'Both "is:read" and "is:unread" were given; the last valid flag wins',
              kind: 'contradictory-flag',
            });
          }
          query.isRead = true;
          // Only clear isUnread if it was set; leave it undefined
          // when the user never typed the other flag.
          if (query.isUnread !== undefined) query.isUnread = false;
        } else {
          // unread
          if (query.isRead === true) {
            issues.push({
              position: tok.position,
              token: tok.raw,
              message: 'Both "is:read" and "is:unread" were given; the last valid flag wins',
              kind: 'contradictory-flag',
            });
          }
          query.isUnread = true;
          if (query.isRead !== undefined) query.isRead = false;
        }
        break;
      }
      case 'has': {
        if (!HAS_VALUES.has(value.toLowerCase())) {
          issues.push({
            position: tok.position,
            token: tok.raw,
            message: `Invalid value for "has:": expected "attachment", got "${value}"`,
            kind: 'invalid-flag',
          });
          // Discard the value: do not leak it into `text`.
          break;
        }
        query.hasAttachment = true;
        break;
      }
      case 'after': {
        if (!isValidIsoDate(value)) {
          issues.push({
            position: tok.position,
            token: tok.raw,
            message: `Invalid date for "after:": expected YYYY-MM-DD, got "${value}"`,
            kind: 'invalid-date',
          });
          // Discard the value: do not leak it into `text`.
          break;
        }
        query.after = value;
        break;
      }
      case 'before': {
        if (!isValidIsoDate(value)) {
          issues.push({
            position: tok.position,
            token: tok.raw,
            message: `Invalid date for "before:": expected YYYY-MM-DD, got "${value}"`,
            kind: 'invalid-date',
          });
          // Discard the value: do not leak it into `text`.
          break;
        }
        query.before = value;
        break;
      }
      default:
        // Unreachable: KNOWN_OPERATORS is the gating predicate.
        textParts.push(tok.value);
        break;
    }
  }

  query.text = textParts.join(' ').replace(/\s+/g, ' ').trim();

  if (issues.length > 0) {
    logger.debug('SearchQueryParser: emitted issues', { count: issues.length });
  }

  return { query, issues };
}

/**
 * Convenience: parse and drop the issue list. Useful when the
 * caller does not care about diagnostics (e.g. unit tests that
 * only assert on `query`).
 */
export function parseSearchQueryOrEmpty(raw: string | null | undefined): ParsedSearchQuery {
  return parseSearchQuery(raw).query;
}
