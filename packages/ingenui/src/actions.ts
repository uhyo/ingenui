/**
 * The `actions` convention.
 *
 * ingenui reserves one predefined variable, **`actions`**, as the bridge from
 * AI-generated UI back to the conversation. The host app declares the actions
 * it supports; the model wires them wherever a function is expected
 * (`<button onClick={actions.submit}>`); and when the user triggers one,
 * ingenui emits an {@link ActionEvent} whose `message` is the canonical next
 * user-turn text for the model ("The `actions.submit` action was fired by the
 * user."). The host app forwards that message as the next request.
 *
 * With **dynamic actions** (ingenui's default; opt out with
 * `dynamicActions: false`), the model may also *define its own*
 * actions simply by referencing them — `onClick={actions.choosePlanPro}` needs
 * no declaration; the name is the definition. This is safe because an
 * undeclared action carries no host behavior: all it can do is emit the
 * canonical message back into the conversation (`declared: false` on the
 * event). Host-declared handlers still run only for declared names.
 * The `actions` variable is then a `Proxy` whose `has` / `get` traps answer
 * for any name, which the parser's `in`-semantics variable resolution accepts
 * and type-infers as `"function"`.
 *
 * **Action values.** The model cannot write closures, so an action never
 * carries arguments the model wrote. What it can carry is what the *user*
 * entered, reported by host-supplied components: an action called with a
 * form's submit event (its fields, via `FormData`), with a click on a named
 * `<button>` (its `name` / `value`), or with a plain data object reports
 * those values as {@link ActionData}, and the canonical message lists them.
 * Which components do so is the host's choice, told to the model in their
 * descriptions.
 */

import type { SchemaType } from "@ingenui/incremental-jsx-parser/core";
import { FORBIDDEN_SEGMENTS } from "@ingenui/incremental-jsx-parser/core";

/**
 * The values a fired action reports: field name -> value (a repeated field,
 * like a group of checkboxes, as an array). Always normalized (see
 * {@link normalizeActionData}).
 */
export type ActionData = Readonly<Record<string, string | readonly string[]>>;

/** A host-side handler run (in addition to `onAction`) when an action fires. */
export type ActionHandler = (...args: readonly unknown[]) => void;

/**
 * The data-only declaration of an action (as in a `GenUiSchema`): no handler,
 * just what the model is told about it.
 */
export interface ActionDefinition {
  /** What the action does, shown to the model in the prompt. */
  readonly description?: string | undefined;
}

/**
 * The actions the model may use: action name -> handler, `true`, or an
 * {@link ActionDefinition} — the latter two declare an action with no local
 * handler (it still fires `onAction`).
 */
export type ActionsDefinition = Readonly<Record<string, ActionHandler | true | ActionDefinition>>;

/** Emitted when the user triggers an action in AI-generated UI. */
export interface ActionEvent {
  /** The action's name (`"submit"`). */
  name: string;
  /** The reference as the model writes it (`"actions.submit"`). */
  reference: string;
  /**
   * The canonical text to send to the model as the next request, e.g.
   * "The `actions.submit` action was fired by the user." — followed by the
   * reported values, if any (see {@link formatActionMessage}).
   */
  message: string;
  /**
   * The values the action reported (see {@link extractActionData}); absent
   * when it reported none. Send these, with `name`, to the server.
   */
  data?: ActionData;
  /** The raw arguments the UI passed (e.g. a React event object). */
  args: readonly unknown[];
  /**
   * `true` for an action the host declared; `false` for a model-defined
   * (dynamic) action, which only notifies — it never runs host code.
   */
  declared: boolean;
}

export type ActionListener = (event: ActionEvent) => void;

/** Limits applied by {@link normalizeActionData}. */
const MAX_FIELDS = 32;
const MAX_ARRAY_ITEMS = 32;
const MAX_VALUE_LENGTH = 2000;
const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeValue(value: unknown): string | undefined {
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else return undefined;
  if (text.length <= MAX_VALUE_LENGTH) return text;
  // Don't split a surrogate pair.
  const end = /[\uDC00-\uDFFF]/.test(text[MAX_VALUE_LENGTH]!)
    ? MAX_VALUE_LENGTH - 1
    : MAX_VALUE_LENGTH;
  return text.slice(0, end);
}

/**
 * Normalize untrusted action values into {@link ActionData}, or `undefined`
 * when there are none. Total and idempotent, so the client and the server
 * derive the same values (and the same message) from the same input:
 *
 * - only a plain object is read; anything else yields `undefined`;
 * - field names must look like `[A-Za-z_][A-Za-z0-9_.-]*` (at most 64
 *   characters, not `__proto__` &c.); other entries are dropped;
 * - values are strings (numbers and booleans are stringified) or arrays of
 *   them; anything else is dropped;
 * - at most 32 fields and 32 items per array; each string is cut to 2000
 *   characters.
 */
