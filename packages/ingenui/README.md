# ingenui

> Pronounced **in-JEN-you-ee** — a prefix of _ingenuity_ that contains _GenUI_.

A **lightweight Generative UI framework**: stream an AI-generated Markdown
message into a live React tree, where fenced ```` ```ui+jsx ```` code blocks
render as **interactive UI** through
[`@ingenui/incremental-jsx-parser`](../incremental-jsx-parser).

The model writes ordinary Markdown; wherever it wants real UI, it opens a
`ui+jsx` fence:

````markdown
Here are your options:

```ui+jsx
<Card title="Standard plan">
  <button onClick={actions.subscribe}>Subscribe</button>
</Card>
```

Let me know if you have questions!
````

## Highlights

- **Just Markdown** — no tool calls or custom protocol; the model writes prose
  and drops in UI wherever it helps. The UI streams in live, with a
  `<Pending />` placeholder at the exact insertion point.
- **Interactive via `actions`** — the model wires `onClick={actions.submit}`;
  when the user clicks, you get the canonical next request for the model
  (``The `actions.submit` action was fired by the user.``). The model can even
  invent its own action names — the name is the definition.
- **Self-correcting** — parse errors, render crashes, and unclosed fences are
  collected as issues and formatted into a feedback report for the model.
- **Errors never blank the message** — each UI block sits in its own error
  boundary, so Markdown and other blocks keep working. `wrapUiBlock` lets
  the app mark a broken block (grey it out, collapse it, show a fallback),
  e.g. above its correction.
- **Safe for untrusted output** — allowlisted components/elements, typed
  props, and a built-in Markdown renderer that never renders raw HTML.
- **Prompt included** — `formatGenUiPrompt` tells the model the message
  format, the actions, and the exact JSX it may emit.
- **Server and client** — one data-only schema, shared by both sides. The
  server (`ingenui/server`, React-free) builds the prompt and validates the
  model's stream as it passes through, catching the same issues the client
  will, as they arrive — and can stop the model on one and continue the
  same message with a correction. The client binds type-checked components
  to the schema. RSC is not required.

> **Status:** early development. The API is implemented and tested, but may
> still change before a stable release.

## Install

```sh
npm install ingenui
# react is a peer dependency (>= 18); @ingenui/incremental-jsx-parser comes with it
```

## Usage

Declare the schema once, as plain data shared by the server and the client:

```ts
// genui-schema.ts
import { defineGenUiSchema } from "ingenui/schema";

export const schema = defineGenUiSchema({
  components: { Card: { props: { title: "string" }, description: "A titled panel." } },
  elements: { div: true, p: true, button: true },
  actions: { subscribe: { description: "Start a subscription." } },
});
```

On the server, prompt the model and validate its stream on the way to the
client:

```ts
import { formatGenUiPrompt, pipeGenUi } from "ingenui/server";

const system = `You are a helpful assistant …\n\n${formatGenUiPrompt(schema)}`;
const pipe = pipeGenUi(await callTheModel(system), schema, { onIssue: console.warn });
return new Response(pipe.stream);
```

On the client, bind the components and render the streamed message:

```tsx
import { bindGenUi } from "ingenui";
import { useGenUiMessage } from "ingenui/react";

const genUi = bindGenUi(schema, { components: { Card } }); // type-checked against the schema

function AssistantMessage({ stream }: { stream: ReadableStream<Uint8Array> }) {
  const { node, message } = useGenUiMessage(stream, {
    ...genUi,
    onAction: (event) => {
      // Send `event.name` back; the server turns it into the canonical next
      // request ("The `actions.subscribe` action was fired by the user.").
      sendAction(event.name);
    },
    Pending: () => <span className="shimmer" />,
  });
  return <div className="message">{node}</div>;
}
```

A client-only setup works too: pass `components`, `actions`, … directly to
`useGenUiMessage`, and send `message.getIssueReport()` back to the model
after `message.done`.

## Documentation

- [API reference](./docs/api.md) — `createGenUiMessage`, options,
  `useGenUiMessage` / `useGenUiNode`, `formatGenUiPrompt`,
  `defineGenUiSchema` / `bindGenUi`, and `ingenui/server`.
- [Server and client](./docs/server.md) — the shared schema, server-side
  validation (`pipeGenUi`), stopping a message on an issue and recovering,
  building the next request on the server, and sharing patterns (plain
  modules, RSC).
- [The `actions` convention](./docs/actions.md) — declared and model-defined
  actions, and `dynamicActions`.
- [Issues and error containment](./docs/issues.md) — the issue kinds, the
  feedback report, per-block error boundaries, and wrapping blocks
  (`wrapUiBlock`).
- [Markdown and streaming](./docs/markdown.md) — the supported Markdown
  subset, its safety rules, and streaming semantics.
- The JSX side (supported syntax, schema, prop types) is documented in
  [`@ingenui/incremental-jsx-parser`](../incremental-jsx-parser).

## License

MIT © uhyo
