import { describe, expect, it } from "vitest";

import { createFenceSplitter } from "./splitter";

/** Structured recording of every splitter callback. */
interface Recording {
  /** Region contents in order: strings are markdown, objects are UI blocks. */
  regions: (string | { ui: string; terminated: boolean })[];
  /** The last reported markdown tail. */
  tail: string;
}

function record(): { rec: Recording; write(chunk: string): void; end(): void } {
  const rec: Recording = { regions: [""], tail: "" };
  const last = (): string | { ui: string; terminated: boolean } => rec.regions.at(-1)!;
  const splitter = createFenceSplitter({
    markdown(text) {
      const current = last();
      if (typeof current !== "string") throw new Error("markdown() while a UI block is open");
      rec.regions[rec.regions.length - 1] = current + text;
    },
    markdownTail(tail) {
      rec.tail = tail;
    },
    openUi() {
      rec.regions.push({ ui: "", terminated: false });
    },
    ui(text) {
      const current = last();
      if (typeof current === "string") throw new Error("ui() while no UI block is open");
      current.ui += text;
    },
    closeUi(terminated) {
      const current = last();
      if (typeof current === "string") throw new Error("closeUi() while no UI block is open");
      current.terminated = terminated;
      rec.regions.push("");
    },
  });
  return { rec, write: splitter.write, end: splitter.end };
}

/** Run the whole input through in the given chunk sizes and return the recording. */
function run(input: string, sizes?: number[]): Recording {
  const r = record();
  if (sizes === undefined) {
    r.write(input);
  } else {
    let offset = 0;
    for (const size of sizes) {
      r.write(input.slice(offset, offset + size));
      offset += size;
    }
    r.write(input.slice(offset));
  }
  r.end();
  return r.rec;
}

const DOC = `Hello *world*.

\`\`\`ui+jsx
<div title="x">hi</div>
\`\`\`

After.
`;

type Region = Recording["regions"][number];
const ui = (text: string, terminated = true): Region => ({ ui: text, terminated });

describe("createFenceSplitter — committed regions", () => {
  // Each case is checked on the whole input, and — since commits must be
  // chunking-invariant — with 1-char chunks and every two-way split.
  const cases: [name: string, input: string, regions: Region[]][] = [
    [
      "passes a fence-less document through",
      "# Title\n\nBody text.\n",
      ["# Title\n\nBody text.\n"],
    ],
    [
      "extracts a ui+jsx fence into a UI region",
      DOC,
      ["Hello *world*.\n\n", ui('<div title="x">hi</div>\n'), "\nAfter.\n"],
    ],
    [
      "handles back-to-back UI blocks",
      "```ui+jsx\n<a/>\n```\n```ui+jsx\n<b/>\n```\n",
      ["", ui("<a/>\n"), "", ui("<b/>\n"), ""],
    ],
    [
      "allows blanks around the info string",
      "``` ui+jsx \n<div/>\n```\n",
      ["", ui("<div/>\n"), ""],
    ],
    [
      "accepts a longer closing fence and an indented opener",
      "  ```ui+jsx\n<div/>\n`````\n",
      ["", ui("<div/>\n"), ""],
    ],
    [
      "requires the closing fence to be at least as long as the opener",
      "````ui+jsx\n<div>\n```\n</div>\n````\nafter\n",
      ["", ui("<div>\n```\n</div>\n"), "after\n"],
    ],
    [
      "keeps a backtick line that is not a closing fence inside the block",
      "```ui+jsx\n<div/>\n```x\n```\n",
      ["", ui("<div/>\n```x\n"), ""],
    ],
    [
      "ignores a ui+jsx opener inside a regular fenced code block",
      "```md\n```ui+jsx\n<div/>\n```\n\nreal text\n",
      ["```md\n```ui+jsx\n<div/>\n```\n\nreal text\n"],
    ],
    [
      "does not treat an indented (4+ spaces) backtick line as a fence",
      "    ```ui+jsx\ncode\n",
      ["    ```ui+jsx\ncode\n"],
    ],
    [
      "does not treat a near-miss info string as a ui+jsx opener",
      "```ui+jsx!\nx\n```\n",
      ["```ui+jsx!\nx\n```\n"],
    ],
    [
      "reports an unterminated UI block at end of stream",
      "before\n```ui+jsx\n<div>hi</div>\n",
      ["before\n", ui("<div>hi</div>\n", false), ""],
    ],
    [
      "closes on a final fence line without a trailing newline",
      "```ui+jsx\n<div/>\n```",
      ["", ui("<div/>\n"), ""],
    ],
    ["commits a final markdown line without a trailing newline", "last line", ["last line"]],
  ];

  for (const [name, input, regions] of cases) {
    it(name, () => {
      expect(run(input).regions).toEqual(regions);
      expect(
        run(
          input,
          Array.from({ length: input.length }, () => 1),
        ).regions,
      ).toEqual(regions);
      for (let i = 1; i < input.length; i++) {
        expect(run(input, [i]).regions, `split at ${i}`).toEqual(regions);
      }
    });
  }
});

