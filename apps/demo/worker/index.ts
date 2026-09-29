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
 * - `POST /api/next`     — builds the next user turn from *structured*
 *   client input (a fired action's name, render crashes), re-validating the
 *   previous message itself instead of trusting client-written text.
 *
 * The demo has no API key, so the "LLM provider" is simulated: it replays the
 * text the user typed, a few characters at a time. A real app would call the
 * provider with the prompt from `/api/prompt` and pipe its text stream the
 * same way; asked to continue after a stop (the request a real app builds
 * with `formatContinuationMessage`), the simulated model writes the sample's
 * correction, then carries on after the broken block.
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

import { demoSchema } from "../src/genui-schema";
import { createCharStream } from "../src/streaming";

/** Keep the public demo cheap: messages are short. */
const MAX_MESSAGE_LENGTH = 20_000;

const systemPrompt = `You are a shopping assistant. Answer in Markdown; use UI blocks where they help.

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

function describe(issue: GenUiIssue): string {
  const block = `block ${issue.blockIndex + 1}`;
  return issue.kind === "jsx-error"
    ? `${block}: ${issue.event.message}`
    : `${block}: ${issue.kind}`;
}

/**
 * The next user turn, composed on the server: the canonical message for the
 * fired action (resolved against the schema) plus the feedback report —
 * parse-time issues from the server's own validation, and the render crashes
 * only the client can observe.
 */
async function next(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const message = readMessage(body?.["message"]);
  if (message === null) return json({ error: "message must be a string" }, 400);

  const parts: string[] = [];
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
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
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
