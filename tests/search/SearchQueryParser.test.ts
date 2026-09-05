/**
 * Phase 3.2 — `SearchQueryParser` tests.
 *
 * Coverage:
 *   - Empty / whitespace / null / undefined input.
 *   - Plain free text (one term, multiple terms, punctuation preserved).
 *   - Each of the nine supported operators in isolation:
 *       from:, to:, subject:, is:unread, is:read, has:attachment,
 *       folder:, after:, before:.
 *   - `folder:` accepts any non-empty value (no whitelist):
 *       inbox, Work, Projects/Termail, Archive/2026.
 *   - Quoted values (subject:"project meeting") and plain free-text
 *     quoted strings ("project meeting").
 *   - Case-insensitive keywords (FROM:Alice).
 *   - Whitespace tolerance and trimming.
 *   - Repeated-operator semantics:
 *       * last valid wins for subject:, folder:, after:, before:, from:
 *       * identical booleans are idempotent (is:unread is:unread, has:attachment has:attachment)
 *       * contradictory is:read + is:unread produces a 'contradictory-flag' issue
 *         and the last valid flag wins.
 *   - Malformed input is non-throwing:
 *       * missing value (from:)
 *       * invalid date (after:not-a-date)
 *       * invalid flag (is:something, has:something)
 *       * unknown operator (cc:bob)
 *       * unclosed quote ("foo)
 *       * empty quoted value ("")
 *
 * The parser is pure; there are no fixtures and no DB. Each test
 * asserts on the returned `ParseResult`.
 */

import { describe, expect, it } from 'vitest';
import {
  type ParseIssueKind,
  type ParsedSearchQuery,
  isValidIsoDate,
  parseSearchQuery,
  parseSearchQueryOrEmpty,
} from '../../src/core/search/SearchQueryParser.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convenience: pull the first issue of a given kind (or undefined). */
function issueOf(result: ReturnType<typeof parseSearchQuery>, kind: ParseIssueKind) {
  return result.issues.find((i) => i.kind === kind);
}

/** Convenience: count issues of a given kind. */
function countOf(result: ReturnType<typeof parseSearchQuery>, kind: ParseIssueKind) {
  return result.issues.filter((i) => i.kind === kind).length;
}

// ---------------------------------------------------------------------------
// Empty / null / whitespace
// ---------------------------------------------------------------------------

describe('parseSearchQuery — empty input', () => {
  it('returns an empty query for null', () => {
    const r = parseSearchQuery(null);
    expect(r).toEqual({ query: { text: '' }, issues: [] });
  });

  it('returns an empty query for undefined', () => {
    const r = parseSearchQuery(undefined);
    expect(r).toEqual({ query: { text: '' }, issues: [] });
  });

  it('returns an empty query for the empty string', () => {
    const r = parseSearchQuery('');
    expect(r).toEqual({ query: { text: '' }, issues: [] });
  });

  it('returns an empty query for whitespace', () => {
    const r = parseSearchQuery('   \n\t  ');
    expect(r).toEqual({ query: { text: '' }, issues: [] });
  });

  it('parseSearchQueryOrEmpty matches parseSearchQuery.query', () => {
    expect(parseSearchQueryOrEmpty('')).toEqual({ text: '' });
    expect(parseSearchQueryOrEmpty('meeting')).toEqual({ text: 'meeting' });
  });
});

// ---------------------------------------------------------------------------
// Plain free text
// ---------------------------------------------------------------------------

describe('parseSearchQuery — plain free text', () => {
  it('preserves a single term', () => {
    const r = parseSearchQuery('meeting');
    expect(r.query).toEqual({ text: 'meeting' });
    expect(r.issues).toEqual([]);
  });

  it('preserves multiple terms', () => {
    const r = parseSearchQuery('project meeting');
    expect(r.query).toEqual({ text: 'project meeting' });
    expect(r.issues).toEqual([]);
  });

  it('trims and collapses whitespace', () => {
    const r = parseSearchQuery('  meeting   notes  ');
    expect(r.query).toEqual({ text: 'meeting notes' });
  });

  it('preserves punctuation in free text', () => {
    // The parser does not strip anything. The repository's
    // buildMatchQuery does the FTS5 sanitization later.
    const r = parseSearchQuery('hello, world!');
    expect(r.query.text).toBe('hello, world!');
  });
});

