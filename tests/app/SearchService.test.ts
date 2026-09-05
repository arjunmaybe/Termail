/**
 * Phase 3.1 — `SearchService` tests.
 *
 * Coverage:
 *   - Empty / whitespace request -> empty hits without SQL.
 *   - Non-empty request delegates to the repository.
 *   - accountId / folderId / limit pass-through.
 *   - Repository errors are caught and surfaced as an empty
 *     hit list (the service never throws on user input).
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SearchService } from '../../src/app/services/SearchService.js';
import { getConfigStore, resetConfigStore } from '../../src/core/config/ConfigStore.js';
import { getDatabase, resetDatabase } from '../../src/core/database/Database.js';
import { MessageRepository } from '../../src/core/database/MessageRepository.js';
import type { SafeAccountInput } from '../../src/core/database/MessageRepository.js';
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
} from '../../src/core/database/SearchRepository.js';
import type { SyncFolder } from '../../src/core/imap/folders.js';
import type { SyncMessage } from '../../src/core/imap/types.js';
import type { AppConfig } from '../../src/core/types/config.js';

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

function makeMessage(over: Partial<SyncMessage> = {}): SyncMessage {
  const uid = over.uid ?? 1;
  return {
    uid,
    messageId: `<msg-${uid}@example.com>`,
    folder: 'INBOX',
    accountId: 'work',
    from: [],
    to: [],
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
    textBody: 'body',
    hasHtmlBody: false,
    attachments: [],
    flags: [],
    ...over,
  };
}

describe('SearchService', () => {
  let testDbPath: string;
  let testConfigPath: string;
  let service: SearchService;
  let configStore: ReturnType<typeof getConfigStore>;
  let db: ReturnType<typeof getDatabase>;
  let messageRepo: MessageRepository;

  beforeEach(async () => {
    resetDatabase();
    resetConfigStore();
    testConfigPath = join(tmpdir(), `termail-ssvc-${Date.now()}-${Math.random()}-config.json`);
    testDbPath = join(tmpdir(), `termail-ssvc-${Date.now()}-${Math.random()}.sqlite`);

    configStore = getConfigStore(testConfigPath);
    await configStore.initialize();
    await configStore.updateConfig({ database: { path: testDbPath } } as Partial<AppConfig>);

    db = getDatabase(configStore.getConfig());
    await db.initialize();
    messageRepo = new MessageRepository(db);
    service = new SearchService(db);

    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'Quarterly budget review' }),
      makeMessage({ uid: 2, subject: 'Lunch tomorrow?' }),
    ]);
  });

  afterEach(() => {
    resetDatabase();
    resetConfigStore();
    for (const p of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`, testConfigPath]) {
      if (existsSync(p)) rmSync(p);
    }
  });

  it('returns empty hits for an empty query', () => {
    const result = service.search({ query: '' });
    expect(result.ok).toBe(true);
    expect(result.hits).toEqual([]);
    expect(result.limit).toBe(SEARCH_DEFAULT_LIMIT);
  });

  it('returns empty hits for a whitespace-only query', () => {
    const result = service.search({ query: '   \n\t  ' });
    expect(result.ok).toBe(true);
    expect(result.hits).toEqual([]);
    expect(result.limit).toBe(SEARCH_DEFAULT_LIMIT);
  });

  it('returns ranked hits for a non-empty query', () => {
    const result = service.search({ query: 'budget' });
    expect(result.ok).toBe(true);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.email.subject).toBe('Quarterly budget review');
    expect(result.limit).toBe(SEARCH_DEFAULT_LIMIT);
  });

  it('passes accountId / folderId / limit through to the repository', () => {
    const result = service.search({
      query: 'budget',
      accountId: 'work',
      folderId: 'work:INBOX',
      limit: 10,
    });
    expect(result.ok).toBe(true);
    expect(result.hits).toHaveLength(1);
    expect(result.limit).toBe(10);
  });

  it('clamps an over-large limit', () => {
    const result = service.search({ query: 'budget', limit: 100_000 });
    expect(result.ok).toBe(true);
    expect(result.hits).toHaveLength(1);
    expect(result.limit).toBe(SEARCH_MAX_LIMIT);
  });

  it('does not throw on a malformed query (e.g. only operator chars)', () => {
    expect(() => service.search({ query: '!!!' })).not.toThrow();
    const result = service.search({ query: '!!!' });
    expect(result.ok).toBe(true);
    expect(result.hits).toEqual([]);
    expect(result.limit).toBe(SEARCH_DEFAULT_LIMIT);
  });

  it('returns ok:true even when the underlying database is in a degenerate state', () => {
    // Closing the database forces the next query to fail; the
    // service is required to swallow the error and return an
    // empty result rather than throwing.
    db.close();
    const result = service.search({ query: 'budget' });
    expect(result.ok).toBe(true);
    expect(result.hits).toEqual([]);
    // The error path must also report the effective clamped
    // limit (not `hits.length`, which is 0 here).
    expect(result.limit).toBe(SEARCH_DEFAULT_LIMIT);
  });

  // -- Limit contract -------------------------------------------------

  it('returns the requested effective limit when fewer hits are returned than the limit', () => {
    // The fixture seeds 1 budget-related message. We ask for
    // 50 hits; the service must report `limit = 50`, not 1.
    const result = service.search({ query: 'budget', limit: 50 });
    expect(result.ok).toBe(true);
    expect(result.hits).toHaveLength(1);
    expect(result.limit).toBe(SEARCH_DEFAULT_LIMIT);
  });

  it('uses the default limit when none is requested', () => {
    const result = service.search({ query: 'budget' });
    expect(result.limit).toBe(SEARCH_DEFAULT_LIMIT);
  });

  it('uses the default limit when an explicit zero is requested', () => {
    const result = service.search({ query: 'budget', limit: 0 });
    expect(result.limit).toBe(SEARCH_DEFAULT_LIMIT);
  });

  it('uses the default limit when a negative limit is requested', () => {
    const result = service.search({ query: 'budget', limit: -10 });
    expect(result.limit).toBe(SEARCH_DEFAULT_LIMIT);
  });

  it('uses the default limit when NaN is requested', () => {
    const result = service.search({ query: 'budget', limit: NaN });
    expect(result.limit).toBe(SEARCH_DEFAULT_LIMIT);
  });

  it('clamps an excessively large limit to the maximum', () => {
    const result = service.search({ query: 'budget', limit: 999_999 });
    expect(result.limit).toBe(SEARCH_MAX_LIMIT);
  });

  it('passes an in-range explicit limit through unchanged', () => {
    const result = service.search({ query: 'budget', limit: 7 });
    expect(result.limit).toBe(7);
  });

  it('returns the effective clamped limit for an empty / whitespace query', () => {
    // Even though no SQL runs, the response must report the
    // effective clamped limit so the UI can render the right
    // "showing 0 of N" placeholder.
    const r1 = service.search({ query: '', limit: 25 });
    expect(r1.limit).toBe(25);

    const r2 = service.search({ query: '   ', limit: 0 });
    expect(r2.limit).toBe(SEARCH_DEFAULT_LIMIT);

    const r3 = service.search({ query: '\t\n', limit: 999_999 });
    expect(r3.limit).toBe(SEARCH_MAX_LIMIT);
  });
});
