import { createElement, Fragment } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { bindGenUi } from "./bind";
import type { GenUiIssue } from "./issues";
import type { GenUiMessageOptions } from "./message";
import { createGenUiMessage } from "./message";
import { pipeGenUi } from "./pipe";
import { defineGenUiSchema } from "./schema";
import { createGenUiValidator } from "./validator";

// Seeded generator of streamed ingenui messages (markdown + ui+jsx fences,
// valid and invalid), checking the package-level counterpart of the parser's
// chunk-independence property: the final rendered result — and the collected
// issues — must not depend on how the stream is split into chunks.

function makeRng(seed: number): () => number {
  let s = seed % 0x7fffffff;
  if (s <= 0) s += 0x7ffffffe;
  return () => {
    s = (s * 48271) % 0x7fffffff;
    return (s - 1) / 0x7ffffffe;
  };
}

type Rng = () => number;

function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

const WORDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta*", "`eta`", "**theta**"];

function genLine(rng: Rng): string {
  const n = 1 + Math.floor(rng() * 5);
  const words: string[] = [];
  for (let i = 0; i < n; i++) words.push(pick(rng, WORDS));
  return words.join(" ");
}

function genMarkdownBlock(rng: Rng): string {
  const r = rng();
  if (r < 0.2) return `# ${genLine(rng)}\n`;
  if (r < 0.3) return `- ${genLine(rng)}\n- ${genLine(rng)}\n`;
  if (r < 0.4) return `> ${genLine(rng)}\n`;
  if (r < 0.5) return "```js\nconst x = 1; // ```ui+jsx inside a code fence\n```\n";
  return `${genLine(rng)}\n${genLine(rng)}\n`;
}

const JSX_SNIPPETS = [
  '<div title="x">hello</div>',
  "<Card label={user.name}>inner text</Card>",
  "<button onClick={actions.submit}>Go</button>",
  "<button onClick={actions.launchRocket}>Fire</button>", // model-defined (dynamic) action
  "<Unknown />", // unknown-component issue
  "<div>{compute()}</div>", // unsupported-expression issue
  "<div><span>mismatch</b></div>", // mismatched-tag issue
  "<div>unclosed", // unclosed-tag issue
  "<ul><li>a</li><li>{count}</li></ul>",
  '<Card label="x" tone="loud" />', // invalid-prop (with a schema)
  "<Card label={count}>{user.age}</Card>", // invalid-prop + unknown-variable
  '<p><a href="javascript:alert(1)">x</a></p>', // invalid-prop (built-in rule)
  "<blink>old</blink>", // disallowed-element (with a schema)
];

function genUiBlock(rng: Rng): string {
  const body = pick(rng, JSX_SNIPPETS);
  return `\`\`\`ui+jsx\n${body}\n\`\`\`\n`;
}

function genDocument(rng: Rng): string {
  const blocks = 1 + Math.floor(rng() * 5);
  let out = "";
  for (let i = 0; i < blocks; i++) {
    out += rng() < 0.4 ? genUiBlock(rng) : genMarkdownBlock(rng);
    if (rng() < 0.7) out += "\n";
  }
  return out;
}

function randomSplits(rng: Rng, length: number): number[] {
  const sizes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    const take = 1 + Math.floor(rng() * Math.min(7, remaining));
    sizes.push(take);
    remaining -= take;
  }
  return sizes;
}

async function* chunked(input: string, sizes: number[]): AsyncGenerator<string> {
  let offset = 0;
  for (const size of sizes) {
    yield input.slice(offset, offset + size);
    offset += size;
  }
  if (offset < input.length) yield input.slice(offset);
}

const Card = ({ label, children }: { label?: string; children?: ReactNode }) =>
  createElement("section", { "data-label": label }, children);

const OPTIONS: GenUiMessageOptions = {
  components: { Card },
  variables: { user: { name: "uhyo" }, count: 42 },
  actions: { submit: true }, // dynamicActions defaults to true, covering actions.launchRocket
};

/** A chunking-independent fingerprint of an issue. */
function issueKey(issue: GenUiIssue): string {
  switch (issue.kind) {
    case "jsx-error":
      return `${issue.blockIndex}:${issue.event.kind}:${issue.event.message}`;
    default:
      return `${issue.blockIndex}:${issue.kind}`;
  }
}

async function run(input: string, sizes: number[]): Promise<{ html: string; issues: string[] }> {
  const message = createGenUiMessage(chunked(input, sizes), OPTIONS);
  await message.done;
  return {
    html: renderToStaticMarkup(createElement(Fragment, null, message.getSnapshot())),
    // Issues from different blocks may interleave differently (each block
    // drains its own channel), so compare them as a sorted multiset.
    issues: message.getIssues().map(issueKey).toSorted(),
  };
}

