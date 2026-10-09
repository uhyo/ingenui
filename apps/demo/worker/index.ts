/**
 * The demo's server: a Cloudflare Worker handling `/api/*` (everything else
 * is the static SPA). It plays the ingenui server between the LLM provider
 * and the client, using only the shared data-only schema and the React-free
 * `ingenui/server` entry:
 *
 * - `GET  /api/prompt`   — the system prompt, built from the schema;
 * - `POST /api/generate` — streams a message to the client through
 *   `pipeGenUi`, validating it on the way — and, on a JSX issue, stopping the
 *   "model" and continuing the same message with a correction (or just
 *   stopping it, or only logging, per the request's `recovery`);
 * - `POST /api/chat`     — the same, with **Claude** as the model: streams
 *   its reply to a conversation through `pipeGenUi`, and on a JSX issue
 *   aborts the request and continues the message with a new one built with
 *   `formatContinuationMessage`. Needs `ANTHROPIC_API_KEY`;
 * - `GET  /api/config`   — whether Claude is configured (and which model);
 * - `POST /api/next`     — builds the next user turn from *structured*
 *   client input (typed text, a fired action's name, render crashes),
 *   re-validating the previous message itself instead of trusting
 *   client-written text.
 *
 * `/api/generate` needs no API key: its "LLM provider" is simulated, replaying
 * the text the user typed a few characters at a time; asked to continue
 * after a stop, the simulated model writes the sample's correction, then
 * carries on after the broken block. `/api/chat` is the real thing.
 *
 * In `vite dev` the same handler is served by a middleware (see
 * `vite.config.ts`); `wrangler dev` / `wrangler deploy` run it as the Worker.
 */
import type { GenUiIssue, GenUiPipeSnapshot } from "ingenui/server";
import {
  formatContinuationMessage,
  formatGenUiPrompt,
  formatIssueReport,
  pipeGenUi,
  resolveGenUiAction,
  validateGenUiMessage,
} from "ingenui/server";

import Anthropic from "@anthropic-ai/sdk";

import { demoSchema } from "../src/genui-schema";
import { createCharStream } from "../src/streaming";
import { callClaude, DEFAULT_MODEL, describeApiError } from "./claude";

/** A Workers Rate Limiting binding (only the part used here). */
interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The Worker's bindings: secrets / vars, and the optional rate limiter. */
export interface Env {
  /** Enables `/api/chat`. A secret: `wrangler secret put ANTHROPIC_API_KEY`. */
  ANTHROPIC_API_KEY?: string;
  /** Overrides the model (default: `claude-opus-5-5`). */
  ANTHROPIC_MODEL?: string;
  /** Limits `/api/chat` requests per client IP (see `wrangler.jsonc`). */
  CHAT_RATE_LIMIT?: RateLimiter;
}

/** Keep the public demo cheap: messages are short. */
const MAX_MESSAGE_LENGTH = 20_000;

/** A conversation sent to `/api/chat`: at most this many turns… */
const MAX_TURNS = 40;
/** …and this many characters in all. */
const MAX_CONVERSATION_LENGTH = 100_000;

const systemPrompt = `You are the shopping assistant of a demo store that showcases a Generative UI framework. The store is fictional: invent plausible products, prices, and details as needed, and keep them consistent within the conversation.

Answer in Markdown; use UI blocks where they help (product cards, comparisons, order summaries, choices), and wire buttons to actions. Keep replies short: a sentence or two of prose around one or two UI blocks.

${formatGenUiPrompt(demoSchema)}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function readMessage(value: unknown): string | null {
  return typeof value === "string" && value.length <= MAX_MESSAGE_LENGTH ? value : null;
}

/** Stand-in for the LLM provider's text stream. */
function simulateModel(text: string, intervalMs: number, chunkSize: number) {
  return createCharStream(text, { intervalMs, chunkSize });
}

type Recovery = "continue" | "stop" | "log";

/** How many times one message may be stopped and continued. */
const MAX_STOPS = 2;

const DEFAULT_CORRECTION = "\n*(That UI block had a problem, so I left it out.)*\n\n";

/** A closing fence line, from the start of a line. */
const FENCE_CLOSE_LINE = /(?:^|\n) {0,3}`{3,}[ \t]*(?:\n|$)/;

