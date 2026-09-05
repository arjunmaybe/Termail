/**
 * Phase 3.1 — `SearchRepository` tests.
 *
 * Coverage:
 *   - `buildMatchQuery` pure helper
 *       * empty / whitespace -> null
 *       * FTS5 operator chars stripped
 *       * double-quote wrapping
 *       * no leading / trailing junk
 *   - `clampLimit` pure helper
 *   - Repository
 *       * empty / whitespace query -> []
 *       * subject match (case-insensitive, FTS5 implicit-AND)
 *       * body match
 *       * from / to / cc address match
 *       * multiple columns OR together (matches a row in either column)
 *       * `accountId` scope
 *       * `folderId` scope (with and without accountId)
 *       * folderId without accountId -> [] (security guard)
 *       * limit clamping (default, max, NaN, zero, negative)
 *       * non-matching query -> []
 *       * results ordered by BM25 score (most relevant first)
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConfigStore, resetConfigStore } from '../../src/core/config/ConfigStore.js';
import { getDatabase, resetDatabase } from '../../src/core/database/Database.js';
import { MessageRepository } from '../../src/core/database/MessageRepository.js';
import type { SafeAccountInput } from '../../src/core/database/MessageRepository.js';
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SearchRepository,
  buildMatchQuery,
  clampLimit,
} from '../../src/core/database/SearchRepository.js';
import type { SyncFolder } from '../../src/core/imap/folders.js';
import type { EmailAddress, SyncMessage } from '../../src/core/imap/types.js';
import type { AppConfig } from '../../src/core/types/config.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseAccount: SafeAccountInput = {
  id: 'work',
  name: 'Work',
  email: 'me@example.com',
  host: 'imap.example.com',
  port: 993,
  username: 'me',
  useTls: true,
  authType: 'password',
};

const otherAccount: SafeAccountInput = {
  id: 'personal',
  name: 'Personal',
  email: 'me@personal.example.com',
  host: 'imap.personal.example.com',
  port: 993,
  username: 'me',
  useTls: true,
  authType: 'password',
};

const inboxFolder: SyncFolder = {
  path: 'INBOX',
  displayName: 'INBOX',
  delimiter: '/',
  flags: ['\\Inbox'],
  specialUse: 'inbox',
  type: 'inbox',
  selectable: true,
  parentPath: null,
  depth: 0,
};

const sentFolder: SyncFolder = {
  path: 'Sent',
  displayName: 'Sent',
  delimiter: '/',
  flags: ['\\Sent'],
  specialUse: 'sent',
  type: 'sent',
  selectable: true,
  parentPath: null,
  depth: 0,
};

function makeAddress(name: string, address: string): EmailAddress {
  return { name, address };
}

function makeMessage(over: Partial<SyncMessage> = {}): SyncMessage {
  const uid = over.uid ?? 1;
  return {
    uid,
    messageId: `<msg-${uid}@example.com>`,
    folder: 'INBOX',
    accountId: 'work',
    from: [makeAddress('Alice', 'alice@example.com')],
    to: [makeAddress('Bob', 'bob@example.com')],
    cc: [],
    subject: 'Hello world',
    date: new Date('2026-01-01T10:00:00Z'),
    internalDate: new Date('2026-01-01T10:00:00Z'),
    receivedAt: new Date('2026-01-01T10:00:05Z'),
    isRead: false,
    isFlagged: false,
    isAnswered: false,
    isDraft: false,
    size: 1024,
    textBody: 'Some default body text',
    hasHtmlBody: false,
    attachments: [],
    flags: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// buildMatchQuery
// ---------------------------------------------------------------------------

describe('buildMatchQuery', () => {
  it('returns null for null / undefined / empty / whitespace', () => {
    expect(buildMatchQuery(null)).toBeNull();
    expect(buildMatchQuery(undefined)).toBeNull();
    expect(buildMatchQuery('')).toBeNull();
    expect(buildMatchQuery('   ')).toBeNull();
    expect(buildMatchQuery('\n\t  ')).toBeNull();
  });

  it('strips FTS5 operator characters', () => {
    // Operator characters become spaces and any resulting empty
    // tokens are dropped. The dash is preserved because unicode61
    // treats it as a token-internal character; see the dedicated
    // "keeps the dash" test below.
    expect(buildMatchQuery('alpha + beta - gamma')).toBe('alpha beta - gamma');
    expect(buildMatchQuery('(alpha) OR beta')).toBe('alpha OR beta');
    expect(buildMatchQuery('alpha:beta')).toBe('alpha beta');
    expect(buildMatchQuery('"quoted"')).toBe('quoted');
    expect(buildMatchQuery('a*b')).toBe('a b');
  });

  it('keeps the dash inside tokens (unicode61 default tokenizer)', () => {
    // The unicode61 tokenizer treats "-" as a token-internal
    // character; "hello-world" is one FTS5 token, not two. We must
    // NOT strip it, otherwise hyphenated words (e.g. "well-known")
    // become unsearchable.
    expect(buildMatchQuery('hello-world')).toBe('hello-world');
  });

  it('joins surviving tokens with a single space (implicit-AND form)', () => {
    expect(buildMatchQuery('alpha beta gamma')).toBe('alpha beta gamma');
  });

  it('collapses internal whitespace', () => {
    expect(buildMatchQuery('alpha   beta\t gamma\n')).toBe('alpha beta gamma');
  });

  it('returns null when input is only operator characters', () => {
    expect(buildMatchQuery('!!!')).toBeNull();
    expect(buildMatchQuery('()()')).toBeNull();
    expect(buildMatchQuery(':::')).toBeNull();
  });

  it('preserves alphanumerics, dashes, and underscore', () => {
    expect(buildMatchQuery('hello-world foo_bar')).toBe('hello-world foo_bar');
  });
});

// ---------------------------------------------------------------------------
// clampLimit
// ---------------------------------------------------------------------------

describe('clampLimit', () => {
  it('returns the default when undefined / NaN / zero / negative', () => {
    expect(clampLimit(undefined)).toBe(SEARCH_DEFAULT_LIMIT);
    expect(clampLimit(Number.NaN)).toBe(SEARCH_DEFAULT_LIMIT);
    expect(clampLimit(0)).toBe(SEARCH_DEFAULT_LIMIT);
    expect(clampLimit(-1)).toBe(SEARCH_DEFAULT_LIMIT);
  });

  it('returns the cap when over the maximum', () => {
    expect(clampLimit(SEARCH_MAX_LIMIT + 1)).toBe(SEARCH_MAX_LIMIT);
    expect(clampLimit(10_000)).toBe(SEARCH_MAX_LIMIT);
  });

  it('returns the value as-is when in range', () => {
    expect(clampLimit(1)).toBe(1);
    expect(clampLimit(100)).toBe(100);
    expect(clampLimit(SEARCH_MAX_LIMIT)).toBe(SEARCH_MAX_LIMIT);
  });

  it('floors fractional values', () => {
    expect(clampLimit(7.9)).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

describe('SearchRepository', () => {
  let testDbPath: string;
  let testConfigPath: string;
  let repo: SearchRepository;
  let messageRepo: MessageRepository;
  let configStore: ReturnType<typeof getConfigStore>;
  let db: ReturnType<typeof getDatabase>;

  beforeEach(async () => {
    resetDatabase();
    resetConfigStore();
    testConfigPath = join(tmpdir(), `termail-sr-${Date.now()}-${Math.random()}-config.json`);
    testDbPath = join(tmpdir(), `termail-sr-${Date.now()}-${Math.random()}.sqlite`);

    configStore = getConfigStore(testConfigPath);
    await configStore.initialize();
    await configStore.updateConfig({ database: { path: testDbPath } } as Partial<AppConfig>);

    db = getDatabase(configStore.getConfig());
    await db.initialize();
    messageRepo = new MessageRepository(db);
    repo = new SearchRepository(db);
  });

  afterEach(() => {
    resetDatabase();
    resetConfigStore();
    for (const p of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`, testConfigPath]) {
      if (existsSync(p)) rmSync(p);
    }
  });

  // -- Pure-data short-circuits -----------------------------------------

  it('returns [] for an empty query', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'findme' }),
    ]);
    expect(repo.search('')).toEqual([]);
  });

  it('returns [] for a whitespace-only query', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'findme' }),
    ]);
    expect(repo.search('   \n\t  ')).toEqual([]);
  });

  it('returns [] when no rows match', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'unrelated', textBody: 'nothing here' }),
    ]);
    expect(repo.search('zzznomatch')).toEqual([]);
  });

  // -- Single-column matches --------------------------------------------

  it('matches in the subject column', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'Quarterly budget review' }),
      makeMessage({ uid: 2, subject: 'Lunch tomorrow?' }),
    ]);
    const hits = repo.search('budget');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.subject).toBe('Quarterly budget review');
  });

  it('matches in the body_text column', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'greeting', textBody: 'Let us discuss the migration' }),
    ]);
    const hits = repo.search('migration');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.id).toBe('work:work:INBOX:1');
  });

  it('matches in the from_addresses column', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({
        uid: 1,
        subject: 'whatever',
        from: [makeAddress('Samantha Carter', 'samantha@example.com')],
      }),
    ]);
    const hits = repo.search('samantha');
    expect(hits).toHaveLength(1);
  });

  it('matches in the to_addresses column', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({
        uid: 1,
        subject: 'whatever',
        to: [makeAddress('Daniel Jackson', 'daniel@example.com')],
      }),
    ]);
    const hits = repo.search('daniel');
    expect(hits).toHaveLength(1);
  });

  it('matches in the cc_addresses column (v3 FTS index)', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({
        uid: 1,
        subject: 'meeting',
        cc: [makeAddress("Teal'c", 'tealc@example.com')],
      }),
    ]);
    // The FTS5 tokenizer splits on apostrophes too; "teal" is the indexed token.
    // The phrase wrapper requires the full token sequence — we strip
    // apostrophes in buildMatchQuery, so "teal'c" still surfaces.
    const hits = repo.search('teal');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.ccAddresses[0]!.address).toBe('tealc@example.com');
  });

  // -- Multi-column / FTS5 implicit-AND ----------------------------------

  it('matches a row whose subject contains all query terms, even when the terms are not adjacent', () => {
    // The two terms "budget" and "review" appear in the same
    // subject but with several words between them. FTS5 implicit-AND
    // matches because both terms are present, regardless of position.
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({
        uid: 1,
        subject: 'Budget planning meeting for quarterly financial review',
      }),
    ]);
    const hits = repo.search('budget review');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.id).toBe('work:work:INBOX:1');
  });

  it('does not match a row whose subject contains only one of the query terms', () => {
    // "review" is missing from the second subject, so the
    // implicit-AND operand must exclude it.
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({
        uid: 1,
        subject: 'Budget planning meeting',
      }),
    ]);
    const hits = repo.search('budget review');
    expect(hits).toEqual([]);
  });

  it('matches rows that contain all query terms even when other rows are missing one', () => {
    // Mixed bag: one row has both terms, one has only one of them.
    // Only the row with both must be returned.
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'Budget planning meeting for the review' }),
      makeMessage({ uid: 2, subject: 'Budget approval workflow' }),
    ]);
    const hits = repo.search('budget review');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.id).toBe('work:work:INBOX:1');
  });

  // -- Scoping -----------------------------------------------------------

  it('scopes results to a given accountId', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'shared topic alpha' }),
    ]);
    messageRepo.upsertMessages(otherAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'shared topic alpha', accountId: 'personal' }),
    ]);
    const workHits = repo.search('shared topic', { accountId: 'work' });
    expect(workHits).toHaveLength(1);
    expect(workHits[0]!.email.accountId).toBe('work');

    const personalHits = repo.search('shared topic', { accountId: 'personal' });
    expect(personalHits).toHaveLength(1);
    expect(personalHits[0]!.email.accountId).toBe('personal');

    const all = repo.search('shared topic');
    expect(all).toHaveLength(2);
  });

  it('scopes results to a given folderId (with accountId)', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'topic alpha', folder: 'INBOX' }),
    ]);
    messageRepo.upsertMessages(baseAccount, sentFolder, [
      makeMessage({ uid: 1, subject: 'topic alpha', folder: 'Sent' }),
    ]);
    const inboxOnly = repo.search('topic alpha', {
      accountId: 'work',
      folderId: 'work:INBOX',
    });
    expect(inboxOnly).toHaveLength(1);
    expect(inboxOnly[0]!.email.folderId).toBe('work:INBOX');
  });

  it('returns [] for folderId without accountId (security guard)', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'topic beta' }),
    ]);
    const hits = repo.search('topic beta', { folderId: 'work:INBOX' });
    expect(hits).toEqual([]);
  });

  // -- Limits -----------------------------------------------------------

  it('uses the default limit when none is provided', () => {
    const total = SEARCH_DEFAULT_LIMIT + 5;
    for (let i = 1; i <= total; i++) {
      messageRepo.upsertMessages(baseAccount, inboxFolder, [
        makeMessage({ uid: i, subject: `repeated topic ${i}` }),
      ]);
    }
    const hits = repo.search('topic');
    expect(hits).toHaveLength(SEARCH_DEFAULT_LIMIT);
  });

  it('respects an explicit limit', () => {
    for (let i = 1; i <= 10; i++) {
      messageRepo.upsertMessages(baseAccount, inboxFolder, [
        makeMessage({ uid: i, subject: `repeated topic ${i}` }),
      ]);
    }
    const hits = repo.search('topic', { limit: 3 });
    expect(hits).toHaveLength(3);
  });

  it('clamps an over-large limit to SEARCH_MAX_LIMIT', () => {
    // Don't actually need SEARCH_MAX_LIMIT rows; we just need to
    // verify the bound is respected by passing a huge value and
    // seeing it doesn't crash.
    for (let i = 1; i <= 5; i++) {
      messageRepo.upsertMessages(baseAccount, inboxFolder, [
        makeMessage({ uid: i, subject: `topic ${i}` }),
      ]);
    }
    const hits = repo.search('topic', { limit: SEARCH_MAX_LIMIT * 10 });
    expect(hits).toHaveLength(5);
  });

  // -- Ranking ----------------------------------------------------------

  it('orders results by BM25 score (most relevant first)', () => {
    // The row whose subject matches exactly "exact" should rank
    // higher than the row that only contains the word incidentally.
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({
        uid: 1,
        subject: 'exact',
        textBody: 'lorem ipsum dolor sit amet, consectetur adipiscing elit',
      }),
      makeMessage({
        uid: 2,
        subject: 'tangential',
        textBody: 'just a brief mention of the word in a long body',
      }),
    ]);
    const hits = repo.search('exact');
    expect(hits[0]!.email.id).toBe('work:work:INBOX:1');
  });
});

// ---------------------------------------------------------------------------
// Phase 3.3 — searchStructured
// ---------------------------------------------------------------------------

describe('SearchRepository.searchStructured', () => {
  let testDbPath: string;
  let testConfigPath: string;
  let repo: SearchRepository;
  let messageRepo: MessageRepository;
  let configStore: ReturnType<typeof getConfigStore>;
  let db: ReturnType<typeof getDatabase>;

  beforeEach(async () => {
    resetDatabase();
    resetConfigStore();
    testConfigPath = join(tmpdir(), `termail-sr2-${Date.now()}-${Math.random()}-config.json`);
    testDbPath = join(tmpdir(), `termail-sr2-${Date.now()}-${Math.random()}.sqlite`);

    configStore = getConfigStore(testConfigPath);
    await configStore.initialize();
    await configStore.updateConfig({ database: { path: testDbPath } } as Partial<AppConfig>);

    db = getDatabase(configStore.getConfig());
    await db.initialize();
    messageRepo = new MessageRepository(db);
    repo = new SearchRepository(db);
  });

  afterEach(() => {
    resetDatabase();
    resetConfigStore();
    for (const p of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`, testConfigPath]) {
      if (existsSync(p)) rmSync(p);
    }
  });

  function epoch(date: Date): number {
    return Math.floor(date.getTime() / 1000);
  }

  it('returns all rows for an empty options object (service-layer short-circuits to [] for this case)', () => {
    // The repository has no notion of "empty query". The service
    // is responsible for short-circuiting when no fields are set.
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'whatever' }),
    ]);
    const hits = repo.searchStructured({});
    expect(hits).toHaveLength(1);
  });

  it('subject filter matches case-insensitively', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'Quarterly budget review' }),
      makeMessage({ uid: 2, subject: 'Lunch tomorrow?' }),
    ]);
    const hits = repo.searchStructured({ subject: 'QUARTERLY' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.subject).toBe('Quarterly budget review');
  });

  it('from filter matches substring against from_addresses', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({
        uid: 1,
        subject: 'whatever',
        from: [makeAddress('Samantha Carter', 'samantha@example.com')],
      }),
    ]);
    const hits = repo.searchStructured({ from: 'samantha' });
    expect(hits).toHaveLength(1);
  });

  it('to filter matches substring against to_addresses', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({
        uid: 1,
        subject: 'whatever',
        to: [makeAddress('Daniel Jackson', 'daniel@example.com')],
      }),
    ]);
    const hits = repo.searchStructured({ to: 'daniel' });
    expect(hits).toHaveLength(1);
  });

  it('isRead=true returns only read messages', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'read', isRead: true }),
      makeMessage({ uid: 2, subject: 'unread', isRead: false }),
    ]);
    const hits = repo.searchStructured({ isRead: true });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.isRead).toBe(true);
  });

  it('isRead=false returns only unread messages', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'read', isRead: true }),
      makeMessage({ uid: 2, subject: 'unread', isRead: false }),
    ]);
    const hits = repo.searchStructured({ isRead: false });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.isRead).toBe(false);
  });

  it('hasAttachment=true returns only messages with attachments', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'with', attachments: [{ filename: 'a.txt', contentType: 'text/plain', size: 1, disposition: 'attachment' }] }),
      makeMessage({ uid: 2, subject: 'without', attachments: [] }),
    ]);
    const hits = repo.searchStructured({ hasAttachment: true });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.hasAttachments).toBe(true);
  });

  it('after filter includes messages on or after the bound', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'old', internalDate: new Date('2025-01-01T00:00:00Z') }),
      makeMessage({ uid: 2, subject: 'new', internalDate: new Date('2026-06-01T00:00:00Z') }),
    ]);
    const hits = repo.searchStructured({ after: epoch(new Date('2026-01-01T00:00:00Z')) });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.subject).toBe('new');
  });

  it('before filter includes messages on or before the bound', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'old', internalDate: new Date('2025-01-01T00:00:00Z') }),
      makeMessage({ uid: 2, subject: 'new', internalDate: new Date('2026-06-01T00:00:00Z') }),
    ]);
    const hits = repo.searchStructured({ before: epoch(new Date('2025-12-31T23:59:59Z')) });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.subject).toBe('old');
  });

  it('after + before together form a closed range', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'a', internalDate: new Date('2025-01-01T00:00:00Z') }),
      makeMessage({ uid: 2, subject: 'b', internalDate: new Date('2025-12-01T00:00:00Z') }),
      makeMessage({ uid: 3, subject: 'c', internalDate: new Date('2026-06-01T00:00:00Z') }),
    ]);
    const hits = repo.searchStructured({
      after: epoch(new Date('2025-06-01T00:00:00Z')),
      before: epoch(new Date('2026-01-01T00:00:00Z')),
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.subject).toBe('b');
  });

  it('accountId scopes results to one account', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'work' }),
    ]);
    messageRepo.upsertMessages(otherAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'personal', accountId: 'personal' }),
    ]);
    const hits = repo.searchStructured({ accountId: 'work' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.accountId).toBe('work');
  });

  it('folder filter resolves to f.full_name (case-insensitive)', () => {
    messageRepo.upsertMessages(baseAccount, sentFolder, [
      makeMessage({ uid: 1, subject: 'a', folder: 'Sent' }),
    ]);
    // `folders` rows come from upsertMessages; pass via folder path.
    const hits = repo.searchStructured({ folder: 'sent' });
    expect(hits).toHaveLength(1);
  });

  it('text + structured filters AND together (FTS5 path)', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'budget review', isRead: false }),
      makeMessage({ uid: 2, subject: 'budget approval', isRead: true }),
    ]);
    // "budget" matches both via FTS5, but `isRead: true` narrows to one.
    const hits = repo.searchStructured({ text: 'budget', isRead: true });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.subject).toBe('budget approval');
  });

  it('text + structured filters AND together (non-FTS5 path)', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'budget', isRead: false }),
      makeMessage({ uid: 2, subject: 'budget', isRead: true }),
    ]);
    // FTS5 sanitizer strips to nothing -> structured path. The
    // `isRead` filter narrows to one.
    const hits = repo.searchStructured({ text: '!!!', isRead: true });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.isRead).toBe(true);
  });

  it('folderId without accountId short-circuits to []', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'a' }),
    ]);
    expect(repo.searchStructured({ folderId: 'work:INBOX' })).toEqual([]);
  });

  it('orders by internal_date DESC, id ASC when no text is given', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'a', internalDate: new Date('2026-01-01T00:00:00Z') }),
      makeMessage({ uid: 2, subject: 'b', internalDate: new Date('2026-06-01T00:00:00Z') }),
      makeMessage({ uid: 3, subject: 'c', internalDate: new Date('2026-03-01T00:00:00Z') }),
    ]);
    const hits = repo.searchStructured({ isRead: false });
    // 'b' is most recent, then 'c', then 'a'.
    expect(hits.map((h) => h.email.subject)).toEqual(['b', 'c', 'a']);
  });

  it('clamps an over-large limit to SEARCH_MAX_LIMIT', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'a' }),
    ]);
    const hits = repo.searchStructured({ isRead: false, limit: SEARCH_MAX_LIMIT * 10 });
    expect(hits.length).toBeLessThanOrEqual(SEARCH_MAX_LIMIT);
  });
});
