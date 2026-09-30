import { act, cleanup, render } from "@testing-library/react";
import { Children } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPushChannel } from "./channel";
import type { GenUiIssue } from "./issues";
import { createGenUiMessage } from "./message";
import type { UiBlockWrapperProps } from "./ui-block";
import { useGenUiNode } from "./react";

function html(node: ReactNode): string {
  return renderToStaticMarkup(<>{node}</>);
}

async function* iterableFrom(chunks: string[]): AsyncGenerator<string> {
  for (const chunk of chunks) yield chunk;
}

/** Let the background pumps (outer stream + per-block channels) drain. */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

afterEach(() => {
  // With `globals: false`, testing-library's automatic cleanup does not
  // register; unmount explicitly so renders don't leak across tests.
  cleanup();
  vi.restoreAllMocks();
});

describe("createGenUiMessage — rendering", () => {
  it("renders a markdown-only message", async () => {
    const message = createGenUiMessage(iterableFrom(["# Hi\n\nSome **bold** text.\n"]));
    await message.done;
    expect(html(message.getSnapshot())).toBe("<h1>Hi</h1><p>Some <strong>bold</strong> text.</p>");
    expect(message.getIssues()).toEqual([]);
    expect(message.getIssueReport()).toBeNull();
  });

  it("renders ui+jsx blocks as live UI between markdown regions", async () => {
    const Card = ({ title }: { title?: string }) => <section>{title}</section>;
    const message = createGenUiMessage(
      iterableFrom(["Before.\n\n```ui+jsx\n", '<Card title="Hello" />\n', "```\n\nAfter.\n"]),
      { components: { Card } },
    );
    await message.done;
    expect(html(message.getSnapshot())).toBe("<p>Before.</p><section>Hello</section><p>After.</p>");
    expect(message.getIssueReport()).toBeNull();
  });

  it("renders a regular code fence as code, not UI", async () => {
    const message = createGenUiMessage(iterableFrom(["```js\nlet x = 1;\n```\n"]));
    await message.done;
    expect(html(message.getSnapshot())).toBe(
      '<pre><code class="language-js">let x = 1;\n</code></pre>',
    );
  });

  it("keeps the snapshot stable, and settled regions' elements across changes", async () => {
    const outer = createPushChannel();
    const message = createGenUiMessage(outer.source);
    outer.push("First paragraph.\n\n```ui+jsx\n<div/>\n```\n");
    await settle();
    const before = message.getSnapshot() as ReactNode[];
    expect(message.getSnapshot()).toBe(before); // stable until the content changes
    outer.push("tail text");
    await settle();
    const after = message.getSnapshot() as ReactNode[];
    expect(after).not.toBe(before);
    // The settled first region keeps its element identity.
    expect(after[0]).toBe(before[0]);
    outer.close();
    await message.done;
  });

  it("shows the Pending placeholder at a markdown frontier while streaming", async () => {
    const Pending = () => <span className="shimmer" />;
    const outer = createPushChannel();
    const message = createGenUiMessage(outer.source, { Pending });
    outer.push("Loading text");
    await settle();
    expect(html(message.getSnapshot())).toBe('<p>Loading text</p><span class="shimmer"></span>');
    outer.close();
    await message.done;
    expect(html(message.getSnapshot())).toBe("<p>Loading text</p>");
  });

  it("shows the Pending placeholder inside a streaming ui block", async () => {
    const Pending = () => <span className="shimmer" />;
    const outer = createPushChannel();
    const message = createGenUiMessage(outer.source, { Pending });
    outer.push("```ui+jsx\n<div>partial");
    await settle();
    expect(html(message.getSnapshot())).toBe('<div>partial<span class="shimmer"></span></div>');
    outer.close();
    await message.done;
  });

  it("supports a custom markdown renderer", async () => {
    const message = createGenUiMessage(iterableFrom(["hello\n"]), {
      renderMarkdown: (markdown) => <div data-md={markdown.trim()} />,
    });
    await message.done;
    expect(html(message.getSnapshot())).toBe('<div data-md="hello"></div>');
  });

  it("renders unterminated inline markup optimistically at the streaming frontier", async () => {
    const outer = createPushChannel();
    const message = createGenUiMessage(outer.source);
    outer.push("Some **bol");
    await settle();
    expect(html(message.getSnapshot())).toBe("<p>Some <strong>bol</strong></p>");
    outer.push("d** text");
    await settle();
    expect(html(message.getSnapshot())).toBe("<p>Some <strong>bold</strong> text</p>");
    outer.push(" and *unfinished");
    outer.close();
    await message.done;
    // Once the stream ends, an unterminated marker is literal again.
    expect(html(message.getSnapshot())).toBe(
      "<p>Some <strong>bold</strong> text and *unfinished</p>",
    );
  });

  it("tells a custom markdown renderer which region is still streaming", async () => {
    const calls: [string, boolean][] = [];
    const outer = createPushChannel();
    const message = createGenUiMessage(outer.source, {
      renderMarkdown: (markdown, { streaming }) => {
        calls.push([markdown, streaming]);
        return null;
      },
    });
    outer.push("Before.\n\n```ui+jsx\n<div/>\n```\nAfter");
    await settle();
    message.getSnapshot();
    expect(calls).toEqual([
      ["Before.\n\n", false],
      ["After", true],
    ]);
    outer.close();
    await message.done;
    message.getSnapshot();
    expect(calls.at(-1)).toEqual(["After", false]);
  });
});

