import { describe, expect, it } from "vitest";

import { bindGenUi } from "./bind";
import { formatGenUiPrompt } from "./prompt";
import { defineGenUiSchema } from "./schema";

describe("formatGenUiPrompt", () => {
  it("describes the message format and embeds the parser's prompt contract", () => {
    const prompt = formatGenUiPrompt({ elements: { div: true, a: { href: "url" } } });
    expect(prompt).toContain("## Message format");
    expect(prompt).toContain("```ui+jsx");
    expect(prompt).toContain("close every ui+jsx fence");
    expect(prompt).toContain("## UI contract");
    expect(prompt).toContain("- <div>");
    expect(prompt).toContain("- <a> — allowed props: href (URL string)");
  });

  it("doesn't tell the model to drop the prose and fences its message format asks for", () => {
    const prompt = formatGenUiPrompt({ components: { Card: true } });
    expect(prompt).not.toContain("Output raw JSX only");
    expect(prompt).not.toContain("no markdown code fences");
    expect(prompt).toContain("Inside a UI block, write only JSX");
  });

  it("declares the actions variable alongside user variables in the contract", () => {
    const prompt = formatGenUiPrompt({
      actions: { submit: true },
      variables: { user: { name: "u" } },
      variableTypes: { user: { name: "string" } },
    });
    expect(prompt).toContain("- {user} — object with fields: name (string)");
    expect(prompt).toContain("- {actions} — object with fields: submit (function)");
  });
});

describe("formatGenUiPrompt — Actions section", () => {
  it("tells the model it may define its own actions (the default)", () => {
    const prompt = formatGenUiPrompt();
    expect(prompt).toContain("## Actions");
    expect(prompt).toContain("define your own actions");
    expect(prompt).toContain("`actions.<name>`");
    expect(prompt).toContain("onClick={actions.submitForm}");
    expect(prompt).toContain('"The `actions.submitForm` action was fired by the user."');
    expect(prompt).toContain("- {actions} —");
  });

  it("lists declared actions, using the first one as the example", () => {
    const prompt = formatGenUiPrompt({ actions: { submit: true, cancel: () => {} } });
    expect(prompt).toContain("- Available actions: `actions.submit`, `actions.cancel`.");
    expect(prompt).toContain("define your own actions");
    expect(prompt).toContain("onClick={actions.submit}");
    expect(prompt).toContain('"The `actions.submit` action was fired by the user."');
  });

  it("tells the model that components may report values with an action", () => {
    const prompt = formatGenUiPrompt({ actions: { subscribe: true } });
    expect(prompt).toContain("Some components also report values with the action");
    expect(prompt).toContain(
      '"The `actions.subscribe` action was fired by the user with these values:\n' +
        '  - fieldName: "what the user entered""',
    );
    // The prompt itself never suggests raw HTML forms: components say so.
    expect(prompt).not.toMatch(/<form|<input/);
  });

  it("tells the model the message doesn't say which element fired it, so each choice needs its own action", () => {
    const prompt = formatGenUiPrompt();
    expect(prompt).toContain("does not say which element fired it");
    expect(prompt).toContain("give every distinct choice its own action");
    expect(prompt).toContain("Never wire one action to several elements");
    expect(prompt).toContain("actions.addToCartBlueMug, actions.addToCartRedMug");
  });

  it("omits self-defined actions when opted out", () => {
    const prompt = formatGenUiPrompt({ actions: { submit: true }, dynamicActions: false });
    expect(prompt).toContain("- Available actions: `actions.submit`.");
    expect(prompt).not.toContain("define your own actions");
    // Still warned against reusing an action, without suggesting invented names.
    expect(prompt).toContain("does not say which element fired it");
    expect(prompt).toContain("never wire one action to several elements");
    expect(prompt).not.toContain("actions.addToCartBlueMug");
  });

  it("omits the Actions section entirely when opted out with no declared actions", () => {
    const prompt = formatGenUiPrompt({ dynamicActions: false });
    expect(prompt).not.toContain("## Actions");
    expect(prompt).not.toContain("- {actions} —");
  });
});

describe("formatGenUiPrompt — from a GenUiSchema", () => {
  const schema = defineGenUiSchema({
    elements: { div: true },
    components: {
      Card: { props: { title: "string" }, description: "A titled panel." },
      Free: true,
    },
    variableTypes: { user: { name: "string" } },
    actions: { subscribe: { description: "Start a subscription." }, cancel: true },
  });

  it("describes components, variables, and actions from the data-only schema", () => {
    const prompt = formatGenUiPrompt(schema);
    expect(prompt).toContain("- <Card> — allowed props: title (string)\n  A titled panel.");
    expect(prompt).toContain("- <Free>");
    expect(prompt).toContain("- {user} — object with fields: name (string)");
    expect(prompt).toContain(
      "- {actions} — object with fields: subscribe (function), cancel (function)",
    );
  });

  it("lists actions with their descriptions", () => {
    const prompt = formatGenUiPrompt(schema);
    expect(prompt).toContain(
      "- Available actions:\n  - `actions.subscribe`: Start a subscription.\n  - `actions.cancel`\n",
    );
    expect(prompt).toContain("onClick={actions.subscribe}");
  });

  it("matches the prompt built from the bound client options", () => {
    const Card = () => null;
    const Free = () => null;
    const bound = bindGenUi(schema, {
      components: { Card, Free },
      variables: { user: { name: "u" } },
    });
    expect(formatGenUiPrompt(bound)).toBe(formatGenUiPrompt(schema));
  });
});
