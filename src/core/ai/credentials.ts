/**
 * Phase 5 — AI credential resolution.
 *
 * The OpenRouter API key always comes from the environment, never from
 * `config.json`, SQLite, or source. Mirrors the `TERMAIL_<ID>_PASSWORD`
 * convention with a single global variable.
 */

import { AuthenticationError } from '../utils/errors.js';

/** Environment variable holding the AI provider API key. */
export const AI_API_KEY_ENV = 'TERMAIL_AI_API_KEY';

/**
 * Resolve the AI API key from the environment. Throws
 * `AuthenticationError` with a non-secret message when missing or empty.
 */
export function resolveAiApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[AI_API_KEY_ENV];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AuthenticationError(
      `Missing AI API key. Set the ${AI_API_KEY_ENV} environment variable.`
    );
  }
  return value;
}
