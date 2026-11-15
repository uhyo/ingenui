---
"ingenui": patch
---

Actions can now report what the user entered. When an action is called with a form's submit event (its fields, via `FormData`, including the submitter), a click on a named `<button>` (its `name` / `value`), or a plain data object, the values appear as `ActionEvent.data` and the canonical message lists them ("… was fired by the user with these values:" followed by JSON-quoted `- name: "value"` lines). The submission's navigation is prevented. `resolveGenUiAction(schema, name, data?)` normalizes the client's values the same way on the server (new `normalizeActionData`; `extractActionData` is exported too). The prompt tells the model that some components report values, as their descriptions say; it never suggests raw HTML forms. Supply form and control components and describe their semantics.
