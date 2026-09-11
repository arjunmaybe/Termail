/**
 * Phase 4 — ComposeController + compose/search state isolation tests.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposeController } from '../../src/app/services/ComposeController.js';
import { SmtpService } from '../../src/core/smtp/SmtpService.js';
import { actions, selectors } from '../../src/core/state/AppState.js';
import type { AccountConfig } from '../../src/core/types/config.js';

const account: AccountConfig = {
  id: 'work',
  name: 'Work',
  email: 'me@example.com',
  enabled: true,
  host: 'imap.example.com',
  port: 993,
  useTls: true,
  authType: 'password',
  smtpHost: 'smtp.example.com',
  smtpPort: 465,
  smtpMode: 'implicit-tls',
};

function makeController(sendMail: ReturnType<typeof vi.fn>, acct: AccountConfig | null = account) {
  const service = new SmtpService({
    factory: () => ({ send: async () => {} }) as any,
    env: {},
  });
  vi.spyOn(service, 'sendMail').mockImplementation(sendMail);
  return new ComposeController(service, () => acct);
}

beforeEach(() => {
  actions.reset();
});

describe('compose state isolation', () => {
  it('openCompose does not touch search state and vice versa', () => {
    actions.setSearchActive(true);
    actions.setSearchQuery('hello');
    const controller = makeController(vi.fn());
    controller.openCompose();
    expect(selectors.composeActive).toBe(true);
    // Search untouched.
    expect(selectors.searchActive).toBe(true);
    expect(selectors.searchQuery).toBe('hello');

    actions.setComposeSubject('s');
    controller.cancelCompose();
    expect(selectors.composeActive).toBe(false);
    expect(selectors.composeSubject).toBe('');
    // Search still untouched.
    expect(selectors.searchActive).toBe(true);
    expect(selectors.searchQuery).toBe('hello');
  });

  it('reset clears both compose and search', () => {
    actions.setSearchActive(true);
    actions.setSearchQuery('q');
    actions.openCompose();
    actions.setComposeSubject('s');
    actions.reset();
    expect(selectors.searchActive).toBe(false);
    expect(selectors.composeActive).toBe(false);
    expect(selectors.composeSubject).toBe('');
  });
});

describe('ComposeController validation', () => {
  it('requires an account', async () => {
    const sendMail = vi.fn();
    const controller = makeController(sendMail, null);
    controller.openCompose();
    controller.setTo(['a@example.com']);
    const outcome = await controller.submitCompose();
    expect(outcome.kind).toBe('validation');
    expect(sendMail).not.toHaveBeenCalled();
    expect(selectors.composeError).toMatch(/No account/i);
  });

  it('requires at least one recipient', async () => {
    const sendMail = vi.fn();
    const controller = makeController(sendMail);
    controller.openCompose();
    const outcome = await controller.submitCompose();
    expect(outcome.kind).toBe('validation');
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('blocks concurrent sends', async () => {
    const sendMail = vi.fn().mockImplementation(() => new Promise(() => {}));
    const controller = makeController(sendMail);
    controller.openCompose();
    controller.setTo(['a@example.com']);
    const first = controller.submitCompose();
    const second = await controller.submitCompose();
    expect(second.kind).toBe('network');
    expect(second).toMatchObject({ message: expect.stringMatching(/in progress/i) });
    actions.setComposeSending(false);
    await Promise.race([first, Promise.resolve()]);
  });
});

describe('ComposeController send outcomes', () => {
  it('marks sent on success and clears the error', async () => {
    const sendMail = vi.fn().mockResolvedValue({ kind: 'ok' });
    const controller = makeController(sendMail);
    controller.openCompose();
    controller.setTo(['to@example.com']);
    controller.setCc(['cc@example.com']);
    controller.setBcc(['hidden@example.com']);
    controller.setSubject('hi');
    controller.setBody('hello');
    const outcome = await controller.submitCompose();
    expect(outcome).toEqual({ kind: 'ok' });
    expect(sendMail).toHaveBeenCalledWith(account, {
      from: 'me@example.com',
      to: ['to@example.com'],
      cc: ['cc@example.com'],
      bcc: ['hidden@example.com'],
      subject: 'hi',
      body: 'hello',
    });
    expect(selectors.composeSent).toBe(true);
    expect(selectors.composeError).toBeNull();
    expect(selectors.composeSending).toBe(false);
  });

  it('surfaces auth/network failures and never exposes the password', async () => {
    const sendMail = vi
      .fn()
      .mockResolvedValue({ kind: 'auth', message: 'SMTP authentication failed: ***' });
    const controller = makeController(sendMail);
    controller.openCompose();
    controller.setTo(['to@example.com']);
    const outcome = await controller.submitCompose();
    expect(outcome.kind).toBe('auth');
    expect(selectors.composeSent).toBe(false);
    expect(selectors.composeError).toContain('***');
    expect(selectors.composeError).not.toContain('dummy-password-123');
  });

  it('cancel clears the buffer and sending flag', () => {
    const controller = makeController(vi.fn());
    controller.openCompose();
    controller.setTo(['a@example.com']);
    controller.setSubject('s');
    controller.cancelCompose();
    expect(selectors.composeActive).toBe(false);
    expect(selectors.composeTo).toEqual([]);
    expect(selectors.composeSubject).toBe('');
    expect(selectors.composeSending).toBe(false);
  });
});
