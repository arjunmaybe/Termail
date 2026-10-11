/**
 * Termail - Main entry point
 */

import { createCliRenderer } from '@opentui/core';
import { App } from './app/App.js';
import { routeKeypress } from './app/KeyRouter.js';
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

    // Bind global keyboard shortcuts. All key routing lives in
    // `routeKeypress` (src/app/KeyRouter.ts) so it can be tested
    // without a live renderer.
    renderer.keyInput.on('keypress', (key) => {
      routeKeypress(key, app, { onShutdown: shutdown });
    });

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
