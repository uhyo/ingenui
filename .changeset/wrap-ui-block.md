---
"ingenui": patch
---

New `wrapUiBlock` option for `createGenUiMessage`: wraps each `ui+jsx` block's rendering with the app's own markup. It receives the block's `blockIndex`, `state` (`"streaming"` / `"closed"` / `"unterminated"`), its `jsx-error` / `render-error` `issues` so far, whether it `crashed`, and `children` (the default rendering, still inside the built-in error boundary), so an app can grey out, collapse, or label a broken block (e.g. above the corrected block after a stop and continuation), or show a fallback for a crashed one. It is called again only when the block's tree or status changes.

A render crash is now final: the block's error boundary no longer retries as more of the stream arrives (props are final when an element appears; only children grow, and components can check `useIsElementComplete()`). `UiBlockErrorBoundary` drops its `resetKey` prop. `renderUiError` is deprecated in favour of `wrapUiBlock` (`crashed ? fallback : children`).
