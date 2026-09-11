/**
 * Phase 5 — `AiController`.
 *
 * TUI-side orchestrator for AI assistance (summarize + reply drafting).
 * Mirrors `ComposeController` layering:
 *
 *   - Owns no SQL and no HTTP. Reads the selected email from `AppState`
 *     via an injected provider and delegates to `AiService`.
 *   - Writes `ai*` signals only (never search/compose signals). Routing a
 *     draft into the compose flow is the caller's job (see `App`), so this
 *     controller can never send anything.
 *   - AI output is display text only.
 */

import type { PersistedEmail } from '../../core/database/index.js';
import { AiService } from '../../core/ai/AiService.js';
import type { AiEmailInput, AiOutcome } from '../../core/ai/types.js';
import type { EmailAddress } from '../../core/types/email.js';
import { actions, selectors } from '../../core/state/AppState.js';
import { logger } from '../../core/utils/logger.js';

export type SelectedEmailProvider = () => PersistedEmail | null;

export class AiController {
  private readonly service: AiService;
  private readonly getEmail: SelectedEmailProvider;

  constructor(service: AiService, getEmail: SelectedEmailProvider) {
    this.service = service;
    this.getEmail = getEmail;
  }

  /** Clear any AI result/error. Does not touch search/compose state. */
  clearAi(): void {
    actions.clearAi();
  }

  isLoading(): boolean {
    return selectors.aiLoading;
  }

  /**
   * Summarize the currently selected email. Maps the outcome to the `ai*`
   * signals. Never throws for validation/auth/network failures.
   */
  async summarizeSelected(): Promise<AiOutcome> {
    return this.runForSelected('summary');
  }

  /**
   * Draft a reply to the currently selected email. The returned text is
   * for the caller to route into compose; this method never touches
   * compose state and never sends.
   */
  async draftReplySelected(instruction?: string): Promise<AiOutcome> {
    return this.runForSelected('draft', instruction);
  }

  private async runForSelected(
    mode: 'summary' | 'draft',
    instruction?: string
  ): Promise<AiOutcome> {
    if (selectors.aiLoading) {
      return { kind: 'network', message: 'AI request already in progress' };
    }
    const email = this.getEmail();
    if (!email) {
      const outcome: AiOutcome = { kind: 'validation', message: 'No email selected' };
      actions.setAiError(outcome.message);
      return outcome;
    }

    actions.setAiLoading(true);
    actions.setAiError(null);
    let outcome: AiOutcome;
    try {
      const input = toAiInput(email);
      outcome =
        mode === 'summary'
          ? await this.service.summarizeEmail(input)
          : await this.service.draftReply(input, instruction);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('AI request threw unexpectedly', { task: mode });
      outcome = { kind: 'network', message };
    } finally {
      actions.setAiLoading(false);
    }

    if (outcome.kind === 'ok') {
      actions.setAiMode(mode);
      actions.setAiResult(outcome.text);
      actions.setAiEmailId(email.id);
      actions.setAiError(null);
    } else {
      actions.setAiMode(null);
      actions.setAiResult(null);
      actions.setAiEmailId(null);
      actions.setAiError(outcome.message);
    }
    return outcome;
  }
}

/** Project a persisted email down to the plain-text AI input shape. */
export function toAiInput(email: PersistedEmail): AiEmailInput {
  return {
    from: formatAddresses(email.fromAddresses),
    to: formatAddresses(email.toAddresses),
    cc: formatAddresses(email.ccAddresses),
    subject: email.subject,
    date: new Date(email.date * 1000).toUTCString(),
    body: email.bodyText ?? '',
  };
}

function formatAddresses(addrs: ReadonlyArray<EmailAddress>): string {
  if (addrs.length === 0) return '(none)';
  return addrs
    .map((a) => (a.name && a.name.length > 0 ? `${a.name} <${a.address}>` : a.address))
    .join(', ');
}
