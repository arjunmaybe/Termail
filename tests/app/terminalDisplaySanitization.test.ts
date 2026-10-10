/**
 * Display-layer terminal sanitization for folder names, sync errors,
 * init errors, and search text.
 *
 * Folder names and server error text are remotely supplied; search text
 * is user-entered (possibly pasted). All reach OpenTUI renderables, so
 * control bytes must be stripped at the render boundary. Attack strings
 * are built with String.fromCharCode so this file holds no raw control
 * bytes. Dummy data only, no network.
 */

import type { CliRenderer } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { FolderTabs } from '../../src/app/components/FolderTabs.js';
import { SearchInputBar } from '../../src/app/components/SearchInputBar.js';
import { WelcomeView } from '../../src/app/components/WelcomeView.js';
import { StatusBar, formatSyncError } from '../../src/app/layout/StatusBar.js';
import { actions } from '../../src/core/state/AppState.js';
import type { Account } from '../../src/core/types/index.js';
import type { Folder } from '../../src/core/types/index.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

const EVIL_MIDDLE = `${ESC}]0;PWNED${BEL}`;

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

function makeAccount(): Account {
  return {
    id: 'work',
    name: 'Work',
    type: 'imap',
    email: 'me@example.com',
    host: 'imap.example.com',
    port: 993,
    username: 'me@example.com',
    useTls: true,
    authType: 'password',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

interface ChunkNode {
  id?: string;
  content?: { chunks?: Array<{ text?: string }> };
  getChildren?: () => ChunkNode[];
}

function textsById(root: ChunkNode): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (node: ChunkNode): void => {
    if (typeof node.id === 'string' && node.content?.chunks) {
      out.set(node.id, node.content.chunks.map((c) => c.text ?? '').join(''));
    }
    for (const child of node.getChildren?.() ?? []) {
      visit(child);
    }
  };
  visit(root);
  return out;
}

function hasControlBytes(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (
      (code >= 0x00 && code <= 0x08) ||
      (code >= 0x0b && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      return true;
    }
  }
  return false;
}

describe('terminal display sanitization', () => {
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

  it('strips escapes from server-derived sync error text', () => {
    const formatted = formatSyncError(`NO ${ESC}[2J login rejected${BEL}`);
    expect(formatted).toMatch(/^● Error: /);
    expect(formatted).toContain('login rejected');
    expect(hasControlBytes(formatted)).toBe(false);
  });

  it('renders malicious folder names as harmless text in folder tabs', async () => {
    renderer = (await createTestRenderer({ width: 120, height: 40 })).renderer;
    const tabs = new FolderTabs(renderer, { themeMode: 'dark' });
    try {
      actions.setFolders([makeFolder({ name: `INBOX${EVIL_MIDDLE}` })]);
      const texts = textsById(tabs as unknown as ChunkNode);
      const tab = texts.get('folder-tab-work:INBOX') ?? '';
      expect(tab).toContain('INBOX]0;PWNED');
      expect(hasControlBytes(tab)).toBe(false);
    } finally {
      tabs.destroy();
    }
  });

  it('renders malicious folder names as harmless text in the status bar', async () => {
    renderer = (await createTestRenderer({ width: 120, height: 40 })).renderer;
    const bar = new StatusBar(renderer, { themeMode: 'dark' });
    try {
      actions.setFolders([makeFolder({ name: `INBOX${EVIL_MIDDLE}` })]);
      actions.setCurrentFolder('work:INBOX');
      const texts = textsById(bar as unknown as ChunkNode);
      const label = texts.get('status-folder') ?? '';
      expect(label).toContain('INBOX]0;PWNED');
      expect(hasControlBytes(label)).toBe(false);
    } finally {
      bar.destroy();
    }
  });

  it('renders malicious folder names as harmless text in the welcome view', async () => {
    renderer = (await createTestRenderer({ width: 120, height: 40 })).renderer;
    const view = new WelcomeView(renderer, { themeMode: 'dark' });
    try {
      actions.setAccounts([makeAccount()]);
      actions.setFolders([makeFolder({ name: `INBOX${EVIL_MIDDLE}` })]);
      actions.setCurrentFolder('work:INBOX');
      const texts = textsById(view as unknown as ChunkNode);
      const subtitle = texts.get('welcome-subtitle') ?? '';
      expect(subtitle).toContain('INBOX]0;PWNED');
      expect(hasControlBytes(subtitle)).toBe(false);
    } finally {
      view.destroy();
    }
  });

  it('renders pasted control characters in the search box as harmless text', async () => {
    renderer = (await createTestRenderer({ width: 120, height: 40 })).renderer;
    const bar = new SearchInputBar(renderer, { themeMode: 'dark' });
    try {
      actions.setSearchActive(true);
      actions.setSearchQuery(`hello${ESC}[2Jworld${BEL}`);
      const texts = textsById(bar as unknown as ChunkNode);
      const input = texts.get('search-input') ?? '';
      expect(input).toBe('hello[2Jworld');
      expect(hasControlBytes(input)).toBe(false);
    } finally {
      bar.destroy();
    }
  });

  it('preserves normal folder names and Unicode', async () => {
    renderer = (await createTestRenderer({ width: 120, height: 40 })).renderer;
    const tabs = new FolderTabs(renderer, { themeMode: 'dark' });
    try {
      actions.setFolders([makeFolder({ name: 'Héllo — 日本語' })]);
      const texts = textsById(tabs as unknown as ChunkNode);
      expect(texts.get('folder-tab-work:INBOX')).toBe('Héllo — 日本語');
    } finally {
      tabs.destroy();
    }
  });
});
