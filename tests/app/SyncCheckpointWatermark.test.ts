/**
 * Regression tests for the scanned-through UID watermark.
 *
 * A fully successful FETCH over a UID range proves that every UID in that
 * range either produced a message or was expunged. The checkpoint may
 * therefore advance through the range even when no messages were returned.
 * Without this, a 500-UID expunge gap permanently stalls incremental sync.
 *
 * These tests drive the real `ImapService` through a fake `ImapFlow` client
 * and persist into an isolated SQLite database via the real `SyncService`.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchMessageObject, ImapFlow } from 'imapflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ImapServiceFactory, SyncService } from '../../src/app/services/SyncService.js';
import { getConfigStore, resetConfigStore } from '../../src/core/config/ConfigStore.js';
import { getDatabase, resetDatabase } from '../../src/core/database/Database.js';
import { MessageRepository } from '../../src/core/database/MessageRepository.js';
import { ImapService } from '../../src/core/imap/ImapService.js';
import type { ImapFlowFactory } from '../../src/core/imap/types.js';
import type { AccountConfig, AppConfig } from '../../src/core/types/config.js';

// The parser is mocked so a test can force the parse-failure branch without
// depending on mailparser's tolerance for arbitrary bytes.
const simpleParserMock = vi.fn();

vi.mock('mailparser', () => ({
  simpleParser: (...args: unknown[]) => simpleParserMock(...args),
}));

const baseAccount: AccountConfig = {
  id: 'work',
  name: 'Work',
  email: 'me@example.com',
  enabled: true,
  host: 'imap.example.com',
  port: 993,
  useTls: true,
  authType: 'password',
};

const inboxFolderId = 'work:INBOX';

interface FakeImapFlow {
  connect: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  fetchAll: ReturnType<typeof vi.fn>;
  mailboxOpen: ReturnType<typeof vi.fn>;
  mailboxClose: ReturnType<typeof vi.fn>;
}

function makeFake(): FakeImapFlow {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    list: vi
      .fn()
      .mockResolvedValue([
        { path: 'INBOX', delimiter: '/', flags: new Set(['\\Inbox']), specialUse: '\\Inbox' },
      ]),
    fetchAll: vi.fn().mockResolvedValue([]),
    mailboxOpen: vi.fn(),
    mailboxClose: vi.fn().mockResolvedValue(true),
  };
}

function makeImapFactory(fake: FakeImapFlow): ImapFlowFactory {
  return {
    create: () => fake as unknown as ImapFlow,
  };
}

function mailbox(uidNext: number, exists = 0) {
  return {
    path: 'INBOX',
    delimiter: '/',
    flags: new Set<string>(),
    uidNext,
    uidValidity: 1n,
    exists,
  };
}

function rawMessage(
  uid: number,
  subject: string,
  source?: Buffer,
  messageId = `<msg-${uid}@example.com>`
): FetchMessageObject {
  return {
    seq: uid,
    uid,
    size: source?.length ?? 100,
    flags: new Set<string>(),
    envelope: {
      subject,
      messageId,
      from: [{ name: 'Alice', address: 'alice@example.com' }],
      to: [{ address: 'me@example.com' }],
      cc: [],
      date: new Date('2026-01-01T00:00:00Z'),
    },
    internalDate: new Date('2026-01-01T00:00:00Z'),
    ...(source ? { source } : {}),
  };
}

describe('SyncService scanned-through checkpoint', () => {
  let testDbPath = '';
  let testConfigPath = '';
  let fake: FakeImapFlow;
  let database: ReturnType<typeof getDatabase>;
  let repo: MessageRepository;
  let syncService: SyncService;

  beforeEach(async () => {
    resetDatabase();
    resetConfigStore();

    testConfigPath = join(tmpdir(), `termail-watermark-${Date.now()}-${Math.random()}-config.json`);
    testDbPath = join(tmpdir(), `termail-watermark-${Date.now()}-${Math.random()}.sqlite`);

    const store = getConfigStore(testConfigPath);
    await store.initialize();
    await store.updateConfig({ database: { path: testDbPath } } as Partial<AppConfig>);

    database = getDatabase(store.getConfig());
    await database.initialize();
    repo = new MessageRepository(database);

    simpleParserMock.mockReset();
    simpleParserMock.mockImplementation(async (source: Buffer) => {
      if (source.toString().includes('PARSE_FAIL')) {
        throw new Error('simulated parser failure');
      }
      return { text: 'parsed body', html: false, attachments: [] };
    });

    fake = makeFake();
    const imap = new ImapService(baseAccount, {
      factory: makeImapFactory(fake),
      env: { TERMAIL_WORK_PASSWORD: 'super-secret' },
    });
    const factory: ImapServiceFactory = () => imap;
    syncService = new SyncService(database, factory);
  });

  afterEach(() => {
    resetDatabase();
    resetConfigStore();
    for (const p of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`, testConfigPath]) {
      if (p && existsSync(p)) rmSync(p);
    }
  });

  async function syncOnce(uidNext: number, fetched: FetchMessageObject[]): Promise<void> {
    fake.mailboxOpen.mockResolvedValueOnce(mailbox(uidNext, fetched.length));
    // The sync service slices the UID window into 100-message batches, so
    // answer each FETCH according to the requested range.
    fake.fetchAll.mockReset();
    fake.fetchAll.mockImplementation(async (range: string) => {
      const [from = 0, to = 0] = range.split(':').map(Number);
      return fetched.filter((m) => m.uid >= from && m.uid <= to);
    });
    const outcome = await syncService.syncAccountFolder(baseAccount, 'INBOX');
    expect(outcome.kind).toBe('ok');
  }

  it('advances the checkpoint through a successfully scanned empty range', async () => {
    await syncOnce(501, [rawMessage(500, 'seed')]);
    expect(fake.fetchAll.mock.calls[0]?.[0]).toBe('1:100');
    expect(fake.fetchAll.mock.calls.at(-1)?.[0]).toBe('401:500');
    expect(repo.getSyncState('work', inboxFolderId)?.highestUid).toBe(500);

    // UIDs 501-1000 are expunged. The range completes successfully with no
    // messages, but it has been fully scanned through UID 1000.
    await syncOnce(1001, []);
    expect(fake.fetchAll.mock.calls[0]?.[0]).toBe('501:600');
    expect(fake.fetchAll.mock.calls.at(-1)?.[0]).toBe('901:1000');
    expect(repo.getSyncState('work', inboxFolderId)?.highestUid).toBe(1000);
    expect(repo.listByFolder('work', inboxFolderId, 10)).toHaveLength(1);
  });

  it('starts the next sync at 1001 and persists a message at UID 1001', async () => {
    await syncOnce(501, [rawMessage(500, 'seed')]);
    await syncOnce(1001, []);
    expect(repo.getSyncState('work', inboxFolderId)?.highestUid).toBe(1000);

    await syncOnce(1501, [rawMessage(1001, 'new mail')]);
    expect(fake.fetchAll.mock.calls[0]?.[0]).toBe('1001:1100');
    expect(fake.fetchAll.mock.calls.at(-1)?.[0]).toBe('1401:1500');

    const state = repo.getSyncState('work', inboxFolderId);
    expect(state?.highestUid).toBe(1500);

    const rows = repo.listByFolder('work', inboxFolderId, 10);
    expect(rows.map((r) => r.uid)).toContain(1001);
    expect(rows.find((r) => r.uid === 1001)?.subject).toBe('new mail');
  });

  it('persists all distinct UIDs sharing a Message-ID and advances the checkpoint', async () => {
    await syncOnce(501, [rawMessage(500, 'seed')]);
    expect(repo.getSyncState('work', inboxFolderId)?.highestUid).toBe(500);

    // UIDs 501-503 share a Message-ID; 504 is unique and follows them.
    // All four are distinct mailbox entries and must be persisted.
    await syncOnce(505, [
      rawMessage(501, 'first', undefined, '<shared@example.com>'),
      rawMessage(502, 'second', undefined, '<shared@example.com>'),
      rawMessage(503, 'third', undefined, '<shared@example.com>'),
      rawMessage(504, 'later unique', undefined, '<unique@example.com>'),
    ]);

    const state = repo.getSyncState('work', inboxFolderId);
    expect(state?.highestUid).toBe(504);
    expect(state?.lastSyncStatus).toBe('ok');

    const rows = repo.listByFolder('work', inboxFolderId, 10);
    expect(rows.map((r) => r.uid).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      500, 501, 502, 503, 504,
    ]);
    expect(rows.filter((r) => r.messageId === 'shared@example.com')).toHaveLength(3);
  });

  it('rolls back message and checkpoint changes when persistence fails', async () => {
    await syncOnce(501, [rawMessage(500, 'seed')]);
    expect(repo.getSyncState('work', inboxFolderId)?.highestUid).toBe(500);

    database.exec(`
      CREATE TRIGGER force_persistence_failure
      BEFORE INSERT ON emails
      WHEN NEW.uid = 502
      BEGIN
        SELECT RAISE(ABORT, 'forced persistence failure');
      END;
    `);

    fake.mailboxOpen.mockResolvedValueOnce(mailbox(505, 4));
    fake.fetchAll.mockReset();
    fake.fetchAll.mockImplementation(async (range: string) => {
      const [from = 0, to = 0] = range.split(':').map(Number);
      return [
        rawMessage(501, 'first', undefined, '<shared@example.com>'),
        rawMessage(502, 'second', undefined, '<shared@example.com>'),
        rawMessage(503, 'third', undefined, '<shared@example.com>'),
        rawMessage(504, 'later unique', undefined, '<unique@example.com>'),
      ].filter((m) => m.uid >= from && m.uid <= to);
    });

    await expect(syncService.syncAccountFolder(baseAccount, 'INBOX')).rejects.toThrow(
      /Failed to persist/
    );

    const state = repo.getSyncState('work', inboxFolderId);
    expect(state?.highestUid).toBe(500);
    expect(state?.lastSyncStatus).toBe('error');

    const rows = repo.listByFolder('work', inboxFolderId, 10);
    expect(rows.map((r) => r.uid)).toEqual([500]);
  });

  it('does not advance the checkpoint when a fetch fails', async () => {
    await syncOnce(501, [rawMessage(500, 'seed')]);
    expect(repo.getSyncState('work', inboxFolderId)?.highestUid).toBe(500);

    fake.mailboxOpen.mockResolvedValueOnce(mailbox(1001, 0));
    fake.fetchAll.mockReset();
    fake.fetchAll.mockRejectedValueOnce(new Error('connection reset'));
    await expect(syncService.syncAccountFolder(baseAccount, 'INBOX')).rejects.toThrow(
      'connection reset'
    );

    const state = repo.getSyncState('work', inboxFolderId);
    expect(state?.highestUid).toBe(500);
    expect(state?.lastSyncStatus).toBe('error');
    expect(repo.listByFolder('work', inboxFolderId, 10)).toHaveLength(1);
  });

  it('stays a no-op when no UID range was scanned', async () => {
    // Empty mailbox: uidNext=1 means there is no 1:* range to fetch.
    fake.mailboxOpen.mockResolvedValueOnce(mailbox(1, 0));
    const outcome = await syncService.syncAccountFolder(baseAccount, 'INBOX');

    expect(outcome.kind).toBe('ok');
    expect(fake.fetchAll).not.toHaveBeenCalled();
    expect(repo.getSyncState('work', inboxFolderId)).toBeNull();
    expect(repo.listByFolder('work', inboxFolderId, 10)).toEqual([]);
  });

  it('persists an unparseable message and accounts for its UID', async () => {
    await syncOnce(2, [rawMessage(1, 'unparseable', Buffer.from('PARSE_FAIL'))]);

    const rows = repo.listByFolder('work', inboxFolderId, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.uid).toBe(1);
    expect(rows[0]?.subject).toBe('unparseable');
    expect(rows[0]?.bodyText).toBeNull();
    expect(repo.getSyncState('work', inboxFolderId)?.highestUid).toBe(1);
  });
});
