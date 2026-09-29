/**
 * Sample sources to stream, for both demo modes.
 *
 * - `jsxSamples` are raw JSX strings within the parser's supported subset —
 *   fed straight to `useIncrementalJsx`.
 * - `markdownSamples` are ingenui messages: Markdown where ```ui+jsx code
 *   fences render as live UI, `actions.*` references wire interactivity
 *   (model-defined names allowed by default), and problems come back as a
 *   feedback report for the model — or, streamed through the demo server,
 *   stop the model mid-message and get corrected in the same message.
 */
import type { Recovery } from "./api";

export interface Sample {
  id: string;
  label: string;
  source: string;
  /**
   * (ingenui samples) What the simulated model writes when the server stops
   * it on an issue and asks it to continue.
   */
  correction?: string;
  /** (ingenui samples) The server's recovery mode to pick with this sample. */
  recovery?: Recovery;
}

export const jsxSamples: Sample[] = [
  {
    id: "product",
    label: "Product card",
    source: `<Card>
  <CardHeader>
    <Title>Aurora Headphones</Title>
    <Badge tone="success">In stock</Badge>
  </CardHeader>
  <CardBody>
    <Text>
      Wireless over-ear headphones with adaptive noise cancellation and a
      30-hour battery.
    </Text>
    <Row>
      <Stat label="Price" value={"$249"} />
      <Stat label="Rating" value={4.8} />
      <Stat label="Reviews" value={1284} />
    </Row>
    <Button variant="primary">Add to cart</Button>
  </CardBody>
</Card>`,
  },
  {
    id: "profile",
    label: "Profile + fragment",
    source: `<Card>
  <Row>
    <Avatar initials="UH" name="uhyo" />
    <CardBody>
      <Title>uhyo</Title>
      <Text>Maintainer of @ingenui/incremental-jsx-parser.</Text>
      <>
        <Badge tone="info">TypeScript</Badge>
        <Badge tone="neutral">React</Badge>
        <Badge tone="success">OSS</Badge>
      </>
    </CardBody>
  </Row>
  <Button variant="ghost">Follow</Button>
</Card>`,
  },
  {
    id: "dashboard",
    label: "Dashboard",
    source: `<Card>
  <Title>This week</Title>
  <Row>
    <Stat label="Visitors" value={9320} />
    <Stat label="Signups" value={418} />
    <Stat label="Churn" value={"1.2%"} />
  </Row>
  <Callout tone="info">
    Traffic is up <Badge tone="success">+12%</Badge> versus last week.
  </Callout>
  <List>
    <Item>Shipped streaming parser</Item>
    <Item>Added the live demo</Item>
    <Item>Wrote the docs</Item>
  </List>
</Card>`,
  },
  {
    id: "malformed",
    label: "Malformed (lenient)",
    source: `<Card>
  <Title>Resilient by design</Title>
  <Text>
    This snippet is missing close tags and uses an unsupported expression
    {someVariable + 1} — the parser recovers instead of throwing.
  <Badge tone="warning">auto-closed`,
  },
];

export const markdownSamples: Sample[] = [
  {
    id: "assistant-reply",
    label: "Assistant reply (Markdown + UI)",
    source: `# Found it!

The **Aurora** line is on sale today — here's the best match for what you
described:

\`\`\`ui+jsx
<Card>
  <CardHeader>
    <Title>Aurora Headphones</Title>
    <Badge tone="success">In stock</Badge>
  </CardHeader>
  <CardBody>
    <Text>Adaptive noise cancellation, 30-hour battery, wireless charging.</Text>
    <Row>
      <Stat label="Price" value={"$249"} />
      <Stat label="Rating" value={4.8} />
    </Row>
    <Button variant="primary" onClick={actions.addToCart}>Add to cart</Button>
  </CardBody>
</Card>
\`\`\`

Click *Add to cart* and I'll take it from there — or ask me for
alternatives. A few things reviewers loved:

- The battery genuinely lasts the week
- Multipoint pairing that just works
`,
  },
  {
    id: "plan-picker",
    label: "Plan picker (model-defined actions)",
    source: `## Pick a plan

Both plans include unlimited projects. The action names below are
**invented by the model** — ingenui's dynamic actions resolve them without
any host-side declaration:

\`\`\`ui+jsx
<Row>
  <Card>
    <Title>Basic</Title>
    <Stat label="Monthly" value={"$9"} />
    <Button variant="ghost" onClick={actions.choosePlanBasic}>Choose Basic</Button>
  </Card>
  <Card>
    <Title>Pro</Title>
    <Stat label="Monthly" value={"$29"} />
    <Badge tone="info">Popular</Badge>
    <Button variant="primary" onClick={actions.choosePlanPro}>Choose Pro</Button>
  </Card>
</Row>
\`\`\`

> Firing an action sends the canonical message back to the model — watch the
> "Next request to the AI" log below.
`,
  },
  {
    id: "code-vs-ui",
    label: "Code fence vs UI fence",
    source: `Only a fence whose info string is exactly \`ui+jsx\` renders as UI.
A regular code fence stays code:

\`\`\`ts
const parser = createGenUiMessage(stream, { components });
\`\`\`

…while this one becomes a live component tree:

\`\`\`ui+jsx
<Callout tone="info">
  Rendered by <Badge tone="success">ingenui</Badge> via @ingenui/incremental-jsx-parser.
</Callout>
\`\`\`
`,
  },
  {
    id: "feedback-loop",
    label: "Malformed (feedback loop)",
    source: `Let me show that chart:

\`\`\`ui+jsx
<Chart data={metrics.weekly} />
<Card>
  <Title>Still renders!</Title>
  <Text>The unknown component above degrades gracefully.</Text>
\`\`\`

The block above references an unknown component and never closes its last
tag — the UI stays up, and the issues become the feedback report shown
below, ready to send back to the model.
`,
    recovery: "log",
  },
  {
    id: "stop-and-recover",
    label: "Malformed (stopped & recovered)",
    source: `Here's how this week went:

\`\`\`ui+jsx
<Card>
  <Title>This week</Title>
  <Chart data={metrics.weekly} />
  <Row>
    <Stat label="Visitors" value={9320} />
    <Stat label="Signups" value={418} />
  </Row>
</Card>
\`\`\`

Traffic is up **12%** on last week — signups are keeping pace.
`,
    recovery: "continue",
    // The server stops the model inside the <Chart> line (its first issue:
    // the unknown `metrics` variable), closes the fence, and asks it to
    // continue; the simulated model then writes this corrected block and
    // carries on after the broken one.
    correction: `
Sorry — I can't draw charts here. The same numbers as stats:

\`\`\`ui+jsx
<Card>
  <Title>This week</Title>
  <Row>
    <Stat label="Visitors" value={9320} />
    <Stat label="Signups" value={418} />
  </Row>
</Card>
\`\`\`
`,
  },
];
