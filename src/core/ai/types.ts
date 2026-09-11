/**
 * Phase 5 — AI types.
 *
 * Minimal shapes for AI-assisted email work (summarization and reply
 * drafting). Plain text only. The provider owns HTTP I/O; the service owns
 * prompt building/orchestration; the controller owns TUI state.
 *
 * AI output is always user-controlled display text. It is never executed,
 * never auto-sent, and never persisted to SQLite.
 */

export type AiTask = 'summarize' | 'draft-reply';

/** A single completion call: system instruction + user data payload. */
export interface AiCompletionRequest {
  system: string;
  user: string;
}

/** Injectable provider surface. Tests substitute a fake. */
export interface AiProvider {
  complete(request: AiCompletionRequest): Promise<string>;
}

/** Factory producing a provider bound to one request's credentials. */
export type AiProviderFactory = (args: {
  endpoint: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
}) => AiProvider;

/** Plain-text email snapshot handed to the AI service (no DB types). */
export interface AiEmailInput {
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  body: string;
}

export type AiOutcome =
  | { kind: 'ok'; text: string }
  | { kind: 'validation'; message: string }
  | { kind: 'auth'; message: string }
  | { kind: 'network'; message: string };
