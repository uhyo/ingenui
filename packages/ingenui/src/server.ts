/**
 * Server entry point (`ingenui/server`) — React-free.
 *
 * The server side of an ingenui app sits between the LLM provider and the
 * client. With the shared, data-only {@link GenUiSchema} (`ingenui/schema`)
 * it:
 *
 * - builds the system prompt (`formatGenUiPrompt`);
 * - validates the model's stream while passing it through to the client
 *   (`pipeGenUi`), or a complete message (`validateGenUiMessage`), reporting
 *   the same issues the client will — as soon as they are streamed — and
 *   can stop the message on an issue, and continue it with a new response
 *   (`formatContinuationMessage` asks the model for one);
 * - builds the next request itself from structured client input: fired
 *   actions resolved against the schema (`resolveGenUiAction`) and the issue
 *   report (`formatIssueReport`), instead of trusting client-written text.
 *
 * Nothing here (or in anything it imports) may depend on React.
 */

import type { ResolvedAction } from "./actions";
import { resolveAction } from "./actions";
import type { GenUiSchema } from "./schema";

export { createGenUiValidator, validateGenUiMessage } from "./validator";
export type { GenUiValidator, GenUiValidatorOptions } from "./validator";

export { formatContinuationMessage, pipeGenUi } from "./pipe";
export type {
  GenUiContinuation,
  GenUiPipe,
  GenUiPipeOptions,
  GenUiPipeResult,
  GenUiPipeSnapshot,
} from "./pipe";

export { formatGenUiPrompt } from "./prompt";
export type { GenUiPromptOptions } from "./prompt";

export { formatActionMessage } from "./actions";
export type { ActionDefinition, ResolvedAction } from "./actions";

export { formatIssueReport } from "./issues";
export type { GenUiIssue, IssueListener } from "./issues";

export type { ComponentDefinition, GenUiSchema } from "./schema";
export { formatJsxError } from "@ingenui/incremental-jsx-parser/core";
export type {
  JsxErrorEvent,
  JsxStreamSource,
  SchemaType,
} from "@ingenui/incremental-jsx-parser/core";

/**
 * Resolve an action **name** reported by the client (e.g. the `name` of the
 * client's `ActionEvent`, sent as structured data) against `schema`. Returns
 * the action with its canonical next-request `message`, or `null` when the
 * model could not have wired such an action — undeclared with
 * `dynamicActions: false`, or not a valid `actions.<name>` member.
 */
export function resolveGenUiAction(schema: GenUiSchema, name: string): ResolvedAction | null {
  return resolveAction(schema, name);
}
