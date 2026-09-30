# Issues and error containment

Errors never blank the message: Markdown keeps rendering, other blocks keep
working, and every problem is collected as an **issue** you can send back to
the model so it can correct itself.

## Issues: the feedback loop

`GenUiIssue` is a discriminated union on `kind`; every issue carries the
0-based `blockIndex` of the `ui+jsx` block it belongs to (in document order):

| `kind`            | Extra fields | Meaning |
| ----------------- | ------------ | ------- |
| `"jsx-error"`     | `event: JsxErrorEvent` | A structured parse-time error from the JSX parser (unknown component/variable, unsupported expression, mismatched/unclosed tag, disallowed element, invalid prop). |
| `"render-error"`  | `error: unknown` | The block's UI **crashed while rendering** (a component threw); the error boundary hid the block. |
| `"unclosed-fence"`| —            | The stream ended before the block's closing ``` fence. |

Issues are reported as they are found through `onIssue` and accumulate on the
message (`message.getIssues()`).

`formatIssueReport(issues)` (also available as `message.getIssueReport()`,
which returns `null` when there is nothing to report) renders them as one
report addressed to the model, grouped per block, with the parser's caret
code frames inline — send it as (part of) the next request and the model can
correct itself:

```text
Your last message had problems in its `ui+jsx` blocks. …

In `ui+jsx` block 1:
- Unknown component <Chart> (line 2, column 3)

    2 |   <Chart data={metrics} />
      |   ^
```

### On the server

The server finds the same `jsx-error` and `unclosed-fence` issues while the
message streams through it (`pipeGenUi` / `validateGenUiMessage` in
[`ingenui/server`](./server.md#the-server--ingenuiserver)). Only
`render-error` needs the client, which can report it as structured data
(`{ blockIndex, message }`). The server can then build the report itself
with `formatIssueReport` instead of accepting report text from the client.
See [building the next request on the server](./server.md#building-the-next-request-on-the-server).

Since the server sees an issue before the client does, it can also stop the
model right there and recover — continuing the same message with a
correction, or rewinding to the last clean boundary. See
[stopping and recovering](./server.md#stopping-and-recovering).

## Error containment

Each `ui+jsx` block renders inside its own error boundary
(`UiBlockErrorBoundary`, exported for standalone use):

- A render-time crash hides **that block only** — the surrounding Markdown
  and other blocks are unaffected — and records a `render-error` issue.
- While the block is still streaming, every new chunk retries the block, so a
  crash caused by partially-arrived content heals itself.
- `renderUiError` supplies a fallback (an "invalid UI" note, for instance);
  by default the crashed block renders as nothing.
- `wrapUiBlock` wraps every block with your own markup, aware of its issues
  and state (below).

## Wrapping UI blocks

A block with parse-time issues still renders whatever parsed. That is often
fine, but sometimes the app wants to show that the block is broken — most of
all when the server [stopped the model and continued the
message](./server.md#continuing-the-same-message): the broken partial block
stays in the message, followed by the model's corrected one.

`wrapUiBlock` wraps each block's rendering. It receives the block's status
and the default rendering as `children`:

```tsx
createGenUiMessage(source, {
  ...genUi,
  wrapUiBlock: ({ issues, state, crashed, children }) => {
    if (crashed) return <p className="ui-note">This UI could not be shown.</p>;
    if (issues.length === 0 && state !== "unterminated") return children;
    return (
      <details className="ui-broken">
        <summary>This UI had problems — a corrected version follows</summary>
        {children}
      </details>
    );
  },
});
```

- `state` is `"streaming"` while the block's fence is open, `"closed"` once
  its closing fence arrives, and `"unterminated"` when the message ended
  without one (the stream ended or failed, or the server stopped it
  mid-block without a continuation).
- `issues` holds the block's `jsx-error` and `render-error` issues so far,
  updated as they arrive. An unclosed fence is not in the list; it shows as
  `state: "unterminated"`.
- `crashed` is `true` while the block's error boundary shows the fallback
  (`children` is then the `renderUiError` fallback). A block that heals as
  more of the stream arrives clears it; its `render-error` stays in
  `issues`.

The built-in error boundary stays inside `children`, so a crashing block
still never takes down the message and keeps retrying while it streams. The
wrapper itself is your code and runs outside the boundary.

The wrapper is called again only when the block's tree or status changes, so
a settled block keeps its element identity. To keep the block's component
state (an input's value, for instance), keep `children` at the same position
in your markup when the status changes: switching between returning
`children` bare and inside a `<details>` remounts it.

`renderUiError` is a shorthand for the common case: it only sets the crash
fallback. Use both to customize the fallback and wrap it.

A failing stream *source* (network error) is separate: `onStreamError` fires
once, `done` rejects, and the content received so far stays rendered, with
open blocks finalized best-effort.
