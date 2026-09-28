import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { GenUiIssue } from "./issues";
import { createUiBlock } from "./ui-block";

describe("createUiBlock", () => {
  it("streams its source into a live tree and notifies on updates", async () => {
    const onUpdate = vi.fn();
    const block = createUiBlock(0, {}, { onIssue: () => {}, onUpdate });
    block.write("<p>he");
    block.write("llo</p>");
    block.close();
    await block.done;
    expect(onUpdate).toHaveBeenCalled();
    expect(renderToStaticMarkup(<>{block.render(null)}</>)).toBe("<p>hello</p>");
  });

  it("reports its parse errors as issues carrying its block index", async () => {
    const issues: GenUiIssue[] = [];
    const block = createUiBlock(3, {}, { onIssue: (i) => issues.push(i), onUpdate: () => {} });
    block.write("<p>{fn()}</p>");
    block.close();
    await block.done;
    expect(issues).toMatchObject([
      { kind: "jsx-error", blockIndex: 3, event: { kind: "unsupported-expression" } },
    ]);
  });
});
