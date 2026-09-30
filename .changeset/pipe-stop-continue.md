---
"ingenui": patch
---

`pipeGenUi` can stop a streamed message on a parse issue and recover, transport-agnostically. `pipe.stop()` (also passed to `onIssue` as its second argument) cancels the source and ends the stream normally instead of with an error. The new `continuation` option continues a stopped message in the same stream: it closes an open fence, then pipes the source the callback returns into the same validation state, so block indices and issues stay aligned with the client. `done` now resolves with a result object (`status`, `text`, `issues`, `issueReport`, `cleanOffset` / `cleanText`, `stops`) instead of the issues array. New `formatContinuationMessage` builds the Messages API "continue from where you left off" request, and the validator gains `getCleanOffset()` / `getFenceClose()`.
