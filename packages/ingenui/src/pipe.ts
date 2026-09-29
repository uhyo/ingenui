/**
 * `pipeGenUi` — validate a model's stream on the server while passing it
 * through to the client unchanged.
 *
 * The typical server route streams the LLM provider's text to the client as
 * the response body; `pipeGenUi` sits in between, feeding every chunk to a
 * {@link createGenUiValidator | validator} before forwarding it. Issues fire
 * the moment they are parsed (before the client has even received the chunk
 * that completes them), and are available as a whole once the stream ends —
 * so the server can log them, and build the model's feedback itself rather
 * than trusting a report sent back by the client.
 *
 * The server can also act on an issue: `stop()` cancels the source and ends
 * the message normally (the client sees a message that ended, not a broken
 * response), and a `continuation` lets the app pipe a follow-up response
 * (e.g. a new request asking the model to continue) into the same message.
 * Everything stays plain text: the client re-derives every parse-time issue
 * from what it receives, so nothing but the text goes over the wire.
 *
 * React-free; works in any runtime with Web Streams (Node 20+, Deno, Bun,
 * Cloudflare Workers, …).
 */

import type { JsxStreamSource } from "@ingenui/incremental-jsx-parser/core";

import type { GenUiIssue } from "./issues";
import type { GenUiSchema } from "./schema";
import { createGenUiValidator } from "./validator";

/** The state of a piped message: at a stop, and once it has ended. */
export interface GenUiPipeSnapshot {
  /**
   * All the text forwarded to the consumer so far: every source's text, plus
   * the fence-closing text inserted before a continuation.
   */
  readonly text: string;
  /**
   * The last clean boundary in `text`: where the opening fence line of the
   * first `ui+jsx` block with issues (or of a block still open) starts, or
   * `text.length` when there is none. Everything before it is plain Markdown
   * and issue-free blocks.
   */
  readonly cleanOffset: number;
  /** `text.slice(0, cleanOffset)`. */
  readonly cleanText: string;
  /** The issues found so far. */
  readonly issues: readonly GenUiIssue[];
  /** The issues formatted as feedback for the model, or `null` when clean. */
  readonly issueReport: string | null;
  /** How many times the message has been stopped (counting this stop). */
  readonly stops: number;
}

/** What {@link GenUiPipe.done} resolves with. */
export interface GenUiPipeResult extends GenUiPipeSnapshot {
  /**
   * How the message ended:
   * - `"complete"`: the (last) source ended by itself;
   * - `"stopped"`: it was stopped and not continued;
   * - `"cancelled"`: the consumer cancelled the stream (end-of-message
   *   checks such as unclosed fences were skipped).
   */
  readonly status: "complete" | "stopped" | "cancelled";
}

/** The source to continue a stopped message with, or `null` to end it there. */
export type GenUiContinuation = JsxStreamSource | null | undefined;

export interface GenUiPipeOptions {
  /**
   * Called for every issue, synchronously, as soon as it is found — before
   * the chunk that completed it is forwarded. Call `pipe.stop()` here to stop
   * the message on the issue.
   */
  onIssue?: ((issue: GenUiIssue, pipe: GenUiPipe) => void) | undefined;
  /**
   * Continue a stopped message. Called after each stop — once the source is
   * cancelled and any open fence is closed — with the message so far;
   * return (or resolve with) the source to continue with, which is validated
   * and forwarded as part of the same message, or `null` to end the message.
   *
   * Setting this option is what makes a stop close an open fence first (so
   * the continuation starts on a fresh line of plain Markdown), whatever the
   * callback then returns. Without it, a stop ends the message right where it
   * was cut.
   */
  continuation?:
    | ((snapshot: GenUiPipeSnapshot) => GenUiContinuation | PromiseLike<GenUiContinuation>)
    | undefined;
}

