/**
 * The demo's LLM provider: Claude, through the Anthropic SDK. One call is one
 * streamed Messages API request whose text deltas come out as a
 * `ReadableStream<string>` — a source `pipeGenUi` accepts as is. Cancelling
 * that stream (which `pipeGenUi` does on `stop()`, or when the client goes
 * away) aborts the request, so a stopped message stops costing tokens.
 */
import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_MODEL = "claude-opus-5-5";

/**
 * Generous for a chat turn with a few UI blocks; thinking tokens count
 * toward it too. It also caps what one request can cost.
 */
const MAX_TOKENS = 8192;

export interface ClaudeCall {
  /** The response's text as it streams. Cancelling it aborts the request. */
  readonly text: ReadableStream<string>;
  /**
   * Resolves once the API has accepted the request (HTTP 200); rejects with
   * the SDK's error otherwise (bad key, rate limit, overload, …).
   */
  readonly connected: Promise<void>;
}

export interface ClaudeRequest {
  readonly client: Anthropic;
  readonly model: string;
  readonly system: string;
  readonly messages: Anthropic.Beta.BetaMessageParam[];
}

export function callClaude({ client, model, system, messages }: ClaudeRequest): ClaudeCall {
  const stream = client.beta.messages.stream({
    model,
    max_tokens: MAX_TOKENS,
    system,
    messages,
    // Snappy chat turns: the UI contract is in the prompt, so low effort
    // (less thinking before the first token) is plenty.
    output_config: { effort: "low" },
    // The system prompt is the same on every request; cache the prefix.
    cache_control: { type: "ephemeral" },
    // On a safety refusal, let the API retry on a fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  const connected = stream.withResponse().then(() => {});
  // Awaited by the caller; never an unhandled rejection when it isn't.
  connected.catch(() => {});

  const events = stream[Symbol.asyncIterator]();
  let cancelled = false;
  const text = new ReadableStream<string>({
    // A failure mid-response (e.g. overloaded) errors this stream, and so the
    // piped response: the client's `onStreamError` reports it.
    async pull(controller) {
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- events are sequential
        const { done, value: event } = await events.next();
        if (cancelled) return;
        if (done) {
          controller.close();
          return;
        }
        if (event.type === "message_delta" && event.delta.stop_reason !== "end_turn") {
          // A refusal (after any fallback) or the length cap: the message
          // just ends there; an open block is reported as cut off.
          console.log(`[claude] stopped early: ${event.delta.stop_reason}`);
        }
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          controller.enqueue(event.delta.text);
          return;
        }
      }
    },
    cancel() {
      cancelled = true;
      stream.abort();
    },
  });

  return { text, connected };
}

/** A failed request, as the demo server's JSON error response. */
export function describeApiError(error: unknown): { status: number; message: string } {
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 502;
    if (status === 401 || status === 403) {
      return { status: 502, message: "The server's ANTHROPIC_API_KEY was rejected." };
    }
    if (status === 429) {
      return { status: 429, message: "Claude is rate-limited right now — try again shortly." };
    }
    return { status: 502, message: `Claude API error ${status}: ${error.message}` };
  }
  return { status: 502, message: "Could not reach the Claude API." };
}
