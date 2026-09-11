/**
 * Phase 4 — `ComposeController`.
 *
 * TUI-side orchestrator for minimal compose (To/Cc/Bcc/Subject/body).
 * Mirrors `SearchController` layering:
 *
 *   - Owns no SQL and no sockets. Reads/writes `AppState` compose signals
 *     only (never search signals) and delegates sending to `SmtpService`.
 *   - The `from` address always comes from the current account; callers
 *     never supply it.
 *   - No drafts persistence, no Sent-folder writes, no background sending.
 */

import { SmtpService, type SendOutcome } from '../../core/smtp/SmtpService.js';
import { actions, selectors } from '../../core/state/AppState.js';
import type { AccountConfig } from '../../core/types/config.js';
import { logger } from '../../core/utils/logger.js';

export type AccountProvider = () => AccountConfig | null;

export class ComposeController {
  private readonly service: SmtpService;
  private readonly getAccount: AccountProvider;

  constructor(service: SmtpService, getAccount: AccountProvider) {
    this.service = service;
    this.getAccount = getAccount;
  }

  /** Open compose with a cleared buffer. Does not touch search state. */
  openCompose(): void {
    actions.openCompose();
  }

  /** Close compose and clear the buffer. Does not touch search state. */
  cancelCompose(): void {
    actions.clearCompose();
  }

  setTo(to: string[]): void {
    actions.setComposeTo(to);
  }

  setCc(cc: string[]): void {
    actions.setComposeCc(cc);
  }

  setBcc(bcc: string[]): void {
    actions.setComposeBcc(bcc);
  }

  setSubject(subject: string): void {
    actions.setComposeSubject(subject);
  }

  setBody(body: string): void {
    actions.setComposeBody(body);
  }

  isActive(): boolean {
    return selectors.composeActive;
  }

  isSending(): boolean {
    return selectors.composeSending;
  }

  /**
   * Validate locally, then delegate to `SmtpService`. Maps the outcome to
   * compose signals. Never throws for validation/auth/network failures;
   * unexpected exceptions become a `network`-style compose error.
   */
  async submitCompose(): Promise<SendOutcome> {
    if (selectors.composeSending) {
      return { kind: 'network', message: 'Send already in progress' };
    }
    const account = this.getAccount();
    if (!account) {
      const outcome: SendOutcome = { kind: 'validation', message: 'No account selected' };
      actions.setComposeError(outcome.message);
      return outcome;
    }

    const to = selectors.composeTo;
    const cc = selectors.composeCc;
    const bcc = selectors.composeBcc;
    if (to.length + cc.length + bcc.length === 0) {
      const outcome: SendOutcome = {
        kind: 'validation',
        message: 'At least one recipient (To, Cc, or Bcc) is required',
      };
      actions.setComposeError(outcome.message);
      return outcome;
    }

    actions.setComposeSending(true);
    actions.setComposeError(null);
    let outcome: SendOutcome;
    try {
      outcome = await this.service.sendMail(account, {
        from: account.email,
        to: [...to],
        cc: [...cc],
        bcc: [...bcc],
        subject: selectors.composeSubject,
        body: selectors.composeBody,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Compose send threw unexpectedly', { accountId: account.id });
      outcome = { kind: 'network', message };
    } finally {
      actions.setComposeSending(false);
    }

    if (outcome.kind === 'ok') {
      actions.setComposeSent(true);
      actions.setComposeError(null);
    } else {
      actions.setComposeSent(false);
      actions.setComposeError(outcome.message);
    }
    return outcome;
  }
}
