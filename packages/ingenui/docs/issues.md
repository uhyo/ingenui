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

A failing stream *source* (network error) is separate: `onStreamError` fires
once, `done` rejects, and the content received so far stays rendered, with
open blocks finalized best-effort.
