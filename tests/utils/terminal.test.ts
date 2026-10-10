/**
 * Unit tests for terminal escape-injection sanitization.
 *
 * Control characters are built with String.fromCharCode so this file
 * itself contains no raw control bytes. Dummy attack strings only.
 */

import { describe, expect, it } from 'vitest';
import { sanitizeForTerminal } from '../../src/core/utils/terminal.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const DEL = String.fromCharCode(127);

function controlCodes(text: string): number[] {
  const codes: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (
      (code >= 0x00 && code <= 0x08) ||
      (code >= 0x0b && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      codes.push(code);
    }
  }
  return codes;
}

describe('sanitizeForTerminal', () => {
  it('removes CSI sequences such as ESC [2J while keeping visible text', () => {
    const cleaned = sanitizeForTerminal('hello' + ESC + '[2Jworld');
    expect(cleaned).toBe('hello[2Jworld');
    expect(cleaned).not.toContain(ESC);
  });

  it('removes OSC window-title sequences', () => {
    const cleaned = sanitizeForTerminal('INBOX' + ESC + ']0;PWNED' + BEL + ' tail');
    expect(cleaned).toBe('INBOX]0;PWNED tail');
    expect(cleaned).not.toContain(ESC);
    expect(cleaned).not.toContain(BEL);
  });

  it('removes OSC hyperlink sequences', () => {
    const cleaned = sanitizeForTerminal(
      'click ' + ESC + ']8;;http://evil.example' + BEL + 'here' + ESC + ']8;;' + BEL
    );
    expect(cleaned).toBe('click ]8;;http://evil.examplehere]8;;');
    expect(cleaned).not.toContain(ESC);
    expect(cleaned).not.toContain(BEL);
  });

  it('removes BEL, standalone ESC, DEL, and C1 controls', () => {
    const c1csi = String.fromCharCode(0x9b);
    const c1osc = String.fromCharCode(0x9d);
    const c1low = String.fromCharCode(0x80);
    const c1high = String.fromCharCode(0x9f);
    const cleaned = sanitizeForTerminal(
      'a' + BEL + 'b' + ESC + 'c' + DEL + 'd' + c1csi + 'e' + c1osc + 'f' + c1low + 'g' + c1high + 'h'
    );
    expect(cleaned).toBe('abcdefgh');
  });

  it('preserves newlines, tabs, and normal Unicode text', () => {
    const input = 'line one\nline two\ttabbed Héllo — 日本語 ☃';
    expect(sanitizeForTerminal(input)).toBe(input);
  });

  it('leaves no executable terminal control sequence in a combined attack', () => {
    const attack =
      'Subject: hi' +
      ESC +
      ']0;pwned' +
      BEL +
      '\nBody ' +
      ESC +
      '[2J' +
      ESC +
      ']8;;http://evil.example' +
      BEL +
      'x' +
      String.fromCharCode(0x9b) +
      '3J' +
      DEL;
    const cleaned = sanitizeForTerminal(attack);
    expect(controlCodes(cleaned)).toEqual([]);
    expect(cleaned).toContain('Subject: hi');
    expect(cleaned).toContain('Body');
    expect(cleaned).toContain('\n');
  });
});
