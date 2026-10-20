/**
 * IMAP UIDVALIDITY generation tests.
 *
 * A folder's UIDVALIDITY identifies its UID generation. When it changes,
 * UIDs may be reused, so cached rows and the incremental checkpoint from
 * the previous generation must be retired. These tests drive the real
 * `ImapService` through a fake `ImapFlow` client and persist into an
 * isolated SQLite database via the real `SyncService`.
 *
 * No network, no real mailbox, no user credentials or database.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchMessageObject, ImapFlow } from 'imapflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ImapServiceFactory,
  type SyncOutcome,
  SyncService,
} from '../../src/app/services/SyncService.js';
import { getConfigStore, resetConfigStore } from '../../src/core/config/ConfigStore.js';
import { getDatabase, resetDatabase } from '../../src/core/database/Database.js';
import { MessageRepository } from '../../src/core/database/MessageRepository.js';
import { SearchRepository } from '../../src/core/database/SearchRepository.js';
import { ImapService } from '../../src/core/imap/ImapService.js';
import type { ImapFlowFactory } from '../../src/core/imap/types.js';
import type { AccountConfig, AppConfig } from '../../src/core/types/config.js';

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
const sentFolderId = 'work:Sent';

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
    list: vi.fn().mockResolvedValue([
      { path: 'INBOX', delimiter: '/', flags: new Set(['\\Inbox']), specialUse: '\\Inbox' },
      { path: 'Sent', delimiter: '/', flags: new Set(['\\Sent']), specialUse: '\\Sent' },
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

function mailbox(uidValidity: bigint | undefined, uidNext: number, exists = 0, path = 'INBOX') {
  return {
    path,
    delimiter: '/',
    flags: new Set<string>(),
    uidNext,
    uidValidity,
    exists,
  };
}

function rawMessage(
  uid: number,
  subject: string,
  messageId = `<msg-${uid}@example.com>`
): FetchMessageObject {
  return {
    seq: uid,
    uid,
    size: 100,
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
  };
}

describe('SyncService UIDVALIDITY generations', () => {
  let testDbPath = '';
  let testConfigPath = '';
  let fake: FakeImapFlow;
  let database: ReturnType<typeof getDatabase>;
  let repo: MessageRepository;
  let search: SearchRepository;
  let syncService: SyncService;

  beforeEach(async () => {
    resetDatabase();
    resetConfigStore();

    testConfigPath = join(tmpdir(), `termail-uidv-${Date.now()}-${Math.random()}-config.json`);
    testDbPath = join(tmpdir(), `termail-uidv-${Date.now()}-${Math.random()}.sqlite`);

    const store = getConfigStore(testConfigPath);
    await store.initialize();
    await store.updateConfig({ database: { path: testDbPath } } as Partial<AppConfig>);

    database = getDatabase(store.getConfig());
    await database.initialize();
    repo = new MessageRepository(database);
    search = new SearchRepository(database);

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

  /**
   * Answer the next `syncMessages` call with `fetched`, filtering by the
   * requested UID range exactly as a server would.
   */
  async function syncOnce(
    uidValidity: bigint | undefined,
    uidNext: number,
    fetched: FetchMessageObject[],
    folderPath = 'INBOX'
  ): Promise<Extract<SyncOutcome, { kind: 'ok' }>> {
    fake.mailboxOpen.mockResolvedValueOnce(
      mailbox(uidValidity, uidNext, fetched.length, folderPath)
    );
    fake.fetchAll.mockReset();
    fake.fetchAll.mockImplementation(async (range: string) => {
      const [from = 0, to = 0] = range.split(':').map(Number);
      return fetched.filter((m) => m.uid >= from && m.uid <= to);
    });
    const outcome = await syncService.syncAccountFolder(baseAccount, folderPath);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') throw new Error(`unexpected outcome: ${outcome.kind}`);
    return outcome;
  }

  function subjectsIn(folderId: string, accountId = 'work'): string[] {
    return repo.listByFolder(accountId, folderId, 20).map((row) => row.subject);
  }

  function searchSubjects(query: string, accountId = 'work'): string[] {
    return search.search(query, { accountId }).map((hit) => hit.email.subject);
  }

  it('uses the incremental checkpoint and preserves rows when UIDVALIDITY is unchanged', async () => {
    await syncOnce(1n, 3, [rawMessage(1, 'First'), rawMessage(2, 'Second')]);
    expect(repo.getSyncState('work', inboxFolderId)?.uidValidity).toBe('1');
    expect(repo.getSyncState('work', inboxFolderId)?.uidValidityObserved).toBe(true);
    expect(repo.getSyncState('work', inboxFolderId)?.highestUid).toBe(2);

    const second = await syncOnce(1n, 4, [rawMessage(3, 'Third')]);
    expect(fake.fetchAll.mock.calls[0]?.[0]).toBe('3:3');
    expect(second.replacedFolderIds).toEqual([]);

    const state = repo.getSyncState('work', inboxFolderId);
    expect(state?.highestUid).toBe(3);
    expect(state?.uidValidity).toBe('1');
    expect(state?.uidValidityObserved).toBe(true);
    expect(subjectsIn(inboxFolderId).sort()).toEqual(['First', 'Second', 'Third']);
  });

  it('replaces reused UIDs when UIDVALIDITY changes and updates FTS results', async () => {
    await syncOnce(1n, 3, [rawMessage(1, 'Old one'), rawMessage(2, 'Old two')]);
    expect(searchSubjects('Old')).toHaveLength(2);

    const changed = await syncOnce(2n, 3, [rawMessage(1, 'New one'), rawMessage(2, 'New two')]);
    // The old checkpoint (highest 2) must be ignored: a full 1:* scan.
    expect(fake.fetchAll.mock.calls[0]?.[0]).toBe('1:2');
    expect(changed.replacedFolderIds).toEqual([inboxFolderId]);

    const state = repo.getSyncState('work', inboxFolderId);
    expect(state?.highestUid).toBe(2);
    expect(state?.uidValidity).toBe('2');
    expect(state?.uidValidityObserved).toBe(true);
    expect(subjectsIn(inboxFolderId).sort()).toEqual(['New one', 'New two']);
    expect(searchSubjects('Old')).toHaveLength(0);
    expect(searchSubjects('New').sort()).toEqual(['New one', 'New two']);
  });

  it('deletes stale old-generation rows even when the new UIDs are numerically higher', async () => {
    await syncOnce(1n, 3, [rawMessage(1, 'Old low'), rawMessage(2, 'Old low two')]);
    expect(subjectsIn(inboxFolderId).sort()).toEqual(['Old low', 'Old low two']);

    await syncOnce(2n, 11, [rawMessage(10, 'New high')]);
    expect(fake.fetchAll.mock.calls[0]?.[0]).toBe('1:10');

    expect(subjectsIn(inboxFolderId)).toEqual(['New high']);
    const state = repo.getSyncState('work', inboxFolderId);
    expect(state?.highestUid).toBe(10);
    expect(state?.uidValidity).toBe('2');
  });

  it('retires an unverified legacy checkpoint with a full scan and replacement', async () => {
    await syncOnce(1n, 2, [rawMessage(1, 'Verified')]);

    // Simulate a pre-v6 row: generation never observed, stale checkpoint,
    // including a legacy NULL-UID row whose generation cannot be verified.
    database
      .query(
        `UPDATE folder_sync_state
            SET highest_uid = 50, uid_validity = NULL, uid_validity_observed = 0
          WHERE account_id = 'work' AND folder_id = 'work:INBOX'`
      )
      .run();
    database
      .query(
        `INSERT INTO emails (id, account_id, folder_id, message_id, subject, date, body_text)
         VALUES ('legacy-null-uid', 'work', 'work:INBOX', '<legacy@example.com>',
                 'Legacy null uid', 1, 'legacy body')`
      )
      .run();

    const outcome = await syncOnce(7n, 3, [rawMessage(1, 'Fresh generation')]);
    // The stale highest_uid = 50 must not be used as a sinceUid.
    expect(fake.fetchAll.mock.calls[0]?.[0]).toBe('1:2');
    expect(outcome.replacedFolderIds).toEqual([inboxFolderId]);

    const state = repo.getSyncState('work', inboxFolderId);
    expect(state?.highestUid).toBe(2);
    expect(state?.uidValidity).toBe('7');
    expect(state?.uidValidityObserved).toBe(true);
    expect(subjectsIn(inboxFolderId)).toEqual(['Fresh generation']);
    expect(database.query('SELECT 1 FROM emails WHERE id = ?').get('legacy-null-uid')).toBeNull();
  });

  it('records an unavailable observation once and then syncs incrementally', async () => {
    const first = await syncOnce(undefined, 2, [rawMessage(1, 'First')]);
    expect(first.replacedFolderIds).toEqual([]);
    let state = repo.getSyncState('work', inboxFolderId);
    expect(state?.uidValidity).toBeNull();
    expect(state?.uidValidityObserved).toBe(true);
    expect(state?.highestUid).toBe(1);

    // The previous observation was NULL (not "never observed"), so the
    // checkpoint is usable and must NOT trigger another replacement.
    const second = await syncOnce(undefined, 4, [rawMessage(2, 'Second')]);
    expect(fake.fetchAll.mock.calls[0]?.[0]).toBe('2:3');
    expect(second.replacedFolderIds).toEqual([]);
    state = repo.getSyncState('work', inboxFolderId);
    expect(state?.uidValidity).toBeNull();
    expect(state?.uidValidityObserved).toBe(true);
    expect(state?.highestUid).toBe(3);
    expect(subjectsIn(inboxFolderId).sort()).toEqual(['First', 'Second']);
  });

  it('resyncs safely across valid → unavailable → valid transitions', async () => {
    await syncOnce(5n, 3, [rawMessage(1, 'Valid one'), rawMessage(2, 'Valid two')]);

    const becameUnavailable = await syncOnce(undefined, 2, [rawMessage(1, 'Unavailable one')]);
    expect(fake.fetchAll.mock.calls[0]?.[0]).toBe('1:1');
    expect(becameUnavailable.replacedFolderIds).toEqual([inboxFolderId]);
    expect(subjectsIn(inboxFolderId)).toEqual(['Unavailable one']);
    expect(repo.getSyncState('work', inboxFolderId)?.uidValidity).toBeNull();
    expect(repo.getSyncState('work', inboxFolderId)?.uidValidityObserved).toBe(true);

    const becameAvailable = await syncOnce(5n, 3, [
      rawMessage(1, 'Valid again'),
      rawMessage(2, 'Valid again two'),
    ]);
    expect(fake.fetchAll.mock.calls[0]?.[0]).toBe('1:2');
    expect(becameAvailable.replacedFolderIds).toEqual([inboxFolderId]);
    expect(subjectsIn(inboxFolderId).sort()).toEqual(['Valid again', 'Valid again two']);
    expect(repo.getSyncState('work', inboxFolderId)?.uidValidity).toBe('5');
  });

  it('clears stale rows and stores highest_uid = 0 when the new generation is empty', async () => {
    await syncOnce(1n, 3, [rawMessage(1, 'Old one'), rawMessage(2, 'Old two')]);
    expect(repo.getSyncState('work', inboxFolderId)?.highestUid).toBe(2);

    const outcome = await syncOnce(2n, 1, []);
    expect(fake.fetchAll).not.toHaveBeenCalled();
    expect(outcome.replacedFolderIds).toEqual([inboxFolderId]);

    const state = repo.getSyncState('work', inboxFolderId);
    expect(state?.highestUid).toBe(0);
    expect(state?.uidValidity).toBe('2');
    expect(state?.uidValidityObserved).toBe(true);
    expect(subjectsIn(inboxFolderId)).toEqual([]);
  });

  it('retains rows, checkpoint, and generation when the fetch fails', async () => {
    await syncOnce(1n, 3, [rawMessage(1, 'Old one'), rawMessage(2, 'Old two')]);

    fake.mailboxOpen.mockResolvedValueOnce(mailbox(2n, 4, 1));
    fake.fetchAll.mockReset();
    fake.fetchAll.mockRejectedValueOnce(new Error('connection reset'));
    await expect(syncService.syncAccountFolder(baseAccount, 'INBOX')).rejects.toThrow(
      'connection reset'
    );

    const state = repo.getSyncState('work', inboxFolderId);
    expect(state?.highestUid).toBe(2);
    expect(state?.uidValidity).toBe('1');
    expect(state?.uidValidityObserved).toBe(true);
    expect(state?.lastSyncStatus).toBe('error');
    expect(subjectsIn(inboxFolderId).sort()).toEqual(['Old one', 'Old two']);
  });

  it('rolls back the whole replacement when persistence fails', async () => {
    await syncOnce(1n, 3, [rawMessage(1, 'Old one'), rawMessage(2, 'Old two')]);

    database.exec(`
      CREATE TRIGGER force_persistence_failure
      BEFORE INSERT ON emails
      WHEN NEW.uid = 10
      BEGIN
        SELECT RAISE(ABORT, 'forced persistence failure');
      END;
    `);

    fake.mailboxOpen.mockResolvedValueOnce(mailbox(2n, 11, 1));
    fake.fetchAll.mockReset();
    fake.fetchAll.mockImplementation(async () => [rawMessage(10, 'New generation')]);
    await expect(syncService.syncAccountFolder(baseAccount, 'INBOX')).rejects.toThrow(
      /Failed to persist/
    );

    const state = repo.getSyncState('work', inboxFolderId);
    expect(state?.highestUid).toBe(2);
    expect(state?.uidValidity).toBe('1');
    expect(state?.uidValidityObserved).toBe(true);
    expect(state?.lastSyncStatus).toBe('error');
    expect(subjectsIn(inboxFolderId).sort()).toEqual(['Old one', 'Old two']);
  });

  it('replaces only the target folder and account, with FTS deletes', async () => {
    // Another account with a cached row must survive the replacement.
    database.exec(`
      INSERT INTO accounts (id, name, type, email, use_tls, auth_type)
      VALUES ('personal', 'Personal', 'imap', 'p@example.com', 1, 'password');
      INSERT INTO folders (id, account_id, name, full_name, type, delimiter)
      VALUES ('personal:INBOX', 'personal', 'INBOX', 'INBOX', 'inbox', '/');
      INSERT INTO emails (id, account_id, folder_id, message_id, subject, date, body_text, uid)
      VALUES ('personal-old', 'personal', 'personal:INBOX', '<p@example.com>',
              'Personal old', 1, 'personal body', 1);
    `);

    await syncOnce(1n, 2, [rawMessage(1, 'Inbox old')]);
    await syncOnce(1n, 11, [rawMessage(10, 'Sent old')], 'Sent');

    const outcome = await syncOnce(2n, 2, [rawMessage(1, 'Inbox new')]);
    expect(outcome.replacedFolderIds).toEqual([inboxFolderId]);

    expect(subjectsIn(inboxFolderId)).toEqual(['Inbox new']);
    expect(subjectsIn(sentFolderId)).toEqual(['Sent old']);
    expect(subjectsIn('personal:INBOX', 'personal')).toEqual(['Personal old']);

    expect(searchSubjects('Inbox old')).toHaveLength(0);
    expect(searchSubjects('Inbox new')).toEqual(['Inbox new']);
    expect(searchSubjects('Sent old')).toEqual(['Sent old']);
    expect(searchSubjects('Personal old', 'personal')).toEqual(['Personal old']);
  });

  it('passes expectedUidValidity through both orchestration paths', async () => {
    await syncOnce(1n, 3, [rawMessage(1, 'First'), rawMessage(2, 'Second')]);

    const imap = new ImapService(baseAccount, {
      factory: makeImapFactory(fake),
      env: { TERMAIL_WORK_PASSWORD: 'super-secret' },
    });
    const spyService = new SyncService(database, () => imap);
    const spy = vi.spyOn(imap, 'syncMessages');

    fake.mailboxOpen.mockResolvedValueOnce(mailbox(1n, 4, 1));
    fake.fetchAll.mockReset();
    fake.fetchAll.mockImplementation(async () => [rawMessage(3, 'Third')]);
    const bootstrap = await spyService.syncAccount(baseAccount);
    expect(bootstrap.kind).toBe('ok');
    expect(spy.mock.calls[0]?.[1]).toEqual({
      limits: { sinceUid: 2 },
      expectedUidValidity: '1',
    });

    spy.mockClear();
    fake.mailboxOpen.mockResolvedValueOnce(mailbox(1n, 5, 1));
    fake.fetchAll.mockReset();
    fake.fetchAll.mockImplementation(async () => [rawMessage(4, 'Fourth')]);
    const folderOutcome = await spyService.syncAccountFolder(baseAccount, 'INBOX');
    expect(folderOutcome.kind).toBe('ok');
    expect(spy.mock.calls[0]?.[1]).toEqual({
      limits: { sinceUid: 3 },
      expectedUidValidity: '1',
    });
  });
});