export function normalizeActionData(input: unknown): ActionData | undefined {
  if (!isPlainObject(input)) return undefined;
  const data: Record<string, string | readonly string[]> = {};
  let count = 0;
  for (const [key, raw] of Object.entries(input)) {
    if (count === MAX_FIELDS) break;
    if (!FIELD_NAME_RE.test(key) || FORBIDDEN_SEGMENTS.has(key)) continue;
    let value: string | readonly string[] | undefined;
    if (Array.isArray(raw)) {
      const items: string[] = [];
      for (const item of raw as unknown[]) {
        if (items.length === MAX_ARRAY_ITEMS) break;
        const text = normalizeValue(item);
        if (text !== undefined) items.push(text);
      }
      value = items;
    } else {
      value = normalizeValue(raw);
    }
    if (value === undefined) continue;
    data[key] = value;
    count++;
  }
  return count > 0 ? data : undefined;
}

/** Collect a form's fields (string values only; files are dropped). */
function formValues(form: HTMLFormElement, submitter: unknown): Record<string, string | string[]> {
  let formData: FormData;
  try {
    formData =
      submitter instanceof HTMLElement ? new FormData(form, submitter) : new FormData(form);
  } catch {
    // Not a submit button of this form.
    formData = new FormData(form);
  }
  const values: Record<string, string | string[]> = {};
  for (const [key, value] of formData) {
    if (typeof value !== "string") continue;
    const existing = values[key];
    if (existing === undefined) values[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else values[key] = [existing, value];
  }
  return values;
}

/** The form an event is a submission of, if it is one. */
function submittedForm(event: unknown): HTMLFormElement | undefined {
  if (typeof HTMLFormElement === "undefined" || typeof event !== "object" || event === null) {
    return undefined;
  }
  const { type, currentTarget, target } = event as Partial<Event>;
  if (type !== "submit") return undefined;
  const form = currentTarget ?? target;
  return form instanceof HTMLFormElement ? form : undefined;
}

/**
 * The values reported by the arguments an action was called with:
 *
 * - a form's **submit event** (React's or a native one): the form's fields,
 *   as `FormData` collects them — named, enabled controls, incl. the
 *   submitter button's `name` / `value`; file inputs are dropped;
 * - any other event on a **named `<button>`**: `{ [name]: value }`;
 * - a **plain object** (a component calling `onSelect({ city: "Tokyo" })`):
 *   its entries.
 *
 * Normalized with {@link normalizeActionData}; `undefined` when nothing is
 * reported.
 */
export function extractActionData(args: readonly unknown[]): ActionData | undefined {
  const [first] = args;
  if (isPlainObject(first)) return normalizeActionData(first);
  if (typeof first !== "object" || first === null || typeof HTMLElement === "undefined") {
    return undefined;
  }
  const form = submittedForm(first);
  if (form !== undefined) {
    const { nativeEvent } = first as { nativeEvent?: unknown };
    const native = (nativeEvent ?? first) as Partial<SubmitEvent>;
    return normalizeActionData(formValues(form, native.submitter));
  }
  const { currentTarget } = first as Partial<Event>;
  if (
    typeof HTMLButtonElement !== "undefined" &&
    currentTarget instanceof HTMLButtonElement &&
    currentTarget.name !== ""
  ) {
    return normalizeActionData({ [currentTarget.name]: currentTarget.value });
  }
  return undefined;
}

/**
 * The canonical next-request text for a fired action, listing the reported
 * values (normalized, JSON-quoted, one per line), if any:
 *
 * ```text
 * The `actions.subscribe` action was fired by the user with these values:
 * - email: "ada@example.com"
 * - topics: ["news","releases"]
 * ```
 */
export function formatActionMessage(name: string, data?: unknown): string {
  const head = `The \`actions.${name}\` action was fired by the user`;
  const values = normalizeActionData(data);
  if (values === undefined) return `${head}.`;
  const lines = Object.entries(values).map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`);
  return `${head} with these values:\n${lines.join("\n")}`;
}

/** The wired `actions` variable plus its declared schema type. */
export interface ActionsVariable {
  /** Value for the parser's `variables.actions`. */
  values: Readonly<Record<string, ActionHandler>>;
  /**
   * Declared shape for the parser's `variableTypes.actions` (all
   * `"function"`). With dynamic actions, names outside this shape fall
   * through to value inference against {@link ActionsVariable.values}, so the
   * declared shape stays valid as-is.
   */
  type: SchemaType;
}

/**
 * Wrap an {@link ActionsDefinition} into the actual `actions` variable handed
 * to the JSX parser: each entry becomes a function that emits the
 * {@link ActionEvent} through `onAction` and then runs the host handler, if
 * one was given.
 *
 * With `dynamic: true`, the returned `values` also resolves **any other
 * name** to a notify-only action function (created lazily, one stable
 * function per name), so the model can define actions by simply referencing
 * them.
 */
export function createActionsVariable(
  actions: ActionsDefinition,
  onAction: ActionListener | undefined,
  dynamic = false,
): ActionsVariable {
  const wrap = (
    name: string,
    handler: ActionsDefinition[string],
    declared: boolean,
  ): ActionHandler => {
    return (...args) => {
      // The action takes over a form submission: never navigate away.
      const form = submittedForm(args[0]);
      if (form !== undefined) (args[0] as { preventDefault?: () => void }).preventDefault?.();
      const data = extractActionData(args);
      onAction?.({
        name,
        reference: `actions.${name}`,
        message: formatActionMessage(name, data),
        ...(data !== undefined && { data }),
        args,
        declared,
      });
      if (typeof handler === "function") handler(...args);
    };
  };

  const declaredActions: Record<string, ActionHandler> = {};
  const shape: Record<string, SchemaType> = {};
  for (const [name, handler] of Object.entries(actions)) {
    declaredActions[name] = wrap(name, handler, true);
    shape[name] = "function";
  }
  if (!dynamic) return { values: declaredActions, type: shape };

  const invented = new Map<string, ActionHandler>();
  const values = new Proxy(declaredActions, {
    has: (target, prop) => typeof prop === "string" || Reflect.has(target, prop),
    get: (target, prop, receiver) => {
      // Declared actions, symbols, and inherited Object.prototype members
      // (toString &c.) behave normally; everything else is a dynamic action.
      if (typeof prop !== "string" || Reflect.has(target, prop)) {
        return Reflect.get(target, prop, receiver);
      }
      let wrapper = invented.get(prop);
      if (wrapper === undefined) {
        wrapper = wrap(prop, true, false);
        invented.set(prop, wrapper);
      }
      return wrapper;
    },
  });
  return { values, type: shape };
}

/** The actions-related options plus the predefined variables they merge into. */
export interface ActionsOptions {
  actions?: ActionsDefinition | undefined;
  dynamicActions?: boolean | undefined;
  onAction?: ActionListener | undefined;
  variables?: Record<string, unknown> | undefined;
  variableTypes?: Readonly<Record<string, SchemaType>> | undefined;
}

/**
 * Resolve the actions options into the parser's predefined variables: the
 * `actions` variable is merged in (overriding any `actions` key). Dynamic
 * actions are the default, so the variable exists unless they are opted out
 * and no action is declared.
 */
export function withActionsVariable<T extends ActionsOptions>(
  options: T,
): Omit<T, "actions" | "dynamicActions" | "onAction"> {
  const { actions = {}, dynamicActions, onAction, ...rest } = options;
  const dynamic = dynamicActions !== false;
  if (!dynamic && Object.keys(actions).length === 0) return rest;
  const actionsVariable = createActionsVariable(actions, onAction, dynamic);
  return {
    ...rest,
    variables: { ...options.variables, actions: actionsVariable.values },
    variableTypes: { ...options.variableTypes, actions: actionsVariable.type },
  };
}

/** A fired action, resolved against the declared actions (see {@link resolveAction}). */
export interface ResolvedAction {
  /** The action's name (`"submit"`). */
  name: string;
  /** The reference as the model writes it (`"actions.submit"`). */
  reference: string;
  /** The canonical next-request text (see {@link formatActionMessage}). */
  message: string;
  /** The reported values, normalized (absent when there are none). */
  data?: ActionData;
  /** `true` for a declared action, `false` for a model-defined (dynamic) one. */
  declared: boolean;
}

const ACTION_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Resolve an action **name** reported by a client (e.g. `{ action: "submit" }`
 * in the next request) against the declared actions — the server-side
 * counterpart of the `actions` variable. Returns `null` when the name is not
 * an action the model could have wired: undeclared with `dynamicActions:
 * false`, or (with dynamic actions) not a valid `actions.<name>` member —
 * non-identifiers, the forbidden segments, and inherited `Object.prototype`
 * members (`toString` &c.) are never actions.
 *
 * `data` is the values the client reports with it (`ActionEvent.data`),
 * untrusted: it is normalized with {@link normalizeActionData} (invalid
 * entries dropped, long values cut) and listed in the `message`.
 *
 * Build the next request from the returned `message` instead of trusting
 * client-supplied text.
 */
export function resolveAction(
  options: Pick<ActionsOptions, "actions" | "dynamicActions">,
  name: string,
  data?: unknown,
): ResolvedAction | null {
  const declared = options.actions !== undefined && Object.hasOwn(options.actions, name);
  if (!declared) {
    if (options.dynamicActions === false) return null;
    if (!ACTION_NAME_RE.test(name) || FORBIDDEN_SEGMENTS.has(name) || name in Object.prototype) {
      return null;
    }
  }
  const values = normalizeActionData(data);
  return {
    name,
    reference: `actions.${name}`,
    message: formatActionMessage(name, values),
    ...(values !== undefined && { data: values }),
    declared,
  };
}
