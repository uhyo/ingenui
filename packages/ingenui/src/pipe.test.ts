import { describe, expect, it } from "vitest";

import { bindGenUi } from "./bind";
import type { GenUiIssue } from "./issues";
import { createGenUiMessage } from "./message";
import type { GenUiPipe, GenUiPipeSnapshot } from "./pipe";
import { formatContinuationMessage, pipeGenUi } from "./pipe";
import { defineGenUiSchema } from "./schema";
import { validateGenUiMessage } from "./validator";

const schema = defineGenUiSchema({ components: { Card: { props: { title: "string" } } } });

async function* iterableFrom<T>(chunks: T[]): AsyncGenerator<T> {
  for (const chunk of chunks) yield chunk;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe("pipeGenUi", () => {
  it("passes the text through unchanged and resolves with the issues", async () => {
    const chunks = ["Hi\n```ui+", "jsx\n<Card title={1} />\n", "<Chart />\n```\n", "bye"];
    const pipe = pipeGenUi(iterableFrom(chunks), schema);
    expect(await readAll(pipe.stream)).toBe(chunks.join(""));
    const { issues, status, text } = await pipe.done;
    expect(status).toBe("complete");
    expect(text).toBe(chunks.join(""));
    expect(issues.map((issue) => issue.kind === "jsx-error" && issue.event.kind)).toEqual([
      "invalid-prop",
      "unknown-component",
    ]);
    expect(pipe.getIssueReport()).toContain("<Chart>");
  });

  it("reports an issue before the chunk completing it reaches the consumer", async () => {
    const seen: GenUiIssue[] = [];
    const pipe = pipeGenUi(iterableFrom(["```ui+jsx\n", "<Chart />", "\n```\n"]), schema, {
      onIssue: (issue) => seen.push(issue),
    });
    const reader = pipe.stream.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toBe("```ui+jsx\n");
    expect(seen).toEqual([]);
    expect(decoder.decode((await reader.read()).value)).toBe("<Chart />");
    expect(seen).toHaveLength(1);
    reader.releaseLock();
  });

  it("decodes byte sources, including code points split across chunks", async () => {
    const bytes = new TextEncoder().encode('```ui+jsx\n<Card title="héllo 👋" />\n```\n');
    const parts = [bytes.slice(0, 22), bytes.slice(22, 27), bytes.slice(27)];
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    });
    const pipe = pipeGenUi(source, schema);
    expect(await readAll(pipe.stream)).toBe('```ui+jsx\n<Card title="héllo 👋" />\n```\n');
    expect((await pipe.done).issues).toEqual([]);
  });

  it("skips empty chunks without stalling", async () => {
    const pipe = pipeGenUi(iterableFrom(["", "a", "", "", "b", ""]), schema);
    expect(await readAll(pipe.stream)).toBe("ab");
  });

  it("cancels the source when the consumer cancels", async () => {
    let cancelled = false;
    const source = new ReadableStream<string>({
      pull(controller) {
        controller.enqueue("```ui+jsx\n<Chart />\n");
      },
      cancel() {
        cancelled = true;
      },
    });
    const pipe = pipeGenUi(source, schema);
    const reader = pipe.stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(cancelled).toBe(true);
    // No end-of-message checks after a cancel (no unclosed-fence).
    const result = await pipe.done;
    expect(result.status).toBe("cancelled");
    const kinds = result.issues.map((issue) => issue.kind);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).not.toContain("unclosed-fence");
  });

  it("errors the stream and rejects done when the source fails", async () => {
    const failure = new Error("upstream failed");
    async function* failing(): AsyncGenerator<string> {
      yield "partial ";
      throw failure;
    }
    const pipe = pipeGenUi(failing(), schema);
    const reader = pipe.stream.getReader();
    await reader.read();
    await expect(reader.read()).rejects.toBe(failure);
    await expect(pipe.done).rejects.toBe(failure);
  });
});

/** A source that records its cancellation and never ends by itself. */
function endlessSource(chunks: string[]): { source: ReadableStream<string>; cancelled(): boolean } {
  let cancelled = false;
  let index = 0;
  const source = new ReadableStream<string>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]!);
      // Past the scripted chunks, the "model" stalls: pull never enqueues.
      else return new Promise<void>(() => {});
      return undefined;
    },
    cancel() {
      cancelled = true;
    },
  });
  return { source, cancelled: () => cancelled };
}

const stopOnFirstIssue = { onIssue: (_issue: GenUiIssue, target: GenUiPipe) => target.stop() };

