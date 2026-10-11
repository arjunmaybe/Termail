/**
 * Keypress routing for the TUI.
 *
 * Extracted from main.ts so the key dispatch logic can be tested
 * independently of the renderer and event loop. This function is the
 * single source of truth for which key triggers which action.
 */

import type { App } from './App.js';

export interface KeyRouterHandlers {
  onShutdown: () => void;
}

export function routeKeypress(
  key: { name: string; ctrl?: boolean },
  app: App,
  handlers: KeyRouterHandlers
): void {
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
