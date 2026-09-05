/**
 * Phase 2.6 — `extractBodyAsync` parser failure regression test.
 *
 * Phase 2.3's `extractBodyAsync` runs `mailparser.simpleParser` over
 * the raw source bytes. A parser failure must not propagate as an
 * unhandled rejection — the function logs a warning and returns an
 * empty body so the rest of the sync continues. This test mocks
 * `simpleParser` to reject, verifies the function returns the empty
 * shape, and verifies no error is thrown to the caller.
 */

import type { FetchMessageObject } from 'imapflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const simpleParserMock = vi.fn();
vi.mock('mailparser', () => ({
  simpleParser: (...args: unknown[]) => simpleParserMock(...args),
}));

async function loadExtractBodyAsync(): Promise<
  (message: FetchMessageObject) => Promise<{
    textBody: string;
    hasHtmlBody: boolean;
    attachments: unknown[];
  }>
> {
  const mod = await import('../../src/core/imap/messages.js');
  return mod.extractBodyAsync as unknown as (
    message: FetchMessageObject
  ) => Promise<{ textBody: string; hasHtmlBody: boolean; attachments: unknown[] }>;
}

describe('extractBodyAsync — parser failure', () => {
  beforeEach(() => {
    simpleParserMock.mockReset();
  });

  afterEach(() => {
    simpleParserMock.mockReset();
  });

  it('returns empty body and does not throw when simpleParser rejects', async () => {
    simpleParserMock.mockRejectedValueOnce(new Error('malformed MIME headers'));
    const extractBodyAsync = await loadExtractBodyAsync();

    const message: FetchMessageObject = {
      seq: 1,
      uid: 7,
      source: Buffer.from('not really a valid email'),
    } as unknown as FetchMessageObject;

    const out = await extractBodyAsync(message);
    expect(out.textBody).toBe('');
    expect(out.hasHtmlBody).toBe(false);
    expect(out.attachments).toEqual([]);
    expect(simpleParserMock).toHaveBeenCalledTimes(1);
  });

  it('returns empty body when simpleParser throws a non-Error value', async () => {
    simpleParserMock.mockImplementationOnce(() => {
      throw new TypeError('bad input');
    });
    const extractBodyAsync = await loadExtractBodyAsync();

    const message: FetchMessageObject = {
      seq: 2,
      uid: 8,
      source: Buffer.from('garbage'),
    } as unknown as FetchMessageObject;

    // simpleParser throwing synchronously is treated the same as
    // rejecting — the try/catch in extractBodyAsync catches both.
    const out = await extractBodyAsync(message);
    expect(out.textBody).toBe('');
    expect(out.hasHtmlBody).toBe(false);
    expect(out.attachments).toEqual([]);
  });
});