// ---------------------------------------------------------------------------
// Each operator in isolation
// ---------------------------------------------------------------------------

describe('parseSearchQuery — scalar operators', () => {
  it('parses from:', () => {
    const r = parseSearchQuery('from:alice@example.com');
    expect(r.query.from).toBe('alice@example.com');
    expect(r.query.text).toBe('');
    expect(r.issues).toEqual([]);
  });

  it('parses to:', () => {
    const r = parseSearchQuery('to:bob@example.com');
    expect(r.query.to).toBe('bob@example.com');
    expect(r.query.text).toBe('');
    expect(r.issues).toEqual([]);
  });

  it('parses subject: and preserves the value verbatim', () => {
    const r = parseSearchQuery('subject:meeting');
    expect(r.query.subject).toBe('meeting');
    expect(r.query.text).toBe('');
    expect(r.issues).toEqual([]);
  });

  it('parses subject: with internal whitespace via a quoted value', () => {
    const r = parseSearchQuery('subject:"project meeting"');
    expect(r.query.subject).toBe('project meeting');
    expect(r.query.text).toBe('');
    expect(r.issues).toEqual([]);
  });

  it('parses after:YYYY-MM-DD', () => {
    const r = parseSearchQuery('after:2026-01-01');
    expect(r.query.after).toBe('2026-01-01');
    expect(r.query.text).toBe('');
    expect(r.issues).toEqual([]);
  });

  it('parses before:YYYY-MM-DD', () => {
    const r = parseSearchQuery('before:2026-09-01');
    expect(r.query.before).toBe('2026-09-01');
    expect(r.query.text).toBe('');
    expect(r.issues).toEqual([]);
  });
});

describe('parseSearchQuery — boolean operators', () => {
  it('parses is:unread', () => {
    const r = parseSearchQuery('is:unread');
    expect(r.query.isUnread).toBe(true);
    expect(r.query.isRead).toBeUndefined();
    expect(r.query.text).toBe('');
    expect(r.issues).toEqual([]);
  });

  it('parses is:read', () => {
    const r = parseSearchQuery('is:read');
    expect(r.query.isRead).toBe(true);
    expect(r.query.isUnread).toBeUndefined();
    expect(r.query.text).toBe('');
    expect(r.issues).toEqual([]);
  });

  it('parses has:attachment', () => {
    const r = parseSearchQuery('has:attachment');
    expect(r.query.hasAttachment).toBe(true);
    expect(r.query.text).toBe('');
    expect(r.issues).toEqual([]);
  });
});