describe("createGenUiMessage — actions", () => {
  it("runs declared handlers and emits ActionEvents for declared and model-defined actions", async () => {
    const submitted = vi.fn();
    const fired: [string, boolean, string][] = [];
    const message = createGenUiMessage(
      iterableFrom([
        "```ui+jsx\n<div><button onClick={actions.submit}>Send</button>",
        "<button onClick={actions.dismissHelp}>Dismiss</button></div>\n```\n",
      ]),
      {
        actions: { submit: submitted },
        onAction: (event) => fired.push([event.name, event.declared, event.message]),
      },
    );
    await message.done;
    // Model-defined actions are accepted by default (dynamicActions).
    expect(message.getIssues()).toEqual([]);

    const { getAllByRole } = render(<>{message.getSnapshot()}</>);
    act(() => {
      for (const button of getAllByRole("button")) button.click();
    });

    expect(submitted).toHaveBeenCalledOnce();
    expect(fired).toEqual([
      ["submit", true, "The `actions.submit` action was fired by the user."],
      ["dismissHelp", false, "The `actions.dismissHelp` action was fired by the user."],
    ]);
  });
});

describe("createGenUiMessage — issues", () => {
  it("collects parser errors per block with block indices", async () => {
    const message = createGenUiMessage(
      iterableFrom(["```ui+jsx\n<Unknown />\n```\n\n", "```ui+jsx\n<div>{1 + 2}</div>\n```\n"]),
      { components: {} },
    );
    await message.done;
    const issues = message.getIssues();
    expect(issues.map((i) => [i.blockIndex, i.kind])).toEqual([
      [0, "jsx-error"],
      [1, "jsx-error"],
    ]);
    const report = message.getIssueReport()!;
    expect(report).toContain("In `ui+jsx` block 1:");
    expect(report).toContain("In `ui+jsx` block 2:");
  });

  it("reports an unclosed ui+jsx fence", async () => {
    const message = createGenUiMessage(iterableFrom(["```ui+jsx\n<div>hi</div>\n"]));
    await message.done;
    expect(message.getIssues().map((i) => i.kind)).toEqual(["unclosed-fence"]);
    expect(html(message.getSnapshot())).toBe("<div>hi</div>");
  });

  it("hides a block that crashes at render time and records a render-error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Boom = () => {
      throw new Error("component exploded");
    };
    const issues: GenUiIssue[] = [];
    const message = createGenUiMessage(iterableFrom(["ok\n\n```ui+jsx\n<Boom />\n```\n"]), {
      components: { Boom },
      onIssue: (issue) => issues.push(issue),
      renderUiError: (blockIndex) => <em>block {blockIndex + 1} hidden</em>,
    });
    await message.done;

    const { container } = render(<>{message.getSnapshot()}</>);
    expect(container.innerHTML).toBe("<p>ok</p><em>block 1 hidden</em>");
    expect(issues.map((i) => i.kind)).toEqual(["render-error"]);
    expect(message.getIssueReport()).toContain("Rendering crashed: component exploded");
  });

  it("reports a crash that persists across retries only once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Boom = (): ReactNode => {
      throw new Error("always broken");
    };
    const outer = createPushChannel();
    const message = createGenUiMessage(outer.source, { components: { Boom } });
    const View = () => <>{useGenUiNode(message)}</>;
    render(<View />);

    // Every chunk updates the block, and each update retries the render.
    for (const chunk of ["```ui+jsx\n<Boom>a", "b", "c</Boom>\n```\n"]) {
      // oxlint-disable-next-line no-await-in-loop
      await act(async () => {
        outer.push(chunk);
        await settle();
      });
    }
    outer.close();
    await act(async () => {
      await message.done;
    });
    expect(message.getIssues().map((i) => i.kind)).toEqual(["render-error"]);
  });

  it("retries a crashed block as more of the stream arrives (self-healing)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Boom = ({ children }: { children?: ReactNode }) => {
      const text = Children.toArray(children)
        .filter((child): child is string => typeof child === "string")
        .join("");
      if (text === "bad") throw new Error("transiently bad");
      return <b>{text}</b>;
    };
    const outer = createPushChannel();
    const message = createGenUiMessage(outer.source, { components: { Boom } });
    const View = () => <>{useGenUiNode(message)}</>;
    const { container } = render(<View />);

    await act(async () => {
      outer.push("```ui+jsx\n<Boom>bad");
      await settle();
    });
    // The partial text crashed the component; the boundary hides the block.
    expect(container.innerHTML).toBe("");

    await act(async () => {
      outer.push("ge</Boom>\n```\n");
      outer.close();
      await settle();
    });
    await act(async () => {
      await message.done;
    });
    expect(container.innerHTML).toBe("<b>badge</b>");
  });
});

