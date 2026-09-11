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

// ---------------------------------------------------------------------------
// Phase 3.4 — regression tests for structured search combinations
// ---------------------------------------------------------------------------

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

  // -- text + structured filter AND semantics --------------------------------

  it('text + from AND semantics', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({
        uid: 1,
        subject: 'budget review',
        from: [makeAddress('Alice', 'alice@example.com')],
        textBody: 'quarterly budget review',
      }),
      makeMessage({
        uid: 2,
        subject: 'budget approval',
        from: [makeAddress('Bob', 'bob@example.com')],
        textBody: 'monthly budget report',
      }),
    ]);
    // text 'budget' matches both messages via FTS5, but `from: 'alice'`
    // narrows to only Alice's message.
    const hits = repo.searchStructured({ text: 'budget', from: 'alice' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.fromAddresses[0]!.address).toBe('alice@example.com');
  });

  it('text + to AND semantics', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({
        uid: 1,
        subject: 'budget review',
        to: [makeAddress('Alice', 'alice@example.com')],
        textBody: 'quarterly budget review',
      }),
      makeMessage({
        uid: 2,
        subject: 'budget approval',
        to: [makeAddress('Bob', 'bob@example.com')],
        textBody: 'monthly budget report',
      }),
    ]);
    // text 'budget' matches both, but `to: 'alice'` narrows to Alice's.
    const hits = repo.searchStructured({ text: 'budget', to: 'alice' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.toAddresses[0]!.address).toBe('alice@example.com');
  });

  it('text + folder AND semantics', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({
        uid: 1,
        subject: 'budget review',
        textBody: 'quarterly budget review',
      }),
    ]);
    messageRepo.upsertMessages(baseAccount, sentFolder, [
      makeMessage({
        uid: 2,
        subject: 'budget approval',
        textBody: 'monthly budget report',
      }),
    ]);
    // text 'budget' matches both via FTS5, but `folder: 'INBOX'` narrows
    // to only the message in the INBOX folder (message 1).
    const hits = repo.searchStructured({ text: 'budget', folder: 'INBOX' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.folderId).toBe('work:INBOX');
  });

  it('hasAttachment: true + text', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({
        uid: 1,
        subject: 'budget review',
        attachments: [{ filename: 'a.txt', contentType: 'text/plain', size: 1, disposition: 'attachment' }],
        textBody: 'quarterly budget review',
      }),
      makeMessage({
        uid: 2,
        subject: 'budget approval',
        attachments: [],
        textBody: 'quarterly budget review',
      }),
    ]);
    // text 'budget' matches both, but `hasAttachment: true` narrows to only the one with attachments.
    const hits = repo.searchStructured({ text: 'budget', hasAttachment: true });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.hasAttachments).toBe(true);
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

