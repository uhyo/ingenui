import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIncrementalJsx } from "@ingenui/incremental-jsx-parser/react";
import type { GenUiIssue, UiBlockWrapperProps } from "ingenui";
import { useGenUiMessage } from "ingenui/react";

import type { Recovery } from "./api";
import { fetchNextTurn, fetchSystemPrompt, streamGeneration } from "./api";
import { componentNames, demoComponents, genUi, Shimmer } from "./components";
import { jsxSamples, markdownSamples, type Sample } from "./samples";
import { createCharStream } from "./streaming";

type Mode = "genui" | "jsx";

interface ModeInfo {
  id: Mode;
  label: string;
  samples: Sample[];
}

const MODES: ModeInfo[] = [
  { id: "genui", label: "ingenui · Markdown + ui+jsx", samples: markdownSamples },
  { id: "jsx", label: "parser · raw JSX", samples: jsxSamples },
];

interface RunParams {
  key: number;
  mode: Mode;
  text: string;
  intervalMs: number;
  chunkSize: number;
  recovery: Recovery;
  correction: string | undefined;
}

const RECOVERIES: { id: Recovery; label: string }[] = [
  { id: "continue", label: "Stop & continue" },
  { id: "stop", label: "Stop" },
  { id: "log", label: "Log only" },
];

const SPEEDS = [
  { label: "Slow", intervalMs: 90, chunkSize: 1 },
  { label: "Normal", intervalMs: 45, chunkSize: 2 },
  { label: "Fast", intervalMs: 16, chunkSize: 4 },
];

