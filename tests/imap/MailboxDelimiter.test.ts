/**
 * B4 — IMAP mailbox delimiter correctness.
 *
 * `normalizeMailbox` must split only on the actual server-supplied
 * delimiter, never hardcoded `/` or `.`.
 */

import { describe, expect, it } from 'vitest';
import { __testing } from '../../src/core/imap/ImapService.js';

const { normalizeMailbox } = __testing;

describe('B4 normalizeMailbox delimiter', () => {
  it('uses a backslash delimiter', () => {
    const info = normalizeMailbox({ path: 'INBOX\\Projects', delimiter: '\\', flags: new Set() });
    expect(info.name).toBe('Projects');
    expect(info.delimiter).toBe('\\');
    expect(info.path).toBe('INBOX\\Projects');
  });

  it('keeps dots inside names when delimiter is /', () => {
    const info = normalizeMailbox({
      path: 'INBOX/Archive.2026',
      delimiter: '/',
      flags: new Set(),
    });
    expect(info.name).toBe('Archive.2026');
  });

  it('keeps slashes inside names when delimiter is .', () => {
    const info = normalizeMailbox({
      path: 'INBOX.Archive/2026',
      delimiter: '.',
      flags: new Set(),
    });
    expect(info.name).toBe('Archive/2026');
  });

  it('handles a normal dot-delimited hierarchy', () => {
    const info = normalizeMailbox({
      path: 'Work.Research.Important',
      delimiter: '.',
      flags: new Set(),
    });
    expect(info.name).toBe('Important');
  });

  it('treats empty/missing delimiters as a single top-level name', () => {
    expect(normalizeMailbox({ path: 'INBOX', delimiter: '', flags: new Set() }).name).toBe('INBOX');
    expect(normalizeMailbox({ path: 'INBOX.Archive', delimiter: '', flags: new Set() }).name).toBe(
      'INBOX.Archive'
    );
    expect(
      normalizeMailbox({
        path: 'INBOX',
        delimiter: undefined as unknown as string,
        flags: new Set(),
      }).name
    ).toBe('INBOX');
  });
});
