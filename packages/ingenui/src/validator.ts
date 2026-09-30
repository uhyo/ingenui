/**
 * Server-side validation of an ingenui message: the React-free counterpart
 * of `createGenUiMessage`'s issue collection.
 *
 * The same fence splitter feeds each `ui+jsx` block into the parser's
 * framework-agnostic core (`createParser`) wired with the schema's canonical
 * checks — exactly the checks the client's parser runs — so, for the same
 * text and schema, the validator reports the same `jsx-error` and
 * `unclosed-fence` issues the client will, and it reports each one
 * synchronously inside the `write()` that completes it. (`render-error` needs
 * the real components, so it only ever happens on the client.)
 */

import type { Parser, SchemaOptions } from "@ingenui/incremental-jsx-parser/core";
import { createParser, createSchemaChecks } from "@ingenui/incremental-jsx-parser/core";

import { withActionsVariable } from "./actions";
import type { GenUiIssue, IssueListener } from "./issues";
import { formatIssueReport } from "./issues";
import type { ComponentDefinition, GenUiSchema } from "./schema";
import { createFenceSplitter } from "./splitter";

/**
 * The parser-level schema options a {@link GenUiSchema} stands for, with the
 * `actions` variable merged in (as on the client, minus the handlers). The
 * client gets the same through `bindGenUi`.
 */
function schemaParserOptions(schema: GenUiSchema): SchemaOptions {
  const components: Record<string, ComponentDefinition> = {};
  for (const [name, entry] of Object.entries(schema.components ?? {})) {
    components[name] = entry === true ? { props: true } : entry;
  }
  return withActionsVariable({
    elements: schema.elements,
    components,
    variableTypes: schema.variableTypes,
    actions: schema.actions,
    dynamicActions: schema.dynamicActions,
  });
}

export interface GenUiValidatorOptions {
  /** Called for every issue, synchronously, as soon as it is found. */
  onIssue?: IssueListener | undefined;
}

/** A push-based validator for one streamed message. */
export interface GenUiValidator {
  /** Feed the next chunk of the message text. */
  write(chunk: string): void;
  /** Signal the end of the message (reports unclosed fences and tags). */
  end(): void;
  /** The issues found so far (a snapshot copy). */
  getIssues(): readonly GenUiIssue[];
  /** The issues formatted as feedback for the model, or `null` when clean. */
  getIssueReport(): string | null;
  /**
   * The last clean boundary: the offset (into the text written so far) of the
   * opening fence line of the first `ui+jsx` block with issues, or of the
   * block still open — whichever comes first. The text before it is plain
   * Markdown and issue-free blocks. When there is neither, the length of the
   * text written so far.
   */
  getCleanOffset(): number;
  /**
   * The text that closes the currently open fence (a `ui+jsx` block or a
   * regular code fence), ending a partial line first — so text written after
   * it starts on a fresh line of plain Markdown. `""` outside a fence (and
   * after `end()`). Write it through the validator like any other text.
   */
  getFenceClose(): string;
}

/**
 * Create a push-based validator for one message against `schema`. Issues are
 * reported through `onIssue` the moment they are parsed and accumulate on the
 * validator; like the client, the result does not depend on how the text is
 * chunked.
 */
export function createGenUiValidator(
  schema: GenUiSchema,
  options: GenUiValidatorOptions = {},
): GenUiValidator {
  // The same canonical checks the client's parser runs (with the schema's
  // component catalog standing in for the real components).
  const checks = createSchemaChecks(schemaParserOptions(schema));

  const issues: GenUiIssue[] = [];
  /** The lowest block index with issues. */
  let firstIssueBlock = Infinity;
  const record = (issue: GenUiIssue): void => {
    issues.push(issue);
    firstIssueBlock = Math.min(firstIssueBlock, issue.blockIndex);
    options.onIssue?.(issue);
  };

  let written = 0;
  let ended = false;
  /** Where each block's opening fence line starts. */
  const blockStarts: number[] = [];
  let blockCount = 0;
  let current: Parser | null = null;

  const splitter = createFenceSplitter({
    markdown() {},
    markdownTail() {},
    openUi(offset) {
      blockStarts.push(offset);
      const blockIndex = blockCount++;
      // Mirrors the client parser's wiring (createIncrementalJsxParser).
      current = createParser({
        mismatchedTag: schema.mismatchedTag,
        onJsxError: (event) => record({ kind: "jsx-error", blockIndex, event }),
        checks,
      });
    },
    ui(text) {
      current?.write(text);
    },
    closeUi(terminated) {
      current?.end();
      current = null;
      if (!terminated) record({ kind: "unclosed-fence", blockIndex: blockCount - 1 });
    },
  });

  return {
    write(chunk) {
      if (ended) return;
      written += chunk.length;
      splitter.write(chunk);
    },
    end() {
      ended = true;
      splitter.end();
    },
    getIssues: () => issues.slice(),
    getIssueReport: () => formatIssueReport(issues),
    getCleanOffset() {
      const firstBad =
        current === null ? firstIssueBlock : Math.min(firstIssueBlock, blockCount - 1);
      return firstBad === Infinity ? written : blockStarts[firstBad]!;
    },
    getFenceClose: () => splitter.fenceClose(),
  };
}

/** Validate a complete message against `schema` (e.g. a stored assistant turn). */
export function validateGenUiMessage(text: string, schema: GenUiSchema): readonly GenUiIssue[] {
  const validator = createGenUiValidator(schema);
  validator.write(text);
  validator.end();
  return validator.getIssues();
}
