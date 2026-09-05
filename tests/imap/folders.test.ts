/**
 * Tests for IMAP folder synchronization.
 *
 * Pure-function tests cover the synchronization layer directly. One
 * integration test drives `ImapService.syncFolders()` through the same
 * fake factory used in Phase 2.1.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImapFlow } from 'imapflow';
import type { AccountConfig } from '../../src/core/types/config.js';
import { NetworkError } from '../../src/core/utils/errors.js';
import {
  type FolderSyncResult,
  type SyncFolder,
  classifyType,
  compareFolders,
  normalizeMailboxEntry,
  syncMailboxes,
} from '../../src/core/imap/folders.js';
import { ImapService } from '../../src/core/imap/ImapService.js';
import type { ImapFlowFactory } from '../../src/core/imap/types.js';

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

interface FakeImapFlow {
  options: unknown;
  connect: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
}

function makeFake(): FakeImapFlow {
  return {
    options: undefined,
    connect: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
  };
}

function makeFactory(fake: FakeImapFlow): ImapFlowFactory {
  return {
    create: (options) => {
      fake.options = options;
      return fake as unknown as ImapFlow;
    },
  };
}

describe('classifyType', () => {
  it('classifies inbox from specialUse', () => {
    expect(
      classifyType({
        path: 'INBOX',
        displayName: 'INBOX',
        flags: [],
        specialUse: 'inbox',
      })
    ).toBe('inbox');
  });

  it('classifies sent from specialUse', () => {
    expect(
      classifyType({
        path: 'Sent',
        displayName: 'Sent',
        flags: [],
        specialUse: 'sent',
      })
    ).toBe('sent');
  });

  it('classifies drafts from specialUse', () => {
    expect(
      classifyType({ path: 'Drafts', displayName: 'Drafts', flags: [], specialUse: 'drafts' })
    ).toBe('drafts');
  });

  it('classifies trash from specialUse', () => {
    expect(
      classifyType({ path: 'Trash', displayName: 'Trash', flags: [], specialUse: 'trash' })
    ).toBe('trash');
  });

  it('classifies archive from specialUse', () => {
    expect(
      classifyType({ path: 'Archive', displayName: 'Archive', flags: [], specialUse: 'archive' })
    ).toBe('archive');
  });

  it('classifies junk as spam', () => {
    expect(
      classifyType({ path: 'Junk', displayName: 'Junk', flags: [], specialUse: 'junk' })
    ).toBe('spam');
  });

  it('classifies spam as spam', () => {
    expect(
      classifyType({ path: 'Spam', displayName: 'Spam', flags: [], specialUse: 'spam' })
    ).toBe('spam');
  });

  it('falls back to flags when specialUse is missing', () => {
    expect(
      classifyType({
        path: 'Foo',
        displayName: 'Foo',
        flags: ['\\Sent', '\\HasNoChildren'],
        specialUse: '',
      })
    ).toBe('sent');
  });

  it('uses name fallback for "Sent Items" with no special-use metadata', () => {
    expect(
      classifyType({ path: 'Sent Items', displayName: 'Sent Items', flags: [], specialUse: '' })
    ).toBe('sent');
  });

  it('uses name fallback for "Junk Mail" with no special-use metadata', () => {
    expect(
      classifyType({ path: 'Junk Mail', displayName: 'Junk Mail', flags: [], specialUse: '' })
    ).toBe('spam');
  });

  it('uses name fallback for "All Mail" with no special-use metadata', () => {
    expect(
      classifyType({ path: 'All Mail', displayName: 'All Mail', flags: [], specialUse: '' })
    ).toBe('archive');
  });

  it('classifies INBOX by path even without special-use metadata', () => {
    expect(
      classifyType({ path: 'INBOX', displayName: 'INBOX', flags: [], specialUse: '' })
    ).toBe('inbox');
  });

  it('classifies "inbox" by path (lowercase) as inbox', () => {
    expect(
      classifyType({ path: 'inbox', displayName: 'inbox', flags: [], specialUse: '' })
    ).toBe('inbox');
  });

  it('returns custom for unrecognized folders', () => {
    expect(
      classifyType({ path: 'Receipts', displayName: 'Receipts', flags: [], specialUse: '' })
    ).toBe('custom');
  });

  it('does not classify "Important" as spam just because it sounds similar', () => {
    expect(
      classifyType({ path: 'Important', displayName: 'Important', flags: [], specialUse: '' })
    ).toBe('custom');
  });
});

describe('normalizeMailboxEntry', () => {
  it('preserves the original path and delimiter', () => {
    const folder = normalizeMailboxEntry({
      path: 'INBOX/Projects',
      delimiter: '/',
      flags: new Set(['\\HasChildren']),
      specialUse: '',
    });
    expect(folder.path).toBe('INBOX/Projects');
    expect(folder.delimiter).toBe('/');
    expect(folder.flags).toEqual(['\\HasChildren']);
  });

  it('derives a display name from the last segment', () => {
    expect(
      normalizeMailboxEntry({ path: 'Work/Research/Important', delimiter: '/', flags: [] })
        .displayName
    ).toBe('Important');
  });

  it('handles non-/ delimiters (e.g. "." used by some servers)', () => {
    const folder = normalizeMailboxEntry({ path: 'INBOX.Projects.2026', delimiter: '.', flags: [] });
    expect(folder.displayName).toBe('2026');
    expect(folder.parentPath).toBe('INBOX.Projects');
    expect(folder.depth).toBe(2);
  });

  it('handles backslash delimiters used by some IMAP servers', () => {
    const folder = normalizeMailboxEntry({ path: 'INBOX\\Projects', delimiter: '\\', flags: [] });
    expect(folder.displayName).toBe('Projects');
    expect(folder.parentPath).toBe('INBOX');
    expect(folder.depth).toBe(1);
  });

  it('marks \\Noselect folders as not selectable', () => {
    const folder = normalizeMailboxEntry({
      path: 'Archive',
      delimiter: '/',
      flags: new Set(['\\Noselect']),
    });
    expect(folder.selectable).toBe(false);
  });

  it('defaults selectable to true when the flag is missing', () => {
    const folder = normalizeMailboxEntry({ path: 'Inbox', delimiter: '/', flags: [] });
    expect(folder.selectable).toBe(true);
  });

  it('returns parentPath=null and depth=0 for top-level entries', () => {
    const folder = normalizeMailboxEntry({ path: 'INBOX', delimiter: '/', flags: [] });
    expect(folder.parentPath).toBeNull();
    expect(folder.depth).toBe(0);
  });

  it('returns the type field for a special-use folder', () => {
    const folder = normalizeMailboxEntry({
      path: 'INBOX',
      delimiter: '/',
      flags: [],
      specialUse: 'inbox',
    });
    expect(folder.type).toBe('inbox');
    expect(folder.specialUse).toBe('inbox');
  });
});

describe('syncMailboxes', () => {
  it('returns an empty result for an empty input list', () => {
    const result = syncMailboxes([]);
    expect(result.folders).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it('places INBOX first in the ordered result', () => {
    const result = syncMailboxes([
      { path: 'Sent', delimiter: '/', flags: [], specialUse: 'sent' },
      { path: 'INBOX', delimiter: '/', flags: [], specialUse: 'inbox' },
      { path: 'Drafts', delimiter: '/', flags: [], specialUse: 'drafts' },
    ]);
    expect(result.folders.map((f) => f.path)).toEqual(['INBOX', 'Sent', 'Drafts']);
  });

  it('deduplicates INBOX case-insensitively', () => {
    const result = syncMailboxes([
      { path: 'INBOX', delimiter: '/', flags: [], specialUse: 'inbox' },
      { path: 'Inbox', delimiter: '/', flags: [], specialUse: 'inbox' },
      { path: 'inbox', delimiter: '/', flags: [], specialUse: 'inbox' },
    ]);
    expect(result.folders).toHaveLength(1);
    expect(result.folders[0]?.type).toBe('inbox');
    expect(result.total).toBe(3);
    expect(result.skipped).toBe(2);
  });

  it('keeps the first occurrence of an alias by path', () => {
    const result = syncMailboxes([
      { path: 'Sent', delimiter: '/', flags: [], specialUse: 'sent' },
      { path: 'Sent Items', delimiter: '/', flags: [], specialUse: 'sent' },
    ]);
    expect(result.folders).toHaveLength(1);
    expect(result.folders[0]?.path).toBe('Sent');
  });

  it('preserves unknown custom folders', () => {
    const result = syncMailboxes([
      { path: 'Receipts', delimiter: '/', flags: [] },
      { path: 'Projects', delimiter: '/', flags: [] },
    ]);
    expect(result.folders).toHaveLength(2);
    expect(result.folders.every((f) => f.type === 'custom')).toBe(true);
  });

  it('keeps nested folders with parent/child relationships', () => {
    const result = syncMailboxes([
      { path: 'INBOX', delimiter: '/', flags: [], specialUse: 'inbox' },
      { path: 'INBOX/Projects', delimiter: '/', flags: [] },
      { path: 'INBOX/Projects/2026', delimiter: '/', flags: [] },
    ]);
    const projects = result.folders.find((f) => f.path === 'INBOX/Projects');
    const projects2026 = result.folders.find((f) => f.path === 'INBOX/Projects/2026');
    expect(projects?.parentPath).toBe('INBOX');
    expect(projects?.depth).toBe(1);
    expect(projects2026?.parentPath).toBe('INBOX/Projects');
    expect(projects2026?.depth).toBe(2);
  });

  it('handles a non-"/" delimiter for nested paths', () => {
    const result = syncMailboxes([
      { path: 'Work', delimiter: '.', flags: [] },
      { path: 'Work.Research', delimiter: '.', flags: [] },
      { path: 'Work.Research.Important', delimiter: '.', flags: [] },
    ]);
    const work = result.folders.find((f) => f.path === 'Work');
    const workResearch = result.folders.find((f) => f.path === 'Work.Research');
    const workImportant = result.folders.find((f) => f.path === 'Work.Research.Important');
    expect(work?.parentPath).toBeNull();
    expect(work?.depth).toBe(0);
    expect(workResearch?.parentPath).toBe('Work');
    expect(workResearch?.depth).toBe(1);
    expect(workImportant?.parentPath).toBe('Work.Research');
    expect(workImportant?.depth).toBe(2);
  });

  it('produces deterministic ordering for custom folders (alphabetical)', () => {
    const result = syncMailboxes([
      { path: 'Zeta', delimiter: '/', flags: [] },
      { path: 'alpha', delimiter: '/', flags: [] },
      { path: 'Beta', delimiter: '/', flags: [] },
    ]);
    expect(result.folders.map((f) => f.path)).toEqual(['alpha', 'Beta', 'Zeta']);
  });

  it('handles a server that advertises no special-use metadata at all', () => {
    const result = syncMailboxes([
      { path: 'INBOX', delimiter: '/', flags: [] },
      { path: 'Sent', delimiter: '/', flags: [] },
      { path: 'Drafts', delimiter: '/', flags: [] },
      { path: 'Trash', delimiter: '/', flags: [] },
    ]);
    const inbox = result.folders.find((f) => f.path === 'INBOX');
    const sent = result.folders.find((f) => f.path === 'Sent');
    const drafts = result.folders.find((f) => f.path === 'Drafts');
    const trash = result.folders.find((f) => f.path === 'Trash');
    expect(inbox?.type).toBe('inbox');
    expect(sent?.type).toBe('sent');
    expect(drafts?.type).toBe('drafts');
    expect(trash?.type).toBe('trash');
  });

  it('classifies Junk as spam via name fallback', () => {
    const result = syncMailboxes([{ path: 'Junk', delimiter: '/', flags: [] }]);
    expect(result.folders[0]?.type).toBe('spam');
  });

  it('classifies "All Mail" as archive via name fallback', () => {
    const result = syncMailboxes([{ path: 'All Mail', delimiter: '/', flags: [] }]);
    expect(result.folders[0]?.type).toBe('archive');
  });

  it('accepts flags as either an array or a Set', () => {
    const result = syncMailboxes([
      { path: 'A', delimiter: '/', flags: ['\\Sent'] },
      { path: 'B', delimiter: '/', flags: new Set(['\\Drafts']) },
    ]);
    expect(result.folders.find((f) => f.path === 'A')?.type).toBe('sent');
    expect(result.folders.find((f) => f.path === 'B')?.type).toBe('drafts');
  });

  it('returns deterministic ordering regardless of input order', () => {
    const a = syncMailboxes([
      { path: 'Z', delimiter: '/', flags: [] },
      { path: 'INBOX', delimiter: '/', flags: [], specialUse: 'inbox' },
      { path: 'A', delimiter: '/', flags: [] },
    ]);
    const b = syncMailboxes([
      { path: 'A', delimiter: '/', flags: [] },
      { path: 'Z', delimiter: '/', flags: [] },
      { path: 'INBOX', delimiter: '/', flags: [], specialUse: 'inbox' },
    ]);
    expect(a.folders.map((f) => f.path)).toEqual(b.folders.map((f) => f.path));
    expect(a.folders.map((f) => f.path)).toEqual(['INBOX', 'A', 'Z']);
  });
});

describe('compareFolders', () => {
  const folder = (type: SyncFolder['type'], path: string): SyncFolder => ({
    path,
    displayName: path,
    delimiter: '/',
    flags: [],
    specialUse: '',
    type,
    selectable: true,
    parentPath: null,
    depth: 0,
  });

  it('puts INBOX before Sent', () => {
    expect(compareFolders(folder('sent', 'S'), folder('inbox', 'I'))).toBeGreaterThan(0);
    expect(compareFolders(folder('inbox', 'I'), folder('sent', 'S'))).toBeLessThan(0);
  });

  it('breaks ties by lower-cased path', () => {
    expect(compareFolders(folder('custom', 'Alpha'), folder('custom', 'beta'))).toBeLessThan(0);
  });
});

describe('ImapService.syncFolders', () => {
  let fake: FakeImapFlow;
  let factory: ImapFlowFactory;
  let service: ImapService;

  beforeEach(() => {
    fake = makeFake();
    factory = makeFactory(fake);
    service = new ImapService(baseAccount, {
      factory,
      env: { TERMAIL_WORK_PASSWORD: 'super-secret' },
    });
  });

  it('returns a deterministic, classified folder list', async () => {
    fake.list.mockResolvedValueOnce([
      { path: 'Sent', delimiter: '/', flags: new Set(['\\Sent']), specialUse: '\\Sent' },
      { path: 'INBOX', delimiter: '/', flags: new Set(['\\Inbox']), specialUse: '\\Inbox' },
      { path: 'Drafts', delimiter: '/', flags: new Set(['\\Drafts']), specialUse: '\\Drafts' },
      { path: 'Receipts', delimiter: '/', flags: new Set() },
      { path: 'INBOX/Projects', delimiter: '/', flags: new Set() },
    ]);
    const result: FolderSyncResult = await service.syncFolders();
    expect(result.total).toBe(5);
    expect(result.skipped).toBe(0);
    expect(result.folders.map((f) => f.path)).toEqual([
      'INBOX',
      'INBOX/Projects',
      'Sent',
      'Drafts',
      'Receipts',
    ]);
    expect(result.folders[0]?.type).toBe('inbox');
    expect(result.folders[2]?.type).toBe('sent');
  });

  it('returns an empty result for an empty mailbox list', async () => {
    fake.list.mockResolvedValueOnce([]);
    const result = await service.syncFolders();
    expect(result.folders).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it('maps list errors to NetworkError', async () => {
    await service.connect();
    fake.list.mockRejectedValueOnce(new Error('connection reset by peer'));
    await expect(service.syncFolders()).rejects.toBeInstanceOf(NetworkError);
  });

  it('does not leak credentials into a thrown error message', async () => {
    fake.list.mockRejectedValueOnce(new Error('list failed: super-secret is bad'));
    const caught = await service
      .syncFolders()
      .then(
        () => new Error('expected throw'),
        (e: unknown) => e as Error
      );
    expect(caught.message).toMatch(/list failed: \*\*\* is bad/);
    expect(caught.message).not.toContain('super-secret');
  });
});
