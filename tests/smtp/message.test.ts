/**
 * Phase 4 — message builder tests (pure, no network).
 */

import { describe, expect, it } from 'vitest';
import {
  buildEnvelopePayload,
  buildMessage,
  dotStuffBody,
  normalizeBodyLines,
  validateAddress,
} from '../../src/core/smtp/message.js';
import { ValidationError } from '../../src/core/utils/errors.js';

describe('validateAddress', () => {
  it('accepts normal addresses', () => {
    expect(validateAddress('bob@example.com', 'To[0]')).toBe('bob@example.com');
  });

  it('rejects empty and malformed addresses', () => {
    expect(() => validateAddress('', 'To[0]')).toThrow(ValidationError);
    expect(() => validateAddress('not-an-email', 'To[0]')).toThrow(ValidationError);
    expect(() => validateAddress('a@', 'To[0]')).toThrow(ValidationError);
  });

  it('rejects CR/LF injection', () => {
    expect(() => validateAddress('bob@example.com\r\nBcc: evil@x.com', 'To[0]')).toThrow(
      ValidationError
    );
    expect(() => validateAddress('bob\n@example.com', 'To[0]')).toThrow(ValidationError);
  });
});

describe('header injection', () => {
  it('rejects CR/LF in subject', () => {
    expect(() =>
      buildMessage({
        from: 'me@example.com',
        to: ['bob@example.com'],
        subject: 'hi\r\nBcc: evil@x.com',
        body: 'hello',
      })
    ).toThrow(ValidationError);
  });

  it('rejects CR/LF in From', () => {
    expect(() =>
      buildMessage({
        from: 'me@example.com\r\nX: 1',
        to: ['bob@example.com'],
        subject: 'hi',
        body: 'hello',
      })
    ).toThrow(ValidationError);
  });
});

describe('normalizeBodyLines / dot-stuffing', () => {
  it('normalizes lone LF/CR to CRLF', () => {
    expect(normalizeBodyLines('a\nb\rc\r\nd')).toBe('a\r\nb\r\nc\r\nd');
  });

  it('dot-stuffs lines starting with a dot', () => {
    expect(dotStuffBody('.hello\n..world\nok')).toBe('..hello\r\n...world\r\nok');
  });

  it('handles empty body', () => {
    expect(dotStuffBody('')).toBe('');
  });
});

describe('buildMessage', () => {
  it('generates required headers with CRLF framing', () => {
    const built = buildMessage({
      from: 'me@example.com',
      to: ['bob@example.com'],
      cc: ['cc@example.com'],
      subject: 'Hello',
      body: 'line1\nline2',
      date: new Date('2026-01-02T03:04:05Z'),
      messageId: '<test-123@example.com>',
    });
    expect(built.raw).toContain('From: me@example.com\r\n');
    expect(built.raw).toContain('To: bob@example.com\r\n');
    expect(built.raw).toContain('Cc: cc@example.com\r\n');
    expect(built.raw).toContain('Subject: Hello\r\n');
    expect(built.raw).toContain('Date: ');
    expect(built.raw).toContain('Message-ID: <test-123@example.com>\r\n');
    expect(built.raw).toContain('MIME-Version: 1.0\r\n');
    expect(built.raw).toContain('Content-Type: text/plain; charset=utf-8\r\n');
    expect(built.raw).toContain('line1\r\nline2');
    expect(built.raw).not.toContain('Bcc:');
    expect(built.envelopeRecipients).toEqual(['bob@example.com', 'cc@example.com']);
  });

  it('preserves Unicode bodies', () => {
    const body = 'héllo wörld ✓ emoji 🎉';
    const built = buildMessage({
      from: 'me@example.com',
      to: ['bob@example.com'],
      subject: 'uni',
      body,
    });
    expect(built.raw).toContain(body);
  });

  it('omits Cc header when empty', () => {
    const built = buildMessage({
      from: 'me@example.com',
      to: ['bob@example.com'],
      subject: 's',
      body: 'b',
    });
    expect(built.raw).not.toContain('Cc:');
  });

  it('generates a UUID-based Message-ID with the sender domain', () => {
    const built = buildMessage({
      from: 'me@example.com',
      to: ['bob@example.com'],
      subject: 's',
      body: 'b',
    });
    const match = /Message-ID: (<[^>\r\n]+>)\r\n/.exec(built.raw);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(
      /^<[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@example\.com>$/i
    );
  });
});

describe('buildEnvelopePayload (BCC)', () => {
  it('excludes BCC from headers but includes it in envelope recipients', () => {
    const built = buildEnvelopePayload({
      from: 'me@example.com',
      to: ['to@example.com'],
      cc: ['cc@example.com'],
      bcc: ['hidden@example.com', 'hidden2@example.com'],
      subject: 's',
      body: 'b',
    });
    expect(built.raw).not.toMatch(/hidden@example\.com/);
    expect(built.raw).not.toMatch(/hidden2@example\.com/);
    expect(built.raw).not.toContain('Bcc:');
    expect(built.envelopeRecipients).toEqual([
      'to@example.com',
      'cc@example.com',
      'hidden@example.com',
      'hidden2@example.com',
    ]);
  });

  it('validates BCC addresses', () => {
    expect(() =>
      buildEnvelopePayload({
        from: 'me@example.com',
        to: ['to@example.com'],
        cc: [],
        bcc: ['bad\r\n@example.com'],
        subject: 's',
        body: 'b',
      })
    ).toThrow(ValidationError);
  });
});