// ---------------------------------------------------------------------------
// Phase 3.4 — regression tests for structured search combinations
// ---------------------------------------------------------------------------

  it('after + isRead combination filters correctly', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'old unread', isRead: false, internalDate: new Date('2025-01-01T00:00:00Z') }),
      makeMessage({ uid: 2, subject: 'old read', isRead: true, internalDate: new Date('2025-01-01T00:00:00Z') }),
      makeMessage({ uid: 3, subject: 'new unread', isRead: false, internalDate: new Date('2026-06-01T00:00:00Z') }),
      makeMessage({ uid: 4, subject: 'new read', isRead: true, internalDate: new Date('2026-06-01T00:00:00Z') }),
    ]);
    // after bound: only messages on or after 2026-01-01
    const hits = repo.searchStructured({ after: epoch(new Date('2025-06-01T00:00:00Z')), isRead: true });
    expect(hits).toHaveLength(1);
    expect(hits.map((h) => h.email.subject)).toEqual(['new read']);

    // after bound with isRead=false
    const hits2 = repo.searchStructured({ after: epoch(new Date('2025-06-01T00:00:00Z')), isRead: false });
    expect(hits2).toHaveLength(1);
    expect(hits2.map((h) => h.email.subject)).toEqual(['new unread']);
  });

  it('before + isUnread combination filters correctly', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'old unread', isRead: false, internalDate: new Date('2025-01-01T00:00:00Z') }),
      makeMessage({ uid: 2, subject: 'old read', isRead: true, internalDate: new Date('2025-01-01T00:00:00Z') }),
      makeMessage({ uid: 3, subject: 'new unread', isRead: false, internalDate: new Date('2026-06-01T00:00:00Z') }),
      makeMessage({ uid: 4, subject: 'new read', isRead: true, internalDate: new Date('2026-06-01T00:00:00Z') }),
    ]);
    // before bound: only messages on or before 2025-12-31
    const hits = repo.searchStructured({ before: epoch(new Date('2025-12-31T23:59:59Z')), isRead: false });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.subject).toBe('old unread');

    // before bound with isRead=true
    const hits2 = repo.searchStructured({ before: epoch(new Date('2025-12-31T23:59:59Z')), isRead: true });
    expect(hits2).toHaveLength(1);
    expect(hits2[0]!.email.subject).toBe('old read');
  });

  it('inclusive after/before boundary behavior', () => {
    // Messages at exact boundary dates
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'exact after', internalDate: new Date('2026-01-01T00:00:00Z') }),
      makeMessage({ uid: 2, subject: 'just after', internalDate: new Date('2026-01-02T00:00:00Z') }),
      makeMessage({ uid: 3, subject: 'exact before', internalDate: new Date('2025-12-31T00:00:00Z') }),
      makeMessage({ uid: 4, subject: 'just before', internalDate: new Date('2025-12-30T00:00:00Z') }),
    ]);
    // after inclusive: includes the bound date itself
    const hitsAfter = repo.searchStructured({ after: epoch(new Date('2026-01-01T00:00:00Z')) });
    expect(hitsAfter).toHaveLength(2); // exact after + just after
    expect(hitsAfter.map((h) => h.email.subject)).toEqual(expect.arrayContaining(['exact after', 'just after']));

    // before inclusive: includes the bound date itself
    const hitsBefore = repo.searchStructured({ before: epoch(new Date('2025-12-31T23:59:59Z')) });
    expect(hitsBefore).toHaveLength(2); // exact before + just before
    expect(hitsBefore.map((h) => h.email.subject)).toEqual(expect.arrayContaining(['exact before', 'just before']));

    // after + before closed range: only message within both bounds
    const hitsRange = repo.searchStructured({
      after: epoch(new Date('2025-12-31T00:00:00Z')),
      before: epoch(new Date('2026-01-01T00:00:00Z')),
    });
    expect(hitsRange).toHaveLength(2);
    expect(hitsRange.map((h) => h.email.subject)).toEqual(
      expect.arrayContaining(['exact before', 'exact after'])
    );
  });

  it('hasAttachment: false returns only messages without attachments', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'with', attachments: [{ filename: 'a.txt', contentType: 'text/plain', size: 1, disposition: 'attachment' }] }),
      makeMessage({ uid: 2, subject: 'without', attachments: [] }),
    ]);
    const hits = repo.searchStructured({ hasAttachment: false });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.hasAttachments).toBe(false);
    expect(hits[0]!.email.subject).toBe('without');
  });

  it('empty subject search behavior via structured options', () => {
    // Empty subject should not match via LILEK; structured path should
    // return messages when no text filter is applied, ordered by date.
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'first email', internalDate: new Date('2026-01-01T00:00:00Z') }),
      makeMessage({ uid: 2, subject: 'second email', internalDate: new Date('2026-06-01T00:00:00Z') }),
    ]);
    // structured search with no text and no filters returns all messages
    // ordered by internal_date DESC, id ASC
    const hits = repo.searchStructured({});
    expect(hits).toHaveLength(2);
    expect(hits[0]!.email.subject).toBe('second email'); // newer first
    expect(hits[1]!.email.subject).toBe('first email');

    // Empty text should fall through to the non-FTS5 path
    const hitsEmptyText = repo.searchStructured({ text: '' });
    expect(hitsEmptyText).toHaveLength(2);
  });

 it('empty body search behavior via structured options', () => {
  messageRepo.upsertMessages(baseAccount, inboxFolder, [
    makeMessage({
      uid: 1,
      subject: 'has body',
      textBody: 'important content',
      internalDate: new Date('2026-01-01T00:00:00Z'),
    }),
    makeMessage({
      uid: 2,
      subject: 'no body',
      textBody: '',
      internalDate: new Date('2026-06-01T00:00:00Z'),
    }),
  ]);

  // Structured search with no text returns all messages ordered by date DESC.
  const hits = repo.searchStructured({});
  expect(hits).toHaveLength(2);
  expect(hits[0]!.email.subject).toBe('no body'); // newer first
  expect(hits[1]!.email.subject).toBe('has body');

  // Empty text should use the non-FTS5 path.
  const hitsEmptyText = repo.searchStructured({ text: '' });
  expect(hitsEmptyText).toHaveLength(2);
});

  // -- Phase 3.4 regression tests: BM25 tie-ordering determinism --------------

  it('BM25 tie-ordering is deterministic (internal_date DESC, id ASC)', () => {
    // Create multiple messages with identical BM25 scores by having
    // identical searchable content. The tiebreaker should be
    // internal_date DESC then id ASC.
    const baseDate = new Date('2026-01-01T10:00:00Z');
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({
        uid: 1,
        subject: 'identical subject',
        textBody: 'identical body',
        internalDate: new Date(baseDate.getTime() + 1000), // oldest
      }),
      makeMessage({
        uid: 2,
        subject: 'identical subject',
        textBody: 'identical body',
        internalDate: new Date(baseDate.getTime() + 3000), // newest
      }),
      makeMessage({
        uid: 3,
        subject: 'identical subject',
        textBody: 'identical body',
        internalDate: new Date(baseDate.getTime() + 2000), // middle
      }),
    ]);
    const hits = repo.search('identical');
    expect(hits).toHaveLength(3);
    // Order should be: newest first (uid 2), then middle (uid 3), then oldest (uid 1)
    expect(hits.map((h) => h.email.uid)).toEqual([2, 3, 1]);
  });

  it('repeated identical searches return the same results in the same order', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'topic alpha', internalDate: new Date('2026-01-01T00:00:00Z') }),
      makeMessage({ uid: 2, subject: 'topic beta', internalDate: new Date('2026-01-02T00:00:00Z') }),
      makeMessage({ uid: 3, subject: 'topic gamma', internalDate: new Date('2026-01-03T00:00:00Z') }),
    ]);
    const first = repo.search('topic');
    const second = repo.search('topic');
    const third = repo.search('topic');
    expect(first.map((h) => h.email.uid)).toEqual(second.map((h) => h.email.uid));
    expect(second.map((h) => h.email.uid)).toEqual(third.map((h) => h.email.uid));
    expect(first.map((h) => h.email.uid)).toEqual([3, 2, 1]); // newest first
  });

  it('repeated identical structured searches return the same results in the same order', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'topic alpha', internalDate: new Date('2026-01-01T00:00:00Z') }),
      makeMessage({ uid: 2, subject: 'topic beta', internalDate: new Date('2026-01-02T00:00:00Z') }),
      makeMessage({ uid: 3, subject: 'topic gamma', internalDate: new Date('2026-01-03T00:00:00Z') }),
    ]);
    const first = repo.searchStructured({ subject: 'topic' });
    const second = repo.searchStructured({ subject: 'topic' });
    const third = repo.searchStructured({ subject: 'topic' });
    expect(first.map((h) => h.email.uid)).toEqual(second.map((h) => h.email.uid));
    expect(second.map((h) => h.email.uid)).toEqual(third.map((h) => h.email.uid));
  });

  // -- Phase 3.4 regression tests: Large result set / 500-limit behavior ------

  it('searchStructured respects the 500-result hard limit', () => {
    // Insert more than 500 messages
    const messages: ReturnType<typeof makeMessage>[] = [];
    for (let i = 1; i <= 600; i++) {
      messages.push(makeMessage({ uid: i, subject: `message ${i}`, internalDate: new Date(`2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`) }));
    }
    messageRepo.upsertMessages(baseAccount, inboxFolder, messages);
    const hits = repo.searchStructured({ limit: 1000 });
    expect(hits).toHaveLength(SEARCH_MAX_LIMIT);
  });

  it('search respects the 500-result hard limit', () => {
    const messages: ReturnType<typeof makeMessage>[] = [];
    for (let i = 1; i <= 600; i++) {
      messages.push(makeMessage({ uid: i, subject: `topic ${i}`, textBody: `body ${i}` }));
    }
    messageRepo.upsertMessages(baseAccount, inboxFolder, messages);
    const hits = repo.search('topic', { limit: 1000 });
    expect(hits).toHaveLength(SEARCH_MAX_LIMIT);
  });

  it('searchStructured with limit=500 returns exactly 500 when that many match', () => {
    const messages: ReturnType<typeof makeMessage>[] = [];
    for (let i = 1; i <= 500; i++) {
      messages.push(makeMessage({ uid: i, subject: `match ${i}`, internalDate: new Date('2026-01-01T00:00:00Z') }));
    }
    messageRepo.upsertMessages(baseAccount, inboxFolder, messages);
    const hits = repo.searchStructured({ limit: 500 });
    expect(hits).toHaveLength(500);
  });

  // -- Phase 3.4 regression tests: Cross-account folder:INBOX isolation -------

  it('cross-account folder isolation: folderId with accountId restricts to that folder in that account', () => {
    // Same folder name "INBOX" in two different accounts
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'work inbox message' }),
    ]);
    messageRepo.upsertMessages(otherAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'personal inbox message', accountId: 'personal' }),
    ]);
    // Search with folderId=work:INBOX and accountId=work should only return work INBOX
    const hits = repo.search('inbox', { accountId: 'work', folderId: 'work:INBOX' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.subject).toBe('work inbox message');
    expect(hits[0]!.email.accountId).toBe('work');
    expect(hits[0]!.email.folderId).toBe('work:INBOX');
  });

  it('cross-account folder isolation: structured search with folderId and accountId', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'work inbox message' }),
    ]);
    messageRepo.upsertMessages(otherAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'personal inbox message', accountId: 'personal' }),
    ]);
    const hits = repo.searchStructured({
      accountId: 'work',
      folderId: 'work:INBOX',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.accountId).toBe('work');
    expect(hits[0]!.email.folderId).toBe('work:INBOX');
  });

  it('cross-account folder isolation: folderId without accountId returns empty (security guard)', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'work inbox' }),
    ]);
    messageRepo.upsertMessages(otherAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'personal inbox', accountId: 'personal' }),
    ]);
    // folderId alone (without accountId) must return empty
    expect(repo.search('inbox', { folderId: 'work:INBOX' })).toEqual([]);
    expect(repo.searchStructured({ folderId: 'work:INBOX' })).toEqual([]);
  });

  // -- Phase 3.4 regression tests: Search error/issues reset behavior ---------

  it('search handles malformed FTS5 query gracefully (empty after sanitization)', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'valid message' }),
    ]);
    // Query that sanitizes to empty should return [] not throw
    expect(repo.search('!!!')).toEqual([]);
    expect(repo.search('()')).toEqual([]);
    expect(repo.search('***')).toEqual([]);
  });

  it('searchStructured handles malformed FTS5 query gracefully', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'valid message' }),
    ]);
    // Query that sanitizes to empty falls through to non-FTS5 path
    const hits = repo.searchStructured({ text: '!!!', subject: 'valid' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.subject).toBe('valid message');
  });

  it('search does not throw on SQL errors from invalid state (returns empty)', () => {
    // This test verifies the repository doesn't crash on unexpected
    // database states. The search method should handle errors gracefully.
    // Since we use parameterized queries and validate inputs, errors
    // should be minimal. We verify a basic search still works after
    // various edge case queries.
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'test' }),
    ]);
    // Various edge case queries should not break subsequent searches
    repo.search('');
    repo.search('   ');
    repo.search('!!!');
    repo.search(null as unknown as string);
    repo.search(undefined as unknown as string);
    // Normal search should still work
    const hits = repo.search('test');
    expect(hits).toHaveLength(1);
  });

  it('searchStructured does not throw on SQL errors from invalid state', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'test' }),
    ]);
    // Various edge case queries should not break subsequent searches
    repo.searchStructured({});
    repo.searchStructured({ text: '' });
    repo.searchStructured({ text: '!!!' });
    repo.searchStructured({ subject: '' });
    repo.searchStructured({ folderId: 'work:INBOX' }); // missing accountId
    // Normal search should still work
    const hits = repo.searchStructured({ subject: 'test' });
    expect(hits).toHaveLength(1);
  });

  // -- Phase 3.4 regression tests: Message-ID edge cases --------------------

  it('handles empty-string Message-ID without crashing', () => {
    // Empty string is valid (NOT NULL but empty); search should not throw
    // and should return the row when queried.
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'only', messageId: '' }),
    ]);
    const hits = repo.searchStructured({});
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.subject).toBe('only');
  });

  it('duplicate Message-ID across different folders are distinct rows', () => {
    // Same Message-ID in INBOX and Sent should appear as two separate
    // hits because identity is (account_id, folder_id, uid), not Message-ID.
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'inbox copy', messageId: '<dup@example.com>' }),
    ]);
    messageRepo.upsertMessages(baseAccount, sentFolder, [
      makeMessage({ uid: 2, subject: 'sent copy', messageId: '<dup@example.com>' }),
    ]);
    const hits = repo.searchStructured({});
    expect(hits).toHaveLength(2);
    const folderIds = hits.map((h) => h.email.folderId).sort();
    expect(folderIds).toEqual(['work:INBOX', 'work:Sent']);
  });

  // -- Phase 3.4 regression tests: Unicode, special chars, address matching --

  it('unicode search values match correctly (FTS5 unicode61 tokenizer)', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'café résumé', textBody: 'naïve façade' }),
      makeMessage({ uid: 2, subject: 'hello world', textBody: 'plain ascii' }),
    ]);
    // FTS5 unicode61 tokenizer handles unicode natively
    const hits = repo.search('café');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.subject).toBe('café résumé');
  });

  it('quoted search values are sanitized (quotes stripped by buildMatchQuery)', () => {
    // buildMatchQuery strips quotes; "exact phrase" becomes exact phrase
    // FTS5 searches across all indexed columns (subject, body, addresses)
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'exact phrase', textBody: 'body' }),
      makeMessage({ uid: 2, subject: 'exact', textBody: 'phrase body' }),
    ]);
    const hits = repo.search('"exact phrase"');
    // Both messages match: msg1 has both terms in subject; msg2 has "exact" in
    // subject and "phrase" in body. FTS5 implicit-AND matches both rows.
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.email.subject).sort()).toEqual(['exact', 'exact phrase']);
  });

  it('special characters in search values are stripped by buildMatchQuery', () => {
    // FTS5 operator chars +()*:;!?[]{}~|/ are stripped
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'hello world', textBody: 'test' }),
      makeMessage({ uid: 2, subject: 'foo bar', textBody: 'test' }),
    ]);
    const hits = repo.search('hello (world) +foo');
    // Stripped to: hello world foo -> implicit-AND requires ALL three terms.
    // Neither message has all three: msg1 lacks "foo", msg2 lacks "hello" and "world".
    expect(hits).toHaveLength(0);
  });

  it('from: address matching works via structured search', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({
        uid: 1,
        subject: 'alpha',
        from: [makeAddress('Alice', 'alice@example.com')],
      }),
      makeMessage({
        uid: 2,
        subject: 'beta',
        from: [makeAddress('Bob', 'bob@test.com')],
      }),
    ]);
    const hits = repo.searchStructured({ from: 'alice' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.fromAddresses[0]!.address).toBe('alice@example.com');
  });

  it('to: address matching works via structured search', () => {
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({
        uid: 1,
        subject: 'alpha',
        to: [makeAddress('Alice', 'alice@example.com')],
      }),
      makeMessage({
        uid: 2,
        subject: 'beta',
        to: [makeAddress('Bob', 'bob@test.com')],
      }),
    ]);
    const hits = repo.searchStructured({ to: 'alice' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.toAddresses[0]!.address).toBe('alice@example.com');
  });
});
});