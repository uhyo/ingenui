import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { GenUiIssue } from "./issues";
import type { UiBlockWrapperProps } from "./ui-block";
import { createUiBlock } from "./ui-block";

describe("createUiBlock", () => {
  it("streams its source into a live tree and notifies on updates", async () => {
    const onUpdate = vi.fn();
    const block = createUiBlock(0, {}, { onIssue: () => {}, onUpdate });
    block.write("<p>he");
    block.write("llo</p>");
    block.close(true);
    await block.done;
    expect(onUpdate).toHaveBeenCalled();
    expect(renderToStaticMarkup(<>{block.render()}</>)).toBe("<p>hello</p>");
  });

  it("reports its parse errors as issues carrying its block index", async () => {
    const issues: GenUiIssue[] = [];
    const block = createUiBlock(3, {}, { onIssue: (i) => issues.push(i), onUpdate: () => {} });
    block.write("<p>{fn()}</p>");
    block.close(true);
    await block.done;
    expect(issues).toMatchObject([
      { kind: "jsx-error", blockIndex: 3, event: { kind: "unsupported-expression" } },
    ]);
  });

  it("keeps its status as a value: state, issues, and a stable element while unchanged", async () => {
    const seen: UiBlockWrapperProps[] = [];
    const block = createUiBlock(
      1,
      {},
      { onIssue: () => {}, onUpdate: () => {} },
      {
        fallback: null,
        wrap: (props) => {
          seen.push(props);
          return <div data-state={props.state}>{props.children}</div>;
        },
      },
    );
    block.write("<p>{fn()}</p>");
    await Promise.resolve();
    const streaming = block.render();
    expect(block.render()).toBe(streaming);
    block.close(false);
    await block.done;
    expect(renderToStaticMarkup(<>{block.render()}</>)).toBe(
      '<div data-state="unterminated"><p></p></div>',
    );
    const last = seen.at(-1)!;
    expect(last).toMatchObject({ blockIndex: 1, state: "unterminated", crashed: false });
    expect(last.issues.map((i) => i.kind)).toEqual(["jsx-error"]);
    // Settled: the same element, without calling the wrapper again.
    const calls = seen.length;
    expect(block.render()).toBe(block.render());
    expect(seen).toHaveLength(calls);
  });
});
