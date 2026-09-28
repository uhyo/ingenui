import { describe, expect, it } from "vitest";

import type { SplitEvent } from "./message-model";
import {
  applySplitEvents,
  createSplitEventCollector,
  EMPTY_MESSAGE,
  endMessage,
} from "./message-model";
import { createFenceSplitter } from "./splitter";

/** A splitter whose `write` returns the events it reported. */
function eventSplitter(): { write(chunk: string): readonly SplitEvent[] } {
  const collector = createSplitEventCollector();
  const splitter = createFenceSplitter(collector.handlers);
  return {
    write(chunk) {
      splitter.write(chunk);
      return collector.take();
    },
  };
}

describe("applySplitEvents", () => {
  it("derives the regions of a message", () => {
    const splitter = eventSplitter();
    let model = applySplitEvents(
      EMPTY_MESSAGE,
      splitter.write("Intro\n```ui+jsx\n<Card />\n```\nOutro\npart"),
    );
    expect(model).toEqual({
      regions: [
        { kind: "markdown", id: 0, committed: "Intro\n", tail: "" },
        { kind: "ui", blockIndex: 0 },
        { kind: "markdown", id: 1, committed: "Outro\n", tail: "part" },
      ],
      blockCount: 1,
      inUi: false,
      streaming: true,
    });
    model = applySplitEvents(model, splitter.write("ial\n```ui+jsx\n<p>"));
    expect(model.regions.slice(2)).toEqual([
      { kind: "markdown", id: 1, committed: "Outro\npartial\n", tail: "" },
      { kind: "ui", blockIndex: 1 },
    ]);
    expect(model.inUi).toBe(true);
  });

  it("returns the same model for block content, and shares unchanged regions", () => {
    const splitter = eventSplitter();
    const model = applySplitEvents(EMPTY_MESSAGE, splitter.write("Intro\n```ui+jsx\n"));
    expect(applySplitEvents(model, splitter.write("<Card>\n<p>"))).toBe(model);
    const next = applySplitEvents(model, splitter.write("\n```\nOutro"));
    expect(next).not.toBe(model);
    expect(next.regions[0]).toBe(model.regions[0]);
    expect(next.regions[1]).toBe(model.regions[1]);
  });

  it("never mutates its input", () => {
    const splitter = eventSplitter();
    const model = applySplitEvents(EMPTY_MESSAGE, splitter.write("a\nb"));
    const json = JSON.stringify(model);
    applySplitEvents(model, splitter.write("c\n```ui+jsx\n"));
    expect(JSON.stringify(model)).toBe(json);
    expect(EMPTY_MESSAGE.regions).toHaveLength(1);
  });
});

describe("endMessage", () => {
  it("marks the model as no longer streaming", () => {
    const ended = endMessage(EMPTY_MESSAGE);
    expect(ended.streaming).toBe(false);
    expect(endMessage(ended)).toBe(ended);
  });
});

describe("createSplitEventCollector", () => {
  it("records the splitter's reports as events, in order", () => {
    const splitter = eventSplitter();
    expect(splitter.write("a\n```ui+jsx\n<p/>\n```\nb")).toEqual([
      { type: "markdown", text: "a\n" },
      { type: "openUi" },
      { type: "ui", text: "<p/>" },
      { type: "ui", text: "\n" },
      { type: "closeUi", terminated: true },
      { type: "markdownTail", tail: "b" },
    ]);
    expect(splitter.write("")).toEqual([]);
  });
});
