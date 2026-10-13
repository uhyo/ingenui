import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIncrementalJsx } from "@ingenui/incremental-jsx-parser/react";
import { useGenUiMessage } from "ingenui/react";

import type { Recovery } from "./api";
import { fetchNextTurn, fetchSystemPrompt, streamGeneration } from "./api";
import { ClaudeChat } from "./ClaudeChat";
import { componentNames, demoComponents, genUi, Shimmer } from "./components";
import { jsxSamples, markdownSamples, type Sample } from "./samples";
import { createCharStream } from "./streaming";
import { issueLabel, UiBlockFrame } from "./ui-block-frame";

type Mode = "claude" | "genui" | "jsx";

interface ModeInfo {
  id: Mode;
  label: string;
  /** The tab's permalink. */
  path: string;
  samples: Sample[];
}

const MODES: ModeInfo[] = [
  {
    id: "genui",
    label: "ingenui · Markdown + ui+jsx",
    path: "/markdown",
    samples: markdownSamples,
  },
  { id: "claude", label: "ingenui · chat with Claude", path: "/chat", samples: [] },
  { id: "jsx", label: "parser · raw JSX", path: "/parser", samples: jsxSamples },
];

/** The mode a URL path links to; `/` (or any unknown path) is the default mode. */
function modeFromPath(pathname: string): ModeInfo {
  const path = pathname.replace(/\/+$/, "");
  return MODES.find((m) => m.path === path) ?? MODES[0]!;
}

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
  const [initialMode] = useState(() => modeFromPath(window.location.pathname));
  const initialSample = initialMode.samples[0] ?? markdownSamples[0]!;
  const [mode, setMode] = useState<Mode>(initialMode.id);
  const [text, setText] = useState(initialSample.source);
  const [speedIndex, setSpeedIndex] = useState(1);
  const [recovery, setRecovery] = useState<Recovery>(initialSample.recovery ?? "continue");
  const [correction, setCorrection] = useState<string | undefined>(initialSample.correction);
  const [run, setRun] = useState<RunParams | null>(null);
  const [chatKey, setChatKey] = useState(0);

  const modeInfo = MODES.find((m) => m.id === mode)!;

  const switchMode = (next: ModeInfo) => {
    if (next.id === mode) return;
    setMode(next.id);
    if (next.samples[0]) loadSample(next.samples[0]);
  };

  // Browser back / forward between the tabs' permalinks.
  useEffect(() => {
    const onPopState = () => switchMode(modeFromPath(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  });

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
          JSX. The chat mode puts a real model behind it: Claude writes the message, and clicking
          its UI sends the next turn. Either way, what has not arrived yet is a single{" "}
          <code>&lt;Pending /&gt;</code> shimmer at the streaming frontier, and components can ask{" "}
          <code>useIsElementComplete()</code> whether their own children are still arriving — cards
          glow while open, badges and buttons hide the shimmer (and buttons stay disabled) until
          their label is final.
        </p>
      </header>

      <section className="panel">
        <div className="mode" role="tablist" aria-label="Demo mode">
          {MODES.map((m) => (
            <a
              key={m.id}
              href={m.path}
              role="tab"
              aria-selected={m.id === mode}
              className={`mode__tab ${m.id === mode ? "mode__tab--active" : ""}`}
              onClick={(e) => {
                // Modified clicks (new tab / window) follow the link itself.
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                if (window.location.pathname !== m.path) window.history.pushState(null, "", m.path);
                switchMode(m);
              }}
            >
              {m.label}
            </a>
          ))}
        </div>

        <div className="panel__toolbar">
          {mode === "claude" && (
            <p className="lede">
              Chat with <strong>Claude</strong>, a real AI model, playing a shopping assistant. Its
              replies come as interactive UI that renders live while they stream in, and clicking a
              button in a reply carries the conversation on.
            </p>
          )}
          {mode !== "claude" && (
            <>
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
            </>
          )}

          {mode === "genui" && <RecoverySelect value={recovery} onChange={setRecovery} />}

          {mode === "claude" ? (
            <button className="run" type="button" onClick={() => setChatKey((k) => k + 1)}>
              New chat
            </button>
          ) : (
            <button className="run" type="button" onClick={startStream}>
              {run ? "↻ Replay stream" : "▶ Stream it"}
            </button>
          )}
        </div>

        {mode !== "claude" && (
          <>
            <textarea
              className="editor"
              spellCheck={false}
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label="Source to stream"
            />
            <p className="hint">
              <AllowedComponents />
              {mode === "genui" && (
                <>
                  {" "}
                  — and <code>actions.*</code> names are model-defined (dynamic actions, the
                  default). The catalog is a data-only schema shared with the server, which streams
                  the message back through <code>pipeGenUi</code>, validating it on the way. On a
                  JSX issue, the server can stop the model before the broken chunk even reaches you
                  — and continue the same message with a correction.
                </>
              )}
            </p>
            {mode === "genui" && <SystemPrompt />}
          </>
        )}
      </section>

      {mode === "claude" ? (
        <>
          <ClaudeChat key={chatKey} recovery={recovery} />
          <ChatInternals recovery={recovery} onRecoveryChange={setRecovery} />
        </>
      ) : run && run.mode === mode ? (
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

function RecoverySelect({
  value,
  onChange,
}: {
  value: Recovery;
  onChange: (value: Recovery) => void;
}) {
  return (
    <label className="field">
      <span>On issue</span>
      <select value={value} onChange={(e) => onChange(e.target.value as Recovery)}>
        {RECOVERIES.map((r) => (
          <option key={r.id} value={r.id}>
            {r.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function AllowedComponents() {
  return (
    <>
      Allowed components (the parser doubles as a security allowlist):{" "}
      {componentNames.map((n) => (
        <code key={n}>{n}</code>
      ))}
    </>
  );
}

/**
 * The chat's technical notes, collapsed below the chat so visitors try it
 * first: how a reply travels, the components, the recovery setting, the
 * system prompt.
 */
function ChatInternals({
  recovery,
  onRecoveryChange,
}: {
  recovery: Recovery;
  onRecoveryChange: (value: Recovery) => void;
}) {
  return (
    <details className="internals">
      <summary>How it works</summary>
      <p>
        Claude gets a system prompt built on the server from the same schema the client renders
        with, and its reply is streamed back through <code>pipeGenUi</code>, validated on the way.
        On a JSX issue, the server can abort the request and ask Claude to continue the same message
        with a corrected block. Clicking a button wired to <code>actions.*</code> sends the next
        turn, with feedback on the previous reply attached by the server.
      </p>
      <p className="hint">
        <AllowedComponents />
      </p>
      <div className="panel__toolbar">
        <RecoverySelect value={recovery} onChange={onRecoveryChange} />
      </div>
      <SystemPrompt />
    </details>
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
