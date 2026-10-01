# API reference

- [`createGenUiMessage`](#creategenuimessagesource-options--ingenui) — the message store
- [Options](#options)
- [`useGenUiMessage` / `useGenUiNode`](#usegenuimessagesource-options--ingenuireact) — React hooks
- [`formatGenUiPrompt`](#formatgenuipromptoptions--ingenui) — the system prompt
- [`defineGenUiSchema` / `bindGenUi`](#definegenuischemaschema--ingenuischema) — the schema shared with the server
- [`ingenui/server`](#ingenuiserver) — the React-free server side

See also: [server and client: the shared schema](./server.md),
[the `actions` convention](./actions.md),
[issues and error containment](./issues.md), and
[Markdown and streaming](./markdown.md).

## `createGenUiMessage(source, options?)` — `ingenui`

The core store for **one streamed message**. Shaped as a drop-in for
`useSyncExternalStore`, like the underlying parser:

```ts
const message = createGenUiMessage(source, options);

message.getSnapshot(); // => ReactNode (stable ref until the content changes)
message.getServerSnapshot(); // SSR-safe snapshot
const unsubscribe = message.subscribe(() => {/* re-render */});
message.dispose(); // cancel the stream and detach
await message.done; // resolves when the stream and every UI block complete

message.getIssues(); // => readonly GenUiIssue[]
message.getIssueReport(); // => string | null — feedback for the model
```

**Accepted `source` types** are the parser's: `ReadableStream<Uint8Array>`
(the common `fetch().body` case), `ReadableStream<string>`, or any
`AsyncIterable<string | Uint8Array>`.

## Options

Everything `createIncrementalJsxParser` accepts (`components`, `elements`,
`variables`, `variableTypes`, `resolveComponent`, `onUnknownComponent`,
`onDisallowedElement`, `mismatchedTag`, `Pending`, `onStreamError`; see the
[parser's API reference](../../incremental-jsx-parser/docs/api.md#options)).
They are forwarded to every `ui+jsx` block's parser. In addition:

| Option           | Type                                  | Description |
| ---------------- | ------------------------------------- | ----------- |
| `actions`        | `Record<string, ActionHandler \| true \| { description? }>` | The actions the model may use; exposed as the predefined variable `actions`, each entry typed `"function"`. `true` (or a `{ description }` for the prompt) declares an action with no local handler. See [the `actions` convention](./actions.md). |
| `dynamicActions` | `boolean`                             | Let the model define its own actions by referencing them: any `actions.<name>` resolves; undeclared names are notify-only (`declared: false`). **Default `true`** — pass `false` to keep the action vocabulary host-owned. |
| `onAction`       | `(event: ActionEvent) => void`        | Fired when the user triggers an action. `event.message` is the canonical next-request text; `event.declared` distinguishes host-declared from model-defined actions. |
| `onIssue`        | `(issue: GenUiIssue) => void`         | Fired for every issue as it is found (issues also accumulate on the message). See [issues](./issues.md). |
| `renderMarkdown` | `(markdown: string, context: { streaming: boolean }) => ReactNode` | Replace the built-in [Markdown renderer](./markdown.md). `streaming` is `true` while the region holds the stream's frontier. |
| `wrapUiBlock`    | `(props: UiBlockWrapperProps) => ReactNode` | Wraps each block's rendering, e.g. to collapse or grey out a block with issues, or to show a fallback for a crashed one. See [wrapping UI blocks](./issues.md#wrapping-ui-blocks). |
| `renderUiError`  | `(blockIndex: number) => ReactNode`   | **Deprecated** — use `wrapUiBlock` (`crashed ? fallback : children`). Rendered in place of a block whose UI crashed (default: nothing). Called once per block, when it opens. |

With a [shared schema](./server.md), the parse-affecting options (`elements`,
`components`, `variables`, `variableTypes`, `actions`, `dynamicActions`,
`mismatchedTag`) come from [`bindGenUi`](#bindgenuischema-bindings--ingenui)
instead. Spread its result and add the client-only ones.

`onJsxError` is not an option here — the parser's structured errors flow into
the issue channel instead (`onIssue` / `getIssues`).

### `wrapUiBlock`

Called with the block's status and its default rendering:

| Prop         | Type | Description |
| ------------ | ---- | ----------- |
| `blockIndex` | `number` | 0-based, in document order (the issues' `blockIndex`). |
| `state`      | `"streaming" \| "closed" \| "unterminated"` | The block's fence is still open; it was closed; or the message ended without closing it (the stream ended or failed, or the server stopped it mid-block). |
| `issues`     | `readonly UiBlockIssue[]` | The block's `jsx-error` and `render-error` issues so far, in the order found (the same objects `getIssues()` returns). An unclosed fence shows as `state: "unterminated"`. |
| `crashed`    | `boolean` | Whether the block crashed while rendering. Final: a crashed block is not retried, and `children` renders nothing (or the deprecated `renderUiError` fallback). |
| `children`   | `ReactNode` | The default rendering: the live tree inside the block's error boundary. The wrapper may leave it out (e.g. when `crashed`). |

The types are exported as `UiBlockWrapperProps`, `UiBlockStatus`,
`UiBlockState`, and `UiBlockIssue`. The wrapper is called again only when
the block's tree or status changes. See [wrapping UI
blocks](./issues.md#wrapping-ui-blocks) for an example.

## `useGenUiMessage(source, options?)` — `ingenui/react`

React hook: creates the message from `source` (re-created when the source
identity changes, disposed on unmount) and subscribes via
`useSyncExternalStore`. Returns `{ node, message }` — the live tree plus the
store, for `done` / `getIssueReport()`.

`useGenUiNode(message)` renders a message store created elsewhere (e.g. where
the request is made, so the same code can read the issue report on
completion).

`useIsElementComplete()` is re-exported from the parser for the components
in your catalog: `false` while the component's element is still streaming,
`true` once it is settled. See the parser's
[API reference](../../incremental-jsx-parser/docs/api.md#useiselementcomplete--ingenuiincremental-jsx-parser).

## `formatGenUiPrompt(options?)` — `ingenui`

Builds the section of the generating model's system prompt that describes
the message format: how to open a `ui+jsx` fence, which actions exist (and,
unless `dynamicActions: false`, that it may invent action names), plus the
parser's `formatPromptContract` — the exact JSX subset, allowed
elements/components/props with their types, and predefined variables. Pass
it a [`GenUiSchema`](#definegenuischemaschema--ingenuischema) (the usual
server-side call, also exported from `ingenui/server`), or the same schema
options you pass to `createGenUiMessage`. Component and action
`description`s are included in the prompt:

```ts
import { formatGenUiPrompt } from "ingenui";

const systemPrompt = `You are a helpful assistant …

${formatGenUiPrompt({
  components: { Card: { component: Card, props: { title: "string" } } },
  elements: { div: true, p: true, button: true },
  actions: { subscribe: true },
})}`;
```

## `defineGenUiSchema(schema)` — `ingenui/schema`

Declares the data-only **GenUI schema** shared by the server and the client:
`elements`, `components` (name → `{ props?, description? }` or `true`),
`variableTypes`, `actions` (name → `true` or `{ description? }`),
`dynamicActions`, and `mismatchedTag`. It is an identity function at
runtime; at the type level it keeps the literal shape for `bindGenUi`. The
entry is React-free. See [server and client](./server.md#the-schema--ingenuischema).

## `bindGenUi(schema, bindings)` — `ingenui`

Binds the implementations to a schema and returns the schema-derived
`createGenUiMessage` options:

```ts
const genUi = bindGenUi(schema, {
  components: { Card, Chart }, // required: one per declared component
  variables: { user }, // required: one per declared variable, of its declared type
  actions: { subscribe: () => openCheckout() }, // optional handlers for declared actions
});
useGenUiMessage(stream, { ...genUi, Pending: Shimmer, onAction });
```

- **Type checks:** components must accept the props the schema declares, all
  of them optional (the model may omit any), plus `children`. Variable values
  must match their declared types. `InferSchemaType<T>` /
  `InferComponentProps<D>` expose the mapping.
- **Runtime checks:** throws when a declared component or variable has no
  binding, or when a component, variable or action handler is not declared
  in the schema.

## `ingenui/server`

The React-free server side. See [server and client](./server.md#the-server--ingenuiserver).

| Export | Description |
| ------ | ----------- |
| `formatGenUiPrompt(schema)` | The system prompt, as above. |
| `pipeGenUi(source, schema, { onIssue?, continuation? })` | Validates a stream while passing it through. Returns `{ stream, done, stop, getIssues, getIssueReport }`: `stream` is a UTF-8 byte stream ready to be a `Response` body, `done` resolves with the result (`status`, `text`, `issues`, `issueReport`, `cleanOffset` / `cleanText`, `stops`) at the end, and `stop()` [stops the message](./server.md#stopping-and-recovering) (`onIssue` receives the pipe too). `continuation` continues a stopped message with a new source. |
| `formatContinuationMessage(text, issueReport)` | The user message asking the model to continue an interrupted response after `text`, with the issue report. |
| `createGenUiValidator(schema, { onIssue? })` | A push-based validator (`write`, `end`, `getIssues`, `getIssueReport`, `getCleanOffset`, `getFenceClose`). |
| `validateGenUiMessage(text, schema)` | Validates a complete message and returns its issues. |
| `resolveGenUiAction(schema, name)` | Resolves an action name sent by the client to `{ name, reference, message, declared }`, or `null` if the model could not have wired it. |
| `formatIssueReport(issues)` / `formatActionMessage(name)` / `formatJsxError(event)` | Feedback formatting, as on the client. |

For the same text and schema, the server reports exactly the `jsx-error` and
`unclosed-fence` issues the client does. `render-error` issues are
client-only.
