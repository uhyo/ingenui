/**
 * Client for the demo's server side (`worker/index.ts`).
 */

/**
 * What the server does on a JSX issue: stop the (simulated) model and
 * continue the same message with a correction, stop it, or only log.
 */
export type Recovery = "continue" | "stop" | "log";

export interface GenerateParams {
  text: string;
  intervalMs: number;
  chunkSize: number;
  recovery: Recovery;
  /** What the simulated model writes when asked to continue after a stop. */
  correction?: string | undefined;
}

/** Receives the text received so far, and whether it is all. */
export type ProgressListener = (receivedSoFar: string, done: boolean) => void;

/**
 * The server's message stream for `params` (`POST /api/generate`, a
 * simulated model), as a byte stream for `useGenUiMessage`.
 */
export function streamGeneration(
  params: GenerateParams,
  onProgress: ProgressListener,
): ReadableStream<Uint8Array> {
  return streamMessage("/api/generate", params, onProgress);
}

/** One turn of a conversation with Claude, as the model sees it. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Claude's reply to `messages` (`POST /api/chat`), streamed through the
 * server's `pipeGenUi`, as a byte stream for `useGenUiMessage`.
 */
export function streamChat(
  params: { messages: ChatMessage[]; recovery: Recovery },
  onProgress: ProgressListener,
): ReadableStream<Uint8Array> {
  return streamMessage("/api/chat", params, onProgress);
}

/**
 * A message streamed by the server, as a byte stream. Created synchronously
 * — the request is made when the stream starts — and cancelling it aborts
 * the request.
 */
function streamMessage(
  url: string,
  params: unknown,
  onProgress: ProgressListener,
): ReadableStream<Uint8Array> {
  const abort = new AbortController();
  const decoder = new TextDecoder();
  let received = "";
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  return new ReadableStream<Uint8Array>({
    async start() {
      onProgress("", false);
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: abort.signal,
      });
      if (!response.ok || !response.body) throw new Error(await errorOf(response));
      reader = response.body.getReader();
    },
    async pull(controller) {
      const { done, value } = await reader!.read();
      if (done) {
        onProgress(received, true);
        controller.close();
        return;
      }
      received += decoder.decode(value, { stream: true });
      onProgress(received, false);
      controller.enqueue(value);
    },
    cancel() {
      abort.abort();
    },
  });
}

/** The server's error message for a failed response. */
async function errorOf(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const { error } = JSON.parse(text) as { error?: unknown };
    if (typeof error === "string") return error;
  } catch {
    // Not JSON: use the text itself.
  }
  return `${response.url} failed: ${response.status} ${text}`;
}

/** Whether the server can talk to Claude (`GET /api/config`). */
export async function fetchClaudeConfig(): Promise<{ available: boolean; model: string }> {
  const response = await fetch("/api/config");
  if (!response.ok) throw new Error(await errorOf(response));
  const body = (await response.json()) as { claude: { available: boolean; model: string } };
  return body.claude;
}

/** The system prompt the server builds from the shared schema. */
export async function fetchSystemPrompt(): Promise<string> {
  const response = await fetch("/api/prompt");
  if (!response.ok) throw new Error(`/api/prompt failed: ${response.status}`);
  return response.text();
}

export interface NextTurnInput {
  /** The previous assistant message, as streamed (`""` before the first). */
  message: string;
  /** What the user typed, if any. */
  text?: string;
  /** The fired action's name (`ActionEvent.name`), if any. */
  action?: string;
  /** Render crashes — the one kind of issue only the client can observe. */
  renderErrors?: { blockIndex: number; message: string }[];
}

/**
 * The next user turn, built by the server from structured input
 * (`POST /api/next`); `null` when there is nothing to send.
 */
export async function fetchNextTurn(input: NextTurnInput): Promise<string | null> {
  const response = await fetch("/api/next", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json()) as { text?: string | null; error?: string };
  if (!response.ok) throw new Error(body.error ?? `/api/next failed: ${response.status}`);
  return body.text ?? null;
}
