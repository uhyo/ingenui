# The schema: a lightweight type system

The schema is a small, declarative type language shared by elements,
components, and variables. It is enforced at parse time (reported through
[`onJsxError`](./errors.md)) and at render time, and it doubles as a
[prompt contract](#the-schema-as-a-prompt-contract-formatpromptcontract) for
the generating model.

## Types

A **`SchemaType`** is one of:

- `"string"`, `"number"`, `"boolean"` — primitives (literals or variable
  references);
- `"function"` — only a variable reference can supply one
  (`onClick={actions.confirm}`);
- `"object"` — any object, via a variable reference (`style={theme.card}`);
- `"node"` — renderable content: nested JSX, or a string/number/boolean;
- `"url"` — a string used as a URL; a literal must not carry an unsafe
  scheme (`javascript:`, `vbscript:`, `data:text/html`, control characters
  stripped), while a variable reference is your own data and is only checked
  to be string-typed;
- `"any"` — anything (the implicit type when only prop *names* are listed);
- a union: `["string", "number"]`;
- an object shape: `{ name: "string", age: "number" }` (walked along dot
  paths; matches wherever `"object"` is expected).

## Elements

`elements` allowlists intrinsic (lowercase) tags; each tag maps to `true`
(any prop), a list of allowed prop names, or prop name → type:

```ts
createIncrementalJsxParser(stream, {
  elements: { div: true, p: true, a: { href: "url", title: "string" }, img: ["src", "alt"] },
  // or just: elements: ["div", "p", "a", "img"]
});
```

A tag outside the list is reported at parse time (`kind:
"disallowed-element"`) and rendered per `onDisallowedElement` — `"skip"`
(default: renders nothing, subtree included) or `"pending"`. A prop outside a
tag's declaration, or whose value fails its declared type, is reported
(`kind: "invalid-prop"`) and dropped.

## Components

Components declare their prop catalog by wrapping the component in a spec —
an entry in `components` is either the component itself or
`{ component, props }`:

```ts
createIncrementalJsxParser(stream, {
  components: {
    Card: { component: Card, props: { title: "string", tone: ["string", "number"], onAction: "function" } },
    Chart, // no declaration: props are the component author's contract
  },
});
```

With a declaration, every parsed prop on that component — string attributes
and `{ }` expressions alike — is validated the same way as element props.

A spec may also carry a `description` — what the component is for. It has no
effect on validation or rendering; [`formatPromptContract`](#the-schema-as-a-prompt-contract-formatpromptcontract)
lists it under the component so the model knows when to use it:

```ts
Card: { component: Card, props: { title: "string" }, description: "A titled panel for related content." },
```

## Variables

Variables get their types inferred from the `variables` values, and
`variableTypes` can declare them explicitly (declared types win; a variable
declared only by type still counts as known):

```ts
createIncrementalJsxParser(stream, {
  variables: { user, theme, actions },
  variableTypes: { user: { name: "string" }, theme: "object", actions: { confirm: "function" } },
});
```

So `<Card title={user.name}>` passes, while `onClick={user.name}` is
rejected: the reference resolves to a string where a `"function"` was
declared.

## Built-in host prop rules

Whether or not a schema is configured, **built-in host prop rules** always
apply to intrinsic tags — they are default declarations in the same type
system, and a user schema can tighten but never relax them. They exist
because AI output frequently contains props that would make React throw
(breaking the "errors never blank the UI" promise) or that are unsafe on
untrusted input; each violation is dropped from the rendered output and
reported as `"invalid-prop"`:

- `dangerouslySetInnerHTML`, `srcDoc`, `ref`, `key`, and `children` are never
  allowed (checked case-insensitively).
- `on*` event handlers are `"function"`-typed: they must reference a
  predefined variable resolving to a function — `onClick={actions.confirm}`
  wires the actual function from `variables`, which is also the idiomatic
  way to give AI-generated UI interactivity. String handlers (`onclick="…"`)
  are rejected.
- `style` is `"object"`-typed: it must be a predefined variable resolving to
  an object (`style={theme.card}`); string styles would make React throw.
- URL props (`href`, `src`, `action`, …) are `"url"`-typed.

Component tags without a declaration are exempt from all prop rules — their
props are the component author's contract.

## The schema as a prompt contract: `formatPromptContract`

The same maps that enforce the schema describe it, so you can hand the model
the exact subset it is allowed to produce. `formatPromptContract` serializes
the configured schema — syntax subset, allowed elements/props with their
declared types, available components with their prop catalogs, predefined
variables (declared types or shallow value shapes only, never values) — into
text for the system prompt of the generating model:

```ts
import { formatPromptContract } from "@ingenui/incremental-jsx-parser";

const schema = {
  components: { Card: { component: Card, props: { title: "string" } }, Button },
  variables: { user, actions: { confirm: onConfirm } },
  variableTypes: { actions: { confirm: "function" } },
  elements: { div: true, p: true, a: { href: "url" } },
};

const systemPrompt = `You generate UI for …\n\n${formatPromptContract(schema)}`;
const parser = createIncrementalJsxParser(stream, {
  ...schema,
  onJsxError: (e) => agent.report(formatJsxError(e)),
});
```

By default the contract assumes the JSX is the model's **whole output** and
tells it to write no prose or code fences around it. When the JSX is
embedded in a larger format that your own prompt describes (for example
inside fenced blocks of a Markdown message, as ingenui does), pass
`standalone: false`: the contract then only constrains what goes inside a
block.

```ts
const contract = formatPromptContract({ ...schema, standalone: false });
```

Together with `onJsxError` + `formatJsxError` this closes the loop: the
contract tells the model what it may emit, and the events tell it what it
got wrong.