/** The client's parse-time issues for `text` (as the client would see it). */
async function clientIssues(text: string): Promise<GenUiIssue[]> {
  const message = createGenUiMessage(
    iterableFrom([...text]),
    bindGenUi(schema, { components: { Card } }),
  );
  await message.done;
  return message.getIssues().filter((issue) => issue.kind !== "render-error");
}

const Card = ({ title }: { title?: string }) => title ?? null;

describe("pipeGenUi — stop", () => {
  it("cancels the source and closes the stream normally", async () => {
    const { source, cancelled } = endlessSource([
      "Hi\n```ui+jsx\n<Card>\n",
      "  <Chart />",
      "\n  <p>more",
    ]);
    const pipe = pipeGenUi(source, schema, stopOnFirstIssue);
    // Resolves (does not reject): the stream ended normally.
    expect(await readAll(pipe.stream)).toBe("Hi\n```ui+jsx\n<Card>\n  <Chart />");
    expect(cancelled()).toBe(true);
    const result = await pipe.done;
    expect(result.status).toBe("stopped");
    expect(result.stops).toBe(1);
    expect(result.text).toBe("Hi\n```ui+jsx\n<Card>\n  <Chart />");
    // Stopped mid-block, without a continuation: the message ends as cut.
    expect(result.issues.map((issue) => issue.kind)).toEqual([
      "jsx-error",
      "jsx-error",
      "unclosed-fence",
    ]);
    expect(result.cleanOffset).toBe(3);
    expect(result.cleanText).toBe("Hi\n");
    expect(result.issueReport).toContain("<Chart>");
  });

  it("keeps server/client parity on the stopped text", async () => {
    const pipe = pipeGenUi(
      iterableFrom(["A\n```ui+jsx\n<div>", "{compute()}</div>\n<Card title={1}", " />\n```\nB"]),
      schema,
      stopOnFirstIssue,
    );
    await readAll(pipe.stream);
    const { text, issues } = await pipe.done;
    expect(text).toBe("A\n```ui+jsx\n<div>{compute()}</div>\n<Card title={1}");
    expect(issues).toEqual(validateGenUiMessage(text, schema));
    expect(await clientIssues(text)).toEqual(issues);
  });

  it("stops a pending read from outside", async () => {
    const { source, cancelled } = endlessSource(["Thinking"]);
    const pipe = pipeGenUi(source, schema);
    const reader = pipe.stream.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("Thinking");
    const next = reader.read(); // stalls: the source never sends more
    pipe.stop();
    expect(await next).toEqual({ done: true, value: undefined });
    expect(cancelled()).toBe(true);
    expect((await pipe.done).status).toBe("stopped");
  });

  it("cancels an async-iterable source through return()", async () => {
    let finalized = false;
    async function* model(): AsyncGenerator<string> {
      try {
        yield "```ui+jsx\n<Chart />";
        yield "\n```\n";
      } finally {
        finalized = true;
      }
    }
    const pipe = pipeGenUi(model(), schema, stopOnFirstIssue);
    await readAll(pipe.stream);
    expect(finalized).toBe(true);
    expect((await pipe.done).text).toBe("```ui+jsx\n<Chart />");
  });

  it("ignores the source failing after it was stopped", async () => {
    const abort = new AbortController();
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("```ui+jsx\n<Chart />");
        abort.signal.addEventListener("abort", () => controller.error(new Error("aborted")));
      },
    });
    const pipe = pipeGenUi(source, schema, {
      onIssue(_issue, target) {
        abort.abort(); // the app aborts its own upstream request…
        target.stop(); // …and stops the message
      },
    });
    expect(await readAll(pipe.stream)).toBe("```ui+jsx\n<Chart />");
    expect((await pipe.done).status).toBe("stopped");
  });

  it("is a no-op once the message has ended", async () => {
    const pipe = pipeGenUi(iterableFrom(["done"]), schema);
    await readAll(pipe.stream);
    pipe.stop();
    expect(await pipe.done).toMatchObject({ status: "complete", stops: 0 });
  });
});

