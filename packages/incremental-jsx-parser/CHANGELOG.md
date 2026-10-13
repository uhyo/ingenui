# @ingenui/incremental-jsx-parser

## 0.0.2

### Patch Changes

- ebfc21a: Add `useIsElementComplete()`: a hook for catalog components that returns `false` while the component's element is still open on the stream and `true` once it is settled (closing tag arrived, self-closing, or auto-closed). Each resolved component element is now wrapped in a context provider, so the flag flips without remounting. Exported from `@ingenui/incremental-jsx-parser` and `/react`, and re-exported from `ingenui/react`.
- 7ea2f79: Internal refactoring: the parser's AST primitives and error events move into dependency-free modules (no more import cycles), and duplicated logic (component resolution, fence parsing, `actions` variable wiring) is shared. `IncrementalJsxParserOptions` fields now also accept an explicit `undefined`, and `GenUiMessage` extends `IncrementalJsxParser`. With `dynamicActions: false` and an empty `actions` map, the `actions` variable is no longer defined (matching the prompt).
- ff93a7e: The prompt contract (`formatPromptContract`, and so `formatGenUiPrompt`) no longer claims text is "rendered literally". It now says text follows JSX rules — HTML entities are decoded and line breaks/indentation collapse to single spaces — still recommends writing characters directly, and lists `&lt;` / `&#123;` alongside `{"<"}` for a literal `<` or `{`.
- e871136: Separate pure logic from side effects. **Breaking (`/core`):** `createParser` now takes the schema checks as one `checks: SchemaChecks` option (build it with the new `createSchemaChecks(schema)`) instead of the flat `isKnownComponent` / `isKnownVariable` / `isAllowedElement` / `checkProp` callbacks, and `TreeBuilderOptions` is no longer exported. The AST node types are now `readonly`, matching the frozen nodes the parser has always handed out. Parse errors are still reported synchronously by the `write()` that completes them, now once the chunk is fully parsed. `validateOpeningTag` and `validateVariable` are exported as the pure functions behind the schema errors. Streaming is faster with small chunks (the live snapshot copies less), and a streamed ingenui message renders with fewer, larger UI-block updates.
- a60f3da: ingenui now covers the server as well as the client:
  
  - `ingenui/schema`: `defineGenUiSchema` declares the parse-affecting options (elements, component prop catalogs with descriptions, variable types, actions, `dynamicActions`, `mismatchedTag`) as plain data, shared by the server and the client.
  - `bindGenUi(schema, bindings)` (in `ingenui`) binds components, variable values and action handlers to a schema. The bindings are type-checked against the schema (`InferSchemaType` / `InferComponentProps`) and checked at runtime.
  - `ingenui/server` (React-free): `pipeGenUi` validates a model's stream while passing it through to the client, reporting the client's parse-time issues as soon as they are streamed. It also exports `createGenUiValidator` / `validateGenUiMessage`, `resolveGenUiAction` (for building the next request on the server from an action name), `formatGenUiPrompt`, and `formatIssueReport`.
  - `formatGenUiPrompt` accepts a schema and includes component and action descriptions. Actions may be declared as `{ description }`.
  
  Parser: component specs accept a `description` (listed by `formatPromptContract`). The prompt contract now lists declared variables first, and a prop rejected by an empty prop catalog now reads "`<Tag>` takes no props".

## 0.0.1

### Patch Changes

- e3b5492: Export the `pumpStream` stream driver (and its `StreamSink` / `StreamHandle` /
  `JsxStreamSource` types) from the `./core` entry, so framework adapters built
  on the core can reuse the same source normalization (byte/string
  `ReadableStream`s and `AsyncIterable`s, streaming `TextDecoder`, cancellation)
  as the React adapter.
