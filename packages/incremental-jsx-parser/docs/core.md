# Framework-agnostic core — `@ingenui/incremental-jsx-parser/core`

The `/core` entry has **zero React dependency**. Use it to build an adapter
for another renderer, or to process streamed JSX without rendering it.

## `createParser(options?)`

A push-based parser that emits a renderer-independent AST:

```ts
import { createParser } from "@ingenui/incremental-jsx-parser/core";

const core = createParser();
core.write("<div>partial");
core.getTree(); // => readonly Node[] (immutable AST snapshot, incl. a PendingNode)
core.subscribe(listener);
core.end(); // finalize; drops the Pending frontier
```

The AST is immutable: the node types are `readonly`, a snapshot never
changes once returned, and a closed node is frozen and keeps its identity
across snapshots, so consumers can memoize on it.

`createParser` accepts `mismatchedTag` and `onJsxError` like the React
adapter (see [error handling](./errors.md)). Each `write()` / `end()` reports
the errors it completed, in source order, before notifying subscribers.

Since the core knows nothing about React components or your data, the
parse-time **schema** errors are opt-in through `checks`, a `SchemaChecks`
object (only consulted when `onJsxError` is set):

| Check              | Signature                                   | Enables                  |
| ------------------ | ------------------------------------------- | ------------------------ |
| `isKnownComponent` | `(tag: string) => boolean`                  | `"unknown-component"`    |
| `isKnownVariable`  | `(path: readonly string[]) => boolean`      | `"unknown-variable"`     |
| `isAllowedElement` | `(tag: string) => boolean`                  | `"disallowed-element"`   |
| `checkProp`        | `(tag, prop, value) => string \| null` (a rejection reason, or `null`) | `"invalid-prop"` |

`isKnownVariable` receives the full dot path, so you can validate the root
name only (`path[0]`) or every segment.

Build them from a schema with `createSchemaChecks` — the canonical wiring the
React adapter uses too, so the same text and schema yield the same errors:

```ts
import { createParser, createSchemaChecks } from "@ingenui/incremental-jsx-parser/core";

const core = createParser({
  onJsxError: (event) => log(event),
  // The component catalog defaults to the keys of `components`; pass your
  // own lookup as the second argument.
  checks: createSchemaChecks({ elements, components, variables, variableTypes }),
});
```

## Helpers

The canonical checks are exported here (they are React-free) — they back
`createSchemaChecks`; apply the same helpers in your renderer so reporting
and enforcement agree (that is exactly what the React adapter does):

- `isElementAllowed(elements, tag)` — the `elements` allowlist check.
- `checkProp(tag, prop, value, { elements, components, variables, variableTypes })`
  — the [schema](./schema.md) prop check, including the built-in host rules;
  `checkPropValue` / `resolveVariableType` are the underlying type
  primitives.
- `isComponentName(tag)` — whether a tag is component-like (Capitalized or
  dotted).
- `resolveVariablePath(variables, path)` — the canonical variable lookup. The
  core emits variable references as `VariableNode`s (a dot-notation `path`)
  and leaves resolving them to the consumer; the React adapter uses this
  helper for both parse-time validation and render-time resolution, so the
  two always agree.
- `validateOpeningTag(tag, props, location, checks)` /
  `validateVariable(path, location, checks)` — the pure functions turning a
  parsed construct into its schema errors (what the parser runs on every
  opening tag and variable reference).
- `formatPromptContract(schema)` — see
  [the schema as a prompt contract](./schema.md#the-schema-as-a-prompt-contract-formatpromptcontract).

## `pumpStream(source, sink)`

The stream driver behind the React adapter. It normalizes any accepted
`JsxStreamSource` (`ReadableStream` of bytes or strings, or an
`AsyncIterable`) into string chunks — decoding bytes with a streaming
`TextDecoder` — and pushes them into a `{ write, end }` sink, returning a
`{ done, cancel }` handle. Use it to build your own adapter, or to
pre-process a stream before it reaches the parser.