/** A wrapper that renders the block's status as attributes, recording each call. */
function recordingWrapper() {
  const calls: UiBlockWrapperProps[] = [];
  const wrapUiBlock = (props: UiBlockWrapperProps): ReactNode => {
    calls.push(props);
    return (
      <div
        data-block={props.blockIndex}
        data-state={props.state}
        data-issues={props.issues.map((i) => i.kind).join(",")}
        data-crashed={String(props.crashed)}
      >
        {props.children}
      </div>
    );
  };
  const last = (blockIndex: number) => calls.findLast((c) => c.blockIndex === blockIndex);
  return { calls, wrapUiBlock, last };
}

describe("createGenUiMessage — wrapUiBlock", () => {
  it("sees jsx-error issues on a block that still renders, and a clean block after it", async () => {
    const { wrapUiBlock, last } = recordingWrapper();
    const message = createGenUiMessage(
      iterableFrom([
        "```ui+jsx\n<p>{broken()}ok</p>\n```\n\nFixed:\n\n",
        "```ui+jsx\n<p>fine</p>\n```\n",
      ]),
      { wrapUiBlock },
    );
    await message.done;
    expect(html(message.getSnapshot())).toBe(
      '<div data-block="0" data-state="closed" data-issues="jsx-error" data-crashed="false"><p>ok</p></div>' +
        "<p>Fixed:</p>" +
        '<div data-block="1" data-state="closed" data-issues="" data-crashed="false"><p>fine</p></div>',
    );
    // The same issue objects the message collects.
    expect(last(0)!.issues).toEqual(message.getIssues());
    expect(last(0)!.issues[0]).toMatchObject({
      kind: "jsx-error",
      event: { kind: "unsupported-expression" },
    });
  });

  it("sees a block streaming, then cut off before its closing fence", async () => {
    const { wrapUiBlock, last } = recordingWrapper();
    const outer = createPushChannel();
    const message = createGenUiMessage(outer.source, { wrapUiBlock });
    outer.push("```ui+jsx\n<p>partial");
    await settle();
    message.getSnapshot();
    expect(last(0)).toMatchObject({ state: "streaming", issues: [] });

    // The stream ends mid-block (e.g. the server stopped the model).
    outer.close();
    await message.done;
    expect(html(message.getSnapshot())).toBe(
      '<div data-block="0" data-state="unterminated" data-issues="jsx-error" data-crashed="false"><p>partial</p></div>',
    );
    // The unclosed tag is the block's issue; the unclosed fence is its state.
    expect(message.getIssues().map((i) => i.kind)).toEqual(["unclosed-fence", "jsx-error"]);
  });

  it("marks the open block unterminated when the stream fails", async () => {
    const { wrapUiBlock, last } = recordingWrapper();
    async function* failing(): AsyncGenerator<string> {
      yield "```ui+jsx\n<div>partial";
      throw new Error("network down");
    }
    const message = createGenUiMessage(failing(), { wrapUiBlock });
    await expect(message.done).rejects.toThrow("network down");
    message.getSnapshot();
    expect(last(0)?.state).toBe("unterminated");
  });

  it("sees a crash (children is the renderUiError fallback), and the recovery", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Boom = ({ children }: { children?: ReactNode }) => {
      const text = Children.toArray(children)
        .filter((child): child is string => typeof child === "string")
        .join("");
      if (text === "bad") throw new Error("transiently bad");
      return <b>{text}</b>;
    };
    const { wrapUiBlock } = recordingWrapper();
    const outer = createPushChannel();
    const message = createGenUiMessage(outer.source, {
      components: { Boom },
      wrapUiBlock,
      renderUiError: (blockIndex) => <em>block {blockIndex + 1} crashed</em>,
    });
    const View = () => <>{useGenUiNode(message)}</>;
    const { container } = render(<View />);

    await act(async () => {
      outer.push("```ui+jsx\n<Boom>bad");
      await settle();
    });
    expect(container.innerHTML).toBe(
      '<div data-block="0" data-state="streaming" data-issues="render-error" data-crashed="true"><em>block 1 crashed</em></div>',
    );

    await act(async () => {
      outer.push("ge</Boom>\n```\n");
      outer.close();
      await settle();
    });
    await act(async () => {
      await message.done;
    });
    // Healed: no longer crashed, but the crash stays on record.
    expect(container.innerHTML).toBe(
      '<div data-block="0" data-state="closed" data-issues="render-error" data-crashed="false"><b>badge</b></div>',
    );
  });

  it("stays crashed without re-rendering the wrapper for a crash that persists", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Boom = (): ReactNode => {
      throw new Error("always broken");
    };
    const { wrapUiBlock, calls } = recordingWrapper();
    const message = createGenUiMessage(iterableFrom(["```ui+jsx\n<Boom />\n```\n"]), {
      components: { Boom },
      wrapUiBlock,
    });
    await message.done;
    const View = () => <>{useGenUiNode(message)}</>;
    const { container } = render(<View />);
    expect(container.innerHTML).toBe(
      '<div data-block="0" data-state="closed" data-issues="render-error" data-crashed="true"></div>',
    );
    // Rendered once before the crash, once after it.
    expect(calls.map((c) => c.crashed)).toEqual([false, true]);
  });

  it("keeps a settled block's wrapped element while the message grows", async () => {
    const { wrapUiBlock, calls } = recordingWrapper();
    const outer = createPushChannel();
    const message = createGenUiMessage(outer.source, { wrapUiBlock });
    outer.push("```ui+jsx\n<p>done</p>\n```\n");
    await settle();
    await settle();
    const before = message.getSnapshot() as ReactNode[];
    const callsBefore = calls.length;
    outer.push("More text");
    await settle();
    const after = message.getSnapshot() as ReactNode[];
    expect(after).not.toBe(before);
    expect(after[0]).toBe(before[0]);
    expect(calls).toHaveLength(callsBefore);
    outer.close();
    await message.done;
  });
});

