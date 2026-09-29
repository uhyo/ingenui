import { describe, expect, it } from "vitest";

import type { GenUiIssue } from "./issues";
import { defineGenUiSchema } from "./schema";
import { createGenUiValidator, validateGenUiMessage } from "./validator";

const schema = defineGenUiSchema({
  elements: { div: true, p: true, button: { onClick: "function" } },
  components: {
    Card: { props: { title: "string" }, description: "A titled panel." },
    Free: true,
  },
  variableTypes: { user: { name: "string" } },
  actions: { submit: { description: "Submit the form." } },
});

const kinds = (issues: readonly GenUiIssue[]): string[] =>
  issues.map((issue) => (issue.kind === "jsx-error" ? `jsx:${issue.event.kind}` : issue.kind));

describe("validateGenUiMessage", () => {
  it("accepts a message that follows the schema", () => {
    const text = [
      "Hello **there**.",
      "",
      "```ui+jsx",
      '<Card title="Hi"><p>{user.name}</p><Free any="thing" /></Card>',
      "<button onClick={actions.submit}>Go</button>",
      "<button onClick={actions.inventedByTheModel}>Also fine</button>",
      "```",
      "",
    ].join("\n");
    expect(validateGenUiMessage(text, schema)).toEqual([]);
    const validator = createGenUiValidator(schema);
    validator.write(text);
    validator.end();
    expect(validator.getIssueReport()).toBeNull();
  });

  it("reports schema violations per block", () => {
    const text = [
      "```ui+jsx",
      "<Chart />",
      "```",
      "",
      "```ui+jsx",
      '<Card title={user.name} tone="x" />',
      "<span>{user.age}</span>",
      "```",
    ].join("\n");
    const issues = validateGenUiMessage(text, schema);
    expect(kinds(issues)).toEqual([
      "jsx:unknown-component",
      "jsx:invalid-prop",
      "jsx:disallowed-element",
      "jsx:unknown-variable",
    ]);
    expect(issues.map((issue) => issue.blockIndex)).toEqual([0, 1, 1, 1]);
  });

  it("reports unclosed fences and tags at the end", () => {
    const issues = validateGenUiMessage("```ui+jsx\n<div>open", schema);
    expect(kinds(issues)).toEqual(["jsx:unclosed-tag", "unclosed-fence"]);
  });

  it("ignores ui+jsx fences inside regular code fences", () => {
    const text = "```md\n```ui+jsx\n<Chart />\n```\n";
    expect(validateGenUiMessage(text, schema)).toEqual([]);
  });

  it("rejects undeclared actions with dynamicActions: false", () => {
    const strict = defineGenUiSchema({ ...schema, dynamicActions: false });
    const text = "```ui+jsx\n<button onClick={actions.nope}>x</button>\n```\n";
    expect(kinds(validateGenUiMessage(text, strict))).toEqual(["jsx:unknown-variable"]);
  });

  it("follows the schema's mismatchedTag", () => {
    const text = "```ui+jsx\n<div><p>x</div></p>\n```\n";
    // autoclose: </div> closes both, then </p> is stray.
    expect(kinds(validateGenUiMessage(text, schema))).toEqual([
      "jsx:mismatched-tag",
      "jsx:mismatched-tag",
    ]);
    // ignore: </div> is dropped, </p> closes <p>, <div> stays open.
    expect(kinds(validateGenUiMessage(text, { ...schema, mismatchedTag: "ignore" }))).toEqual([
      "jsx:mismatched-tag",
      "jsx:unclosed-tag",
    ]);
  });
});

describe("createGenUiValidator", () => {
  it("reports an issue synchronously in the write that completes it", () => {
    const seen: GenUiIssue[] = [];
    const validator = createGenUiValidator(schema, { onIssue: (issue) => seen.push(issue) });
    validator.write("Intro\n```ui+jsx\n<Char");
    expect(seen).toEqual([]);
    validator.write("t />");
    expect(kinds(seen)).toEqual(["jsx:unknown-component"]);
    validator.write("\n```\n");
    validator.end();
    expect(kinds(validator.getIssues())).toEqual(["jsx:unknown-component"]);
    expect(validator.getIssueReport()).toContain("In `ui+jsx` block 1:");
  });

  it("is chunking-invariant, source locations included", () => {
    const text =
      "a\n```ui+jsx\n<Card title={1}><Chart /></Card>\n<p>{x}</p>\n```\nb\n```ui+jsx\n<div>";
    const whole = validateGenUiMessage(text, schema);
    expect(kinds(whole)).toEqual([
      "jsx:invalid-prop",
      "jsx:unknown-component",
      "jsx:unknown-variable",
      "jsx:unclosed-tag",
      "unclosed-fence",
    ]);
    const validator = createGenUiValidator(schema);
    for (const char of text) validator.write(char);
    validator.end();
    expect(validator.getIssues()).toEqual(whole);
  });
});

const block = (body: string): string => `\`\`\`ui+jsx\n${body}\n\`\`\`\n`;

describe("createGenUiValidator — cut information", () => {
  it("reports the last clean boundary: the first block with issues", () => {
    const clean = `Intro\n\n${block('<Card title="ok" />')}\nMore\n`;
    const text = `${clean}${block("<Chart />")}after\n${block("<Nope />")}`;
    const validator = createGenUiValidator(schema);
    validator.write(clean);
    expect(validator.getCleanOffset()).toBe(clean.length);
    for (const char of text.slice(clean.length)) validator.write(char);
    expect(validator.getCleanOffset()).toBe(clean.length);
    validator.end();
    expect(validator.getCleanOffset()).toBe(clean.length);
  });

  it("treats a block still open as not clean", () => {
    const validator = createGenUiValidator(schema);
    validator.write("Intro\n```ui+jsx\n<Card title=");
    expect(validator.getCleanOffset()).toBe("Intro\n".length);
    validator.write('"x" />\n```\nok');
    expect(validator.getCleanOffset()).toBe('Intro\n```ui+jsx\n<Card title="x" />\n```\nok'.length);
  });

  it("gives the text closing an open fence, to write through it", () => {
    const validator = createGenUiValidator(schema);
    validator.write("```ui+jsx\n<div>x");
    const close = validator.getFenceClose();
    expect(close).toBe("\n```\n");
    validator.write(close);
    expect(validator.getFenceClose()).toBe("");
    validator.write("```ui+jsx\n<p>fine</p>\n```\n");
    validator.end();
    // The cut block reports its unclosed tag, not an unclosed fence.
    expect(validator.getIssues().map((issue) => [issue.blockIndex, issue.kind])).toEqual([
      [0, "jsx-error"],
    ]);
    expect(validator.getFenceClose()).toBe("");
  });
});