/** What {@link pipeGenUi} returns. */
export interface GenUiPipe {
  /**
   * The pass-through stream: the source text, UTF-8 encoded — ready to be a
   * `Response` body. It is pull-based: the source is read (and validated) as
   * this stream is consumed. Cancelling it cancels the source.
   */
  readonly stream: ReadableStream<Uint8Array>;
  /**
   * Resolves once the message has ended — the source was fully streamed
   * through, it was stopped (and not continued), or the consumer cancelled
   * the stream. Rejects if a source or the `continuation` callback fails.
   */
  readonly done: Promise<GenUiPipeResult>;
  /**
   * Stop the message: cancel the current source right away, then either end
   * the stream normally (not with an error) or, with a `continuation`,
   * continue with the source it returns. The chunk being processed when
   * `stop()` is called from `onIssue` is still forwarded — it has already
   * been validated. No-op once stopped (until continued) or ended.
   */
  stop(): void;
  /** The issues found so far (a snapshot copy). */
  getIssues(): readonly GenUiIssue[];
  /** The issues formatted as feedback for the model, or `null` when clean. */
  getIssueReport(): string | null;
}

function isReadableStream(source: JsxStreamSource): source is ReadableStream<Uint8Array | string> {
  return typeof (source as ReadableStream<unknown>).getReader === "function";
}

function iterate(source: JsxStreamSource): AsyncIterator<string | Uint8Array> {
  if (!isReadableStream(source)) return source[Symbol.asyncIterator]();
  const reader = source.getReader();
  return {
    next: () => reader.read() as Promise<IteratorResult<string | Uint8Array>>,
    async return() {
      await reader.cancel();
      return { done: true, value: undefined };
    },
  };
}

const noop = (): void => {};

/**
 * Cancel a source without waiting: an async generator only runs `return()`
 * once its pending `next()` settles, which may take a while.
 */
function cancelSource(iterator: AsyncIterator<unknown>): void {
  try {
    void Promise.resolve(iterator.return?.()).catch(noop);
  } catch {
    // A throwing `return()` still leaves the source abandoned.
  }
}

/**
 * Validate `source` against `schema` while passing it through. Accepts the
 * same sources as the client (`ReadableStream` of bytes or strings, or any
 * `AsyncIterable` of either — e.g. an LLM SDK's text-delta stream).
 *
 * ```ts
 * const pipe = pipeGenUi(llmTextStream, schema, { onIssue: (issue) => log(issue) });
 * pipe.done.then((result) => saveFeedback(result.issueReport));
 * return new Response(pipe.stream, { headers: { "content-type": "text/plain; charset=utf-8" } });
 * ```
 */
