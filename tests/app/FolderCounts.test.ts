/**
 * B6 — folder unread counts from persisted emails (GROUP BY folder_id).
 *
 * Uses realistic persisted folder/count data (via `MessageRepository`
 * upserts), not manual injection, to prove:
 *  - multiple folders receive independent totals/unread counts
 *  - non-current folders show correct unread counts even when the
 *    in-memory slice holds only the current folder
 *  - current-folder mark-as-read updates remain immediate
 *  - no cross-account leakage
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CliRenderer } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FolderTabs } from '../../src/app/components/FolderTabs.js';
import { getConfigStore, resetConfigStore } from '../../src/core/config/ConfigStore.js';
import { getDatabase, resetDatabase } from '../../src/core/database/Database.js';
import { MessageRepository } from '../../src/core/database/MessageRepository.js';
import type { SafeAccountInput } from '../../src/core/database/MessageRepository.js';
import { actions } from '../../src/core/state/AppState.js';
import type { Folder } from '../../src/core/types/index.js';
import type { PersistedEmail } from '../../src/core/database/index.js';
import type { SyncFolder } from '../../src/core/imap/folders.js';
import type { SyncMessage } from '../../src/core/imap/types.js';
import type { AppConfig } from '../../src/core/types/config.js';

const workAccount: SafeAccountInput = {
  id: 'work',
  name: 'Work',
  email: 'me@example.com',
  host: 'imap.example.com',
  port: 993,
  username: 'me',
  useTls: true,
  authType: 'password',
};

const personalAccount: SafeAccountInput = {
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
    subject: 'hi',
    date: new Date('2026-01-01T10:00:00Z'),
    internalDate: new Date('2026-01-01T10:00:00Z'),
    receivedAt: new Date('2026-01-01T10:00:05Z'),
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
  };
}

function toFolderProjection(p: {
  id: string;
  accountId: string;
  name: string;
  fullName: string;
  type: string;
  unreadCount: number;
  totalCount: number;
}): Folder {
  return {
    id: p.id,
    accountId: p.accountId,
    name: p.name,
    fullName: p.fullName,
    type: p.type as Folder['type'],
    parentId: undefined,
    delimiter: '/',
    attributes: [],
    unreadCount: p.unreadCount,
    totalCount: p.totalCount,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function tabContent(tabs: FolderTabs, folderId: string): string | null {
  const child = tabs.getChildren().find((c) => (c as { id?: string }).id === `folder-tab-${folderId}`) as
    | { content?: { chunks?: Array<{ text?: string }> } }
    | undefined;
  if (!child?.content?.chunks) return null;
  return child.content.chunks.map((c) => c.text ?? '').join('');
}

describe('B6 folder counts from persisted emails', () => {
  let testDbPath: string;
  let testConfigPath: string;
  let repo: MessageRepository;
  let db: ReturnType<typeof getDatabase>;
  let renderer: CliRenderer | null = null;

  beforeEach(async () => {
    resetDatabase();
    resetConfigStore();
    actions.reset();
    testConfigPath = join(tmpdir(), `termail-b6-${Date.now()}-${Math.random()}-config.json`);
    testDbPath = join(tmpdir(), `termail-b6-${Date.now()}-${Math.random()}.sqlite`);
    const configStore = getConfigStore(testConfigPath);
    await configStore.initialize();
    await configStore.updateConfig({ database: { path: testDbPath } } as Partial<AppConfig>);
    db = getDatabase(configStore.getConfig());
    await db.initialize();
    repo = new MessageRepository(db);
  });

  afterEach(() => {
    actions.reset();
    resetDatabase();
    resetConfigStore();
    if (renderer) {
      try {
        renderer.stop();
        renderer.destroy();
      } catch {
        /* ignore */
      }
      renderer = null;
    }
    for (const p of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`, testConfigPath]) {
      if (existsSync(p)) rmSync(p);
    }
  });

  it('multiple folders receive independent totals/unread counts', () => {
    repo.upsertMessages(workAccount, inboxFolder, [
      makeMessage({ uid: 1, isRead: false }),
      makeMessage({ uid: 2, isRead: false }),
      makeMessage({ uid: 3, isRead: false }),
      makeMessage({ uid: 4, isRead: true }),
      makeMessage({ uid: 5, isRead: true }),
    ]);
    repo.upsertMessages(workAccount, sentFolder, [
      makeMessage({ uid: 6, isRead: false, folder: 'Sent' }),
      makeMessage({ uid: 7, isRead: false, folder: 'Sent' }),
    ]);

    const folders = repo.listFoldersForAccount('work');
    const inbox = folders.find((f) => f.fullName === 'INBOX')!;
    const sent = folders.find((f) => f.fullName === 'Sent')!;
    expect(inbox.totalCount).toBe(5);
    expect(inbox.unreadCount).toBe(3);
    expect(sent.totalCount).toBe(2);
    expect(sent.unreadCount).toBe(2);
  });

  it('getFolderCounts groups by folder_id for the account', () => {
    repo.upsertMessages(workAccount, inboxFolder, [
      makeMessage({ uid: 1, isRead: false }),
      makeMessage({ uid: 2, isRead: true }),
    ]);
    repo.upsertMessages(workAccount, sentFolder, [
      makeMessage({ uid: 3, isRead: false, folder: 'Sent' }),
    ]);
    const counts = repo.getFolderCounts('work');
    const byId = new Map(counts.map((c) => [c.folderId, c]));
    expect(byId.get('work:INBOX')).toMatchObject({ total: 2, unread: 1 });
    expect(byId.get('work:Sent')).toMatchObject({ total: 1, unread: 1 });
  });

  it('no cross-account leakage', () => {
    repo.upsertMessages(workAccount, inboxFolder, [makeMessage({ uid: 1, isRead: false })]);
    repo.upsertMessages(personalAccount, inboxFolder, [
      makeMessage({ uid: 1, isRead: false, accountId: 'personal', messageId: '<p1@example.com>' }),
      makeMessage({ uid: 2, isRead: false, accountId: 'personal', messageId: '<p2@example.com>' }),
    ]);

    const workFolders = repo.listFoldersForAccount('work');
    expect(workFolders).toHaveLength(1);
    expect(workFolders[0]!.accountId).toBe('work');
    expect(workFolders[0]!.unreadCount).toBe(1);
    expect(workFolders[0]!.totalCount).toBe(1);

    const personalFolders = repo.listFoldersForAccount('personal');
    expect(personalFolders).toHaveLength(1);
    expect(personalFolders[0]!.unreadCount).toBe(2);

    const workCounts = repo.getFolderCounts('work');
    expect(workCounts).toHaveLength(1);
    expect(workCounts[0]!.folderId).toBe('work:INBOX');
  });

  it('non-current folders show correct unread when slice holds only the current folder', async () => {
    repo.upsertMessages(workAccount, inboxFolder, [
      makeMessage({ uid: 1, isRead: false }),
      makeMessage({ uid: 2, isRead: false }),
      makeMessage({ uid: 3, isRead: false }),
    ]);
    repo.upsertMessages(workAccount, sentFolder, [
      makeMessage({ uid: 4, isRead: false, folder: 'Sent' }),
      makeMessage({ uid: 5, isRead: false, folder: 'Sent' }),
    ]);

    const persisted = repo.listFoldersForAccount('work');
    actions.setFolders(persisted.map((p) => toFolderProjection(p)));
    // Current folder is INBOX (auto-selected). Slice holds only INBOX.
    const inboxEmails = repo.listByFolder('work', 'work:INBOX', 500);
    actions.setEmails(inboxEmails);

    renderer = (await createTestRenderer({ width: 120, height: 40 })).renderer;
    const tabs = new FolderTabs(renderer, { id: 'folder-tabs-b6', themeMode: 'dark' });
    try {
      expect(tabContent(tabs, 'work:INBOX')).toBe('INBOX (3)');
      // Sent shows DB truth even though the slice has no Sent rows.
      expect(tabContent(tabs, 'work:Sent')).toBe('Sent (2)');
    } finally {
      tabs.destroy();
      renderer.stop();
      renderer.destroy();
      renderer = null;
    }
  });

  it('current-folder mark-as-read updates remain immediate', async () => {
    repo.upsertMessages(workAccount, inboxFolder, [
      makeMessage({ uid: 1, isRead: false }),
      makeMessage({ uid: 2, isRead: false }),
      makeMessage({ uid: 3, isRead: false }),
    ]);
    repo.upsertMessages(workAccount, sentFolder, [
      makeMessage({ uid: 4, isRead: false, folder: 'Sent' }),
      makeMessage({ uid: 5, isRead: false, folder: 'Sent' }),
    ]);
    const persisted = repo.listFoldersForAccount('work');
    actions.setFolders(persisted.map((p) => toFolderProjection(p)));
    const inboxEmails: PersistedEmail[] = repo.listByFolder('work', 'work:INBOX', 500);
    actions.setEmails(inboxEmails);

    renderer = (await createTestRenderer({ width: 120, height: 40 })).renderer;
    const tabs = new FolderTabs(renderer, { id: 'folder-tabs-b6-live', themeMode: 'dark' });
    try {
      expect(tabContent(tabs, 'work:INBOX')).toBe('INBOX (3)');

      actions.markAsRead(inboxEmails[0]!.id);
      expect(tabContent(tabs, 'work:INBOX')).toBe('INBOX (2)');
      // Non-current untouched.
      expect(tabContent(tabs, 'work:Sent')).toBe('Sent (2)');
    } finally {
      tabs.destroy();
      renderer.stop();
      renderer.destroy();
      renderer = null;
    }
  });
});
