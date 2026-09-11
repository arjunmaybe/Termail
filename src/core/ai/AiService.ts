/**
 * Phase 5 — `AiService`.
 *
 * Thin orchestrator between configuration/credentials and the injectable AI
 * provider. Mirrors the `SmtpService` outcome pattern:
 *
 * - Refuses to run when `ai.enabled` is false (opt-in only).
 * - Resolves the API key from `TERMAIL_AI_API_KEY` at call time.
 * - Maps provider errors to a typed `AiOutcome` with redacted messages.
 * - Output is display text only: never executed, never auto-sent, never
 *   persisted to SQLite. Reply drafts go to the compose buffer for review.
 */

import { resolveAiApiKey } from './credentials.js';
import { OpenRouterTransport, type FetchFn } from './OpenRouterTransport.js';
import { buildDraftReplyPrompt, buildSummarizePrompt } from './prompts.js';
import type { AiEmailInput, AiOutcome, AiProviderFactory } from './types.js';
import type { AiConfig } from '../types/config.js';
import {
  AuthenticationError,
  NetworkError,
  ValidationError,
  getErrorMessage,
} from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const defaultFactory: AiProviderFactory = (args) =>
  new OpenRouterTransport({
    endpoint: args.endpoint,
    model: args.model,
    apiKey: args.apiKey,
    timeoutMs: args.timeoutMs,
  });

export interface AiServiceOptions {
  config: AiConfig;
  factory?: AiProviderFactory;
  env?: NodeJS.ProcessEnv;
  fetchFn?: FetchFn;
}

export class AiService {
  private readonly config: AiConfig;
  private readonly factory: AiProviderFactory;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: AiServiceOptions) {
    this.config = options.config;
    this.env = options.env ?? process.env;
    if (options.factory !== undefined) {
      this.factory = options.factory;
    } else if (options.fetchFn !== undefined) {
      // Test path: default OpenRouter transport with an injected fetch fake.
      const fetchFn = options.fetchFn;
      this.factory = (args) => new OpenRouterTransport({ ...args, fetchFn });
    } else {
      this.factory = defaultFactory;
    }
  }

  /** Summarize one email. Input must carry at least a subject or a body. */
  async summarizeEmail(email: AiEmailInput): Promise<AiOutcome> {
    const gate = this.checkEnabled();
    if (gate) return gate;
    const content = this.checkHasContent(email);
    if (content) return content;

    return this.run(buildSummarizePrompt(email, this.config.maxBodyChars), 'summarize');
  }

  /** Draft a reply to one email. The caller routes output to compose. */
  async draftReply(email: AiEmailInput, instruction?: string): Promise<AiOutcome> {
    const gate = this.checkEnabled();
    if (gate) return gate;
    const content = this.checkHasContent(email);
    if (content) return content;

    return this.run(
      buildDraftReplyPrompt(email, this.config.maxBodyChars, instruction),
      'draft-reply'
    );
  }

  private checkEnabled(): AiOutcome | null {
    if (!this.config.enabled) {
      return {
        kind: 'validation',
        message: 'AI assistance is disabled. Enable it in the "ai" section of the config file.',
      };
    }
    return null;
  }

  private checkHasContent(email: AiEmailInput): AiOutcome | null {
    if (email.subject.trim().length === 0 && email.body.trim().length === 0) {
      return { kind: 'validation', message: 'Nothing to process: the email has no subject or body' };
    }
    return null;
  }

  private async run(
    request: { system: string; user: string },
    task: 'summarize' | 'draft-reply'
  ): Promise<AiOutcome> {
    let apiKey: string;
    try {
      apiKey = resolveAiApiKey(this.env);
    } catch (error) {
      return { kind: 'auth', message: getErrorMessage(error) };
    }

    const provider = this.factory({
      endpoint: this.config.endpoint,
      model: this.config.model,
      apiKey,
      timeoutMs: this.config.requestTimeoutMs,
    });

    try {
      const text = await provider.complete(request);
      logger.info('AI request completed', { task, chars: text.length });
      return { kind: 'ok', text };
    } catch (error) {
      return mapAiError(error, apiKey);
    }
  }
}

function redactKey(message: string, apiKey: string): string {
  if (!apiKey) return message;
  return message.split(apiKey).join('***');
}

function mapAiError(error: unknown, apiKey: string): AiOutcome {
  if (error instanceof ValidationError) {
    return { kind: 'validation', message: redactKey(error.message, apiKey) };
  }
  if (error instanceof AuthenticationError) {
    return { kind: 'auth', message: redactKey(error.message, apiKey) };
  }
  if (error instanceof NetworkError) {
    return { kind: 'network', message: redactKey(error.message, apiKey) };
  }
  return { kind: 'network', message: redactKey(getErrorMessage(error), apiKey) };
}
