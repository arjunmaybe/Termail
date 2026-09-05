/**
 * Phase 2.6 — `FolderTabs` regression tests.
 *
 * The sidebar's per-folder unread count is derived from the in-memory
 * `AppState.foldersWithUnread` computed signal — the underlying `Folder`
 * projection's `unreadCount` field is always 0 because Phase 2.4 does
 * not write `unread_count` / `total_count` to the database.
 *
 * These tests render a real `FolderTabs` against a real (in-process)
 * renderer and assert the visible tab label reflects the live in-memory
 * unread count.
 */

import { type CliRenderer, createCliRenderer } from '@opentui/core';
import { afterEach, describe, expect, it } from 'vitest';
import { FolderTabs } from '../../src/app/components/FolderTabs.js';
import type { PersistedEmail } from '../../src/core/database/index.js';
import { actions } from '../../src/core/state/AppState.js';
import type { Folder } from '../../src/core/types/index.js';

function makeFolder(over: Partial<Folder> = {}): Folder {
  return {
    id: 'work:INBOX',
    accountId: 'work',
    name: 'INBOX',
    fullName: 'INBOX',
    type: 'inbox',
    parentId: undefined,
    delimiter: '/',
    attributes: [],
    unreadCount: 0,
    totalCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function makeEmail(over: Partial<PersistedEmail> = {}): PersistedEmail {
  const id = over.id ?? 'work:INBOX:1';
  return {
    id,
    accountId: 'work',
    folderId: 'work:INBOX',
    messageId: '<a@example.com>',
    fromAddresses: [],
    toAddresses: [],
    ccAddresses: [],
    subject: '',
    date: 0,
    internalDate: 0,
    receivedAt: 0,
    isRead: false,
    isFlagged: false,
    isAnswered: false,
    isDraft: false,
    hasAttachments: false,
    size: 0,
    bodyText: null,
    bodyHtml: null,
    headers: {},
    attachments: [],
    flags: [],
    uid: 1,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe('FolderTabs', () => {
  let renderer: CliRenderer | null = null;

  afterEach(() => {
    actions.reset();
    if (renderer) {
      try {
        renderer.stop();
        renderer.destroy();
      } catch {
        /* ignore */
      }
      renderer = null;
    }
  });

  async function makeTabs(): Promise<{
    tabs: FolderTabs;
    renderer: CliRenderer;
  }> {
    renderer = await createCliRenderer({ useMouse: false, exitOnCtrlC: false });
    const tabs = new FolderTabs(renderer, {
      id: 'folder-tabs-test',
      themeMode: 'dark',
    });
    return { tabs, renderer };
  }

  function tabContent(tabs: FolderTabs, folderId: string): string | null {
    const id = `folder-tab-${folderId}`;
    const child = tabs.getChildren().find((c) => (c as { id?: string }).id === id) as
      | { content?: { chunks?: Array<{ text?: string }> } }
      | undefined;
    if (!child?.content?.chunks) return null;
    return child.content.chunks.map((c) => c.text ?? '').join('');
  }

  it('shows no count when the folder has zero unread', async () => {
    actions.setFolders([makeFolder({ id: 'work:INBOX', name: 'INBOX' })]);
    const { tabs } = await makeTabs();
    const content = tabContent(tabs, 'work:INBOX');
    expect(content).toBe('INBOX');
  });

  it('shows the live unread count from the in-memory email list', async () => {
    actions.setFolders([makeFolder({ id: 'work:INBOX', name: 'INBOX' })]);
    // Two unread messages in INBOX.
    actions.setEmails([
      makeEmail({ id: 'work:INBOX:1', folderId: 'work:INBOX', isRead: false }),
      makeEmail({ id: 'work:INBOX:2', folderId: 'work:INBOX', isRead: false }),
    ]);
    const { tabs } = await makeTabs();
    const content = tabContent(tabs, 'work:INBOX');
    expect(content).toBe('INBOX (2)');
  });

  it('counts only unread (not flagged) emails', async () => {
    actions.setFolders([makeFolder({ id: 'work:INBOX', name: 'INBOX' })]);
    actions.setEmails([
      makeEmail({ id: 'work:INBOX:1', folderId: 'work:INBOX', isRead: false, isFlagged: true }),
      makeEmail({ id: 'work:INBOX:2', folderId: 'work:INBOX', isRead: true }),
      makeEmail({ id: 'work:INBOX:3', folderId: 'work:INBOX', isRead: false }),
    ]);
    const { tabs } = await makeTabs();
    const content = tabContent(tabs, 'work:INBOX');
    expect(content).toBe('INBOX (2)');
  });

  it('per-folder counts are independent', async () => {
    actions.setFolders([
      makeFolder({ id: 'work:INBOX', name: 'INBOX' }),
      makeFolder({ id: 'work:Sent', name: 'Sent', type: 'sent' }),
    ]);
    actions.setEmails([
      makeEmail({ id: 'work:INBOX:1', folderId: 'work:INBOX', isRead: false }),
      makeEmail({ id: 'work:INBOX:2', folderId: 'work:INBOX', isRead: true }),
      makeEmail({ id: 'work:Sent:1', folderId: 'work:Sent', isRead: false }),
      makeEmail({ id: 'work:Sent:2', folderId: 'work:Sent', isRead: false }),
      makeEmail({ id: 'work:Sent:3', folderId: 'work:Sent', isRead: false }),
    ]);
    const { tabs } = await makeTabs();
    expect(tabContent(tabs, 'work:INBOX')).toBe('INBOX (1)');
    expect(tabContent(tabs, 'work:Sent')).toBe('Sent (3)');
  });

  it('updates the displayed count when emails are added', async () => {
    actions.setFolders([makeFolder({ id: 'work:INBOX', name: 'INBOX' })]);
    actions.setEmails([makeEmail({ id: 'work:INBOX:1', folderId: 'work:INBOX', isRead: false })]);
    const { tabs } = await makeTabs();
    expect(tabContent(tabs, 'work:INBOX')).toBe('INBOX (1)');

    actions.setEmails([
      makeEmail({ id: 'work:INBOX:1', folderId: 'work:INBOX', isRead: false }),
      makeEmail({ id: 'work:INBOX:2', folderId: 'work:INBOX', isRead: false }),
      makeEmail({ id: 'work:INBOX:3', folderId: 'work:INBOX', isRead: false }),
    ]);
    expect(tabContent(tabs, 'work:INBOX')).toBe('INBOX (3)');
  });
});
