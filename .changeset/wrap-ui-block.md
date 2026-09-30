---
"ingenui": patch
---

New `wrapUiBlock` option for `createGenUiMessage`: wraps each `ui+jsx` block's rendering with the app's own markup. It receives the block's `blockIndex`, `state` (`"streaming"` / `"closed"` / `"unterminated"`), its `jsx-error` / `render-error` `issues` so far, whether it is `crashed` right now, and `children` (the default rendering, still inside the built-in error boundary), so an app can grey out, collapse, or label a broken block (e.g. above the corrected block after a stop and continuation). It is called again only when the block's tree or status changes. `renderUiError` stays as the shorthand for the crash fallback, now called once per block. `UiBlockErrorBoundary` gains an `onRecover` prop.
