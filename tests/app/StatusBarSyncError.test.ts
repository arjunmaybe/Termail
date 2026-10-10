/**
 * B1 — sync error visibility in the existing status UI.
 *
 * Proves authentication/network sync errors are actually visible in
 * the StatusBar (first line, length-limited, fallback to generic).
 */

import type { CliRenderer } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusBar, formatSyncError } from '../../src/app/layout/StatusBar.js';
import { actions } from '../../src/core/state/AppState.js';

function syncContent(bar: StatusBar): string | null {
  const right = bar.getChildren().find((c) => (c as { id?: string }).id === 'status-right') as
    | { getChildren: () => Array<{ id?: string; content?: { chunks?: Array<{ text?: string }> } }> }
    | undefined;
  if (!right) return null;
  const sync = right.getChildren().find((c) => c.id === 'status-sync');
  if (!sync?.content?.chunks) return null;
  return sync.content.chunks.map((c) => c.text ?? '').join('');
}

describe('B1 StatusBar sync error visibility', () => {
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

  it('shows authentication errors in the status bar', async () => {
    renderer = (await createTestRenderer({ width: 120, height: 40 })).renderer;
    const bar = new StatusBar(renderer, { themeMode: 'dark' });
    try {
      actions.setSyncError('Authentication failed: bad password');
      const content = syncContent(bar);
      expect(content).toContain('bad password');
      expect(content).toMatch(/Error/);
    } finally {
      bar.destroy();
    }
  });

  it('shows network errors in the status bar', async () => {
    renderer = (await createTestRenderer({ width: 120, height: 40 })).renderer;
    const bar = new StatusBar(renderer, { themeMode: 'dark' });
    try {
      actions.setSyncError('Network error: ECONNREFUSED');
      const content = syncContent(bar);
      expect(content).toContain('ECONNREFUSED');
    } finally {
      bar.destroy();
    }
  });

  it('shows only the first line and limits display length', async () => {
    renderer = (await createTestRenderer({ width: 120, height: 40 })).renderer;
    const bar = new StatusBar(renderer, { themeMode: 'dark' });
    try {
      actions.setSyncError('first line here\nsecond line here\nthird');
      expect(syncContent(bar)).toContain('first line here');
      expect(syncContent(bar)).not.toContain('second line');

      const long = 'x'.repeat(200);
      actions.setSyncError(long);
      const clipped = syncContent(bar)!;
      expect(clipped.length).toBeLessThanOrEqual('● Error: '.length + 80);
    } finally {
      bar.destroy();
    }
  });

  it('falls back to generic Error when no message exists', () => {
    expect(formatSyncError(null)).toBe('● Error');
    expect(formatSyncError('')).toBe('● Error');
    expect(formatSyncError('   \n  ')).toBe('● Error');
  });

  it('status bar falls back when status is error with no message', async () => {
    renderer = (await createTestRenderer({ width: 120, height: 40 })).renderer;
    const bar = new StatusBar(renderer, { themeMode: 'dark' });
    try {
      actions.reset();
      actions.setSyncStatus('error');
      expect(syncContent(bar)).toBe('● Error');
    } finally {
      bar.destroy();
    }
  });
});
