/**
 * B9 — `before:YYYY-MM-DD` must cover the complete calendar day.
 *
 * Service-level regression (repository operators unchanged):
 *  - after: remains inclusive at start of day
 *  - before: covers through 23:59:59
 *  - same-day after:X before:X represents the whole day
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

function makeMessage(over: Partial<SyncMessage> & { internalDate?: Date }): SyncMessage {
  const uid = over.uid ?? 1;
  return {
    uid,
    messageId: `<msg-${uid}@example.com>`,
    folder: 'INBOX',
    accountId: 'work',
    from: [],
    to: [],
    cc: [],
    subject: `msg-${uid}`,
    date: new Date('2026-03-15T10:00:00Z'),
    internalDate: new Date('2026-03-15T10:00:00Z'),
    receivedAt: new Date('2026-03-15T10:00:05Z'),
    isRead: false,
    isFlagged: false,
    isAnswered: false,
    isDraft: false,
    size: 100,
    textBody: 'body',
    hasHtmlBody: false,
    attachments: [],
    flags: [],
    ...over,
  } as SyncMessage;
}

describe('B9 before: day semantics (service level)', () => {
  let testDbPath: string;
  let testConfigPath: string;
  let service: SearchService;
  let messageRepo: MessageRepository;

  beforeEach(async () => {
    resetDatabase();
    resetConfigStore();
    testConfigPath = join(tmpdir(), `termail-b9-${Date.now()}-${Math.random()}-config.json`);
    testDbPath = join(tmpdir(), `termail-b9-${Date.now()}-${Math.random()}.sqlite`);
    const configStore = getConfigStore(testConfigPath);
    await configStore.initialize();
    await configStore.updateConfig({ database: { path: testDbPath } } as Partial<AppConfig>);
    const db = getDatabase(configStore.getConfig());
    await db.initialize();
    messageRepo = new MessageRepository(db);
    service = new SearchService(db);

    // Day under test: 2026-03-15. Seed boundary times + next-day exclusion.
    messageRepo.upsertMessages(baseAccount, inboxFolder, [
      makeMessage({ uid: 1, subject: 'midnight', internalDate: new Date('2026-03-15T00:00:00Z') }),
      makeMessage({ uid: 2, subject: 'midday', internalDate: new Date('2026-03-15T12:00:00Z') }),
      makeMessage({
        uid: 3,
        subject: 'end-of-day',
        internalDate: new Date('2026-03-15T23:59:59Z'),
      }),
      makeMessage({
        uid: 4,
        subject: 'next-day-midnight',
        internalDate: new Date('2026-03-16T00:00:00Z'),
      }),
      makeMessage({ uid: 5, subject: 'prev-day', internalDate: new Date('2026-03-14T23:59:59Z') }),
    ]);
  });

  afterEach(() => {
    resetDatabase();
    resetConfigStore();
    for (const p of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`, testConfigPath]) {
      if (existsSync(p)) rmSync(p);
    }
  });

  it('before-date includes midnight', () => {
    const r = service.searchParsed({ text: '', before: '2026-03-15' });
    expect(r.hits.map((h) => h.email.subject)).toContain('midnight');
  });

  it('before-date includes midday', () => {
    const r = service.searchParsed({ text: '', before: '2026-03-15' });
    expect(r.hits.map((h) => h.email.subject)).toContain('midday');
  });

  it('before-date includes 23:59:59', () => {
    const r = service.searchParsed({ text: '', before: '2026-03-15' });
    expect(r.hits.map((h) => h.email.subject)).toContain('end-of-day');
  });

  it('before-date excludes next-day midnight', () => {
    const r = service.searchParsed({ text: '', before: '2026-03-15' });
    expect(r.hits.map((h) => h.email.subject)).not.toContain('next-day-midnight');
  });

  it('same-day after:X before:X represents the whole day', () => {
    const r = service.searchParsed({ text: '', after: '2026-03-15', before: '2026-03-15' });
    const subjects = r.hits.map((h) => h.email.subject).sort();
    expect(subjects).toEqual(['end-of-day', 'midday', 'midnight'].sort());
  });

  it('after remains inclusive at start of day and through 23:59:59', () => {
    const r = service.searchParsed({ text: '', after: '2026-03-15' });
    const subjects = r.hits.map((h) => h.email.subject);
    // Includes start-of-day and end-of-day on the after date, plus later.
    expect(subjects).toContain('midnight');
    expect(subjects).toContain('midday');
    expect(subjects).toContain('end-of-day');
    expect(subjects).toContain('next-day-midnight');
    // Excludes strictly earlier.
    expect(subjects).not.toContain('prev-day');
  });
});