export function App() {
  const [mode, setMode] = useState<Mode>("genui");
  const [text, setText] = useState(markdownSamples[0]!.source);
  const [speedIndex, setSpeedIndex] = useState(1);
  const [recovery, setRecovery] = useState<Recovery>("continue");
  const [correction, setCorrection] = useState<string | undefined>(undefined);
  const [run, setRun] = useState<RunParams | null>(null);

  const modeInfo = MODES.find((m) => m.id === mode)!;

  const switchMode = (next: ModeInfo) => {
    if (next.id === mode) return;
    setMode(next.id);
    loadSample(next.samples[0]!);
  };

  const loadSample = (sample: Sample) => {
    setText(sample.source);
    setCorrection(sample.correction);
    if (sample.recovery) setRecovery(sample.recovery);
  };

  const startStream = () => {
    const speed = SPEEDS[speedIndex]!;
    setRun({
      key: Date.now(),
      mode,
      text,
      intervalMs: speed.intervalMs,
      chunkSize: speed.chunkSize,
      recovery,
      correction,
    });
  };

  return (
    <div className="page">
      <header className="masthead">
        <h1 className="masthead__title">
          <img
            className="masthead__logo"
            src="/ingenui-lockup-dark.svg"
            alt="ingenui"
            width={640}
            height={168}
          />
          <span className="masthead__tag">
            <span className="masthead__dot">●</span> live demo
          </span>
        </h1>
        <p>
          A streamed message becomes a <strong>live React tree</strong>. In ingenui mode the stream
          is Markdown where <code>```ui+jsx</code> code fences render as interactive UI (with{" "}
          <code>actions.*</code> wiring events back to the conversation); in parser mode it is raw
          JSX. Either way, what has not arrived yet is a single <code>&lt;Pending /&gt;</code>{" "}
          shimmer at the streaming frontier, and components can ask{" "}
          <code>useIsElementComplete()</code> whether their own children are still arriving — cards
          glow while open, badges and buttons hide the shimmer (and buttons stay disabled) until
          their label is final.
        </p>
      </header>

      <section className="panel">
        <div className="mode" role="tablist" aria-label="Demo mode">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={m.id === mode}
              className={`mode__tab ${m.id === mode ? "mode__tab--active" : ""}`}
              onClick={() => switchMode(m)}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="panel__toolbar">
          <label className="field">
            <span>Sample</span>
            <select
              value=""
              onChange={(e) => {
                const sample = modeInfo.samples.find((s) => s.id === e.target.value);
                if (sample) loadSample(sample);
              }}
            >
              <option value="" disabled>
                Load a sample…
              </option>
              {modeInfo.samples.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Speed</span>
            <select value={speedIndex} onChange={(e) => setSpeedIndex(Number(e.target.value))}>
              {SPEEDS.map((s, i) => (
                <option key={s.label} value={i}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>

          {mode === "genui" && (
            <label className="field">
              <span>On issue</span>
              <select value={recovery} onChange={(e) => setRecovery(e.target.value as Recovery)}>
                {RECOVERIES.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          <button className="run" type="button" onClick={startStream}>
            {run ? "↻ Replay stream" : "▶ Stream it"}
          </button>
        </div>

        <textarea
          className="editor"
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Source to stream"
        />
        <p className="hint">
          Allowed components (the parser doubles as a security allowlist):{" "}
          {componentNames.map((n) => (
            <code key={n}>{n}</code>
          ))}
          {mode === "genui" && (
            <>
              {" "}
              — and <code>actions.*</code> names are model-defined (dynamic actions, the default).
              The catalog is a data-only schema shared with the server, which streams the message
              back through <code>pipeGenUi</code>, validating it on the way. On a JSX issue, the
              server can stop the model before the broken chunk even reaches you — and continue the
              same message with a correction.
            </>
          )}
        </p>
        {mode === "genui" && <SystemPrompt />}
      </section>

      {run ? (
        run.mode === "genui" ? (
          <GenUiStreamView key={run.key} params={run} />
        ) : (
          <JsxStreamView key={run.key} params={run} />
        )
      ) : (
        <section className="empty">Press “Stream it” to start.</section>
      )}
    </div>
  );
}

/** The received-stream pane + progress bar shared by both modes. */
function StreamPanes({
  params,
  streamed,
  done,
  paneTitle,
  children,
}: {
  params: RunParams;
  streamed: string;
  /** Whether the whole stream has arrived. */
  done: boolean;
  paneTitle: string;
  children: ReactNode;
}) {
  // An estimate: a stopped or continued message differs from the input.
  const progress = done ? 1 : Math.min(1, streamed.length / Math.max(1, params.text.length));
  return (
    <>
      <div className="stage__panes">
        <div className="pane">
          <div className="pane__head">
            <span>Received stream</span>
            <span className={`status ${done ? "status--done" : "status--live"}`}>
              {done ? "complete" : "streaming…"}
            </span>
          </div>
          <pre className="stream-text">
            {streamed}
            {!done && <span className="caret" />}
          </pre>
        </div>

        <div className="pane">
          <div className="pane__head">
            <span>{paneTitle}</span>
            {!done && <span className="status status--live">+ &lt;Pending /&gt;</span>}
          </div>
          <div className="render-surface">{children}</div>
        </div>
      </div>

      <div className="progress">
        <div className="progress__bar" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
    </>
  );
}

function JsxStreamView({ params }: { params: RunParams }) {
  const [streamed, setStreamed] = useState("");
  const [errors, setErrors] = useState<{ id: number; message: string }[]>([]);

  // Remounted on every run (parent `key`), so the stream is created exactly once
  // per run — each parser gets its own fresh, single-use source.
  const stream = useMemo(
    () =>
      createCharStream(params.text, {
        intervalMs: params.intervalMs,
        chunkSize: params.chunkSize,
        onProgress: setStreamed,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const node = useIncrementalJsx(stream, {
    components: demoComponents,
    Pending: Shimmer,
    onUnknownComponent: "pending",
    onJsxError: (event) =>
      setErrors((prev) => [...prev, { id: prev.length, message: event.message }]),
  });

  return (
    <section className="stage">
      <StreamPanes
        params={params}
        streamed={streamed}
        done={streamed === params.text}
        paneTitle="Live React tree"
      >
        {node}
      </StreamPanes>

      {errors.length > 0 && (
        <div className="errors">
          <strong>onJsxError ({errors.length}):</strong>
          <ul>
            {errors.map((err) => (
              <li key={err.id}>{err.message}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function issueLabel(issue: GenUiIssue): string {
  const block = `block ${issue.blockIndex + 1}`;
  switch (issue.kind) {
    case "jsx-error":
      return `${block}: ${issue.event.message}`;
    case "render-error":
      return `${block}: rendering crashed (${
        issue.error instanceof Error ? issue.error.message : String(issue.error)
      })`;
    case "unclosed-fence":
      return `${block}: the ui+jsx fence was never closed`;
  }
}

/**
 * The demo's `wrapUiBlock`: a block with issues (or cut off before its
 * closing fence) stays on screen, greyed out and labelled — above the
 * corrected block the model writes after a stop. `children` keeps its
 * position whatever the status, so a block that turns broken mid-stream
 * is not remounted. A crash is final, so a crashed block is simply replaced.
 */
function UiBlockFrame({ blockIndex, state, issues, crashed, children }: UiBlockWrapperProps) {
  if (crashed) {
    return (
      <div className="ui-callout ui-callout--info">UI block {blockIndex + 1} hidden (crashed)</div>
    );
  }
  const problems: string[] = [];
  if (issues.length > 0) problems.push(`had ${issues.length} issue(s)`);
  if (state === "unterminated") problems.push("was cut off");
  const broken = problems.length > 0;
  return (
    <div className={`ui-block${broken ? " ui-block--broken" : ""}`}>
      {broken && (
        <div className="ui-block__label">
          ⚠ UI block {blockIndex + 1} {problems.join(" and ")}. Kept for reference.
        </div>
      )}
      <div className="ui-block__body">{children}</div>
    </div>
  );
}

/** The system prompt, as the server builds it from the shared schema. */
function SystemPrompt() {
  const [prompt, setPrompt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <details
      className="prompt"
      onToggle={(e) => {
        if (!e.currentTarget.open || prompt !== null) return;
        fetchSystemPrompt().then(setPrompt, (err: unknown) => setError(String(err)));
      }}
    >
      <summary>System prompt (built on the server from the shared schema)</summary>
      <pre>{error ?? prompt ?? "Loading…"}</pre>
    </details>
  );
}

function GenUiStreamView({ params }: { params: RunParams }) {
  const [streamed, setStreamed] = useState("");
  const [received, setReceived] = useState(false);
  const [issues, setIssues] = useState<{ id: number; message: string }[]>([]);
  const [actionLog, setActionLog] = useState<{ id: number; message: string }[]>([]);
  const [report, setReport] = useState<string | null>(null);
  const streamedRef = useRef("");
  const renderErrorsRef = useRef<{ blockIndex: number; message: string }[]>([]);

  // Remounted per run (parent `key`): one single-use stream per message,
  // streamed by the server (a simulated model, validated with pipeGenUi).
  const stream = useMemo(
    () =>
      streamGeneration(
        {
          text: params.text,
          intervalMs: params.intervalMs,
          chunkSize: params.chunkSize,
          recovery: params.recovery,
          correction: params.correction,
        },
        (text, done) => {
          streamedRef.current = text;
          setStreamed(text);
          setReceived(done);
        },
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const log = (message: string) => setActionLog((prev) => [...prev, { id: prev.length, message }]);

  const { node, message } = useGenUiMessage(stream, {
    // The schema-derived options: components bound to the shared schema.
    ...genUi,
    Pending: Shimmer,
    onUnknownComponent: "pending",
    // The client reports only the action's *name*; the server resolves it
    // against the schema and writes the next request itself.
    onAction: (event) => {
      fetchNextTurn({
        message: streamedRef.current,
        action: event.name,
        renderErrors: renderErrorsRef.current,
      }).then(
        (text) => log(text ?? ""),
        (err: unknown) => log(`(rejected by the server: ${String(err)})`),
      );
    },
    onIssue: (issue) => {
      if (issue.kind === "render-error") {
        renderErrorsRef.current.push({
          blockIndex: issue.blockIndex,
          message: issue.error instanceof Error ? issue.error.message : String(issue.error),
        });
      }
      setIssues((prev) => [...prev, { id: prev.length, message: issueLabel(issue) }]);
    },
    // Grey out and label a broken block (e.g. above its correction), and
    // replace a crashed one.
    wrapUiBlock: (props) => <UiBlockFrame {...props} />,
  });

  // When the message completes, ask the server for the feedback it would
  // send to the model: its own validation, plus the client's render crashes.
  useEffect(() => {
    let alive = true;
    message.done
      .then(() =>
        fetchNextTurn({ message: streamedRef.current, renderErrors: renderErrorsRef.current }),
      )
      .then(
        (text) => {
          if (alive) setReport(text);
        },
        () => {},
      );
    return () => {
      alive = false;
    };
  }, [message]);

  return (
    <section className="stage">
      <StreamPanes params={params} streamed={streamed} done={received} paneTitle="Live message">
        {node}
      </StreamPanes>

      {actionLog.length > 0 && (
        <div className="action-log">
          <strong>Next request to the AI (onAction → built by the server):</strong>
          <ul>
            {actionLog.map((entry) => (
              <li key={entry.id}>{entry.message}</li>
            ))}
          </ul>
        </div>
      )}

      {issues.length > 0 && (
        <div className="errors">
          <strong>Issues found by the client ({issues.length}):</strong>
          <ul>
            {issues.map((issue) => (
              <li key={issue.id}>{issue.message}</li>
            ))}
          </ul>
        </div>
      )}

      {report !== null && (
        <div className="report">
          <strong>Feedback report for the model (built by the server):</strong>
          <pre>{report}</pre>
        </div>
      )}
    </section>
  );
}
