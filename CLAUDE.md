# CLAUDE.md

Guidance for working in this repository.

## What this is

A **pnpm monorepo** hosting a Generative UI toolchain. Workspace layout:

- `packages/*` — published libraries. Currently:
  - [`packages/incremental-jsx-parser`](./packages/incremental-jsx-parser) —
    incrementally parses a **streamed JSX string** into a **live React tree**,
    rendering the not-yet-arrived part as a single `<Pending />` placeholder at
    the streaming frontier.
  - [`packages/ingenui`](./packages/ingenui) — lightweight **Generative UI
    framework** wrapping the parser: streams AI-generated **Markdown** where
    ```` ```ui+jsx ```` code fences render as live UI, with the `actions`
    convention (UI → next AI request) and structured issue feedback for the
    model. Covers both the client and the server: a data-only schema shared
    by both sides, and a React-free `ingenui/server` that prompts the model
    and validates its stream as it passes through.
- `apps/*` — private, unpublished apps. Currently:
  - [`apps/demo`](./apps/demo) — Vite playground with two modes: streams a
    ingenui Markdown message (live UI blocks, action log, feedback report)
    or raw JSX into the live tree. Deployed as a Cloudflare Worker whose
    `/api/*` routes (`worker/index.ts`) are the ingenui server side: a
    simulated model streamed through `pipeGenUi`, plus the server-built
    prompt and next request. In `vite dev` a middleware serves the same
    handler. Both workspace libraries resolve to source via aliases (Vite,
    tsconfig, wrangler), so there is no build step.

Per-package docs: the parser's original goal is
[`packages/incremental-jsx-parser/GOAL.md`](./packages/incremental-jsx-parser/GOAL.md),
the full design is
[`packages/incremental-jsx-parser/PLAN.md`](./packages/incremental-jsx-parser/PLAN.md),
and the public API is documented in its
[`docs/`](./packages/incremental-jsx-parser/docs).

Each package's `README.md` stays minimal (what it is, highlights, install,
basic usage, links); detailed documentation lives in the package's `docs/`
directory. When changing public API or behavior, update the relevant
`docs/*.md` page.

## Monorepo conventions

- Single lockfile at the repo root; `pnpm install` there installs everything.
  Workspace members declare each other with `workspace:*`.
- **Lint/format are root-level** (`pnpm run lint` → `oxlint`, `pnpm run format`
  → `oxfmt`, configs `.oxlintrc.json` / `.oxfmtrc.json` at the root, covering
  the whole repo). Packages don't have their own lint/format scripts.
- **Typecheck/test/build are per-package**; root scripts fan out with
  `pnpm -r run <script>` (packages lacking the script are skipped). Package
  tsconfigs extend the root [`tsconfig.base.json`](./tsconfig.base.json)
  (the demo app keeps a looser standalone tsconfig).
- Target a single package with `pnpm --filter <package-name> <script>`.
- New published packages go in `packages/<name>` with their own `package.json`
  (`repository.directory` set), `tsconfig.json` extending the base, `tsdown`
  build, colocated Vitest tests, and a `LICENSE` copy. Add `publint`/`attw`
  scripts so root `pnpm run publint` / `pnpm run attw` cover them.

## Architecture: `packages/incremental-jsx-parser`

The pipeline is a chain of small, independently testable modules
(`source → tokenizer → tree builder → store → React adapter`). Paths below are
relative to `packages/incremental-jsx-parser/`:

| File | Role |
| ---- | ---- |
| `src/ast.ts` | AST node types + the dependency-free primitives every stage shares (`UNSUPPORTED_EXPRESSION`, `isComponentName`, `resolveVariablePath` / `FORBIDDEN_SEGMENTS`). Imports nothing, which keeps the module graph acyclic. |
| `src/errors.ts` | `JsxErrorEvent` union + `formatJsxError` (code-frame report). |
| `src/position.ts` | `SourceLocation` + `PositionTracker`: line/column/offset and per-line context for error frames, kept out of the lexer. The tokenizer *extends* it (private state, protected API) so the per-character fields stay on one object — measurably faster than holding a tracker. Dependency-free. |
| `src/text-run.ts` | `TextRun`: one run of child text, entity-decoded and JSX-whitespace-normalized incrementally (real-JSX semantics, decode-before-normalize). A possibly-incomplete entity or unresolved whitespace is withheld from `pending()` until it resolves. |
| `src/tokenizer.ts` | Resumable, char-level lexing state machine (text via `TextRun`, positions via `PositionTracker`). Retains partial state across chunk boundaries and emits a **chunking-invariant** token stream. `getPending()` reports the renderable frontier (partial text). |
| `src/tree-builder.ts` | Builds the AST from tokens. Open elements are builder-private frames that become frozen nodes when they close (so no node is ever mutated once handed out; closed nodes are reused by reference); `snapshot()` is a pure read that materializes the open path + the single `PendingNode` frontier. `push(tokens)` / `end()` **return** the error events (no listener calls); schema errors come from `validate.ts`. Handles closing-tag mismatch (`mismatchedTag`). |
| `src/validate.ts` | Parse-time schema validation as pure functions: `validateOpeningTag` / `validateVariable` map a parsed construct + `SchemaChecks` to error events. `createSchemaChecks(schema)` is the one canonical wiring of the schema checks, shared by the React adapter and ingenui's server validator. |
| `src/entities.ts` | HTML character-reference decoding (numeric + the named HTML4 set + `apos`), shared by text and string attribute values. Unknown references stay verbatim. Dependency-free. |
| `src/expression.ts` | Pure parser for the supported `{ }` subset (literals, predefined-variable references incl. dot-notation member access, + nested JSX — the latter two via injected callbacks). Returns `UNSUPPORTED_EXPRESSION` otherwise. Depends only on `ast.ts`. |
| `src/schema.ts` | Element allowlist (`elements`) + the lightweight prop type system (`SchemaType`: primitives, `function`/`object`/`node`/`url`/`any`, unions, object shapes). Elements and component specs declare prop catalogs (`checkProp` validates every parsed prop, incl. component props); variables get declared types (`variableTypes`) or value-inferred ones (`resolveVariableType`). The built-in host rules (`style: "object"`, `on*: "function"`, URL props: `"url"`, blocked `dangerouslySetInnerHTML` &c.) are default declarations in the same system and can't be relaxed. Shared canonical checks — parse-time events and render-time enforcement both call them. `formatPromptContract` serializes the schema (types included) for the generating model's system prompt. React-free. |
| `src/core.ts` | `./core` entry: `createParser` — the imperative shell over tokenizer + builder (push-based store, dispatches the returned errors to `onJsxError`, version-cached `getTree`, per-chunk notifications) + re-exports of the React-free API. **Zero React dependency.** |
| `src/stream.ts` | `pumpStream`: normalizes `ReadableStream`/`AsyncIterable` sources, decodes bytes with a streaming `TextDecoder`, supports cancellation. |
| `src/render.ts` | AST → `ReactNode`. Component resolution (`resolveComponent`, shared with the parse-time probe), node-id keys, WeakMap memoization of closed subtrees. `RenderOptions` is the documented base of the adapter's options. |
| `src/index.ts` | React adapter entry (`createIncrementalJsxParser`). |
| `src/react.ts` | `useIncrementalJsx` hook (over `useSyncExternalStore`). |

### Invariants worth preserving

- **Single frontier** (PLAN §1): while the stream is open the snapshot contains
  exactly one `PendingNode`, nested in the innermost open element.
- **Chunk independence** (PLAN §5): the final result must not depend on how the
  input is split. Enforced by the resumable tokenizer and the fuzz suite.
- **Immutable AST**: the node types are `readonly` and no node is mutated once
  handed out; closed nodes are frozen and keep their identity. This keeps React
  reconciliation cheap (stable keys + memoized subtrees).
- **Pure core, imperative shell**: stages return their output (tokens, error
  events) as data; only `createParser` / the adapters invoke callbacks.
- **Performance**: the tokenizer and tree builder are hot paths. Benchmark a
  refactor of them against the previous commit (several chunk sizes, e.g. 4 /
  16 / 1024 chars) before landing it.

### Deliberate v1 scope decisions

- Text follows **real JSX parser semantics** (Babel-equivalent): HTML entities
  are decoded (numeric + HTML4 named set; not the full HTML5 list) and JSX
  whitespace rules apply (indentation dropped, line breaks join with a single
  space). Both happen incrementally in the tokenizer, decode-before-normalize.
- Nested JSX *inside an expression* is buffered until its `}` (it appears at once
  rather than streaming its own inner frontier).

### Subpath exports

`.` (React adapter), `./react` (hook), `./core` (framework-agnostic, incl.
`pumpStream`). The `./core` entry must stay React-free — don't import
`react`/`render.ts` from `core.ts`, `ast.ts`, `errors.ts`, `position.ts`,
`text-run.ts`, `tokenizer.ts`, `tree-builder.ts`, `validate.ts`,
`expression.ts`, `schema.ts`, `entities.ts`, or `stream.ts`.

## Architecture: `packages/ingenui`

Wraps the parser's **public API only** (root entry + `./core`); typecheck and
Vitest resolve it to the parser's source via tsconfig `paths` / a Vite alias
(same pattern as `apps/demo`), so no build step is needed first. Paths below
are relative to `packages/ingenui/`:

| File | Role |
| ---- | ---- |
| `src/fence.ts` | CommonMark backtick-fence regex + `isFenceClose`, shared by the splitter and the Markdown renderer. |
| `src/splitter.ts` | Resumable Markdown / ```` ```ui+jsx ```` fence splitter, reporting through handlers (it never touches consumer state; handlers rather than returned events keep the server path allocation-free). Chunking-invariant commits (per complete line); a partial trailing line is a tentative "tail" (withheld while it could still be a fence); tracks regular code fences so a `ui+jsx` opener inside one is not misread. |
| `src/channel.ts` | Single-consumer push channel; each `ui+jsx` block's extracted JSX is pushed through one into its own `createIncrementalJsxParser`. |
| `src/markdown.tsx` | Built-in safe CommonMark-subset renderer (raw HTML stays literal text, URL schemes checked). Pure/total — re-run on a growing region while streaming. Pluggable via `renderMarkdown`. |
| `src/actions.ts` | The `actions` convention: declared actions → the predefined `actions` variable (typed `"function"`), firing `ActionEvent`s with the canonical next-request `message`. `withActionsVariable` merges it into the variables — the one place both the message runtime and the prompt do so. Dynamic actions (the default; `dynamicActions: false` opts out): a Proxy resolves *any* `actions.<name>` to a notify-only action (`declared: false`) — the model defines actions by referencing them; no host code ever runs for undeclared names. |
| `src/issues.ts` | `GenUiIssue` union (`jsx-error` / `render-error` / `unclosed-fence`, all per `blockIndex`) + `formatIssueReport` (feedback text for the model). |
| `src/boundary.tsx` | Per-block error boundary; `resetKey` bumps on each parser update so a crashed block retries as the stream grows (`onError` / `onRecover` report crash and recovery). |
| `src/message-model.ts` | The message's structure as an immutable value: `createSplitEventCollector` records the splitter's reports as `SplitEvent`s, and `applySplitEvents` (pure reducer) turns each chunk's events into markdown / UI regions. No runtime objects. React-free. |
| `src/ui-block.tsx` | `createUiBlock`: one block's runtime — push channel → its own `createIncrementalJsxParser`, rendered in a boundary; reports its `jsx-error` / `render-error` issues (each distinct crash once). Keeps its status (`state`, `issues`, `crashed`) as an immutable value for the app's `wrapUiBlock`; `render()` is memoized on (parser version, status) so a settled block keeps its element identity. |
| `src/message.tsx` | `createGenUiMessage`: the imperative shell — pumps the source through the splitter into the model (reducer) and the block runtimes (one merged write per block per chunk), collects issues, and renders (`renderMessage`, per-region Markdown memoization) into a `useSyncExternalStore`-shaped store. |
| `src/prompt.ts` | `formatGenUiPrompt`: message format + actions (with descriptions) + the parser's `formatPromptContract`. Takes a `GenUiSchema` or the client options. |
| `src/schema.ts` | `./schema` entry: `GenUiSchema`, the parse-affecting options as plain data (elements, component prop catalogs + descriptions, `variableTypes`, actions, `dynamicActions`, `mismatchedTag`), + `defineGenUiSchema` (identity; keeps literal types). Shared by server and client. |
| `src/bind.ts` | `bindGenUi(schema, bindings)`: attaches components / variable values / action handlers, returning `createGenUiMessage` options. Type-checks the bindings (`InferSchemaType` / `InferComponentProps`: declared props all optional + `children`) and throws on missing or undeclared bindings. |
| `src/validator.ts` | `createGenUiValidator` / `validateGenUiMessage`: splitter + the parser core's `createParser` per block, wired with `createSchemaChecks` exactly like the client's parser. Synchronous issues. Also the cut information: the last clean boundary (`getCleanOffset`, from the splitter's opener offsets) and the open fence's closing text (`getFenceClose`). |
| `src/pipe.ts` | `pipeGenUi`: pull-based pass-through `ReadableStream<Uint8Array>` that validates as it goes; `done` resolves with the result (status, text, issues, clean boundary). `stop()` (also via `onIssue`'s second argument) cancels the source and ends the stream normally; the `continuation` option closes an open fence and pipes a new source into the same message. Transport-agnostic: only text goes over the wire. `formatContinuationMessage` builds the "continue from where you left off" request. |
| `src/index.ts` / `src/react.ts` / `src/server.ts` | Entries: `.` (store + helpers + `bindGenUi`), `./react` (`useGenUiMessage`, `useGenUiNode`), `./server` (validator, `pipeGenUi`, prompt, `resolveGenUiAction`, report formatting). |

Invariants: chunk independence end-to-end (its own fuzz suite); markdown
regions and UI blocks keep stable element identities once settled; a crashed
UI block never takes down the message (boundary + retry, with the app's
`wrapUiBlock` outside the boundary); issues are the only error channel
(`onJsxError` is not exposed); **server/client parity**: for the same text and
schema, the server validator reports exactly the client's parse-time issues
(`jsx-error` and `unclosed-fence`; only `render-error` is client-only),
including for stopped and continued piped messages. The fuzz suite checks
this. Both sides build their schema checks with the
parser's `createSchemaChecks`; keep the rest of the validator's parser wiring
in step with `createIncrementalJsxParser`'s. Every parse-affecting option belongs in
`GenUiSchema`. **`./schema` and `./server` stay React-free**: they may import
only the parser's `/core` (enforced by `server.test.ts`), so `issues.ts`,
`prompt.ts`, `actions.ts`, `splitter.ts`, `fence.ts`, `message-model.ts`,
`validator.ts`, and `pipe.ts` must not import React or the parser's root
entry.

## Development

```sh
pnpm install     # at the repo root — installs the whole workspace
pnpm run check   # lint + format:check + typecheck + test (run before pushing)
pnpm test        # all package tests (vitest run per package)
pnpm run build   # build all packages
```

Tooling: TypeScript (strict), Vitest + happy-dom, oxlint + oxfmt, tsdown,
publint + attw. Each `src/*.ts(x)` has a colocated `*.test.ts(x)`; the fuzz suite
(`packages/incremental-jsx-parser/src/fuzz.test.ts`) checks chunk-independence
and the single-frontier invariant over generated input. The `./core` entry's
React-freedom is enforced by `core.test.ts` (like `server.test.ts` in ingenui).

## Release flow (Changesets)

Releases are automated by [`.github/workflows/release.yml`](./.github/workflows/release.yml)
on pushes to `master`. Changesets is workspace-aware: it versions and publishes
every non-private package with pending changesets (private workspace members
like `apps/demo` are never versioned or published).

1. **In a PR that changes published behavior**, add a changeset:
   ```sh
   pnpm changeset
   ```
   Pick the affected package(s) and bump (patch/minor/major) and describe the
   change. Commit the generated `.changeset/*.md` file with the PR.

   **Early development: always pick `patch`.** Versions must stay within
   `0.0.x` for now, whatever the change — Changesets has no config to cap
   versions, so the bump choice in each changeset is the only control. Never
   select `minor` or `major` until the maintainer lifts this rule.
2. **On merge to `master`**, the release workflow opens (or updates) a
   "Version Packages" PR that applies the pending changesets, bumps the
   versions, and updates each package's `CHANGELOG.md`.
3. **Merging the "Version Packages" PR** publishes to npm (public access, with
   provenance).

The workflow uses the `changesets/action` v2 sub-actions (paired with
`@changesets/cli` v3), one job each: `select-mode` decides `version` (pending
changesets) / `publish` (unpublished versions) / `none`; `version` opens the
PR; `pack` builds and packs tarballs (`changeset pack`); `publish` publishes
those tarballs. Permissions are per job; only `publish` gets `id-token: write`.

Publishing uses **npm trusted publishing (OIDC)** — no `NPM_TOKEN` secret. The
`publish` job's `id-token: write` permission lets npm authenticate via OIDC. This
requires a one-time setup on npmjs.com **per package**: configure the package's
trusted publisher to this repo and the `release.yml` workflow. Provenance is
generated automatically.

Don't bump versions in `package.json` files by hand — let Changesets do it.
