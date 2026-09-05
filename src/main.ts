/**
 * Termail - Main entry point
 */

import { createCliRenderer } from '@opentui/core';
import { App } from './app/App.js';
import { logger } from './core/utils/logger.js';

async function main(): Promise<void> {
  logger.info('Starting termail...');

  let renderer: Awaited<ReturnType<typeof createCliRenderer>> | null = null;

  try {
    renderer = await createCliRenderer({
      exitOnCtrlC: true,
      useMouse: false,
    });

    const app = new App(renderer, { id: 'app', initialTheme: 'dark' });
    renderer.root.add(app);

    // Wire app state subscription so children re-render on changes
    app.attach();

    // Bind global keyboard shortcuts
    renderer.keyInput.on('keypress', (key) => {
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

      switch (key.name) {
        case 'q':
          if (!key.ctrl) {
            shutdown();
          }
          break;
        case 'escape':
        case 'backspace':
          // Reserved for Phase 2 navigation
          break;
        case 'r':
          // Phase 2.5: trigger a sync of the current account / folder.
          // The handler lives entirely inside `App.requestSync()`; this
          // file is intentionally the only place that owns the keypress.
          void app.requestSync();
          break;
        case '/':
        case 'slash':
          // Phase 3.3: open the search input bar.
          app.openSearch();
          break;
        default:
          break;
      }
    });

    const shutdown = (): void => {
      logger.info('Shutting down...');
      if (renderer) {
        try {
          renderer.stop();
          renderer.destroy();
        } catch (err) {
          logger.error('Error during shutdown', { error: err });
        }
      }
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    renderer.start();
  } catch (error) {
    logger.error('Failed to start application', { error });
    if (renderer) {
      try {
        renderer.stop();
        renderer.destroy();
      } catch {
        /* ignore */
      }
    }
    process.exit(1);
  }
}

main();
