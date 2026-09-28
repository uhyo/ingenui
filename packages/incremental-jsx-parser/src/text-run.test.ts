import { describe, expect, it } from "vitest";

import { TextRun } from "./text-run";

function take(...chunks: string[]): string {
  const run = new TextRun();
  for (const chunk of chunks) for (const ch of chunk) run.push(ch);
  return run.take();
}

describe("TextRun", () => {
  it("decodes character references, keeping invalid ones verbatim", () => {
    expect(take("a &amp; b &#x41;&#66; &bogus; &amp")).toBe("a & b AB &bogus; &amp");
  });

  it("applies the JSX whitespace rules", () => {
    expect(take("  hello\n    world  ")).toBe("  hello world  ");
    expect(take("\n  \n  ")).toBe("");
    expect(take("a\t\tb")).toBe("a  b");
  });

  it("withholds an unresolved entity and whitespace from the pending text", () => {
    const run = new TextRun();
    for (const ch of "a &am") run.push(ch);
    expect(run.pending()).toBe("a");
    run.push("p");
    run.push(";");
    expect(run.pending()).toBe("a &");
  });

  it("resets after take()", () => {
    const run = new TextRun();
    for (const ch of "one\n") run.push(ch);
    expect(run.take()).toBe("one");
    for (const ch of "two") run.push(ch);
    expect(run.take()).toBe("two");
  });
});
