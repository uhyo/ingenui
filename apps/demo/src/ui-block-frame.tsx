/**
 * How the demo shows UI blocks and their issues — shared by the simulated
 * stream and the Claude chat.
 */
import type { GenUiIssue, UiBlockWrapperProps } from "ingenui";

/** A one-line description of an issue. */
export function issueLabel(issue: GenUiIssue): string {
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
export function UiBlockFrame({
  blockIndex,
  state,
  issues,
  crashed,
  children,
}: UiBlockWrapperProps) {
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