describe("createGenUiMessage — lifecycle", () => {
  it("rejects done and reports onStreamError when the source fails", async () => {
    const failure = new Error("network down");
    async function* failing(): AsyncGenerator<string> {
      yield "some text\n\n```ui+jsx\n<div>partial";
      throw failure;
    }
    const onStreamError = vi.fn();
    const message = createGenUiMessage(failing(), { onStreamError });
    await expect(message.done).rejects.toBe(failure);
    expect(onStreamError).toHaveBeenCalledWith(failure);
    await settle();
    // Received content stays rendered, finalized best-effort.
    expect(html(message.getSnapshot())).toBe("<p>some text</p><div>partial</div>");
  });

  it("dispose cancels the stream, including an open ui block", async () => {
    const outer = createPushChannel();
    const message = createGenUiMessage(outer.source);
    outer.push("hello\n\n```ui+jsx\n<p>x");
    await settle();
    const before = html(message.getSnapshot());
    expect(before).toBe("<p>hello</p><p>x</p>");
    message.dispose();
    outer.push("y</p>\n```\nmore text\n");
    await settle();
    expect(html(message.getSnapshot())).toBe(before);
    // Settles rather than waiting forever on the open block's parser.
    await message.done;
  });

  it("notifies subscribers as chunks arrive, until they unsubscribe", async () => {
    const outer = createPushChannel();
    const message = createGenUiMessage(outer.source);
    let notified = 0;
    const unsubscribe = message.subscribe(() => notified++);
    outer.push("a");
    await settle();
    expect(notified).toBeGreaterThan(0);

    unsubscribe();
    const seen = notified;
    outer.push("b\n```ui+jsx\n<p>c</p>\n```\n");
    outer.close();
    await message.done;
    expect(notified).toBe(seen);
  });
});
