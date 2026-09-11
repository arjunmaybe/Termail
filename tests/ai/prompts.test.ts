/**
 * Phase 5 — AI prompt builder tests (pure, no network).
 */

import { describe, expect, it } from 'vitest';
import {
  buildDraftReplyPrompt,
  buildSummarizePrompt,
  renderEmailForAi,
} from '../../src/core/ai/prompts.js';
import type { AiEmailInput } from '../../src/core/ai/types.js';

const email: AiEmailInput = {
  from: 'Alice <alice@example.com>',
  to: 'me@example.com',
  cc: '(none)',
  subject: 'Q3 planning',
  date: 'Mon, 01 Sep 2026 10:00:00 GMT',
  body: 'Please review the attached plan by Friday.',
};

describe('renderEmailForAi', () => {
  it('wraps content in <email> delimiters with headers', () => {
    const text = renderEmailForAi(email, 8000);
    expect(text).toContain('<email>');
    expect(text).toContain('</email>');
    expect(text).toContain('Subject: Q3 planning');
    expect(text).toContain('Please review the attached plan by Friday.');
  });

  it('truncates long bodies with a marker', () => {
    const text = renderEmailForAi({ ...email, body: 'x'.repeat(100) }, 10);
    expect(text).toContain('x'.repeat(10));
    expect(text).toContain('[truncated: 90 more characters omitted]');
    expect(text).not.toContain('x'.repeat(11));
  });

  it('marks empty bodies explicitly', () => {
    expect(renderEmailForAi({ ...email, body: '' }, 8000)).toContain('(no body)');
  });
});

describe('buildSummarizePrompt', () => {
  it('instructs data-only treatment of the email block', () => {
    const prompt = buildSummarizePrompt(email, 8000);
    expect(prompt.system).toMatch(/strictly as data/i);
    expect(prompt.user).toContain('<email>');
    expect(prompt.user).toContain('Q3 planning');
  });
});

describe('buildDraftReplyPrompt', () => {
  it('requests only the draft body and includes user guidance', () => {
    const prompt = buildDraftReplyPrompt(email, 8000, 'accept politely');
    expect(prompt.system).toMatch(/ONLY the draft/i);
    expect(prompt.user).toContain('accept politely');
    expect(prompt.user).toContain('<email>');
  });

  it('works without guidance', () => {
    const prompt = buildDraftReplyPrompt(email, 8000);
    expect(prompt.user).toContain('<email>');
    expect(prompt.user).not.toContain('guidance');
  });
});