describe("pipeGenUi — continuation", () => {
  it("closes the open fence and continues the same message", async () => {
    const snapshots: GenUiPipeSnapshot[] = [];
    const pipe = pipeGenUi(
      iterableFrom(["Intro\n```ui+jsx\n<Card>", "<Chart />", "</Card>\n```\n"]),
      schema,
      {
        ...stopOnFirstIssue,
        continuation(snapshot) {
          snapshots.push(snapshot);
          return iterableFrom(["Fixed:\n```ui+jsx\n", '<Card title="ok" />\n```\n']);
        },
      },
    );
    const expected =
      'Intro\n```ui+jsx\n<Card><Chart />\n```\nFixed:\n```ui+jsx\n<Card title="ok" />\n```\n';
    expect(await readAll(pipe.stream)).toBe(expected);

    expect(snapshots).toHaveLength(1);
    const [cut] = snapshots;
    expect(cut!.text).toBe("Intro\n```ui+jsx\n<Card><Chart />\n```\n");
    expect(cut!.cleanText).toBe("Intro\n");
    expect(cut!.stops).toBe(1);
    // Closing the fence ended the block: its unclosed <Card> is reported, not an unclosed fence.
    expect(cut!.issues.map((issue) => issue.kind === "jsx-error" && issue.event.kind)).toEqual([
      "unknown-component",
      "unclosed-tag",
    ]);
    expect(cut!.issueReport).toContain("In `ui+jsx` block 1:");

    const result = await pipe.done;
    expect(result).toMatchObject({
      status: "complete",
      stops: 1,
      text: expected,
      cleanText: "Intro\n",
    });
    // One message: block indices run on, and the client agrees.
    expect(result.issues).toEqual(validateGenUiMessage(expected, schema));
    expect(await clientIssues(expected)).toEqual(result.issues);
  });

  it("ends the message, fence closed, when the continuation returns null", async () => {
    const pipe = pipeGenUi(iterableFrom(["```ui+jsx\n<Chart />", "\n<p>more"]), schema, {
      ...stopOnFirstIssue,
      continuation: async () => null,
    });
    expect(await readAll(pipe.stream)).toBe("```ui+jsx\n<Chart />\n```\n");
    const result = await pipe.done;
    expect(result.status).toBe("stopped");
    expect(result.issues.map((issue) => issue.kind)).not.toContain("unclosed-fence");
  });

  it("can stop the continuation again (the app keeps the retry budget)", async () => {
    const sources = [
      iterableFrom(["```ui+jsx\n<Chart />\n```\n"]),
      iterableFrom(["```ui+jsx\n<Graph />\n```\n"]),
      iterableFrom(["```ui+jsx\n<Plot />\n```\n"]),
    ];
    let next = 1;
    const pipe = pipeGenUi(sources[0]!, schema, {
      ...stopOnFirstIssue,
      continuation: ({ stops }) => (stops < 2 ? sources[next++] : null),
    });
    await readAll(pipe.stream);
    const result = await pipe.done;
    expect(result).toMatchObject({ status: "stopped", stops: 2 });
    expect(result.issues.map((issue) => issue.blockIndex)).toEqual([0, 1]);
  });

  it("cancels the continuation when the consumer went away meanwhile", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const { source: next, cancelled } = endlessSource(["never read"]);
    const pipe = pipeGenUi(iterableFrom(["```ui+jsx\n<Chart />"]), schema, {
      ...stopOnFirstIssue,
      continuation: async () => {
        await released;
        return next;
      },
    });
    const reader = pipe.stream.getReader();
    await reader.read();
    await reader.cancel();
    release();
    const result = await pipe.done;
    expect(result.status).toBe("cancelled");
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelled()).toBe(true);
  });

  it("errors the stream when the continuation fails", async () => {
    const failure = new Error("request failed");
    const pipe = pipeGenUi(iterableFrom(["```ui+jsx\n<Chart />"]), schema, {
      ...stopOnFirstIssue,
      continuation: () => Promise.reject(failure),
    });
    const reader = pipe.stream.getReader();
    await reader.read();
    await reader.read(); // the closing fence
    await expect(reader.read()).rejects.toBe(failure);
    await expect(pipe.done).rejects.toBe(failure);
  });
});

describe("formatContinuationMessage", () => {
  it("asks the model to continue after the text, with the issue report", () => {
    const message = formatContinuationMessage("Hello\n```ui+jsx\n<Chart />\n```\n", "REPORT");
    expect(message).toMatch(/^Your previous response was interrupted and ended with:/);
    expect(message).toContain(
      "<previous_response>\nHello\n```ui+jsx\n<Chart />\n```\n\n</previous_response>",
    );
    expect(message).toContain("REPORT");
    expect(message).toMatch(/Continue from where you left off/);
    expect(formatContinuationMessage("Hi", null)).not.toContain("corrected block");
  });
});
