/**
 * ingenui — a lightweight Generative UI framework (`ingenui`).
 *
 * Streams an AI-generated **Markdown** message into a live React tree, where
 * fenced ```ui+jsx code blocks render as interactive UI through
 * `@ingenui/incremental-jsx-parser`. Owns three conventions on top of the parser:
 *
 * - **`ui+jsx` fences** — the message format (`createGenUiMessage`,
 *   `formatGenUiPrompt`);
 * - **`actions`** — the predefined variable connecting UI events back to the
 *   conversation (`GenUiMessageOptions.actions` / `onAction`);
 * - **issues** — parse errors, render crashes (contained per block by an
 *   error boundary), and unclosed fences, collected and formatted as feedback
 *   for the model (`getIssueReport`).
 *
 * The React hook lives in `ingenui/react`. The data-only schema shared with
 * the server is `ingenui/schema` (bound to implementations here with
 * `bindGenUi`), and the React-free server side is `ingenui/server`.
 */

export { createGenUiMessage } from "./message";
export type { GenUiMessage, GenUiMessageOptions, MarkdownRenderContext } from "./message";

export { bindGenUi } from "./bind";
export type { BoundGenUi, GenUiBindings, InferComponentProps, InferSchemaType } from "./bind";

export { defineGenUiSchema } from "./schema";
export type { ComponentDefinition, GenUiSchema } from "./schema";

export { formatGenUiPrompt } from "./prompt";
export type { GenUiPromptOptions } from "./prompt";

export { createActionsVariable, formatActionMessage } from "./actions";
export type {
  ActionDefinition,
  ActionEvent,
  ActionHandler,
  ActionListener,
  ActionsDefinition,
  ActionsVariable,
} from "./actions";

export { formatIssueReport } from "./issues";
export type { GenUiIssue, IssueListener } from "./issues";

export { renderMarkdown } from "./markdown";
export type { RenderMarkdownOptions } from "./markdown";

export type { UiBlockIssue, UiBlockState, UiBlockStatus, UiBlockWrapperProps } from "./ui-block";

export { UiBlockErrorBoundary } from "./boundary";
export type { UiBlockErrorBoundaryProps } from "./boundary";

// Re-exported from @ingenui/incremental-jsx-parser for convenience: the types most
// ingenui options are written in terms of.
export { formatJsxError } from "@ingenui/incremental-jsx-parser/core";
export type {
  ComponentEntry,
  ComponentSpec,
  ElementAllowlist,
  JsxErrorEvent,
  JsxStreamSource,
  SchemaType,
} from "@ingenui/incremental-jsx-parser";