/**
 * What the simulated model writes when asked to continue: the correction,
 * then the rest of what it meant to write. It compares what was forwarded
 * with its intended text; when they diverge, it was cut inside a block (the
 * pipe closed the fence), so it skips the rest of that block.
 */
function continuationOf(intended: string, forwarded: string, correction: string): string {
  let cut = 0;
  while (cut < forwarded.length && forwarded[cut] === intended[cut]) cut++;
  let rest = intended.slice(cut);
  if (cut < forwarded.length) {
    const close = FENCE_CLOSE_LINE.exec(rest);
    rest = close === null ? "" : rest.slice(close.index + close[0].length);
  }
  return `${correction}${rest}`;
}

async function generate(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const text = readMessage(body?.["text"]);
  if (text === null) return json({ error: "text must be a string (up to 20k chars)" }, 400);
  const requested = body?.["recovery"];
  const recovery: Recovery = requested === "stop" || requested === "log" ? requested : "continue";
  const sampleCorrection = body?.["correction"];
  const correction =
    typeof sampleCorrection === "string" && sampleCorrection.length <= 2_000
      ? sampleCorrection
      : DEFAULT_CORRECTION;

  const intervalMs = clamp(body?.["intervalMs"], 5, 500, 45);
  const chunkSize = clamp(body?.["chunkSize"], 1, 64, 2);
  const started = Date.now();
  const log = (message: string) => console.log(`[ingenui] +${Date.now() - started}ms`, message);

  // The simulated model's current response, and where it starts in the message.
  let intended = text;
  let attemptStart = 0;
  const pipe = pipeGenUi(simulateModel(text, intervalMs, chunkSize), demoSchema, {
    // Found while streaming — before the client has the chunk that completes
    // the problem (visible in the dev-server / Worker logs).
    onIssue(issue, target) {
      log(describe(issue));
      // A real app would also abort its provider request here.
      if (recovery !== "log" && issue.kind === "jsx-error") target.stop();
    },
    continuation:
      recovery === "continue"
        ? (snapshot: GenUiPipeSnapshot) => {
            log(
              `stopped (${snapshot.stops}/${MAX_STOPS}); clean prefix: ${snapshot.cleanOffset} chars`,
            );
            if (snapshot.stops > MAX_STOPS) return null;
            // A real app sends this as a new request's last user message.
            const followUp = formatContinuationMessage(snapshot.text, snapshot.issueReport);
            log(`continuation request (${followUp.length} chars)`);
            intended = continuationOf(intended, snapshot.text.slice(attemptStart), correction);
            attemptStart = snapshot.text.length;
            return simulateModel(intended, intervalMs, chunkSize);
          }
        : undefined,
  });
  pipe.done.then(
    (result) =>
      log(`${result.status} after ${result.stops} stop(s), ${result.issues.length} issue(s)`),
    () => {},
  );
  return new Response(pipe.stream, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function modelOf(env: Env): string {
  return env.ANTHROPIC_MODEL || DEFAULT_MODEL;
}

/**
 * The conversation so far, from the client: user / assistant turns (text
 * only), starting and ending with a user turn. `null` when malformed or over
 * the demo's limits.
 */
function readConversation(value: unknown): Anthropic.Beta.BetaMessageParam[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TURNS) return null;
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  let total = 0;
  for (const entry of value as unknown[]) {
    const { role, content } = (entry ?? {}) as Record<string, unknown>;
    if (role !== "user" && role !== "assistant") return null;
    const text = readMessage(content);
    if (text === null || text.trim() === "") return null;
    total += text.length;
    messages.push({ role, content: text });
  }
  if (total > MAX_CONVERSATION_LENGTH) return null;
  if (messages[0]!.role !== "user" || messages.at(-1)!.role !== "user") return null;
  return messages;
}

/**
 * Claude's reply to a conversation, streamed through `pipeGenUi` — the same
 * pipeline as `/api/generate`, with the real model behind it. On a JSX
 * issue (unless `recovery` is "log") the request is aborted; with
 * "continue", a new request asks Claude to continue the same message.
 */
async function chat(request: Request, env: Env): Promise<Response> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json({ error: "Claude is not configured on this server (no ANTHROPIC_API_KEY)." }, 503);
  }
  if (env.CHAT_RATE_LIMIT) {
    const key = request.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.CHAT_RATE_LIMIT.limit({ key });
    if (!success) return json({ error: "Too many messages — wait a minute and try again." }, 429);
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const messages = readConversation(body?.["messages"]);
  if (messages === null) {
    return json({ error: "messages must be a conversation ending with a user turn" }, 400);
  }
  const requested = body?.["recovery"];
  const recovery: Recovery = requested === "stop" || requested === "log" ? requested : "continue";

  const client = new Anthropic({ apiKey });
  const model = modelOf(env);
  const started = Date.now();
  const log = (message: string) =>
    console.log(`[ingenui/claude] +${Date.now() - started}ms`, message);

  const first = callClaude({ client, model, system: systemPrompt, messages });
  try {
    await first.connected;
  } catch (error) {
    const { status, message } = describeApiError(error);
    log(message);
    return json({ error: message }, status);
  }

  const pipe = pipeGenUi(first.text, demoSchema, {
    onIssue(issue, target) {
      log(describe(issue));
      // Stopping cancels the source, which aborts the request.
      if (recovery !== "log" && issue.kind === "jsx-error") target.stop();
    },
    continuation:
      recovery === "continue"
        ? async (snapshot: GenUiPipeSnapshot) => {
            log(`stopped (${snapshot.stops}/${MAX_STOPS})`);
            if (snapshot.stops > MAX_STOPS) return null;
            const call = callClaude({
              client,
              model,
              system: systemPrompt,
              messages: [
                ...messages,
                {
                  role: "user",
                  content: formatContinuationMessage(snapshot.text, snapshot.issueReport),
                },
              ],
            });
            try {
              await call.connected;
            } catch (error) {
              // Let the message end where it was stopped.
              log(`continuation failed: ${describeApiError(error).message}`);
              return null;
            }
            return call.text;
          }
        : undefined,
  });
  pipe.done.then(
    (result) =>
      log(`${result.status} after ${result.stops} stop(s), ${result.issues.length} issue(s)`),
    (error: unknown) => log(`failed: ${String(error)}`),
  );
  return new Response(pipe.stream, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function describe(issue: GenUiIssue): string {
  const block = `block ${issue.blockIndex + 1}`;
  return issue.kind === "jsx-error"
    ? `${block}: ${issue.event.message}`
    : `${block}: ${issue.kind}`;
}

/**
 * The next user turn, composed on the server: what the user typed, or the
 * canonical message for the fired action (resolved against the schema), plus
 * the feedback report —
 * parse-time issues from the server's own validation, and the render crashes
 * only the client can observe.
 */
async function next(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const message = readMessage(body?.["message"]);
  if (message === null) return json({ error: "message must be a string" }, 400);

  const parts: string[] = [];
  const input = body?.["text"];
  if (input !== undefined) {
    const typed = readMessage(input);
    if (typed === null || typed.trim() === "")
      return json({ error: "text must be non-empty" }, 400);
    parts.push(typed);
  }
  const action = body?.["action"];
  if (action !== undefined) {
    const resolved = typeof action === "string" ? resolveGenUiAction(demoSchema, action) : null;
    if (resolved === null) return json({ error: "unknown action" }, 400);
    parts.push(resolved.message);
  }

  const renderErrors = Array.isArray(body?.["renderErrors"]) ? body["renderErrors"] : [];
  const issues: GenUiIssue[] = [...validateGenUiMessage(message, demoSchema)];
  for (const entry of renderErrors.slice(0, 20) as unknown[]) {
    const { blockIndex, message: error } = (entry ?? {}) as Record<string, unknown>;
    if (typeof blockIndex === "number" && Number.isInteger(blockIndex) && blockIndex >= 0) {
      issues.push({ kind: "render-error", blockIndex, error: String(error).slice(0, 200) });
    }
  }
  const report = formatIssueReport(issues);
  if (report !== null) parts.push(report);

  return json({ text: parts.length > 0 ? parts.join("\n\n") : null });
}

export default {
  async fetch(request: Request, env: Env = {}): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/config" && request.method === "GET") {
      return json({
        claude: { available: Boolean(env.ANTHROPIC_API_KEY), model: modelOf(env) },
      });
    }
    if (pathname === "/api/chat" && request.method === "POST") return chat(request, env);
    if (pathname === "/api/prompt" && request.method === "GET") {
      return new Response(systemPrompt, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (pathname === "/api/generate" && request.method === "POST") return generate(request);
    if (pathname === "/api/next" && request.method === "POST") return next(request);
    return json({ error: "not found" }, 404);
  },
};
