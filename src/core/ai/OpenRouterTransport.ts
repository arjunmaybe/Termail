/**
 * Phase 5 — OpenRouter HTTPS transport over native `fetch`.
 *
 * Minimal chat-completions client: one POST per `complete()` call, no
 * streaming/SSE, per-request timeout via `AbortController`. The `fetch`
 * implementation is injectable so tests run fully offline with fakes.
 *
 * The API key travels only in the `Authorization` header and is redacted
 * from every thrown error and every log payload.
 */

import { AuthenticationError, NetworkError, getErrorMessage } from '../utils/errors.js';
import type { AiCompletionRequest, AiProvider } from './types.js';

export type FetchFn = typeof fetch;

export interface OpenRouterTransportOptions {
  endpoint: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  fetchFn?: FetchFn;
}

interface ChatCompletionsResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
  error?: { message?: unknown };
}

function redactKey(message: string, apiKey: string): string {
  if (!apiKey) return message;
  return message.split(apiKey).join('***');
}

/** Parse an OpenRouter chat-completions body into plain text. */
export function parseCompletionBody(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    throw new NetworkError('AI provider returned a malformed response (not an object)');
  }
  const parsed = body as ChatCompletionsResponse;
  if (parsed.error !== undefined && parsed.error !== null) {
    const detail =
      typeof parsed.error === 'object' && parsed.error !== null
        ? String((parsed.error as { message?: unknown }).message ?? 'unknown provider error')
        : String(parsed.error);
    throw new NetworkError(`AI provider error: ${detail.slice(0, 300)}`);
  }
  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new NetworkError('AI provider returned an empty or malformed response');
  }
  return content;
}

export class OpenRouterTransport implements AiProvider {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;

  constructor(options: OpenRouterTransportOptions) {
    this.endpoint = options.endpoint;
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async complete(request: AiCompletionRequest): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new NetworkError(`AI request timed out after ${this.timeoutMs}ms`);
      }
      throw new NetworkError(
        `AI request failed: ${redactKey(getErrorMessage(error), this.apiKey)}`
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
      throw new AuthenticationError(
        'AI authentication failed: the provider rejected the API key. ' +
          'Check the TERMAIL_AI_API_KEY environment variable.'
      );
    }
    if (response.status === 429) {
      throw new NetworkError('AI request was rate-limited (429). Try again later.');
    }
    if (!response.ok) {
      let preview = '';
      try {
        preview = (await response.text()).slice(0, 300);
      } catch {
        preview = '';
      }
      throw new NetworkError(
        `AI request failed with status ${response.status}` +
          (preview ? `: ${redactKey(preview, this.apiKey)}` : '')
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new NetworkError(
        `AI provider returned invalid JSON: ${redactKey(getErrorMessage(error), this.apiKey)}`
      );
    }
    return parseCompletionBody(body);
  }
}

export const __testing = { parseCompletionBody };
