/**
 * Renderer configuration guard.
 *
 * OpenTUI's renderer can own Ctrl+C itself (`exitOnCtrlC`): it registers a
 * global keypress listener that schedules `renderer.destroy()`,
 * independent of the application key router. Because OpenTUI runs every
 * global listener regardless of `defaultPrevented`, the router cannot veto
 * that path. The app must therefore disable it and own Ctrl+C, so a
 * non-empty composer can never be torn down without confirmation.
 */

import { describe, expect, it } from 'vitest';
import { RENDERER_OPTIONS } from '../../src/app/rendererOptions.js';

describe('renderer options', () => {
  it('disables the renderer-owned Ctrl+C destroy handler', () => {
    expect(RENDERER_OPTIONS.exitOnCtrlC).toBe(false);
  });

  it('keeps mouse disabled so focus is keyboard-only', () => {
    expect(RENDERER_OPTIONS.useMouse).toBe(false);
  });
});
