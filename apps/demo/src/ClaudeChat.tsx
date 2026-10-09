/**
 * Chat with Claude: the whole ingenui loop end to end, with a real model.
 *
 * Each user turn is composed by the server (`/api/next`: what the user typed
 * or the fired action's message, plus the feedback report on the previous
 * reply), and each reply is Claude's, streamed through the server's
 * `pipeGenUi` (`/api/chat`) into `useGenUiMessage`. Clicking a UI button
 * wired to `actions.*` sends the next turn by itself.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useGenUiMessage } from "ingenui/react";

import type { ChatMessage, Recovery } from "./api";
import { fetchClaudeConfig, fetchNextTurn, streamChat } from "./api";
import { genUi, Shimmer } from "./components";
import { issueLabel, UiBlockFrame } from "./ui-block-frame";

const STARTERS = [
  "I need trail running shoes under $150. Show me a few options.",
  "Compare three espresso machines for a small kitchen.",
  "Help me pick a laptop for travel and light photo editing.",
];

type RenderError = { blockIndex: number; message: string };

type Turn =
  | {
      id: number;
      role: "user";
      /** What the user did, for display. */
      label: string;
      /** What the model receives, as composed by the server. */
      content: string;
    }
  | {
      id: number;
      role: "assistant";
      /** The conversation this reply answers. */
      history: ChatMessage[];
      recovery: Recovery;
    };

/** What a reply leaves behind for the next turn. */
interface Reply {
  text: string;
  /** Render crashes: only the client sees them. Grows if a block crashes later. */
  renderErrors: RenderError[];
}

export function ClaudeChat({ recovery }: { recovery: Recovery }) {
  const [config, setConfig] = useState<{ available: boolean; model: string } | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const replies = useRef(new Map<number, Reply>());
  const nextId = useRef(0);
  // Read at call time: a reply's `onAction` is fixed when its message is
  // created, and two clicks can land before a re-render.
  const busyRef = useRef(false);
  const sendRef = useRef<(request: { text: string } | { action: string }) => Promise<void>>(
    async () => {},
  );

  useEffect(() => {
    fetchClaudeConfig().then(setConfig, (err: unknown) => setError(String(err)));
  }, []);

  /** The conversation so far, as the model sees it. */
  const conversation = (): ChatMessage[] => {
    const messages: ChatMessage[] = [];
    for (const turn of turns) {
      const content = turn.role === "user" ? turn.content : replies.current.get(turn.id)?.text;
      if (content?.trim()) messages.push({ role: turn.role, content });
    }
    return messages;
  };

  const setBusyBoth = (value: boolean) => {
    busyRef.current = value;
    setBusy(value);
  };

  const send = async (request: { text: string } | { action: string }) => {
    if (busyRef.current) return;
    setBusyBoth(true);
    setError(null);
    const last = turns.findLast((turn) => turn.role === "assistant");
    const reply = last ? replies.current.get(last.id) : undefined;
    try {
      // The server writes the turn: the input, plus feedback on the last reply.
      const content = await fetchNextTurn({
        message: reply?.text ?? "",
        ...request,
        renderErrors: reply?.renderErrors ?? [],
      });
      if (content === null) {
        setBusyBoth(false);
        return;
      }
      const label = "text" in request ? request.text : `Clicked actions.${request.action}`;
      const user: Turn = { id: nextId.current++, role: "user", label, content };
      const history = [...conversation(), { role: "user" as const, content }];
      setTurns((prev) => [
        ...prev,
        user,
        { id: nextId.current++, role: "assistant", history, recovery },
      ]);
      if ("text" in request) setInput("");
    } catch (err) {
      setError(String(err));
      setBusyBoth(false);
    }
  };
  sendRef.current = send;

  const settle = (id: number, reply: Reply) => {
    replies.current.set(id, reply);
    setBusyBoth(false);
  };

  if (config === null) {
    return <section className="chat chat--empty">{error ?? "Connecting…"}</section>;
  }
  if (!config.available) {
    return (
      <section className="chat chat--empty">
        <p>
          Claude isn't configured on this server. Set <code>ANTHROPIC_API_KEY</code> — in{" "}
          <code>apps/demo/.env.local</code> for <code>vite dev</code> / <code>wrangler dev</code>,
          or with <code>wrangler secret put ANTHROPIC_API_KEY</code> for the deployed Worker — and
          reload.
        </p>
      </section>
    );
  }

  const canSend = !busy && input.trim() !== "";
  return (
    <section className="chat">
      <div className="chat__head">
        <span>Conversation</span>
        <span className="status status--done">{config.model}</span>
      </div>

      <div className="chat__turns">
        {turns.length === 0 && (
          <div className="chat__starters">
            <span>Try:</span>
            {STARTERS.map((starter) => (
              <button
                key={starter}
                type="button"
                className="chip"
                disabled={busy}
                onClick={() => void send({ text: starter })}
              >
                {starter}
              </button>
            ))}
          </div>
        )}
        {turns.map((turn) =>
          turn.role === "user" ? (
            <UserTurnView key={turn.id} label={turn.label} content={turn.content} />
          ) : (
            <AssistantReply
              key={turn.id}
              history={turn.history}
              recovery={turn.recovery}
              onAction={(name) => void sendRef.current({ action: name })}
              onSettled={(reply) => settle(turn.id, reply)}
            />
          ),
        )}
      </div>

      {error !== null && <div className="errors">{error}</div>}

      <form
        className="chat__composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) void send({ text: input.trim() });
        }}
      >
        <textarea
          className="chat__input"
          value={input}
          placeholder={busy ? "Claude is replying…" : "Ask the shopping assistant…"}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          rows={2}
          aria-label="Message to Claude"
        />
        <button className="run" type="submit" disabled={!canSend}>
          Send
        </button>
      </form>
    </section>
  );
}

