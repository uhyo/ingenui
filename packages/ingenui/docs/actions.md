# The `actions` convention

`actions` is the bridge from the generated UI back into the conversation.
The app declares actions; the model wires them wherever a function is
expected (`onClick={actions.submit}`); when the user triggers one, ingenui
hands the app the canonical next request:
``The `actions.submit` action was fired by the user.``

```ts
const message = createGenUiMessage(stream, {
  actions: {
    submit: (event) => {/* runs in addition to onAction */},
    cancel: true, // no local handler; still reported through onAction
  },
  onAction: ({ name, reference, message, data, args }) => {
    // name: "submit", reference: "actions.submit"
    // message: "The `actions.submit` action was fired by the user."
    // data: the values the user entered, if any (see "Action values")
    sendToModel(message);
  },
});
```

Under the hood each action becomes an entry of the predefined `actions`
variable (declared `"function"` in the schema), so the parser validates
references at parse time, and `onClick={actions}` (not a function) fails the
type check. The helpers (`formatActionMessage`, `createActionsVariable`,
`extractActionData`, `normalizeActionData`) are
exported for custom setups.

## Model-defined actions: the `dynamicActions` default

An AI-defined action carries no host behavior — all it can ever do is send
the canonical "this action was fired" message back into the conversation. So
a declaration adds nothing the reference itself doesn't already say: **the
name is the definition.** By default (`dynamicActions: true`), any
`actions.<name>` the model writes resolves to a notify-only action:

````markdown
Which plan would you like?

```ui+jsx
<div>
  <button onClick={actions.choosePlanBasic}>Basic</button>
  <button onClick={actions.choosePlanPro}>Pro</button>
</div>
```
````

Clicking "Pro" fires `onAction` with `declared: false` and the message
``The `actions.choosePlanPro` action was fired by the user.`` — the model
invented the name, so it knows what it means. Declared actions keep working
exactly as before (`declared: true`, local handler runs); an undeclared name
never runs host code, so apps switching on `event.name` should treat unknown
names as pass-through-to-the-model.

`formatGenUiPrompt` follows the same default and tells the model it may
invent action names. Because a fired action reports only its name (and any
[values](#action-values) its component reports) — not which element fired
it — the prompt also tells the model to give every distinct choice its own action
(`actions.addToCartBlueMug`, `actions.addToCartRedMug`, … rather than
`actions.addToCart` on every item). With `dynamicActions: false` it still
warns against wiring one action to elements that mean different things.

## Action values

The model can't write closures (`onClick={() => actions.search(query)}` is
outside the JSX subset), so it never passes arguments to an action. What an
action *can* carry is what the **user** entered — reported by **components
you supply**. When an action is called with one of these, the values end up
in `event.data` and the message lists them:

| Called with | Reports |
| ----------- | ------- |
| A form's **submit event** (React's or a native one) | The form's fields, as `FormData` collects them: named, enabled controls (repeated names as an array), including the submitter button's `name` / `value`; file inputs are dropped. The submission's default (navigation) is prevented. |
| Any other event on a **named `<button>`** (`currentTarget`) | `{ [name]: value }` |
| A **plain object** (`onSelect({ city: "Tokyo" })`) | Its entries |

```text
The `actions.subscribe` action was fired by the user with these values:
- email: "ada@example.com"
- topics: ["news","releases"]
```

Values are normalized (`normalizeActionData`): field names must look like
`[A-Za-z_][A-Za-z0-9_.-]*` (≤ 64 characters), values are strings or string
arrays (numbers and booleans are stringified), at most 32 fields / 32 items
per array, each string cut to 2000 characters. They are JSON-quoted in the
message, so a value can't fake another line.

### Forms are components, not raw HTML

ingenui doesn't steer the model toward raw `<form>` / `<input>`: the prompt
only says that *some components* report values, "as their descriptions say".
Supply the form and its controls as components, render the real HTML inside
them, and **say in each description what it reports** — that is how the
model learns the semantics:

```ts
const schema = defineGenUiSchema({
  components: {
    SubscribeForm: {
      props: { onSubmit: "function", submitLabel: "string" },
      description:
        "A form with a submit button. Wire onSubmit to an action: on submit, the " +
        "action reports the value of every field inside it, by the field's name.",
    },
    TextField: {
      props: { name: "string", label: "string", placeholder: "string" },
      description:
        "A labeled text input; only valid inside a form. Its value is reported " +
        "under `name` when the form is submitted.",
    },
  },
});
```

```tsx
function SubscribeForm({ onSubmit, submitLabel = "Submit", children }) {
  // Forward the submit event: the action reads the form's fields from it.
  return (
    <form onSubmit={onSubmit}>
      {children}
      <button type="submit">{submitLabel}</button>
    </form>
  );
}

function TextField({ name, label, placeholder }) {
  // Uncontrolled: what the user types lives in the DOM, and survives the
  // re-renders of a still-streaming message.
  return (
    <label>
      {label} <input name={name} placeholder={placeholder} />
    </label>
  );
}
```

A component not backed by a native form (a date picker, a map) calls the
action with a plain object instead: `onPick({ date: "2026-11-20" })`.

Like the action name, the values are untrusted client input: send
`event.data` to the server and let [`resolveGenUiAction`](#actions-on-the-server)
normalize it.

## Opting out

Pass `dynamicActions: false` (to both `createGenUiMessage` and
`formatGenUiPrompt`) when the host owns the action vocabulary — then a
reference outside the declared `actions`, including a typo in a declared
name, is caught as an `unknown-variable` issue, and with no `actions`
declared the variable does not exist at all.

## Actions on the server

In a [shared schema](./server.md), actions are declared as data (`true`, or
`{ description }`, which is shown to the model), and the client binds any
handlers with `bindGenUi`. Keep the next request on the server: the client
reports only the fired action's **name** (`event.name`) and its
[values](#action-values) (`event.data`), and the server resolves them against
the schema to get the canonical message:

```ts
import { resolveGenUiAction } from "ingenui/server";

const resolved = resolveGenUiAction(schema, body.action, body.data);
if (resolved === null) return badRequest(); // not an action the model could have wired
nextUserTurn = resolved.message; // "The `actions.subscribe` action was fired by the user."
```

That way the model's next input is never free text written by the client:
the values are normalized (invalid entries dropped, long values cut) and
JSON-quoted into the message, exactly as on the client. Any
valid `actions.<name>` member resolves with dynamic actions; only declared
names resolve with `dynamicActions: false`.

## Implementation note

With dynamic actions, the `actions` value becomes a `Proxy` answering for any
name, which the parser's `in`-semantics variable resolution accepts and
type-infers as `"function"` — chunk invariance and the rest of the schema are
untouched. Inherited `Object.prototype` member names like `toString` are left
alone.
