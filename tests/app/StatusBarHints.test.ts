/**
 * B3 — status bar advertises the primary shortcuts (q, /, r, s, d).
 *
 * Navigation keys (j/k, h/l, arrows, Tab, Enter, Esc) are implemented
 * in main.ts but intentionally not advertised here to keep the
 * one-line bar dense.
 */

import type { CliRenderer } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusBar } from '../../src/app/layout/StatusBar.js';
import { actions } from '../../src/core/state/AppState.js';

function hintIds(bar: StatusBar): string[] {
  const left = bar.getChildren().find((c) => (c as { id?: string }).id === 'status-left') as
    | { getChildren: () => Array<{ id?: string }> }
    | undefined;
  if (!left) return [];
  return left.getChildren().map((c) => c.id ?? '');
}

describe('B3 StatusBar keyboard hints', () => {
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

  it('advertises the primary shortcuts while omitting navigation keys', async () => {
    renderer = (await createTestRenderer({ width: 120, height: 40 })).renderer;
    const bar = new StatusBar(renderer, { themeMode: 'dark' });
    try {
      const ids = hintIds(bar);
      for (const expected of ['kbd-q', 'kbd-/', 'kbd-r', 'kbd-s', 'kbd-d']) {
        expect(ids).toContain(expected);
      }
      for (const omitted of [
        'kbd-j',
        'kbd-k',
        'kbd-h',
        'kbd-l',
        'kbd-up',
        'kbd-down',
        'kbd-left',
        'kbd-right',
        'kbd-tab',
        'kbd-return',
        'kbd-escape',
      ]) {
        expect(ids).not.toContain(omitted);
      }
    } finally {
      bar.destroy();
    }
  });
});
