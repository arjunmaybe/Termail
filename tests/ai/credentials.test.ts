/**
 * Phase 5 — AI credential tests. Dummy key only, no network.
 */

import { describe, expect, it } from 'vitest';
import { AI_API_KEY_ENV, resolveAiApiKey } from '../../src/core/ai/credentials.js';
import { AuthenticationError } from '../../src/core/utils/errors.js';

const DUMMY_KEY = 'test-ai-key-123';

describe('resolveAiApiKey', () => {
  it('uses TERMAIL_AI_API_KEY', () => {
    expect(AI_API_KEY_ENV).toBe('TERMAIL_AI_API_KEY');
    expect(resolveAiApiKey({ [AI_API_KEY_ENV]: DUMMY_KEY })).toBe(DUMMY_KEY);
  });

  it('throws AuthenticationError when missing', () => {
    expect(() => resolveAiApiKey({})).toThrow(AuthenticationError);
  });

  it('throws AuthenticationError when empty', () => {
    expect(() => resolveAiApiKey({ [AI_API_KEY_ENV]: '' })).toThrow(AuthenticationError);
  });

  it('names the variable without exposing any secret', () => {
    try {
      resolveAiApiKey({});
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthenticationError);
      expect((error as Error).message).toContain('TERMAIL_AI_API_KEY');
      expect((error as Error).message).not.toContain(DUMMY_KEY);
    }
  });
});
