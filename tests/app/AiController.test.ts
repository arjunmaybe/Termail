/**
 * Phase 5 — AiController tests with a fake AiService (no network).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiController } from '../../src/app/services/AiController.js';
import { AiService } from '../../src/core/ai/AiService.js';
import type { AiOutcome } from '../../src/core/ai/types.js';
import { actions, selectors } from '../../src/core/state/AppState.js';
import type { PersistedEmail } from '../../src/core/database/index.js';
import { DEFAULT_AI_CONFIG } from '../../src/core/types/config.js';

function makeEmail(over: Partial<PersistedEmail> = {}): PersistedEmail {
  return {
    id: 'email-1',
    accountId: 'work',
    folderId: 'work:INBOX',
    messageId: '<m-1@example.com>',
    fromAddresses: [{ name: 'Alice', address: 'alice@example.com' }],
    toAddresses: [{ name: '', address: 'me@example.com' }],
    ccAddresses: [],
    subject: 'Q3 planning',
    date: 1788295200,
    internalDate: null,
    receivedAt: null,
    isRead: false,
    isFlagged: false,
    isAnswered: false,
    isDraft: false,
    hasAttachments: false,
    size: 100,
    bodyText: 'Please review by Friday.',
    bodyHtml: null,
    headers: {},
    attachments: [],
    flags: [],
    uid: 1,
    createdAt: 1788295200,
    updatedAt: 1788295200,
    ...over,
  };
}

function makeController(
  summarizeImpl: () => Promise<AiOutcome>,
  email: PersistedEmail | null = makeEmail()
) {
  const service = new AiService({ config: { ...DEFAULT_AI_CONFIG, enabled: true } });
  const spy = vi.spyOn(service, 'summarizeEmail').mockImplementation(summarizeImpl);
  vi.spyOn(service, 'draftReply').mockImplementation(async () => ({
    kind: 'network',
    message: 'unused in summarize path',
  }));
  return { controller: new AiController(service, () => email), spy };
}

beforeEach(() => {
  actions.reset();
});

describe('AiController validation', () => {
  it('requires a selected email', async () => {
    const summarizeEmail = vi.fn();
    const service = new AiService({ config: { ...DEFAULT_AI_CONFIG, enabled: true } });
    vi.spyOn(service, 'summarizeEmail').mockImplementation(summarizeEmail);
    const controller = new AiController(service, () => null);
    const outcome = await controller.summarizeSelected();
    expect(outcome.kind).toBe('validation');
    expect(summarizeEmail).not.toHaveBeenCalled();
    expect(selectors.aiError).toMatch(/No email selected/i);
  });

  it('blocks concurrent requests', async () => {
    const { controller } = makeController(() => new Promise<AiOutcome>(() => {}));
    const first = controller.summarizeSelected();
    const second = await controller.summarizeSelected();
    expect(second.kind).toBe('network');
    expect(second).toMatchObject({ message: expect.stringMatching(/already in progress/i) });
    actions.setAiLoading(false);
    await Promise.race([first, Promise.resolve()]);
  });
});

describe('AiController outcomes', () => {
  it('stores summary results with the email id', async () => {
    const { controller, spy } = makeController(async () => ({ kind: 'ok', text: 'Summary.' }));
    const outcome = await controller.summarizeSelected();
    expect(outcome).toEqual({ kind: 'ok', text: 'Summary.' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(selectors.aiMode).toBe('summary');
    expect(selectors.aiResult).toBe('Summary.');
    expect(selectors.aiEmailId).toBe('email-1');
    expect(selectors.aiError).toBeNull();
    expect(selectors.aiLoading).toBe(false);
  });

  it('stores draft results without touching compose state', async () => {
    const service = new AiService({ config: { ...DEFAULT_AI_CONFIG, enabled: true } });
    vi.spyOn(service, 'draftReply').mockResolvedValue({ kind: 'ok', text: 'Draft.' });
    const controller = new AiController(service, () => makeEmail());
    const outcome = await controller.draftReplySelected('accept');
    expect(outcome).toEqual({ kind: 'ok', text: 'Draft.' });
    expect(selectors.aiMode).toBe('draft');
    expect(selectors.composeBody).toBe('');
    expect(selectors.composeActive).toBe(false);
  });

  it('surfaces failures and clears stale results', async () => {
    const { controller } = makeController(async () => ({ kind: 'network', message: 'boom' }));
    const outcome = await controller.summarizeSelected();
    expect(outcome.kind).toBe('network');
    expect(selectors.aiResult).toBeNull();
    expect(selectors.aiMode).toBeNull();
    expect(selectors.aiEmailId).toBeNull();
    expect(selectors.aiError).toBe('boom');
    expect(selectors.aiLoading).toBe(false);
  });

  it('clearAi resets AI state without touching search/compose', async () => {
    const { controller } = makeController(async () => ({ kind: 'ok', text: 'S.' }));
    actions.setSearchActive(true);
    actions.setSearchQuery('q');
    await controller.summarizeSelected();
    controller.clearAi();
    expect(selectors.aiResult).toBeNull();
    expect(selectors.aiMode).toBeNull();
    expect(selectors.searchActive).toBe(true);
    expect(selectors.searchQuery).toBe('q');
  });
});
