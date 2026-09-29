# Server and client: the shared schema

A real AI app has three actors, and the model's output flows through all of
them:

```text
[LLM provider] ──stream──▶ [your server] ──stream──▶ [client]
```

ingenui covers both of your sides. The glue is the **GenUI schema**: the
parse-affecting half of the options as plain, JSON-serializable data. Both
sides import the same schema:

- the **server** builds the system prompt from it, validates the model's
  stream against it while passing the stream through, and builds the next
  request itself;
- the **client** binds the implementations (components, variable values,
  action handlers) to it and renders.

The server and the client run the same checks on the same text, so they
report the same issues.

- [The schema — `ingenui/schema`](#the-schema--ingenuischema)
- [The client — `bindGenUi`](#the-client--bindgenui-ingenui)
- [The server — `ingenui/server`](#the-server--ingenuiserver)
- [Stopping and recovering](#stopping-and-recovering)
- [Building the next request on the server](#building-the-next-request-on-the-server)
- [Sharing the schema](#sharing-the-schema)

## The schema — `ingenui/schema`

```ts
// genui-schema.ts — imported by the server and the client
import { defineGenUiSchema } from "ingenui/schema";

export const schema = defineGenUiSchema({
  elements: { div: true, p: true, button: { onClick: "function" } },
  components: {
    Card: { props: { title: "string" }, description: "A titled panel for related content." },
    PlanPicker: { props: { plans: "object", onPick: "function" } },
    Chart: true, // any props, no description
  },
  variableTypes: { user: { name: "string", plan: "string" } },
  actions: { subscribe: { description: "Start a subscription." }, cancel: true },
  dynamicActions: true, // the default: the model may also invent action names
  mismatchedTag: "autoclose", // the default
});
```

| Field            | Description |
| ---------------- | ----------- |
| `elements`       | The intrinsic-element allowlist, as in the [parser's schema](../../incremental-jsx-parser/docs/schema.md#elements). |
| `components`     | The component catalog: name → `{ props?, description? }` (`true` = any props). `props` is the [prop catalog](../../incremental-jsx-parser/docs/schema.md#components); `description` is shown to the model. |
| `variableTypes`  | The predefined variables' [types](../../incremental-jsx-parser/docs/schema.md#types). The server only knows these types, so declare object shapes fully: a member missing from the declaration is an unknown variable on the server. |
| `actions`        | The declared [actions](./actions.md): name → `true` or `{ description? }`. |
| `dynamicActions` | [Model-defined actions](./actions.md#model-defined-actions-the-dynamicactions-default) (default `true`). |
| `mismatchedTag`  | Closing-tag mismatch recovery (`"autoclose"` / `"ignore"`). |

The rule for what goes where: anything that changes **parse results** is in
the schema. Options that only affect **rendering** (`Pending`,
`onUnknownComponent`, `onDisallowedElement`, `renderMarkdown`,
`renderUiError`) stay client-side.

`defineGenUiSchema` does nothing at runtime. At the type level it keeps the
literal shape, which is what lets `bindGenUi` check the bindings.
`ingenui/schema` is React-free.

## The client — `bindGenUi` (`ingenui`)

`bindGenUi(schema, bindings)` attaches the implementations and returns the
schema-derived options for [`createGenUiMessage` /
`useGenUiMessage`](./api.md). Spread them next to the client-only options:

```tsx
import { bindGenUi } from "ingenui";
import { useGenUiMessage } from "ingenui/react";
import { schema } from "./genui-schema";

const genUi = bindGenUi(schema, {
  components: { Card, PlanPicker, Chart },
  variables: { user }, // one value per declared variable
  actions: { subscribe: () => openCheckout() }, // optional handlers for declared actions
});

function AssistantMessage({ stream }: { stream: ReadableStream<Uint8Array> }) {
  const { node } = useGenUiMessage(stream, { ...genUi, Pending: Shimmer, onAction, onIssue });
  return <div className="message">{node}</div>;
}
```

The bindings are checked against the schema:

- **At the type level**, each component must accept the props the schema
  lets the model pass. `{ title: "string" }` requires
  `ComponentType<{ title?: string; children?: ReactNode }>`. Every declared
  prop is **optional**, because the model may omit any of them. Variable
  values must match their declared types. `InferSchemaType` /
  `InferComponentProps` are exported for your own typings.
- **At runtime**, `bindGenUi` throws when a declared component or variable
  has no binding, or when a binding is not declared in the schema. The model
  is only ever told about the schema.

## The server — `ingenui/server`

A React-free entry, for any runtime with Web Streams (Node 20+, Deno, Bun,
Cloudflare Workers, …). It imports only the parser's `/core`.

### `formatGenUiPrompt(schema)`

The same [prompt builder](./api.md#formatgenuipromptoptions--ingenui),
taking the schema directly. Component and action descriptions are included:

```ts
import { formatGenUiPrompt } from "ingenui/server";

const system = `You are a helpful assistant …\n\n${formatGenUiPrompt(schema)}`;
```

### `pipeGenUi(source, schema, options?)`

Validates the model's stream while passing it through unchanged:

```ts
import { pipeGenUi } from "ingenui/server";

const llmStream = await callTheModel({ system, messages }); // the provider's text stream
const pipe = pipeGenUi(llmStream, schema, {
  onIssue: (issue) => log(issue), // fires as soon as each issue is streamed
});
pipe.done.then((result) => saveForNextTurn(result.text, result.issues));
return new Response(pipe.stream, { headers: { "content-type": "text/plain; charset=utf-8" } });
```

- `source` accepts what the client accepts: a `ReadableStream` of bytes or
  strings, or any `AsyncIterable` of either, such as an SDK's text-delta
  iterator.
- `pipe.stream` is the text, UTF-8 encoded, ready to be a response body.
  It is **pull-based**: the source is read (and validated) as the stream is
  consumed. Cancelling it, for example when the client disconnects, cancels
  the source.
- `onIssue` fires **synchronously inside the chunk that completes the
  problem**, before that chunk is forwarded to the client.
- `pipe.done` resolves once the message has ended, with a result:

  | Field                       | Description |
  | --------------------------- | ----------- |
  | `status`                    | `"complete"` (the source ended), `"stopped"` ([stopped](#stopping-and-recovering) and not continued), or `"cancelled"` (the consumer cancelled; end-of-message checks such as unclosed fences are skipped). |
  | `text`                      | Everything forwarded to the client. |
  | `issues` / `issueReport`    | The issues, and their [report](./issues.md#issues-the-feedback-loop) (`null` when clean). |
  | `cleanOffset` / `cleanText` | The [last clean boundary](#the-cut-information) and the text before it. |
  | `stops`                     | How many times the message was stopped. |

  It rejects if the source fails. `getIssues()` / `getIssueReport()` read
  the current state at any time.

Only `render-error` issues can't be found here: they need the real
components, so only the client sees them. Every `jsx-error` and
`unclosed-fence` the client will report, the server reports too, and for
any chunking on either side (a fuzz suite checks this).

### `createGenUiValidator(schema, options?)` / `validateGenUiMessage(text, schema)`

The validator underneath `pipeGenUi`. It is push-based (`write`, `end`,
`getIssues`, `getIssueReport`, plus `onIssue`) for wiring into your own
stream handling. `validateGenUiMessage` is the one-shot form, for stored
messages, tests and evals.

Two more methods give what a stop needs, if you handle the stream
yourself: `getCleanOffset()` (the [last clean boundary](#the-cut-information))
and `getFenceClose()` (the text that closes the open fence, `""` when none
is; write it through the validator and to the client like any other text).
Continuing a message is simply writing on: the validator doesn't care where
the text comes from.

## Stopping and recovering

`pipeGenUi` finds a broken `ui+jsx` block before the client receives the
chunk that completes the problem. The server can act on it: stop the
model, then recover. ingenui provides the pieces and leaves the transport to
you. It consumes and produces plain Markdown; the client re-derives every
parse-time issue from the text it receives, so nothing but the text needs
to go over the wire, and **server/client parity holds for stopped and
continued messages too**.

### `stop()`

Call `pipe.stop()` from `onIssue` (which receives the pipe as its second
argument), or from anywhere else, such as a timeout:

```ts
const pipe = pipeGenUi(source, schema, {
  onIssue(issue, pipe) {
    if (issue.kind === "jsx-error") pipe.stop();
  },
});
```

- The source is cancelled right away (`reader.cancel()` for a stream,
  `return()` for an async iterable). An async generator only runs `return()`
  once its pending read settles, so if yours wraps a provider request,
  abort that request yourself too; a source that fails after `stop()` is
  ignored.
- The output stream then **closes normally**: the client sees a message
  that ended, not a broken response.
- The chunk being validated when `stop()` is called from `onIssue` is still
  forwarded (it has been validated already). What the client receives is
  exactly what the server validated.
- Which issues warrant a stop is up to you: `onIssue` is the predicate.
  `stop()` has no effect once the message has ended, so it can't act on the
  end-of-message issues (`unclosed-fence`, unclosed tags at the very end).

Without a continuation, the message ends exactly where it was cut: a block
cut mid-way reports `unclosed-fence` on both sides.

### Continuing the same message

The `continuation` option continues a stopped message in the same stream.
After each stop, the pipe closes any open fence, then calls
`continuation(snapshot)`; return a new source (or a promise of one) to
validate and forward it as part of the **same message**, or `null` to end
it there:

```ts
const pipe = pipeGenUi(source, schema, {
  onIssue: (issue, pipe) => pipe.stop(),
  continuation: async (snapshot) => (snapshot.stops <= 2 ? await requestContinuation(snapshot) : null),
});
```

- **The open fence is closed first.** When the stop lands inside a
  `ui+jsx` block (or a regular code fence), the pipe forwards the text that
  closes it (a line break if needed, then the closing backticks), so the
  continuation starts on a fresh line of plain Markdown. The cut block is
  then complete: its unclosed tags are reported as `jsx-error`s, and there
  is no `unclosed-fence`. This happens whenever `continuation` is set, even
  if it then returns `null`.
- **Block indices run on.** The client sees one append-only Markdown
  stream, so the continuation's blocks are numbered after the ones already
  sent, on both sides.
- **The retry budget is yours.** `snapshot.stops` counts the stops so far;
  return `null` when it runs out. A continuation can be stopped again.
- If the consumer cancels while the callback runs, the returned source is
  cancelled. If the callback throws, the stream errors and `done` rejects.

The continuation is new text, not a byte-exact resumption: the model may
repeat itself or rephrase. ingenui doesn't trim overlap; ask for "no
repetition" in the continuation request (as `formatContinuationMessage`
does).

### The cut information

The snapshot passed to `continuation` (and the result `done` resolves
with) has what a recovery request needs:

- `text`: everything forwarded so far, fence-closing text included. This is
  the "ended with […]" part of a continuation request.
- `cleanOffset` / `cleanText`: the **last clean boundary**. It is where the
  opening fence line of the first `ui+jsx` block with issues (or of a block
  still open) starts; the text before it is plain Markdown and issue-free
  blocks. A rewind restarts from here.
- `issues` / `issueReport`: the issues so far and their report, for the
  correction.
- `stops`: the number of stops, this one included.

`formatContinuationMessage(text, issueReport)` formats the user message
asking the model to continue:

```text
Your previous response was interrupted and ended with:

<previous_response>
…text…
</previous_response>

Your last message had problems in its `ui+jsx` blocks. …

Continue from where you left off, without repeating what is already there. If a
`ui+jsx` block is broken or missing, write a corrected block.
```

### Recipes for the Messages API

The Messages API can't take input while a response is streaming: the only
way to steer the model is to abort and send a new request. Claude 4.6 and
later don't accept an assistant prefill; the documented
[recovery](https://platform.claude.com/docs/en/build-with-claude/streaming#error-recovery)
is a new request with a user message: *"Your previous response was
interrupted and ended with […]. Continue from where you left off."*
Platforms with built-in interrupt and steer fit the same shape: stop, then
send a follow-up.

A helper for both recipes, turning a request into a text source you can
abort:

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

function callTheModel(messages: Anthropic.MessageParam[]) {
  const stream = client.messages.stream({ model: "claude-opus-5-5", max_tokens: 64000, system, messages });
  async function* text() {
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield event.delta.text;
    }
  }
  return { abort: () => stream.abort(), text: text() };
}
```

#### Continue without rewinding

The text already sent stays; the model continues in the same stream
("that UI was broken, here's a correct one: …"). This needs nothing from
your transport:

```ts
import { formatContinuationMessage, pipeGenUi } from "ingenui/server";

const MAX_STOPS = 2;

async function respond(messages: Anthropic.MessageParam[]): Promise<Response> {
  let call = callTheModel(messages);
  const pipe = pipeGenUi(call.text, schema, {
    onIssue(issue, pipe) {
      if (issue.kind !== "jsx-error") return;
      call.abort(); // stop paying for tokens right away
      pipe.stop();
    },
    continuation(snapshot) {
      if (snapshot.stops > MAX_STOPS) return null; // out of budget: end the message
      call = callTheModel([
        ...messages,
        { role: "user", content: formatContinuationMessage(snapshot.text, snapshot.issueReport) },
      ]);
      return call.text;
    },
  });
  // The assistant turn to keep in the history is what the user saw.
  pipe.done.then((result) => saveAssistantTurn(result.text, result.issues));
  return new Response(pipe.stream, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
```

The broken block stays on screen above the correction. How it looks there
is a client rendering concern (`renderUiError`, your components).

#### Rewind and restart

The broken response is discarded and replaced. This needs **your own
protocol** to tell the client, which then swaps to the new source; since
`useGenUiMessage` builds a fresh message for a new source, nothing else
changes on the client:

```ts
import type { GenUiPipeResult } from "ingenui/server";

// First response: stop on the issue, without a continuation.
const call = callTheModel(messages);
const pipe = pipeGenUi(call.text, schema, {
  onIssue(issue, pipe) {
    if (issue.kind !== "jsx-error") return;
    call.abort();
    pipe.stop();
  },
});
pipe.done.then((result) => {
  if (result.status === "stopped") notifyClientToRetry(turnId, result); // your protocol
});

// The retry: restart from the last clean boundary. The new response replays
// the clean prefix, then streams the model's continuation of it.
function retry(messages: Anthropic.MessageParam[], cut: GenUiPipeResult): Response {
  const call = callTheModel([
    ...messages,
    { role: "user", content: formatContinuationMessage(cut.cleanText, cut.issueReport) },
  ]);
  async function* restarted() {
    yield cut.cleanText;
    yield* call.text;
  }
  const pipe = pipeGenUi(restarted(), schema /* , the same stop policy */);
  return new Response(pipe.stream, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
```

To restart from scratch instead, send the original request again (with
the issue report, so the model avoids the problem) and skip the clean
prefix.

Either way, keep a retry budget (one or two attempts is plenty) and fall
back to letting the broken message stand: the client renders it anyway,
and the issue report goes into the next turn as usual.

## Building the next request on the server

The previous message's feedback and the "action was fired" message both end
up in the model's next request. **Build them on the server** from structured
client input, not from text the client sends:

```ts
import { formatIssueReport, resolveGenUiAction, validateGenUiMessage } from "ingenui/server";

// The client sends { action: event.name, renderErrors: [{ blockIndex, message }] }
function nextUserTurn(previousMessage: string, action: string | undefined, renderErrors) {
  const parts: string[] = [];
  if (action !== undefined) {
    const resolved = resolveGenUiAction(schema, action); // null: not an action the model could wire
    if (resolved === null) throw new BadRequest();
    parts.push(resolved.message); // "The `actions.subscribe` action was fired by the user."
  }
  const report = formatIssueReport([
    ...validateGenUiMessage(previousMessage, schema), // or the issues saved from pipeGenUi
    ...renderErrors.map(({ blockIndex, message }) => ({ kind: "render-error", blockIndex, error: message })),
  ]);
  if (report !== null) parts.push(report);
  return parts.join("\n\n");
}
```

`resolveGenUiAction(schema, name)` accepts:

- declared actions;
- with dynamic actions, any valid `actions.<name>` member.

It rejects non-identifiers, `__proto__` / `constructor` / `prototype`, and
inherited `Object.prototype` names such as `toString`.

## Sharing the schema

### A shared module (the default)

The schema is plain data, so one module can be imported by both your server
code and your client bundle. Nothing client-side gets pulled into the
server: `ingenui/schema` and `ingenui/server` never import React. This works
with any stack: a Vite SPA plus an API route, Remix, Next.js, Hono,
Workers, … React Server Components are not required. The
[demo](../../../apps/demo) is built this way.

### A per-request schema with React Server Components (a pattern)

Sometimes the schema depends on the request: admins get extra actions, or
`variableTypes` reflect the signed-in user's data. The prompt, the validator
and the client must then all use **the same** per-request schema. With RSC,
a Server Component can compute it once and pass it down. The schema is JSON,
so it crosses the server/client boundary as an ordinary prop:

```tsx
// app/chat/page.tsx — a Server Component
export default async function ChatPage() {
  const user = await currentUser();
  const schema = defineGenUiSchema({
    ...baseSchema,
    actions: user.isAdmin ? { ...baseSchema.actions, refund: true } : baseSchema.actions,
  });
  // The route handler that calls the model derives the same schema from the
  // same request, for formatGenUiPrompt and pipeGenUi.
  return <Chat schema={schema} />;
}
```

```tsx
// Chat.tsx
"use client";
export function Chat({ schema }: { schema: GenUiSchema }) {
  const genUi = useMemo(() => bindGenUi(schema, { components, variables }), [schema]);
  // … useGenUiMessage(stream, { ...genUi, Pending, onAction })
}
```

With a schema computed at runtime, `bindGenUi` can't type-check the
bindings against the literal shape, but the runtime checks still apply.
Keep the static shape in a shared module and narrow it per request, as
above.

### Keeping deployments in sync

If the server and the client are deployed separately, a client bundle can
briefly run against a newer server, with a different schema. Treat the
schema like an API contract: add components and actions before you start
prompting with them, and remove them only after clients stop using them.