- feae30a: Initial release: incrementally parse a streamed JSX string into a live React
  tree, rendering the not-yet-arrived part as a single `<Pending />` placeholder at
  the streaming frontier.

  - React hook (`useIncrementalJsx`) and store (`createIncrementalJsxParser`).
  - Framework-agnostic, push-based core (`createParser`) with zero React dependency.
  - Resumable, chunk-independent tokenizer; append-only AST with memoized,
    referentially-stable closed subtrees.
  - Supported JSX subset: host/component elements, fragments, self-closing tags,
    string/boolean/expression attributes, and `{ }` expressions (string/template
    literals without substitutions, numbers, `true`/`false`/`null`/`undefined`,
    and nested JSX).
  - Lenient error handling (auto-close, configurable `mismatchedTag`).

- 098477a: Report source locations on JSX errors. Every `JsxErrorEvent` now carries a
  `location: SourceLocation` — 1-based `line`/`column`, stream `offset`, and
  `lineText` (the content of the offending line, as streamed so far) — pointing
  at the offending construct: the `<` of a mismatched/unknown/unclosed tag, the
  `{` of an unsupported expression. Errors inside a nested JSX expression are
  reported at the enclosing `{`.

  New `formatJsxError(event)` export (root and `/core` entries) renders the
  message, position, and a caret code frame in one string:

  ```text
  Mismatched closing tag </b>; expected </a> (line 2, column 8)

    2 |   hello</b>
      |        ^
  ```

  Locations are chunking-invariant like the rest of the token stream.

