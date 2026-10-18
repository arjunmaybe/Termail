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

import { validateAddress } from '../../core/smtp/message.js';
import type { SendOutcome, SmtpService } from '../../core/smtp/SmtpService.js';
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

  /**
   * Open compose already populated with a draft (used by the AI reply
   * flow). Recipients, subject, and body are applied atomically and the
   * Body field takes focus once the native editor has received the text,
   * so an AI-prefilled draft never lands half-applied or with the wrong
   * focus. Never sends.
   */
  openComposeDraft(draft: {
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    body?: string;
  }): void {
    actions.openComposeWith({
      to: draft.to ?? [],
      cc: draft.cc ?? [],
      bcc: draft.bcc ?? [],
      subject: draft.subject ?? '',
      body: draft.body ?? '',
      focus: 'body',
    });
  }

  /**
   * True when any composer field holds content. Used by the discard
   * policy: an empty composer closes immediately, a non-empty one asks
   * for confirmation.
   */
  hasContent(): boolean {
    return (
      selectors.composeTo.length > 0 ||
      selectors.composeCc.length > 0 ||
      selectors.composeBcc.length > 0 ||
      selectors.composeSubject.trim().length > 0 ||
      selectors.composeBody.trim().length > 0
    );
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

    // Validate every recipient locally *before* the SMTP service builds a
    // transport. The transport builder re-validates as a backstop, but
    // rejecting here guarantees a malformed address (including CR/LF
    // injection) never reaches the constructor or opens a socket.
    const recipientGroups: Array<{ field: string; values: string[] }> = [
      { field: 'To', values: to },
      { field: 'Cc', values: cc },
      { field: 'Bcc', values: bcc },
    ];
    for (const { field, values } of recipientGroups) {
      for (let i = 0; i < values.length; i += 1) {
        const value = values[i] as string;
        try {
          validateAddress(value, `${field}[${i}]`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const outcome: SendOutcome = { kind: 'validation', message };
          actions.setComposeError(message);
          return outcome;
        }
      }
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
