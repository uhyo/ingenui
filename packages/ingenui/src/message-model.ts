/**
 * The structure of a streamed message as an immutable value: its markdown and
 * `ui+jsx` regions, derived from the splitter's reports by a pure reducer.
 *
 * The model holds no runtime objects: a UI region is only its block index.
 * The block's content lives in its own parser (see `ui-block.tsx`), and
 * rendering is the message store's job (see `message.tsx`). React-free.
 */

import type { FenceSplitterHandlers } from "./splitter";

/** One splitter report (see {@link FenceSplitterHandlers}) as data. */
export type SplitEvent =
  | { readonly type: "markdown"; readonly text: string }
  | { readonly type: "markdownTail"; readonly tail: string }
  | { readonly type: "openUi" }
  | { readonly type: "ui"; readonly text: string }
  | { readonly type: "closeUi"; readonly terminated: boolean };

/**
 * Splitter handlers that record each report as a {@link SplitEvent}; `take()`
 * returns the events since the last call.
 */
export function createSplitEventCollector(): {
  handlers: FenceSplitterHandlers;
  take(): readonly SplitEvent[];
} {
  let events: SplitEvent[] = [];
  return {
    handlers: {
      markdown: (text) => void events.push({ type: "markdown", text }),
      markdownTail: (tail) => void events.push({ type: "markdownTail", tail }),
      openUi: () => void events.push({ type: "openUi" }),
      ui: (text) => void events.push({ type: "ui", text }),
      closeUi: (terminated) => void events.push({ type: "closeUi", terminated }),
    },
    take() {
      const taken = events;
      events = [];
      return taken;
    },
  };
}

export interface MarkdownRegion {
  readonly kind: "markdown";
  /** Stable id (creation order), e.g. for a React key. */
  readonly id: number;
  /** Committed text: complete lines, append-only. */
  readonly committed: string;
  /** The tentative partial last line (see the splitter's `markdownTail`). */
  readonly tail: string;
}

export interface UiRegion {
  readonly kind: "ui";
  readonly blockIndex: number;
}

export type Region = MarkdownRegion | UiRegion;

export interface MessageModel {
  /** Regions in stream order; the last one holds the stream's frontier. */
  readonly regions: readonly Region[];
  /** The number of `ui+jsx` blocks opened so far. */
  readonly blockCount: number;
  /** Whether a `ui+jsx` block is open at the frontier. */
  readonly inUi: boolean;
  /** Whether the stream may still grow. */
  readonly streaming: boolean;
}

/** The model of a message before any text has arrived. */
export const EMPTY_MESSAGE: MessageModel = {
  regions: [{ kind: "markdown", id: 0, committed: "", tail: "" }],
  blockCount: 0,
  inUi: false,
  streaming: true,
};

/**
 * Apply one chunk's splitter events. Returns `model` itself when they change
 * nothing structural (`ui` text belongs to the block's parser); otherwise a
 * new model sharing every unchanged region.
 */
export function applySplitEvents(model: MessageModel, events: readonly SplitEvent[]): MessageModel {
  let regions: Region[] | null = null;
  let { blockCount, inUi } = model;
  for (const event of events) {
    switch (event.type) {
      case "markdown":
      case "markdownTail": {
        regions ??= model.regions.slice();
        const last = regions[regions.length - 1];
        // The splitter only reports markdown between UI blocks.
        if (last?.kind !== "markdown") break;
        regions[regions.length - 1] =
          event.type === "markdown"
            ? { ...last, committed: last.committed + event.text }
            : { ...last, tail: event.tail };
        break;
      }
      case "openUi":
        regions ??= model.regions.slice();
        regions.push({ kind: "ui", blockIndex: blockCount++ });
        inUi = true;
        break;
      case "ui":
        break;
      case "closeUi":
        regions ??= model.regions.slice();
        regions.push({ kind: "markdown", id: blockCount, committed: "", tail: "" });
        inUi = false;
        break;
    }
  }
  if (regions === null) return model;
  return { regions, blockCount, inUi, streaming: model.streaming };
}

/** The model once the stream has ended (normally or not). */
export function endMessage(model: MessageModel): MessageModel {
  return model.streaming ? { ...model, streaming: false } : model;
}