- 2ffb609: Text now follows real JSX parser semantics (Babel/TypeScript) instead of being kept raw:

  - **HTML character references are decoded** — numeric (`&#65;`, `&#x1F600;`) and the named HTML4 set plus `&apos;` — in child text and in string attribute values. Unknown or malformed references stay verbatim, and a decoded `<` or `{` is text, not markup.
  - **JSX whitespace rules apply to text** — tabs become spaces, indentation and whitespace-only lines around child elements are dropped, whitespace at the end of a non-final line is trimmed, and a line break inside text collapses to a single joining space. Whitespace within a single line (including a run's leading/trailing spaces on that line) is kept, as in real JSX.

  Both behaviors are chunk-independent and streaming-aware: an entity or line break split across chunks resolves identically however the stream is chunked, and the pending text frontier withholds a possibly-incomplete entity (`&am…`) or not-yet-resolved whitespace until its fate is known.

- c16ebd8: Generalize the schema into a lightweight prop type system. What was a
  hardcoded rule ("`style` must be a variable resolving to an object") is now
  a declaration in a small, shared type language — and integrators can declare
  the same for their own components and elements.

  - New `SchemaType`: `"string" | "number" | "boolean" | "function" |
"object" | "node" | "url" | "any"`, unions (`["string", "number"]`), and
    object shapes (`{ name: "string" }`).
  - **Component catalog declares props**: a `components` entry can now be a
    `{ component, props }` spec, where `props` is `true`, a list of allowed
    prop names, or prop name → `SchemaType`. Every parsed prop on that
    component is validated against the declaration; violations are reported
    (`kind: "invalid-prop"`) and dropped. Undeclared components stay exempt
    (the author's contract).
  - **Elements declare prop types**: the `elements` record form now also
    accepts prop name → `SchemaType` per tag
    (`{ a: { href: "url", title: "string" } }`), in addition to `true` and
    name lists.
  - **Variables carry types**: new `variableTypes` option declares a
    `SchemaType` per variable (shapes are walked along dot paths, and a
    declared variable counts as known even without a value); otherwise the
    type is inferred from the `variables` value. Variable references in props
    are checked against the declared prop type — e.g. `onClick={user.name}`
    is now rejected when `user.name` is a string.
  - The built-in host rules are expressed in the same system (`style:
"object"`, `on*`: `"function"`, URL props: `"url"`, plus the hard
    blocklist) and always apply to intrinsic elements — a user schema can
    tighten them, never relax them.
  - `formatPromptContract` now describes declared prop and variable types, so
    the generating model sees the same contract the parser enforces.
  - API: `checkHostProp` is renamed to `checkProp` (it now covers component
    props too); new exports `checkPropValue`, `resolveVariableType`,
    `describeType`, `resolveComponentEntry` and types `SchemaType`,
    `PropTypes`, `PropsDefinition`, `ComponentEntry`, `ComponentSpec`,
    `ComponentSchemaEntry`.

- 65eafe7: Add a tightened schema for untrusted AI-generated JSX, and a prompt contract
  derived from it.

  - New `elements` option: an allowlist of intrinsic (lowercase) HTML tags —
    `["div", "a"]` or `{ div: true, a: ["href"] }` with per-tag prop
    allowlists. A rejected tag is reported (`kind: "disallowed-element"`) and
    rendered per the new `onDisallowedElement` option (`"skip"` default, or
    `"pending"`).
  - Built-in host prop rules now always apply to intrinsic elements; each
    violation is reported (`kind: "invalid-prop"`) and the prop is dropped
    instead of reaching React: string `style` values (previously these made
    React throw at render time, blanking the tree), `dangerouslySetInnerHTML`
    / `srcDoc` / `ref` / `key` / `children`, `on*` handlers that don't
    reference a predefined variable (`onClick={actions.confirm}` still works
    and wires the real function), and `javascript:`-style URL schemes.
  - New `formatPromptContract(options)` serializes the configured schema
    (syntax subset, allowed elements/props, components, variable shapes) into
    system-prompt-ready text for the model generating the stream.
  - The canonical checks (`isElementAllowed`, `checkProp`) and the new
    core hooks (`isAllowedElement`, `checkProp`) are exported from both the
    root and `/core` entries, so custom renderers can enforce exactly what the
    parse-time events report.

- 7e3cbc3: Support variable references in `{ }` expressions: a bare identifier (`{name}`) or dot-notation member access (`{user.name.first}`), in both children and props. Variables are predefined through the new `variables` option (`Record<string, unknown>`), mirroring how `components` works — and because the map holds the actual values, every segment of a dot path is validated against them at parse time: a reference that would not resolve (unknown root, or a member missing at any depth) renders as nothing and is reported through `onJsxError` as the new `"unknown-variable"` event (carrying the root `name` and full `path`). The framework-agnostic core emits variable references as a new `VariableNode` (`kind: "variable"`, with the dot path), accepts an `isKnownVariable(path)` probe for parse-time error events, and exports `resolveVariablePath(variables, path)` — the canonical lookup (`in`-based, prototype chain included, primitives boxed, null-safe) used by both parse-time validation and the React adapter's render-time resolution. References cannot escape the predefined data: `__proto__`, `constructor`, and `prototype` are excluded from the syntax at any position, and root names must be own properties of the `variables` map.
- 38a8d65: Restructure error handling into two channels split by recoverability.

  `onJsxError` is the channel for **recoverable** errors: unified, structured
  JSX-level events that fire synchronously at parse time (inside `write()` /
  `end()`), before any render and in every recovery mode, so a stream producer
  (e.g. an LLM agent) can get instant feedback while the tree keeps recovering
  tolerantly as before. The `JsxErrorEvent` union covers `"mismatched-tag"`
  (including stray closes), `"unknown-component"`, `"unsupported-expression"`,
  and `"unclosed-tag"` at end of input; each event carries a human-readable
  `message`.

  `onStreamError` is the channel for the one **unrecoverable** error: the
  stream source failing. It receives the raw error once, alongside the existing
  `done` rejection.

  The core `createParser` accepts `onJsxError` too, plus an `isKnownComponent`
  predicate to enable unknown-component detection without React; the
  `isComponentName` helper is now exported.

  Breaking (pre-release cleanup): the legacy `onError` callback is removed —
  use `onJsxError` / `onStreamError`. Reporting is now decoupled from recovery,
  so the reporting-only modes are gone: `mismatchedTag` is
  `"autoclose" | "ignore"` (the `"error"` mode behaved like `"ignore"` plus a
  report), and `onUnknownComponent`'s `"error"` mode is renamed `"skip"`
  (renders nothing).
