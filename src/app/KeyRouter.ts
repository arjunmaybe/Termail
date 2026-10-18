/**
 * Keypress routing for the TUI.
 *
 * Extracted from main.ts so the key dispatch logic can be tested
 * independently of the renderer and event loop. This function is the
 * single source of truth for which key triggers which action.
 *
 * Routing order matters:
 *   1. Composer (when active) owns the keyboard entirely — the inbox
 *      shortcuts below must never fire while composing.
 *   2. Ctrl+C quits from the normal UI (the renderer's own `exitOnCtrlC`
 *      handler is disabled in `rendererOptions.ts`).
 *   3. Search-active branch.
 *   4. Reading view navigation.
 *   5. Normal-UI bindings.
 *
 * `preventDefault()` on a key stops the focused OpenTUI renderable (an
 * editor) from also handling it. It does NOT stop other global listeners;
 * `stopPropagation()` would, and is deliberately not used here.
 */

import type { App } from './App.js';

export interface RoutableKey {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  preventDefault?: () => void;
}

export interface KeyRouterHandlers {
  onShutdown: () => void;
}

export function routeKeypress(key: RoutableKey, app: App, handlers: KeyRouterHandlers): void {
  // A new keystroke dismisses any transient status message (no timers).
  if (app.getStatusMessage() !== null) {
    app.clearStatusMessage();
  }

  // Phase 4 — composer branch. Runs before everything else so no
  // composer keystroke can leak into the inbox shortcuts below. Keys the
  // composer does not own fall through (no preventDefault) so the focused
  // native editor receives them.
  if (app.isComposeActive()) {
    routeComposeKeypress(key, app);
    return;
  }

  // Ctrl+C quits from the normal UI. The renderer's independent Ctrl+C
  // destroy handler is disabled (see rendererOptions.ts), so this is the
  // only quit path for the key.
  if (key.ctrl && key.name === 'c') {
    handlers.onShutdown();
    return;
  }

  // Phase 3.3 — search-active branch. While the search input
  // bar is open, `q` and `r` are disabled and the regular
  // navigation keys are routed to the search controller.
  if (app.isSearchActive()) {
    if (key.ctrl) return; // ignore Ctrl-modified keys
    switch (key.name) {
      case 'escape':
        app.cancelSearch();
        return;
      case 'return':
        void app.submitSearch();
        return;
      case 'backspace':
        app.popChar();
        return;
      case 'space':
        app.pushChar(' ');
        return;
      default:
        // Printable single character.
        if (typeof key.name === 'string' && key.name.length === 1) {
          app.pushChar(key.name);
        }
        return;
    }
  }

  if (key.ctrl) return;

  // Reading-view navigation: while an email is open, j/k and the arrows
  // scroll the message instead of moving the list highlight. PageUp and
  // PageDown scroll by viewports. Every other key falls through to the
  // regular bindings below (quit, sync, search, Escape, ...).
  if (app.isReadingViewOpen()) {
    switch (key.name) {
      case 'j':
      case 'down':
        app.scrollReadingView(1);
        return;
      case 'k':
      case 'up':
        app.scrollReadingView(-1);
        return;
      case 'pagedown':
        app.scrollReadingViewPage(1);
        return;
      case 'pageup':
        app.scrollReadingViewPage(-1);
        return;
      default:
        break;
    }
  }

  switch (key.name) {
    case 'q':
      handlers.onShutdown();
      break;
    case 'escape':
      // Close the reading view and return to the list, preserving the
      // highlight on the same email.
      app.closeOpenedEmail();
      break;
    case 'r':
      // Phase 2.5: trigger a sync of the current account / folder.
      void app.requestSync();
      break;
    case '/':
    case 'slash':
      // Phase 3.3: open the search input bar.
      app.openSearch();
      break;
    case 'c':
      // Phase 4: open a blank compose (replaces the whole shell). Consume
      // the key so the opening 'c' cannot land in the freshly focused To
      // field (the composer focuses To synchronously during this dispatch).
      key.preventDefault?.();
      app.openCompose();
      break;
    case 's':
      // Phase 5: summarize the selected email (detail pane).
      void app.summarizeSelectedEmail();
      break;
    case 'd':
      // Phase 5: draft a reply into compose for review. Never sends.
      void app.draftReplyWithAi();
      break;
    case 'j':
    case 'down':
      app.moveEmailSelection(1);
      break;
    case 'k':
    case 'up':
      app.moveEmailSelection(-1);
      break;
    case 'h':
    case 'left':
      app.moveFolderSelection(-1);
      break;
    case 'l':
    case 'right':
      app.moveFolderSelection(1);
      break;
    case 'tab':
      app.moveFolderSelection(1);
      break;
    case 'return':
      // Open the highlighted email in the reading view. Never advances
      // to a different email merely because one is already highlighted.
      app.openSelectedEmail();
      break;
    default:
      break;
  }
}

/**
 * Composer key handling. The composer owns focus, so it (not the native
 * editors) decides what Enter, Tab, Escape and Ctrl+C mean. Only keys the
 * composer acts on call `preventDefault()`; everything else is left for
 * the focused editor (arrow keys, Ctrl+A/E/K/U, printable characters,
 * paste, selection, undo/redo, ...).
 */
function routeComposeKeypress(key: RoutableKey, app: App): void {
  // Discard confirmation is modal: it captures y/n and both discard keys.
  if (app.isComposeConfirmingDiscard()) {
    if (!key.ctrl && !key.meta && !key.shift && key.name === 'y') {
      key.preventDefault?.();
      app.confirmComposeDiscard();
      return;
    }
    if ((!key.ctrl && !key.meta && !key.shift && key.name === 'n') || key.name === 'escape') {
      key.preventDefault?.();
      app.cancelComposeDiscard();
      return;
    }
    if (key.ctrl && key.name === 'c') {
      // Ctrl+C while confirming behaves like Escape: keep editing.
      key.preventDefault?.();
      app.cancelComposeDiscard();
      return;
    }
    // Swallow every other key so nothing leaks to the editors or the app
    // while the confirmation prompt is up.
    key.preventDefault?.();
    return;
  }

  // Discard safety: Escape and Ctrl+C both start the discard policy.
  if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
    key.preventDefault?.();
    app.requestComposeDiscard();
    return;
  }

  // Enter variants: `\r` -> "return", `\n` -> "linefeed", keypad -> "kpenter".
  const isEnter = key.name === 'return' || key.name === 'linefeed' || key.name === 'kpenter';

  // Send. Ctrl+Enter is only distinguishable on terminals that report
  // modifiers (kitty/modifyOtherKeys); the Send target in the Tab cycle
  // is the portable fallback for the rest.
  if (key.ctrl && isEnter) {
    key.preventDefault?.();
    app.requestComposeSend();
    return;
  }

  // Field cycling.
  if (key.name === 'tab') {
    key.preventDefault?.();
    app.cycleComposeFocus(key.shift ? -1 : 1);
    return;
  }

  const focus = app.getComposeFocus();

  // Send target owns Enter/Space (portable send). No editor is focused
  // for this field, so remaining keys are swallowed.
  if (focus === 'send') {
    key.preventDefault?.();
    if (isEnter || key.name === 'space') {
      app.requestComposeSend();
    }
    return;
  }

  // Single-line fields: Enter advances to the next field rather than
  // submitting. Body keeps Enter as a newline (handled by the native
  // textarea, so no preventDefault here).
  if (isEnter && focus !== 'body') {
    key.preventDefault?.();
    app.cycleComposeFocus(1);
    return;
  }
}