function UserTurnView({ label, content }: { label: string; content: string }) {
  return (
    <div className="turn turn--user">
      <div className="turn__bubble">{label}</div>
      {content !== label && (
        <details className="turn__sent">
          <summary>Sent to Claude (composed by the server)</summary>
          <pre>{content}</pre>
        </details>
      )}
    </div>
  );
}

function AssistantReply({
  history,
  recovery,
  onAction,
  onSettled,
}: {
  history: ChatMessage[];
  recovery: Recovery;
  onAction: (name: string) => void;
  onSettled: (reply: Reply) => void;
}) {
  const [streamed, setStreamed] = useState("");
  const [received, setReceived] = useState(false);
  const [issues, setIssues] = useState<{ id: number; message: string }[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const streamedRef = useRef("");
  const renderErrors = useRef<RenderError[]>([]);

  // Keyed by turn: one request per reply, made once.
  const stream = useMemo(
    () =>
      streamChat({ messages: history, recovery }, (text, done) => {
        streamedRef.current = text;
        setStreamed(text);
        setReceived(done);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const { node, message } = useGenUiMessage(stream, {
    ...genUi,
    Pending: Shimmer,
    onUnknownComponent: "pending",
    onAction: (event) => onAction(event.name),
    onIssue: (issue) => {
      if (issue.kind === "render-error") {
        renderErrors.current.push({
          blockIndex: issue.blockIndex,
          message: issue.error instanceof Error ? issue.error.message : String(issue.error),
        });
      }
      setIssues((prev) => [...prev, { id: prev.length, message: issueLabel(issue) }]);
    },
    onStreamError: (error) => setFailure(error instanceof Error ? error.message : String(error)),
    wrapUiBlock: (props) => <UiBlockFrame {...props} />,
  });

  useEffect(() => {
    const settle = () =>
      onSettled({ text: streamedRef.current, renderErrors: renderErrors.current });
    message.done.then(settle, settle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message]);

  const waiting = streamed === "" && !received && failure === null;
  return (
    <div className="turn turn--assistant">
      <div className="pane__head">
        <span>Claude</span>
        {failure === null && (
          <span className={`status ${received ? "status--done" : "status--live"}`}>
            {received ? "complete" : waiting ? "thinking…" : "streaming…"}
          </span>
        )}
      </div>
      <div className="render-surface">{node}</div>
      {failure !== null && <div className="errors">{failure}</div>}
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
      {streamed !== "" && (
        <details className="turn__sent">
          <summary>Received stream ({streamed.length} chars)</summary>
          <pre>{streamed}</pre>
        </details>
      )}
    </div>
  );
}