describe("Fuzz — chunking invariance of the final message", () => {
  it("renders identically regardless of chunk boundaries", async () => {
    for (let trial = 0; trial < 60; trial++) {
      const rng = makeRng(trial * 2654435761 + 7);
      const input = genDocument(rng);
      // oxlint-disable-next-line no-await-in-loop
      const whole = await run(input, [input.length]);

      // 1-char chunks.
      // oxlint-disable-next-line no-await-in-loop
      const single = await run(
        input,
        Array.from({ length: input.length }, () => 1),
      );
      expect(single, input).toEqual(whole);

      // Random splits.
      for (let k = 0; k < 3; k++) {
        // oxlint-disable-next-line no-await-in-loop
        const random = await run(input, randomSplits(rng, input.length));
        expect(random, input).toEqual(whole);
      }
    }
  }, 30_000);
});

// The server-side validator must report exactly the parse-time issues the
// client finds for the same text and schema (render crashes aside) — for any
// chunking on either side.

const SCHEMA = defineGenUiSchema({
  elements: ["div", "span", "p", "a", "ul", "li", "button"],
  components: { Card: { props: { label: "string" } } },
  variableTypes: { user: { name: "string" }, count: "number" },
  actions: { submit: true },
});

const BOUND = bindGenUi(SCHEMA, {
  components: { Card },
  variables: { user: { name: "uhyo" }, count: 42 },
});

async function clientIssues(input: string, sizes: number[]): Promise<string[]> {
  const message = createGenUiMessage(chunked(input, sizes), BOUND);
  await message.done;
  return message.getIssues().map(issueKey).toSorted();
}

function serverIssues(input: string, sizes: number[]): string[] {
  const validator = createGenUiValidator(SCHEMA);
  let offset = 0;
  for (const size of sizes) {
    validator.write(input.slice(offset, offset + size));
    offset += size;
  }
  validator.write(input.slice(offset));
  validator.end();
  return validator.getIssues().map(issueKey).toSorted();
}

describe("Fuzz — server/client issue parity", () => {
  it("reports the same issues on the server as on the client", async () => {
    let withIssues = 0;
    for (let trial = 0; trial < 60; trial++) {
      const rng = makeRng(trial * 40503 + 11);
      const input = genDocument(rng);
      // oxlint-disable-next-line no-await-in-loop
      const client = await clientIssues(input, randomSplits(rng, input.length));
      const server = serverIssues(input, randomSplits(rng, input.length));
      expect(server, input).toEqual(client);
      if (client.length > 0) withIssues++;
    }
    expect(withIssues).toBeGreaterThan(10);
  }, 30_000);
});

// Stopping a piped message on an issue — mid-block, wherever the chunk that
// completes the issue ends — and continuing it with another source must still
// yield one ordinary message: the server's issues are exactly what the
// client (and a fresh validator) derive from the forwarded text, for any
// chunking of that concatenated text.

describe("Fuzz — stopped and continued messages", () => {
  it("keeps parity and chunk invariance on the concatenated stream", async () => {
    let stopped = 0;
    let midBlock = 0;
    for (let trial = 0; trial < 60; trial++) {
      const rng = makeRng(trial * 69069 + 5);
      const first = genDocument(rng);
      const continuations = [genDocument(rng), genDocument(rng)];
      const continued = rng() < 0.7; // otherwise stop without a continuation
      let cutInBlock = false;
      const pipe = pipeGenUi(chunked(first, randomSplits(rng, first.length)), SCHEMA, {
        onIssue: (issue, target) => {
          if (issue.kind === "jsx-error") target.stop();
        },
        continuation: continued
          ? (snapshot) => {
              // The fence-closing text made the forwarded text diverge from the source.
              if (snapshot.stops === 1 && !first.startsWith(snapshot.text)) cutInBlock = true;
              const next = continuations[snapshot.stops - 1];
              return next === undefined ? null : chunked(next, randomSplits(rng, next.length));
            }
          : undefined,
      });
      // oxlint-disable-next-line no-await-in-loop
      const text = await new Response(pipe.stream).text();
      // oxlint-disable-next-line no-await-in-loop
      const result = await pipe.done;
      expect(result.text).toBe(text);
      if (result.stops > 0) stopped++;
      if (cutInBlock) midBlock++;

      const piped = result.issues.map(issueKey).toSorted();
      expect(serverIssues(text, [text.length]), text).toEqual(piped);
      expect(serverIssues(text, randomSplits(rng, text.length)), text).toEqual(piped);
      // oxlint-disable-next-line no-await-in-loop
      expect(await clientIssues(text, randomSplits(rng, text.length)), text).toEqual(piped);

      // The clean boundary is chunking-invariant too, and precedes every broken block.
      const validator = createGenUiValidator(SCHEMA);
      validator.write(text);
      validator.end();
      expect(validator.getCleanOffset(), text).toBe(result.cleanOffset);
      if (result.issues.length > 0) {
        expect(serverIssues(result.cleanText, [result.cleanText.length]), text).toEqual([]);
      }
    }
    expect(stopped).toBeGreaterThan(20);
    expect(midBlock).toBeGreaterThan(10);
  }, 30_000);
});
