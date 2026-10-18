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

function makeController(sendMail: SmtpService['sendMail'], acct: AccountConfig | null = account) {
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

  it('rejects an invalid recipient before the transport is constructed', async () => {
    // No `sendMail` spy: we want the real service so we can prove the
    // controller short-circuits *before* the transport factory runs. If
    // validation only lived in the transport, the factory would be
    // invoked and then throw.
    const factory = vi.fn(() => ({ send: async () => {} }) as any);
    const service = new SmtpService({ factory, env: {} });
    const controller = new ComposeController(service, () => account);

    controller.openCompose();
    controller.setTo(['not-an-email']);
    const outcome = await controller.submitCompose();

    expect(outcome.kind).toBe('validation');
    expect(factory).not.toHaveBeenCalled();
    expect(selectors.composeError).toMatch(/To\[0\]/);
    expect(selectors.composeSending).toBe(false);
  });

  it('rejects a CR/LF-injected recipient before the transport is constructed', async () => {
    const factory = vi.fn(() => ({ send: async () => {} }) as any);
    const service = new SmtpService({ factory, env: {} });
    const controller = new ComposeController(service, () => account);

    controller.openCompose();
    controller.setTo(['bob@example.com\r\nBcc: evil@x.com']);
    const outcome = await controller.submitCompose();

    expect(outcome.kind).toBe('validation');
    expect(factory).not.toHaveBeenCalled();
    expect(selectors.composeError).toMatch(/must not contain CR or LF/i);
  });

  it('does not construct a transport when the envelope is otherwise invalid', async () => {
    const factory = vi.fn(() => ({ send: async () => {} }) as any);
    const service = new SmtpService({ factory, env: {} });
    const controller = new ComposeController(service, () => account);

    controller.openCompose();
    controller.setCc(['ok@example.com', 'bad@']);
    const outcome = await controller.submitCompose();

    expect(outcome.kind).toBe('validation');
    expect(factory).not.toHaveBeenCalled();
    expect(selectors.composeError).toMatch(/Cc\[1\]/);
  });
});

describe('ComposeController draft + content policy', () => {
  it('openComposeDraft populates every field atomically and focuses Body', () => {
    const controller = makeController(vi.fn());
    controller.openComposeDraft({
      to: ['alice@example.com'],
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
      subject: 'Re: hello',
      body: 'AI BODY',
    });

    expect(selectors.composeActive).toBe(true);
    expect(selectors.composeTo).toEqual(['alice@example.com']);
    expect(selectors.composeCc).toEqual(['cc@example.com']);
    expect(selectors.composeBcc).toEqual(['bcc@example.com']);
    expect(selectors.composeSubject).toBe('Re: hello');
    expect(selectors.composeBody).toBe('AI BODY');
    expect(selectors.composeFocus).toBe('body');
    // Never sends on its own.
    expect(selectors.composeSending).toBe(false);
  });

  it('openComposeDraft tolerates missing fields', () => {
    const controller = makeController(vi.fn());
    controller.openComposeDraft({ subject: 's' });
    expect(selectors.composeTo).toEqual([]);
    expect(selectors.composeCc).toEqual([]);
    expect(selectors.composeBcc).toEqual([]);
    expect(selectors.composeSubject).toBe('s');
    expect(selectors.composeBody).toBe('');
    expect(selectors.composeFocus).toBe('body');
  });

  it('hasContent reflects any populated field', () => {
    const controller = makeController(vi.fn());
    controller.openCompose();
    expect(controller.hasContent()).toBe(false);

    controller.setBody('   \n  ');
    expect(controller.hasContent()).toBe(false);

    controller.setSubject('hi');
    expect(controller.hasContent()).toBe(true);
  });

  it('hasContent is true for a recipient-only draft', () => {
    const controller = makeController(vi.fn());
    controller.openCompose();
    controller.setTo(['a@example.com']);
    expect(controller.hasContent()).toBe(true);
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
