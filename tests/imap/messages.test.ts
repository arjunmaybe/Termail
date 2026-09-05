/**
 * Tests for IMAP message synchronization.
 *
 * Pure-function tests cover the normalization helpers directly. An
 * integration suite drives `ImapService.syncMessages()` through the
 * same fake factory used in Phase 2.1/2.2.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImapFlow, type FetchMessageObject } from 'imapflow';
import type { AccountConfig } from '../../src/core/types/config.js';
import { NetworkError } from '../../src/core/utils/errors.js';
import {
  ImapService,
} from '../../src/core/imap/ImapService.js';
import {
  buildFetchQuery,
  buildFetchRange,
  dedupeMessages,
  extractBodyAsync,
  flagsToBooleans,
  htmlToPlainText,
  mapAttachment,
  normalizeDate,
  normalizeFetchedMessage,
  normalizeMessageId,
  parseEnvelopeAddresses,
  planBatches,
  resolveLimits,
  sortNewestFirst,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_MESSAGES,
  DEFAULT_MAX_SOURCE_BYTES,
} from '../../src/core/imap/messages.js';
import type { ImapFlowFactory, SyncMessage } from '../../src/core/imap/types.js';

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

const envWithPassword = { TERMAIL_WORK_PASSWORD: 'super-secret' };

// ---------------------------------------------------------------------------
// Pure-function tests
// ---------------------------------------------------------------------------

describe('parseEnvelopeAddresses', () => {
  it('returns an empty array for undefined or empty input', () => {
    expect(parseEnvelopeAddresses(undefined)).toEqual([]);
    expect(parseEnvelopeAddresses([])).toEqual([]);
  });

  it('maps a single address with name and address', () => {
    expect(
      parseEnvelopeAddresses([{ name: 'Alice', address: 'alice@example.com' }])
    ).toEqual([{ name: 'Alice', address: 'alice@example.com' }]);
  });

  it('maps multiple addresses', () => {
    expect(
      parseEnvelopeAddresses([
        { name: 'Alice', address: 'alice@example.com' },
        { name: 'Bob', address: 'bob@example.com' },
      ])
    ).toHaveLength(2);
  });

  it('handles missing name', () => {
    expect(parseEnvelopeAddresses([{ address: 'bob@example.com' }])).toEqual([
      { name: '', address: 'bob@example.com' },
    ]);
  });

  it('handles missing address', () => {
    expect(parseEnvelopeAddresses([{ name: 'Alice' }])).toEqual([
      { name: 'Alice', address: '' },
    ]);
  });

  it('drops entries that have neither name nor address', () => {
    expect(
      parseEnvelopeAddresses([
        { name: '', address: '' },
        { name: 'Alice', address: 'a@example.com' },
      ])
    ).toEqual([{ name: 'Alice', address: 'a@example.com' }]);
  });

  it('trims whitespace from name and address', () => {
    expect(
      parseEnvelopeAddresses([{ name: '  Alice  ', address: '  alice@example.com  ' }])
    ).toEqual([{ name: 'Alice', address: 'alice@example.com' }]);
  });
});

describe('normalizeMessageId', () => {
  it('returns "" for empty/null/undefined', () => {
    expect(normalizeMessageId('')).toBe('');
    expect(normalizeMessageId(null)).toBe('');
    expect(normalizeMessageId(undefined)).toBe('');
  });

  it('strips angle brackets', () => {
    expect(normalizeMessageId('<abc@example.com>')).toBe('abc@example.com');
  });

  it('strips repeated angle brackets', () => {
    expect(normalizeMessageId('<<abc@example.com>>')).toBe('abc@example.com');
  });

  it('leaves an unbracketed id unchanged', () => {
    expect(normalizeMessageId('abc@example.com')).toBe('abc@example.com');
  });
});

describe('normalizeDate', () => {
  it('returns null for null/undefined', () => {
    expect(normalizeDate(null)).toBeNull();
    expect(normalizeDate(undefined)).toBeNull();
  });

  it('returns the same Date instance when given a Date', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    expect(normalizeDate(d)).toBe(d);
  });

  it('parses ISO strings', () => {
    const d = normalizeDate('2026-01-01T00:00:00Z');
    expect(d).toBeInstanceOf(Date);
    expect(d?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns null for unparseable strings', () => {
    expect(normalizeDate('not a date')).toBeNull();
  });

  it('returns null for an invalid Date instance', () => {
    expect(normalizeDate(new Date('garbage'))).toBeNull();
  });
});

describe('flagsToBooleans', () => {
  it('returns all-false and empty raw for undefined', () => {
    const f = flagsToBooleans(undefined);
    expect(f.isRead).toBe(false);
    expect(f.isFlagged).toBe(false);
    expect(f.isAnswered).toBe(false);
    expect(f.isDraft).toBe(false);
    expect(f.raw).toEqual([]);
  });

  it('maps the standard IMAP flags', () => {
    const f = flagsToBooleans(new Set(['\\Seen', '\\Flagged', '\\Answered', '\\Draft']));
    expect(f.isRead).toBe(true);
    expect(f.isFlagged).toBe(true);
    expect(f.isAnswered).toBe(true);
    expect(f.isDraft).toBe(true);
    expect(f.raw).toEqual(['\\Seen', '\\Flagged', '\\Answered', '\\Draft']);
  });

  it('is case-insensitive', () => {
    const f = flagsToBooleans(new Set(['\\seen', '\\FLAGGED']));
    expect(f.isRead).toBe(true);
    expect(f.isFlagged).toBe(true);
  });
});

describe('mapAttachment', () => {
  it('fills defaults for missing fields', () => {
    expect(mapAttachment({})).toEqual({
      filename: '',
      contentType: 'application/octet-stream',
      size: 0,
      disposition: 'unknown',
      contentId: undefined,
    });
  });

  it('preserves all fields when present', () => {
    expect(
      mapAttachment({
        filename: 'doc.pdf',
        contentType: 'application/pdf',
        size: 1234,
        contentDisposition: 'attachment',
        contentId: '<abc>',
      })
    ).toEqual({
      filename: 'doc.pdf',
      contentType: 'application/pdf',
      size: 1234,
      disposition: 'attachment',
      contentId: 'abc',
    });
  });

  it('classifies inline disposition', () => {
    expect(
      mapAttachment({ contentDisposition: 'inline', contentType: 'image/png' })
        .disposition
    ).toBe('inline');
  });
});

describe('htmlToPlainText', () => {
  it('strips script and style blocks', () => {
    expect(htmlToPlainText('hello<script>x</script>world')).toBe('helloworld');
    expect(htmlToPlainText('hi<style>p{}</style>there')).toBe('hithere');
  });

  it('replaces br and block closers with newlines', () => {
    expect(htmlToPlainText('a<br>b<br/>c</p>d')).toMatch(/a\nb\nc\nd/);
  });

  it('strips remaining tags', () => {
    expect(htmlToPlainText('<b>bold</b>')).toBe('bold');
  });

  it('decodes common entities', () => {
    expect(htmlToPlainText('A &amp; B &lt; C')).toBe('A & B < C');
  });

  it('returns "" for empty input', () => {
    expect(htmlToPlainText('')).toBe('');
  });
});

describe('buildFetchQuery', () => {
  it('requests envelope, flags, structure, and capped source', () => {
    const q = buildFetchQuery();
    expect(q.uid).toBe(true);
    expect(q.flags).toBe(true);
    expect(q.envelope).toBe(true);
    expect(q.internalDate).toBe(true);
    expect(q.size).toBe(true);
    expect(q.bodyStructure).toBe(true);
    expect(q.source).toEqual({ maxLength: DEFAULT_MAX_SOURCE_BYTES });
  });

  it('honors a custom source cap', () => {
    const q = buildFetchQuery(1024);
    expect(q.source).toEqual({ maxLength: 1024 });
  });
});

describe('resolveLimits', () => {
  it('fills in defaults for missing fields', () => {
    const r = resolveLimits();
    expect(r.maxMessages).toBe(DEFAULT_MAX_MESSAGES);
    expect(r.batchSize).toBe(DEFAULT_BATCH_SIZE);
    expect(r.maxSourceBytes).toBe(DEFAULT_MAX_SOURCE_BYTES);
    expect(r.sinceUid).toBeUndefined();
  });

  it('overrides only the fields that are set', () => {
    const r = resolveLimits({ maxMessages: 10, batchSize: 5, sinceUid: 100 });
    expect(r.maxMessages).toBe(10);
    expect(r.batchSize).toBe(5);
    expect(r.sinceUid).toBe(100);
    expect(r.maxSourceBytes).toBe(DEFAULT_MAX_SOURCE_BYTES);
  });
});

describe('buildFetchRange', () => {
  it('returns "1:*" when no sinceUid is given', () => {
    expect(buildFetchRange()).toBe('1:*');
    expect(buildFetchRange(undefined)).toBe('1:*');
  });

  it('returns the inclusive upper bound for a sinceUid', () => {
    expect(buildFetchRange(99)).toBe('100:*');
  });

  it('treats negative sinceUid as no bound', () => {
    expect(buildFetchRange(-1)).toBe('1:*');
  });
});

describe('planBatches', () => {
  it('returns [] when there are no UIDs to fetch', () => {
    expect(
      planBatches({ upperUid: 0, sinceUid: 0, batchSize: 10, maxMessages: 100 })
    ).toEqual([]);
  });

  it('returns a single batch when the count fits', () => {
    expect(
      planBatches({ upperUid: 5, sinceUid: 0, batchSize: 10, maxMessages: 100 })
    ).toEqual([{ from: 1, to: 5 }]);
  });

  it('splits into multiple batches', () => {
    expect(
      planBatches({ upperUid: 25, sinceUid: 0, batchSize: 10, maxMessages: 100 })
    ).toEqual([
      { from: 1, to: 10 },
      { from: 11, to: 20 },
      { from: 21, to: 25 },
    ]);
  });

  it('honors maxMessages', () => {
    expect(
      planBatches({ upperUid: 100, sinceUid: 0, batchSize: 10, maxMessages: 15 })
    ).toEqual([
      { from: 1, to: 10 },
      { from: 11, to: 15 },
    ]);
  });

  it('respects sinceUid as a lower bound', () => {
    expect(
      planBatches({ upperUid: 20, sinceUid: 10, batchSize: 10, maxMessages: 100 })
    ).toEqual([{ from: 11, to: 20 }]);
  });
});

describe('normalizeFetchedMessage', () => {
  const receivedAt = new Date('2026-01-01T00:00:00Z');

  it('builds a SyncMessage from a complete FetchMessageObject', async () => {
    const raw: FetchMessageObject = {
      seq: 1,
      uid: 42,
      flags: new Set(['\\Seen', '\\Flagged']),
      size: 1024,
      envelope: {
        subject: 'Hello',
        messageId: '<abc@example.com>',
        from: [{ name: 'Alice', address: 'alice@example.com' }],
        to: [{ name: 'Bob', address: 'bob@example.com' }],
        cc: [],
        date: new Date('2026-01-01T10:00:00Z'),
      },
      internalDate: new Date('2026-01-01T10:00:00Z'),
    };
    const m = await normalizeFetchedMessage({
      accountId: 'work',
      folder: 'INBOX',
      receivedAt,
      raw,
      body: { textBody: 'hi there', hasHtmlBody: false, attachments: [] },
    });
    expect(m.uid).toBe(42);
    expect(m.messageId).toBe('abc@example.com');
    expect(m.subject).toBe('Hello');
    expect(m.folder).toBe('INBOX');
    expect(m.accountId).toBe('work');
    expect(m.from).toEqual([{ name: 'Alice', address: 'alice@example.com' }]);
    expect(m.to).toEqual([{ name: 'Bob', address: 'bob@example.com' }]);
    expect(m.cc).toEqual([]);
    expect(m.isRead).toBe(true);
    expect(m.isFlagged).toBe(true);
    expect(m.isAnswered).toBe(false);
    expect(m.isDraft).toBe(false);
    expect(m.size).toBe(1024);
    expect(m.textBody).toBe('hi there');
    expect(m.hasHtmlBody).toBe(false);
    expect(m.attachments).toEqual([]);
    expect(m.flags).toEqual(['\\Seen', '\\Flagged']);
    expect(m.date?.toISOString()).toBe('2026-01-01T10:00:00.000Z');
    expect(m.internalDate?.toISOString()).toBe('2026-01-01T10:00:00.000Z');
    expect(m.receivedAt).toBe(receivedAt);
  });

  it('handles missing optional fields safely', async () => {
    const raw: FetchMessageObject = {
      seq: 1,
      uid: 1,
    };
    const m = await normalizeFetchedMessage({
      accountId: 'work',
      folder: 'INBOX',
      receivedAt,
      raw,
      body: { textBody: '', hasHtmlBody: false, attachments: [] },
    });
    expect(m.messageId).toBe('');
    expect(m.subject).toBe('');
    expect(m.from).toEqual([]);
    expect(m.to).toEqual([]);
    expect(m.cc).toEqual([]);
    expect(m.date).toBeNull();
    expect(m.internalDate).toBeNull();
    expect(m.size).toBe(0);
    expect(m.isRead).toBe(false);
    expect(m.textBody).toBe('');
    expect(m.flags).toEqual([]);
  });
});

describe('extractBodyAsync', () => {
  it('returns empty body when there is no source', async () => {
    const out = await extractBodyAsync({ seq: 1, uid: 1 });
    expect(out.textBody).toBe('');
    expect(out.hasHtmlBody).toBe(false);
    expect(out.attachments).toEqual([]);
  });
});

describe('dedupeMessages', () => {
  const mk = (uid: number, messageId: string): SyncMessage => ({
    uid,
    messageId,
    folder: 'INBOX',
    accountId: 'work',
    from: [],
    to: [],
    cc: [],
    subject: '',
    date: null,
    internalDate: null,
    receivedAt: new Date(0),
    isRead: false,
    isFlagged: false,
    isAnswered: false,
    isDraft: false,
    size: 0,
    textBody: '',
    hasHtmlBody: false,
    attachments: [],
    flags: [],
  });

  it('keeps the first occurrence of a duplicate UID', () => {
    const a = mk(1, 'a@x');
    const b = mk(2, 'b@x');
    const dup = mk(1, 'c@x');
    const r = dedupeMessages([a, b, dup]);
    expect(r.unique).toEqual([a, b]);
    expect(r.deduped).toBe(1);
  });

  it('keeps the first occurrence of a duplicate Message-ID', () => {
    const a = mk(1, 'same@x');
    const b = mk(2, 'same@x');
    const r = dedupeMessages([a, b]);
    expect(r.unique).toEqual([a]);
    expect(r.deduped).toBe(1);
  });

  it('does not dedupe on empty Message-ID', () => {
    const a = mk(1, '');
    const b = mk(2, '');
    const r = dedupeMessages([a, b]);
    expect(r.unique).toEqual([a, b]);
    expect(r.deduped).toBe(0);
  });

  it('returns all unique when there are no duplicates', () => {
    const r = dedupeMessages([mk(1, 'a'), mk(2, 'b')]);
    expect(r.unique).toHaveLength(2);
    expect(r.deduped).toBe(0);
  });
});

describe('sortNewestFirst', () => {
  const mk = (uid: number, date: Date | null): SyncMessage => ({
    uid,
    messageId: '',
    folder: 'INBOX',
    accountId: 'work',
    from: [],
    to: [],
    cc: [],
    subject: '',
    date,
    internalDate: null,
    receivedAt: new Date(0),
    isRead: false,
    isFlagged: false,
    isAnswered: false,
    isDraft: false,
    size: 0,
    textBody: '',
    hasHtmlBody: false,
    attachments: [],
    flags: [],
  });

  it('orders by internalDate/date, newest first', () => {
    const old = mk(1, new Date('2024-01-01T00:00:00Z'));
    const mid = mk(2, new Date('2025-06-01T00:00:00Z'));
    const neu = mk(3, new Date('2026-01-01T00:00:00Z'));
    expect(sortNewestFirst([old, mid, neu]).map((m) => m.uid)).toEqual([3, 2, 1]);
  });

  it('sinks null-dated messages to the bottom', () => {
    const d = mk(1, new Date('2026-01-01T00:00:00Z'));
    const noDate = mk(2, null);
    expect(sortNewestFirst([noDate, d]).map((m) => m.uid)).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// ImapService.syncMessages integration tests
// ---------------------------------------------------------------------------

interface FakeImapFlow {
  options: unknown;
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
    options: undefined,
    connect: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    fetchAll: vi.fn().mockResolvedValue([]),
    mailboxOpen: vi.fn().mockResolvedValue({
      path: 'INBOX',
      delimiter: '/',
      flags: new Set<string>(),
      uidNext: 1,
      uidValidity: 1n,
      exists: 0,
    }),
    mailboxClose: vi.fn().mockResolvedValue(true),
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

function makeRawFetchedMessage(uid: number, subject: string): FetchMessageObject {
  return {
    seq: uid,
    uid,
    size: 100,
    flags: new Set(uid % 2 === 0 ? ['\\Seen'] : []),
    envelope: {
      subject,
      messageId: `<msg-${uid}@example.com>`,
      from: [{ name: 'Alice', address: 'alice@example.com' }],
      to: [{ address: 'me@example.com' }],
      cc: [],
      date: new Date(`2026-01-${String(uid).padStart(2, '0')}T00:00:00Z`),
    },
    internalDate: new Date(`2026-01-${String(uid).padStart(2, '0')}T00:00:00Z`),
  };
}

describe('ImapService.syncMessages', () => {
  let fake: FakeImapFlow;
  let factory: ImapFlowFactory;
  let service: ImapService;

  beforeEach(() => {
    fake = makeFake();
    factory = makeFactory(fake);
    service = new ImapService(baseAccount, {
      factory,
      env: envWithPassword,
    });
  });

  it('returns an empty result for an empty mailbox', async () => {
    fake.mailboxOpen.mockResolvedValueOnce({
      path: 'INBOX',
      delimiter: '/',
      flags: new Set<string>(),
      uidNext: 1,
      uidValidity: 1n,
      exists: 0,
    });
    fake.fetchAll.mockResolvedValueOnce([]);
    const result = await service.syncMessages('INBOX');
    expect(result.folder).toBe('INBOX');
    expect(result.messages).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.parsed).toBe(0);
    expect(result.deduped).toBe(0);
  });

  it('fetches messages in batches and normalizes them', async () => {
    fake.mailboxOpen.mockResolvedValueOnce({
      path: 'INBOX',
      delimiter: '/',
      flags: new Set<string>(),
      uidNext: 26,
      uidValidity: 1n,
      exists: 25,
    });
    // uidNext=26 means UIDs 1..25. batchSize defaults to 100 so one batch.
    fake.fetchAll.mockResolvedValueOnce([
      makeRawFetchedMessage(1, 'first'),
      makeRawFetchedMessage(2, 'second'),
      makeRawFetchedMessage(3, 'third'),
    ]);
    const result = await service.syncMessages('INBOX');
    expect(result.total).toBe(3);
    expect(result.parsed).toBe(3);
    expect(result.deduped).toBe(0);
    expect(result.messages.map((m) => m.subject)).toEqual(['third', 'second', 'first']);
    // Mailbox was closed even though we did not disconnect.
    expect(fake.mailboxClose).toHaveBeenCalledTimes(1);
  });

  it('dedupes duplicate UIDs', async () => {
    fake.mailboxOpen.mockResolvedValueOnce({
      path: 'INBOX',
      delimiter: '/',
      flags: new Set<string>(),
      uidNext: 3,
      uidValidity: 1n,
      exists: 2,
    });
    fake.fetchAll.mockResolvedValueOnce([
      makeRawFetchedMessage(1, 'a'),
      makeRawFetchedMessage(1, 'a-dup'),
    ]);
    const result = await service.syncMessages('INBOX');
    expect(result.total).toBe(2);
    expect(result.parsed).toBe(1);
    expect(result.deduped).toBe(1);
  });

  it('honors maxMessages cap', async () => {
    fake.mailboxOpen.mockResolvedValueOnce({
      path: 'INBOX',
      delimiter: '/',
      flags: new Set<string>(),
      uidNext: 11,
      uidValidity: 1n,
      exists: 10,
    });
    fake.fetchAll.mockResolvedValueOnce(
      [1, 2, 3].map((u) => makeRawFetchedMessage(u, `s${u}`))
    );
    const result = await service.syncMessages('INBOX', {
      limits: { maxMessages: 3, batchSize: 10 },
    });
    expect(result.messages).toHaveLength(3);
  });

  it('slices a large range into multiple batches', async () => {
    fake.mailboxOpen.mockResolvedValueOnce({
      path: 'INBOX',
      delimiter: '/',
      flags: new Set<string>(),
      uidNext: 5,
      uidValidity: 1n,
      exists: 4,
    });
    // 4 UIDs at batchSize 2 yields exactly 2 batches: 1:2 and 3:4.
    fake.fetchAll
      .mockResolvedValueOnce([
        makeRawFetchedMessage(1, 'a'),
        makeRawFetchedMessage(2, 'b'),
      ])
      .mockResolvedValueOnce([
        makeRawFetchedMessage(3, 'c'),
        makeRawFetchedMessage(4, 'd'),
      ]);
    const result = await service.syncMessages('INBOX', {
      limits: { batchSize: 2, maxMessages: 10 },
    });
    expect(fake.fetchAll).toHaveBeenCalledTimes(2);
    expect(result.messages).toHaveLength(4);
    expect(result.total).toBe(4);
  });

  it('maps mailboxOpen failures to NetworkError', async () => {
    await service.connect();
    fake.mailboxOpen.mockRejectedValueOnce(new Error('Mailbox does not exist'));
    await expect(service.syncMessages('NoSuchFolder')).rejects.toBeInstanceOf(NetworkError);
  });

  it('maps fetchAll failures to NetworkError', async () => {
    await service.connect();
    fake.mailboxOpen.mockResolvedValueOnce({
      path: 'INBOX',
      delimiter: '/',
      flags: new Set<string>(),
      uidNext: 2,
      uidValidity: 1n,
      exists: 1,
    });
    fake.fetchAll.mockRejectedValueOnce(new Error('connection reset'));
    await expect(service.syncMessages('INBOX')).rejects.toBeInstanceOf(NetworkError);
  });

  it('closes the mailbox even when fetchAll throws', async () => {
    await service.connect();
    fake.mailboxOpen.mockResolvedValueOnce({
      path: 'INBOX',
      delimiter: '/',
      flags: new Set<string>(),
      uidNext: 2,
      uidValidity: 1n,
      exists: 1,
    });
    fake.fetchAll.mockRejectedValueOnce(new Error('boom'));
    await expect(service.syncMessages('INBOX')).rejects.toBeInstanceOf(NetworkError);
    expect(fake.mailboxClose).toHaveBeenCalledTimes(1);
  });

  it('redacts the resolved secret in any thrown error message', async () => {
    await service.connect();
    fake.mailboxOpen.mockRejectedValueOnce(
      new Error('auth failed: super-secret is bad')
    );
    const caught: Error = await service
      .syncMessages('INBOX')
      .then(
        () => new Error('expected throw'),
        (e: unknown) => e as Error
      );
    expect(caught.message).toMatch(/auth failed: \*\*\* is bad/);
    expect(caught.message).not.toContain('super-secret');
  });

  it('still closes the mailbox if mailboxClose itself fails', async () => {
    await service.connect();
    fake.mailboxOpen.mockResolvedValueOnce({
      path: 'INBOX',
      delimiter: '/',
      flags: new Set<string>(),
      uidNext: 1,
      uidValidity: 1n,
      exists: 0,
    });
    fake.fetchAll.mockResolvedValueOnce([]);
    fake.mailboxClose.mockRejectedValueOnce(new Error('close failed'));
    const result = await service.syncMessages('INBOX');
    expect(result.messages).toEqual([]);
    expect(fake.mailboxClose).toHaveBeenCalledTimes(1);
  });
});
