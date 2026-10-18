#!/usr/bin/env bun

/**
 * Termail - Main entry point
 */

import { createCliRenderer } from '@opentui/core';
import { App } from './app/App.js';
import { routeKeypress } from './app/KeyRouter.js';
import { RENDERER_OPTIONS } from './app/rendererOptions.js';
import {
  type CredentialSetupRequest,
  defaultSetupDeps,
  runCredentialSetup,
} from './core/secretstore/setupCredential.js';
import { logger } from './core/utils/logger.js';

/**
 * One-time credential setup commands. These run before the TUI starts:
 *   bun run src/main.ts --set-password [accountId]
 *   bun run src/main.ts --set-oauth-token [accountId]
 *   bun run src/main.ts --delete-password [accountId]
 *   bun run src/main.ts --delete-oauth-token [accountId]
 * Secrets are read with terminal echo disabled and never displayed.
 */
function parseCredentialSetupArgs(argv: string[]): CredentialSetupRequest | null {
  const [command, accountId] = argv;
  switch (command) {
    case '--set-password':
      return { action: 'set', kind: 'password', ...(accountId ? { accountId } : {}) };
    case '--set-oauth-token':
      return { action: 'set', kind: 'oauth2', ...(accountId ? { accountId } : {}) };
    case '--delete-password':
      return { action: 'delete', kind: 'password', ...(accountId ? { accountId } : {}) };
    case '--delete-oauth-token':
      return { action: 'delete', kind: 'oauth2', ...(accountId ? { accountId } : {}) };
    default:
      return null;
  }
}

async function main(): Promise<void> {
  const setupRequest = parseCredentialSetupArgs(process.argv.slice(2));
  if (setupRequest) {
    process.exit(await runCredentialSetup(setupRequest, defaultSetupDeps()));
  }

  logger.info('Starting termail...');

  let renderer: Awaited<ReturnType<typeof createCliRenderer>> | null = null;

  try {
    // `RENDERER_OPTIONS` disables OpenTUI's own Ctrl+C destroy handler so
    // Ctrl+C is routed through the application (see the module doc).
    renderer = await createCliRenderer({ ...RENDERER_OPTIONS });

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

    // Ctrl+C arrives as a keypress (not SIGINT) in the TUI's raw mode. A
    // real SIGINT (e.g. `kill -INT`) must not discard a non-empty composer
    // without confirmation either: route it through the discard policy
    // while composing, and keep the immediate shutdown outside it.
    const handleSigint = (): void => {
      if (app.isComposeActive()) {
        app.requestComposeDiscard();
        return;
      }
      shutdown();
    };

    // Bind global keyboard shortcuts. All key routing lives in
    // `routeKeypress` (src/app/KeyRouter.ts) so it can be tested
    // without a live renderer.
    renderer.keyInput.on('keypress', (key) => {
      routeKeypress(key, app, { onShutdown: shutdown });
    });

    process.on('SIGINT', handleSigint);
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
