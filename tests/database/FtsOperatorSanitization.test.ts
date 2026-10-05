/**
 * B10 — FTS5 operator sanitization: implicit-AND only.
 *
 * Raw MATCH must never let user input become OR/AND/NOT/NEAR or
 * leading-minus syntax. Internal hyphens are preserved.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConfigStore, resetConfigStore } from '../../src/core/config/ConfigStore.js';
import { getDatabase, resetDatabase } from '../../src/core/database/Database.js';
import { MessageRepository } from '../../src/core/database/MessageRepository.js';
import type { SafeAccountInput } from '../../src/core/database/MessageRepository.js';
import { SearchRepository, buildMatchQuery } from '../../src/core/database/SearchRepository.js';
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
    size: 100,
    textBody: 'Some default body text',
    hasHtmlBody: false,
    attachments: [],
    flags: [],
    ...over,
  };
}

describe('B10 buildMatchQuery operator sanitization', () => {
  it('drops standalone OR', () => {
    expect(buildMatchQuery('alpha OR beta')).toBe('alpha beta');
    expect(buildMatchQuery('alpha or beta')).toBe('alpha beta');
  });

  it('drops standalone AND', () => {
    expect(buildMatchQuery('alpha AND beta')).toBe('alpha beta');
    expect(buildMatchQuery('alpha and beta')).toBe('alpha beta');
  });

  it('drops standalone NOT', () => {
    expect(buildMatchQuery('alpha NOT beta')).toBe('alpha beta');
    expect(buildMatchQuery('alpha not beta')).toBe('alpha beta');
  });

  it('drops standalone NEAR', () => {
    expect(buildMatchQuery('alpha NEAR beta')).toBe('alpha beta');
    expect(buildMatchQuery('alpha near beta')).toBe('alpha beta');
  });

  it('strips leading minus', () => {
    expect(buildMatchQuery('-spam')).toBe('spam');
    expect(buildMatchQuery('alpha -beta')).toBe('alpha beta');
  });

  it('returns null for standalone minus', () => {
    expect(buildMatchQuery('-')).toBeNull();
    expect(buildMatchQuery('  -  ')).toBeNull();
    expect(buildMatchQuery('OR')).toBeNull();
    expect(buildMatchQuery('AND OR NOT NEAR')).toBeNull();
  });

  it('preserves internal hyphens', () => {
    expect(buildMatchQuery('hello-world')).toBe('hello-world');
    expect(buildMatchQuery('well-known fact')).toBe('well-known fact');
  });
});

describe('B10 implicit-AND integration', () => {
  let testDbPath: string;
  let testConfigPath: string;
  let repo: SearchRepository;
  let messageRepo: MessageRepository;

  beforeEach(async () => {
    resetDatabase();
    resetConfigStore();
    testConfigPath = join(tmpdir(), `termail-b10-${Date.now()}-${Math.random()}-config.json`);
    testDbPath = join(tmpdir(), `termail-b10-${Date.now()}-${Math.random()}.sqlite`);
    const configStore = getConfigStore(testConfigPath);
    await configStore.initialize();
    await configStore.updateConfig({ database: { path: testDbPath } } as Partial<AppConfig>);
    const db = getDatabase(configStore.getConfig());
    await db.initialize();
    messageRepo = new MessageRepository(db);
    repo = new SearchRepository(db);
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'Budget planning meeting for quarterly review' }),
      makeMessage({ uid: 2, subject: 'Lunch tomorrow' }),
    ]);
  });

  afterEach(() => {
    resetDatabase();
    resetConfigStore();
    for (const p of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`, testConfigPath]) {
      if (existsSync(p)) rmSync(p);
    }
  });

  it('keeps implicit-AND behavior for ordinary multi-term queries', () => {
    const hits = repo.search('budget review');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.email.subject).toContain('Budget');
  });

  it('does not honor user-supplied OR as an operator', () => {
    // `budget OR lunch` sanitizes to `budget lunch` (implicit AND):
    // neither seeded row contains both terms.
    expect(repo.search('budget OR lunch')).toEqual([]);
  });
});