describe('parseSearchQuery — folder: free-form', () => {
  it('accepts "inbox"', () => {
    const r = parseSearchQuery('folder:inbox');
    expect(r.query.folder).toBe('inbox');
    expect(r.query.text).toBe('');
    expect(r.issues).toEqual([]);
  });

  it('accepts "Work" (mixed case preserved)', () => {
    const r = parseSearchQuery('folder:Work');
    expect(r.query.folder).toBe('Work');
    expect(r.query.text).toBe('');
    expect(r.issues).toEqual([]);
  });

  it('accepts "Projects/Termail" (nested path)', () => {
    const r = parseSearchQuery('folder:Projects/Termail');
    expect(r.query.folder).toBe('Projects/Termail');
    expect(r.query.text).toBe('');
    expect(r.issues).toEqual([]);
  });

  it('accepts "Archive/2026" (custom folder with year)', () => {
    const r = parseSearchQuery('folder:Archive/2026');
    expect(r.query.folder).toBe('Archive/2026');
    expect(r.query.text).toBe('');
    expect(r.issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Combinations
// ---------------------------------------------------------------------------

describe('parseSearchQuery — combinations', () => {
  it('combines subject: with a boolean', () => {
    const r = parseSearchQuery('subject:invoice is:unread');
    expect(r.query.subject).toBe('invoice');
    expect(r.query.isUnread).toBe(true);
    expect(r.query.text).toBe('');
    expect(r.issues).toEqual([]);
  });

  it('combines from: with free text', () => {
    const r = parseSearchQuery('from:alice@example.com meeting');
    expect(r.query.from).toBe('alice@example.com');
    expect(r.query.text).toBe('meeting');
    expect(r.issues).toEqual([]);
  });

  it('combines several operators with a free-text remainder', () => {
    const r = parseSearchQuery(
      'from:alice@example.com subject:"project meeting" is:unread has:attachment folder:Work budget'
    );
    expect(r.query.from).toBe('alice@example.com');
    expect(r.query.subject).toBe('project meeting');
    expect(r.query.isUnread).toBe(true);
    expect(r.query.hasAttachment).toBe(true);
    expect(r.query.folder).toBe('Work');
    expect(r.query.text).toBe('budget');
    expect(r.issues).toEqual([]);
  });

  it('treats a fully-quoted free-text string as a single free-text term', () => {
    const r = parseSearchQuery('"project meeting"');
    expect(r.query.text).toBe('project meeting');
    expect(r.issues).toEqual([]);
  });

  it('is case-insensitive on operator keywords', () => {
    const r = parseSearchQuery('FROM:Alice');
    expect(r.query.from).toBe('Alice');
    expect(r.query.text).toBe('');
    expect(r.issues).toEqual([]);
  });

  it('preserves a trailing punctuation in a value', () => {
    // The parser does not normalize inside values; the execution
    // layer is responsible for that.
    const r = parseSearchQuery('from:alice@example.com!');
    expect(r.query.from).toBe('alice@example.com!');
    expect(r.query.text).toBe('');
    expect(r.issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Repeated-operator semantics
// ---------------------------------------------------------------------------

describe('parseSearchQuery — repeated operators (last valid wins)', () => {
  it('repeated from: keeps the last value', () => {
    const r = parseSearchQuery('from:a from:b');
    expect(r.query.from).toBe('b');
    expect(r.query.text).toBe('');
    expect(r.issues).toEqual([]);
  });

  it('repeated subject: keeps the last value', () => {
    const r = parseSearchQuery('subject:foo subject:bar');
    expect(r.query.subject).toBe('bar');
    expect(r.query.text).toBe('');
    expect(r.issues).toEqual([]);
  });

  it('repeated folder: keeps the last value', () => {
    const r = parseSearchQuery('folder:Work folder:Personal');
    expect(r.query.folder).toBe('Personal');
    expect(r.query.text).toBe('');
    expect(r.issues).toEqual([]);
  });

  it('repeated after: keeps the last value', () => {
    const r = parseSearchQuery('after:2026-01-01 after:2026-02-01');
    expect(r.query.after).toBe('2026-02-01');
    expect(r.query.text).toBe('');
    expect(r.issues).toEqual([]);
  });

  it('repeated before: keeps the last value', () => {
    const r = parseSearchQuery('before:2026-09-01 before:2026-10-01');
    expect(r.query.before).toBe('2026-10-01');
    expect(r.query.text).toBe('');
    expect(r.issues).toEqual([]);
  });

  it('repeated identical is:unread is idempotent', () => {
    const r = parseSearchQuery('is:unread is:unread');
    expect(r.query.isUnread).toBe(true);
    expect(countOf(r, 'contradictory-flag')).toBe(0);
    expect(r.issues).toEqual([]);
  });

  it('repeated identical has:attachment is idempotent', () => {
    const r = parseSearchQuery('has:attachment has:attachment');
    expect(r.query.hasAttachment).toBe(true);
    expect(countOf(r, 'invalid-flag')).toBe(0);
    expect(r.issues).toEqual([]);
  });

  it('contradictory is:read after is:unread emits contradictory-flag, last wins', () => {
    const r = parseSearchQuery('is:read is:unread');
    expect(r.query.isUnread).toBe(true);
    expect(r.query.isRead).toBe(false);
    expect(countOf(r, 'contradictory-flag')).toBe(1);
  });

  it('contradictory is:unread after is:read emits contradictory-flag, last wins', () => {
    const r = parseSearchQuery('is:unread is:read');
    expect(r.query.isRead).toBe(true);
    expect(r.query.isUnread).toBe(false);
    expect(countOf(r, 'contradictory-flag')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Malformed input — non-throwing
// ---------------------------------------------------------------------------

describe('parseSearchQuery — malformed input', () => {
  it('from: with no value is a missing-value issue', () => {
    const r = parseSearchQuery('from:');
    expect(r.query.from).toBeUndefined();
    expect(issueOf(r, 'missing-value')).toBeDefined();
  });

  it('after:not-a-date is an invalid-date issue and the value is not leaked into text', () => {
    const r = parseSearchQuery('after:not-a-date');
    expect(r.query.after).toBeUndefined();
    expect(issueOf(r, 'invalid-date')).toBeDefined();
    expect(r.query.text).toBe('');
  });

  it('is:something is an invalid-flag issue', () => {
    const r = parseSearchQuery('is:something');
    expect(r.query.isUnread).toBeUndefined();
    expect(r.query.isRead).toBeUndefined();
    expect(issueOf(r, 'invalid-flag')).toBeDefined();
    expect(r.query.text).toBe('');
  });

  it('has:something is an invalid-flag issue', () => {
    const r = parseSearchQuery('has:something');
    expect(r.query.hasAttachment).toBeUndefined();
    expect(issueOf(r, 'invalid-flag')).toBeDefined();
    expect(r.query.text).toBe('');
  });

  it('cc:bob is an unknown-operator issue and the token falls through to free text', () => {
    const r = parseSearchQuery('cc:bob@example.com meeting');
    expect(issueOf(r, 'unknown-operator')).toBeDefined();
    expect(r.query.text).toBe('cc:bob@example.com meeting');
  });

  it('"foo (unclosed) is an unclosed-quote issue', () => {
    const r = parseSearchQuery('"foo');
    expect(issueOf(r, 'unclosed-quote')).toBeDefined();
    // The value after the opening quote is preserved as free text.
    expect(r.query.text).toBe('foo');
  });

  it('"" is an empty-quoted-value issue', () => {
    const r = parseSearchQuery('""');
    expect(issueOf(r, 'empty-quoted-value')).toBeDefined();
    expect(r.query.text).toBe('');
  });

  it("'' is an empty-quoted-value issue", () => {
    const r = parseSearchQuery("''");
    expect(issueOf(r, 'empty-quoted-value')).toBeDefined();
    expect(r.query.text).toBe('');
  });

  it('never throws on arbitrary input', () => {
    // Quick sanity sweep: no input should ever throw.
    const samples = [
      '',
      '   ',
      'from:',
      'from: ',
      ':nokeyword',
      'is:',
      'has:',
      'after:',
      'before:',
      'folder:',
      'subject:',
      'to:',
      'cc:',
      'bcc:',
      'is:something has:something after:oops before:meh from: meeting',
      '""""""',
      '""""""""""',
      '"',
      "'",
      "''''''",
      "'''",
    ];
    for (const s of samples) {
      expect(() => parseSearchQuery(s)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Internal helpers (exported for tests)
// ---------------------------------------------------------------------------

describe('isValidIsoDate', () => {
  it('accepts canonical dates', () => {
    expect(isValidIsoDate('2026-01-01')).toBe(true);
    expect(isValidIsoDate('2026-12-31')).toBe(true);
    expect(isValidIsoDate('2000-02-29')).toBe(true); // leap year
  });

  it('rejects malformed strings', () => {
    expect(isValidIsoDate('')).toBe(false);
    expect(isValidIsoDate('2026-1-1')).toBe(false);
    expect(isValidIsoDate('2026/01/01')).toBe(false);
    expect(isValidIsoDate('not-a-date')).toBe(false);
    expect(isValidIsoDate('2026-13-01')).toBe(false);
    expect(isValidIsoDate('2026-00-01')).toBe(false);
    expect(isValidIsoDate('2026-01-32')).toBe(false);
    // Silent overflow: Feb 30 -> Mar 2.
    expect(isValidIsoDate('2026-02-30')).toBe(false);
    // Non-leap-year Feb 29.
    expect(isValidIsoDate('2025-02-29')).toBe(false);
  });
});
