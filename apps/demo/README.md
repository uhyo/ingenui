# Generative UI toolchain — live demo

An interactive playground for the workspace libraries. It streams a source
**a few characters at a time** (the way an LLM streams tokens) and renders the
resulting **live React tree** side-by-side with the raw text. Everything that
hasn't arrived yet is the single `<Pending />` frontier, shown here as a
shimmer. Three modes:

- **ingenui · Markdown + ui+jsx** (default) — streams a
  [`ingenui`](../../packages/ingenui) message **through the demo's server**:
  Markdown where ```` ```ui+jsx ```` code fences render as live, interactive
  UI. Clicking a streamed `actions.*` handler logs the **next request to the
  AI**, built by the server from the action's name. Action names may be
  model-defined (dynamic actions, the default). A malformed sample shows the
  **feedback report** the server built for the model.
- **ingenui · chat with Claude** — the same pipeline with a **real model**:
  a chat with Claude as a shopping assistant. Its replies stream through the
  server's `pipeGenUi` (which can abort the request on a broken block and ask
  Claude to continue with a corrected one), and clicking a button wired to
  `actions.*` sends the next turn — composed by the server, with feedback on
  the previous reply attached. Needs an
  [API key](#claude-api-key).
- **parser · raw JSX** — streams a bare JSX string straight into
  [`@ingenui/incremental-jsx-parser`](../../packages/incremental-jsx-parser).

The layout is two side-by-side panes: the **received stream** (raw text, growing
with a blinking caret) on the left, and the **live React tree** it parses into on
the right.

## What it shows

- **Server and client share one schema** — [`src/genui-schema.ts`](./src/genui-schema.ts)
  is plain data. The Worker ([`worker/index.ts`](./worker/index.ts)) builds
  the system prompt from it (open "System prompt" in the UI) and streams each
  message through `pipeGenUi`, which logs issues the moment they are
  streamed (see the dev-server / Worker logs). The client binds the React
  components to the same schema with `bindGenUi`
  ([`src/components.tsx`](./src/components.tsx)).
- **The next request is built on the server** — the client sends only
  structured data (the fired action's name, render crashes).
  `POST /api/next` resolves the action against the schema, re-validates the
  message itself, and returns the next user turn.

- **Incremental rendering** — settled subtrees stay put while only the open path
  and the `<Pending />` shimmer update each chunk.
- **The single frontier** — exactly one shimmer at a time: after the Markdown
  when the frontier is in prose, or nested in the innermost open element of a
  streaming UI block.
- **Per-component completion** — demo components read `useIsElementComplete()`:
  a `Card` shows an animated rainbow border while its children are still
  streaming; `Badge` and `Button` hide the shimmer inside them (it would make
  them wider than their final size), and a `Button` stays disabled until its
  label is final.
- **Lenient parsing** — the malformed samples omit close tags, reference
  unknown components, and use unsupported `{ }` expressions; the tree recovers
  and the problems surface as structured events (`onJsxError` in parser mode,
  issues + the feedback report in ingenui mode) instead of throwing.
- **Components as an allowlist** — only the components in
  [`src/components.tsx`](./src/components.tsx) can be instantiated by the streamed
  source; anything else degrades to `<Pending />`.
- **Broken blocks, marked** — `wrapUiBlock` greys out and labels a block
  with issues (or cut off mid-way). With "Stop & continue", the broken
  partial block stays above the model's corrected one (try the
  "Malformed (stopped & recovered)" sample).
- **The actions loop** — `onClick={actions.addToCart}` in a sample wires a real
  click handler; firing it emits "The `actions.addToCart` action was fired by
  the user.", shown in the action log.

## Run it

The demo imports both libraries straight from the workspace source
(`../../packages/*/src`) via Vite aliases (and wrangler `alias` for the
Worker), so there's no build step — edits to the libraries show up live. In
`vite dev`, a small middleware ([`vite.config.ts`](./vite.config.ts)) serves
the Worker's `/api/*` routes, so wrangler isn't needed to develop.

```sh
pnpm install          # once, at the repo root
pnpm --filter ingenui-demo dev
```

Then open the printed URL. Pick a sample (or edit the JSX), choose a speed, and
press **Stream it**.

### Claude API key

The chat mode calls the Claude API from the server side (`/api/chat`, in
[`worker/claude.ts`](./worker/claude.ts)); the key never reaches the
browser. Put it in `apps/demo/.env.local` (gitignored; see
[`.env.example`](./.env.example)), which both `vite dev` and `wrangler dev`
read:

```sh
ANTHROPIC_API_KEY=sk-ant-…
# ANTHROPIC_MODEL=claude-opus-5-5   # optional override
```

Without a key, the other modes work as before and the chat mode says it
isn't configured. Requests use `claude-opus-5-5` at `effort: "low"` (fast
first tokens for a chat turn), `max_tokens: 8192`, prompt caching on the
system prompt, and the server-side refusal fallback (`fallbacks: "default"`).

## Deploy (Cloudflare Workers)

The demo ships as a Worker with
[static assets](https://developers.cloudflare.com/workers/static-assets/):
the Worker script ([`worker/index.ts`](./worker/index.ts)) runs first for
`/api/*` (`run_worker_first`), and Cloudflare serves everything else from the
built `dist/`. The config is in [`wrangler.jsonc`](./wrangler.jsonc).
`not_found_handling: "single-page-application"` rewrites unknown paths to
`index.html`.

The sample modes need no API key: their "LLM provider" is simulated,
replaying the text from the editor a few characters at a time. The chat mode
calls Claude, so give the deployed Worker the key as a secret:

```sh
pnpm exec wrangler secret put ANTHROPIC_API_KEY
```

A public demo spends your API credit on every visitor's message. The Worker
limits `/api/chat` to 6 requests per minute per client IP (the
`CHAT_RATE_LIMIT` [rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
in `wrangler.jsonc`), caps the conversation's size, and aborts a request as
soon as the client disconnects or the server stops the message; also set a
spend limit for the key's workspace in the Claude Console.

One-time auth (either works):

```sh
pnpm exec wrangler login            # interactive OAuth, or…
export CLOUDFLARE_API_TOKEN=…       # token with "Edit Workers" permission
```

Then build + publish:

```sh
pnpm install          # once, at the repo root
pnpm --filter ingenui-demo run deploy   # = vite build && wrangler deploy
```

Wrangler prints the live URL (`https://ingenui-demo.<account>.workers.dev`).
To preview the production build on the Workers runtime locally first, run
`pnpm cf:preview` (`vite build && wrangler dev`). Plain `vite preview` serves
only the static build, without the `/api/*` routes.

## How it's wired

ingenui mode:

```tsx
// src/genui-schema.ts — shared, data only
export const demoSchema = defineGenUiSchema({ components: { Card: { props: {} }, … }, actions: { addToCart: … } });

// worker/index.ts — the server
const pipe = pipeGenUi(simulatedModelStream, demoSchema, { onIssue: log });
return new Response(pipe.stream);

// … and with Claude (`/api/chat`): its text deltas are the source; stopping
// cancels it, which aborts the request; a continuation is a new request.
const call = callClaude({ client, model, system: systemPrompt, messages });
const pipe = pipeGenUi(call.text, demoSchema, {
  onIssue: (issue, pipe) => issue.kind === "jsx-error" && pipe.stop(),
  continuation: (snapshot) =>
    callClaude({ …, messages: [...messages, { role: "user", content: formatContinuationMessage(snapshot.text, snapshot.issueReport) }] }).text,
});

// src/components.tsx + App.tsx — the client
const genUi = bindGenUi(demoSchema, { components: { Card, … } });
const { node, message } = useGenUiMessage(streamGeneration(params), {
  ...genUi,
  Pending: Shimmer,                // frontier placeholder
  onAction: (event) => { /* POST /api/next { message, action: event.name } -> the action log */ },
  onIssue: (issue) => { /* surfaced live in the UI */ },
  wrapUiBlock: (props) => <UiBlockFrame {...props} />, // greys out a broken block
});
// on message.done: POST /api/next { message, renderErrors } -> the feedback panel
```

Parser mode:

```tsx
import { useIncrementalJsx } from "@ingenui/incremental-jsx-parser/react";

const node = useIncrementalJsx(stream, {
  components: demoComponents,      // allowlist + renderers
  Pending: Shimmer,               // frontier placeholder
  onUnknownComponent: "pending",
  onJsxError: (event) => { /* event.message surfaced in the UI */ },
});
```

The streamed source is a `ReadableStream<Uint8Array>` built in
[`src/streaming.ts`](./src/streaming.ts), which releases the text in small chunks
on a timer and encodes to bytes — deliberately exercising the library's
streaming `TextDecoder` path. Parser mode uses it in the browser; ingenui mode
uses it in the Worker as the simulated model, and the browser reads the
server's response ([`src/api.ts`](./src/api.ts)).

> The demo intentionally does **not** wrap the tree in `<StrictMode>`: a stream
> source is single-use, and StrictMode's dev double-invocation would consume it
> before the real run. The library is StrictMode-safe given a *stable* source.