describe("createFenceSplitter — streaming", () => {
  it("reports a partial line as the markdown tail, then commits it on newline", () => {
    const r = record();
    r.write("Hello wo");
    expect(r.rec.regions).toEqual([""]);
    expect(r.rec.tail).toBe("Hello wo");
    r.write("rld\n");
    expect(r.rec.regions).toEqual(["Hello world\n"]);
    expect(r.rec.tail).toBe("");
  });

  it("withholds a tail that could still become a ui+jsx opener", () => {
    const r = record();
    r.write("```ui+j");
    expect(r.rec.tail).toBe("");
    r.write("sx");
    expect(r.rec.tail).toBe("");
    // Turns out not to be a ui+jsx fence after all.
    r.write("!and more\n");
    expect(r.rec.regions).toEqual(["```ui+jsx!and more\n"]);
  });

  it("does not withhold a tail that can no longer be a fence", () => {
    const r = record();
    r.write("`code` in ");
    expect(r.rec.tail).toBe("`code` in ");
  });

  it("streams UI content within a line once it cannot be a closing fence", () => {
    const r = record();
    r.write("```ui+jsx\n<div>a");
    expect(r.rec.regions[1]).toEqual(ui("<div>a", false));
    r.write("b");
    expect(r.rec.regions[1]).toEqual(ui("<div>ab", false));
    r.write("</div>\n```\n");
    expect(r.rec.regions[1]).toEqual(ui("<div>ab</div>\n"));
  });

  it("withholds backticks inside a UI block until they resolve", () => {
    const r = record();
    r.write("```ui+jsx\n<div/>\n``");
    expect(r.rec.regions[1]).toEqual(ui("<div/>\n", false));
    // A third backtick would close; a different character flushes instead.
    r.write("`x");
    expect(r.rec.regions[1]).toEqual(ui("<div/>\n```x", false));
  });
});

describe("createFenceSplitter — opener offsets", () => {
  it("reports where each opening fence line starts, for any chunking", () => {
    const input = "Hi\n```ui+jsx\n<div/>\n```\ntext\n  ````ui+jsx\n<p/>\n````\n";
    const expected = [input.indexOf("```ui"), input.indexOf("  ````")];
    for (const size of [1, 2, 5, input.length]) {
      const offsets: number[] = [];
      const splitter = createFenceSplitter({
        markdown() {},
        markdownTail() {},
        openUi: (offset) => void offsets.push(offset),
        ui() {},
        closeUi() {},
      });
      for (let i = 0; i < input.length; i += size) splitter.write(input.slice(i, i + size));
      splitter.end();
      expect(offsets, `size ${size}`).toEqual(expected);
    }
  });
});

describe("createFenceSplitter — fenceClose", () => {
  /** The splitter's fenceClose() after `input`, and whether writing it closes the open fence. */
  function closeAfter(input: string): { close: string; closes: boolean } {
    const r = record();
    const splitter = createFenceSplitter({
      markdown() {},
      markdownTail() {},
      openUi() {},
      ui() {},
      closeUi() {},
    });
    splitter.write(input);
    const close = splitter.fenceClose();
    // Replay through a recording splitter: after the close, a ui+jsx opener
    // must start a new block (so we are back in plain Markdown).
    r.write(input + close + "```ui+jsx\n<b/>\n```\n");
    r.end();
    const blocks = r.rec.regions.filter((region) => typeof region !== "string");
    const last = blocks.at(-1);
    return { close, closes: typeof last === "object" && last.ui === "<b/>\n" };
  }

  it("is empty in plain Markdown", () => {
    expect(closeAfter("text\n").close).toBe("");
    expect(closeAfter("partial line").close).toBe("");
  });

  it("closes an open ui+jsx block, ending a partial line first", () => {
    expect(closeAfter("```ui+jsx\n<div>\n")).toEqual({ close: "```\n", closes: true });
    expect(closeAfter("```ui+jsx\n<div>te")).toEqual({ close: "\n```\n", closes: true });
    expect(closeAfter("````ui+jsx\n<div>")).toEqual({ close: "\n````\n", closes: true });
    // Withheld backticks that cannot close on their own.
    expect(closeAfter("```ui+jsx\n<div/>\n``")).toEqual({ close: "\n```\n", closes: true });
  });

  it("only ends the line when the partial line already is the closing fence", () => {
    expect(closeAfter("```ui+jsx\n<div/>\n```")).toEqual({ close: "\n", closes: true });
  });

  it("closes a regular code fence too", () => {
    expect(closeAfter("```js\nconst x")).toEqual({ close: "\n```\n", closes: true });
  });
});