export function pipeGenUi(
  source: JsxStreamSource,
  schema: GenUiSchema,
  options: GenUiPipeOptions = {},
): GenUiPipe {
  const validator = createGenUiValidator(schema, {
    onIssue: options.onIssue && ((issue) => options.onIssue!(issue, pipe)),
  });
  const encoder = new TextEncoder();
  let iterator = iterate(source);
  let decoder = new TextDecoder();

  let text = "";
  let stops = 0;
  /** A stop was requested and not yet resolved (by continuing or ending). */
  let stopping = false;
  let ended = false;
  /** Wakes a pending read up when `stop()` is called. */
  let wake: (() => void) | null = null;

  let resolveDone!: (result: GenUiPipeResult) => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<GenUiPipeResult>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // The stream itself errors too; don't make `done` an unhandled rejection
  // for callers who only consume the stream.
  done.catch(noop);

  const snapshot = (): GenUiPipeSnapshot => {
    const cleanOffset = validator.getCleanOffset();
    return {
      text,
      cleanOffset,
      cleanText: text.slice(0, cleanOffset),
      issues: validator.getIssues(),
      issueReport: validator.getIssueReport(),
      stops,
    };
  };

  const forward = (controller: ReadableStreamDefaultController<Uint8Array>, chunk: string) => {
    validator.write(chunk);
    text += chunk;
    controller.enqueue(encoder.encode(chunk));
  };

  const finish = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    status: "complete" | "stopped",
  ): void => {
    ended = true;
    validator.end();
    controller.close();
    resolveDone({ ...snapshot(), status });
  };

  const fail = (error: unknown): never => {
    ended = true;
    rejectDone(error);
    throw error;
  };

  /**
   * Resolve a requested stop (the source is already cancelled). Returns
   * whether the message continues with a new source.
   */
  const handleStop = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<boolean> => {
    if (options.continuation) {
      const close = validator.getFenceClose();
      if (close !== "") forward(controller, close);
      let next: GenUiContinuation;
      try {
        next = await options.continuation(snapshot());
      } catch (error) {
        if (ended) return false;
        return fail(error);
      }
      if (ended) {
        // The consumer cancelled meanwhile.
        if (next) cancelSource(iterate(next));
        return false;
      }
      if (next) {
        iterator = iterate(next);
        decoder = new TextDecoder();
        stopping = false;
        return true;
      }
    }
    finish(controller, "stopped");
    return false;
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Loop until something is enqueued: a pull that enqueues nothing (an
      // empty chunk, a partial UTF-8 sequence) would not be called again.
      for (;;) {
        if (stopping) {
          // oxlint-disable-next-line no-await-in-loop -- resolving a stop is sequential
          if (!(await handleStop(controller))) return;
          continue;
        }
        const pending = iterator.next();
        let result: IteratorResult<string | Uint8Array> | null;
        try {
          // oxlint-disable-next-line no-await-in-loop -- reading is sequential
          result = await Promise.race([
            pending,
            new Promise<null>((resolve) => {
              wake = () => resolve(null);
            }),
          ]);
        } catch (error) {
          if (ended) return;
          // A source failing because it was cancelled by a stop is expected.
          if (stopping) continue;
          return fail(error);
        } finally {
          wake = null;
        }
        // The consumer cancelled meanwhile.
        if (ended) return;
        if (result === null) {
          // Stopped while reading: whatever the read yields is dropped.
          pending.catch(noop);
          continue;
        }
        const chunk = result.done
          ? decoder.decode()
          : typeof result.value === "string"
            ? result.value
            : decoder.decode(result.value, { stream: true });
        if (chunk !== "") forward(controller, chunk);
        // A stop requested while validating this chunk takes precedence,
        // even over the source's end: the app may still continue.
        if (stopping) continue;
        if (result.done) {
          finish(controller, "complete");
          return;
        }
        if (chunk !== "") return;
      }
    },
    async cancel() {
      if (ended) return;
      ended = true;
      resolveDone({ ...snapshot(), status: "cancelled" });
      // After a stop, the source is already cancelled.
      if (!stopping) await iterator.return?.();
    },
  });

  const pipe: GenUiPipe = {
    stream,
    done,
    stop() {
      if (ended || stopping) return;
      stopping = true;
      stops++;
      cancelSource(iterator);
      wake?.();
    },
    getIssues: () => validator.getIssues(),
    getIssueReport: () => validator.getIssueReport(),
  };
  return pipe;
}

/**
 * The user message asking the model to continue an interrupted response —
 * the Messages API's documented recovery for models that no longer accept
 * an assistant prefill: *"Your previous response was interrupted and ended
 * with […]. Continue from where you left off."* — with the issue report, if
 * any, so the model knows why and can correct a broken `ui+jsx` block.
 *
 * Pass the text the continuation should follow: `snapshot.text` when
 * continuing the same message (the client keeps what it already has), or
 * `snapshot.cleanText` when the app rewinds to the last clean boundary.
 */
export function formatContinuationMessage(text: string, issueReport: string | null): string {
  const parts = [
    `Your previous response was interrupted and ended with:\n\n<previous_response>\n${text}\n</previous_response>`,
  ];
  if (issueReport !== null) parts.push(issueReport);
  parts.push(
    issueReport === null
      ? "Continue from where you left off, without repeating what is already there."
      : "Continue from where you left off, without repeating what is already there. " +
          "If a `ui+jsx` block is broken or missing, write a corrected block.",
  );
  return parts.join("\n\n");
}
