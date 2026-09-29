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

/**
 * The server's message stream for `params` (`POST /api/generate`), as a
 * byte stream for `useGenUiMessage`. Created synchronously — the request is
 * made when the stream starts — and cancelling it aborts the request.
 * `onProgress` receives the text received so far, and whether it is all.
 */
export function streamGeneration(
  params: GenerateParams,
  onProgress: (receivedSoFar: string, done: boolean) => void,
): ReadableStream<Uint8Array> {
  const abort = new AbortController();
  const decoder = new TextDecoder();
  let received = "";
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  return new ReadableStream<Uint8Array>({
    async start() {
      onProgress("", false);
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: abort.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`/api/generate failed: ${response.status} ${await response.text()}`);
      }
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

/** The system prompt the server builds from the shared schema. */
export async function fetchSystemPrompt(): Promise<string> {
  const response = await fetch("/api/prompt");
  if (!response.ok) throw new Error(`/api/prompt failed: ${response.status}`);
  return response.text();
}

export interface NextTurnInput {
  /** The previous assistant message, as streamed. */
  message: string;
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
