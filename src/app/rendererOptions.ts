/**
 * Renderer configuration for the TUI.
 *
 * `exitOnCtrlC` is intentionally `false`. OpenTUI's renderer registers its
 * own *global* keypress listener (when `exitOnCtrlC` is true) that matches
 * Ctrl+C and schedules `renderer.destroy()` — entirely independent of the
 * application's key router. Because OpenTUI's `emitWithPriority` runs every
 * global listener regardless of `defaultPrevented`, the app router cannot
 * veto that path with `preventDefault()`. Disabling it here lets the app
 * own Ctrl+C: normal quit outside the composer, discard-safety inside it.
 *
 * Kept in its own module so the invariant can be asserted by a test
 * without importing `main.ts` (which starts the application on import).
 */
export const RENDERER_OPTIONS = {
  exitOnCtrlC: false,
  useMouse: false,
} as const;
