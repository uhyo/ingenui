import { describe, expect, it, vi } from "vitest";

import type { ActionEvent } from "./actions";
import {
  createActionsVariable,
  extractActionData,
  formatActionMessage,
  normalizeActionData,
} from "./actions";

/** Stands in for React's synthetic event (a class instance, not a plain object). */
class FakeSyntheticEvent {
  constructor(
    readonly type: string,
    readonly currentTarget: EventTarget | null,
    readonly nativeEvent: Event = new Event(type),
    readonly preventDefault: () => void = () => {},
  ) {}
}

describe("formatActionMessage", () => {
  it("produces the canonical next-request text", () => {
    expect(formatActionMessage("submit")).toBe(
      "The `actions.submit` action was fired by the user.",
    );
  });

  it("lists the reported values, JSON-quoted, one per line", () => {
    expect(
      formatActionMessage("subscribe", {
        email: 'ada@example.com\n- admin: "yes"',
        topics: ["a", "b"],
      }),
    ).toBe(
      "The `actions.subscribe` action was fired by the user with these values:\n" +
        '- email: "ada@example.com\\n- admin: \\"yes\\""\n' +
        '- topics: ["a","b"]',
    );
  });

  it("normalizes what it lists (no values: the plain message)", () => {
    expect(formatActionMessage("go", { "bad key": "x" })).toBe(
      "The `actions.go` action was fired by the user.",
    );
  });
});

describe("normalizeActionData", () => {
  it("keeps string, number, boolean and array values", () => {
    expect(normalizeActionData({ a: "x", n: 3, b: false, list: ["p", 1, null] })).toEqual({
      a: "x",
      n: "3",
      b: "false",
      list: ["p", "1"],
    });
  });

  it("returns undefined for non-plain objects and empty results", () => {
    for (const input of [undefined, null, "x", 1, ["a"], new Date(), {}, { a: null }]) {
      expect(normalizeActionData(input)).toBeUndefined();
    }
    expect(normalizeActionData(Object.assign(Object.create(null), { a: "x" }))).toEqual({ a: "x" });
  });

  it("drops invalid field names", () => {
    const input = JSON.parse(
      '{"ok_name.1-x":"1","1abc":"2","has space":"3","__proto__":"4","":"5"}',
    );
    expect(normalizeActionData(input)).toEqual({ "ok_name.1-x": "1" });
    expect(normalizeActionData({ ["a".repeat(65)]: "x" })).toBeUndefined();
  });

  it("caps fields, array items and value length (without splitting surrogate pairs)", () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, "x"]));
    expect(Object.keys(normalizeActionData(many)!)).toHaveLength(32);
    const items = normalizeActionData({ a: Array.from({ length: 40 }, () => "x") })!["a"];
    expect(items).toHaveLength(32);
    expect((normalizeActionData({ a: "y".repeat(5000) })!["a"] as string).length).toBe(2000);
    const emoji = "y".repeat(1999) + "😀";
    expect(normalizeActionData({ a: emoji })!["a"]).toBe("y".repeat(1999));
  });

  it("is idempotent", () => {
    const input = { a: "y".repeat(5000), b: [1, "z"], "bad key": "x" };
    const once = normalizeActionData(input);
    expect(normalizeActionData(once)).toEqual(once);
  });
});

describe("extractActionData", () => {
  function formWithFields(): { form: HTMLFormElement; submit: HTMLButtonElement } {
    document.body.innerHTML = `
      <form>
        <input name="email" value="ada@example.com">
        <input name="topics" type="checkbox" value="news" checked>
        <input name="topics" type="checkbox" value="releases" checked>
        <input name="unchecked" type="checkbox" value="x">
        <input name="file" type="file">
        <input value="unnamed">
        <button name="plan" value="pro" type="submit">Pro</button>
      </form>`;
    return { form: document.querySelector("form")!, submit: document.querySelector("button")! };
  }

  it("reads a form's fields (and the submitter) from a native submit event", () => {
    const { form, submit } = formWithFields();
    const event = new SubmitEvent("submit", { submitter: submit });
    form.addEventListener("submit", (e) => {
      expect(extractActionData([e])).toEqual({
        email: "ada@example.com",
        topics: ["news", "releases"],
        plan: "pro",
      });
    });
    form.dispatchEvent(event);
    expect.assertions(1);
  });

  it("reads a React-style synthetic submit event (currentTarget + nativeEvent)", () => {
    const { form } = formWithFields();
    const synthetic = new FakeSyntheticEvent("submit", form);
    expect(extractActionData([synthetic])).toEqual({
      email: "ada@example.com",
      topics: ["news", "releases"],
    });
  });

  it("reads a named button's name / value", () => {
    document.body.innerHTML = `<button name="product" value="blue-mug">Add</button><button>Plain</button>`;
    const [named, plain] = document.querySelectorAll("button");
    expect(extractActionData([new FakeSyntheticEvent("click", named!)])).toEqual({
      product: "blue-mug",
    });
    expect(extractActionData([new FakeSyntheticEvent("click", plain!)])).toBeUndefined();
  });

  it("reads a plain data object", () => {
    expect(extractActionData([{ city: "Tokyo", nights: 3 }])).toEqual({
      city: "Tokyo",
      nights: "3",
    });
  });

  it("reports nothing for other arguments", () => {
    expect(extractActionData([])).toBeUndefined();
    expect(extractActionData(["payload", 1])).toBeUndefined();
    expect(extractActionData([new Event("click")])).toBeUndefined();
  });
});

describe("createActionsVariable", () => {
  it("declares every action as a function", () => {
    const { type } = createActionsVariable({ submit: true, cancel: () => {} }, undefined);
    expect(type).toEqual({ submit: "function", cancel: "function" });
  });

  it("emits an ActionEvent and runs the host handler", () => {
    const events: ActionEvent[] = [];
    const handler = vi.fn();
    const { values } = createActionsVariable({ submit: handler }, (event) => events.push(event));

    values["submit"]!("arg0", 1);

    expect(handler).toHaveBeenCalledWith("arg0", 1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: "submit",
      reference: "actions.submit",
      message: "The `actions.submit` action was fired by the user.",
      args: ["arg0", 1],
    });
  });

  it("reports the values on the event and in the message, and takes over a form submission", () => {
    const events: ActionEvent[] = [];
    const handler = vi.fn();
    const { values } = createActionsVariable({ subscribe: handler }, (event) => events.push(event));
    document.body.innerHTML = `<form><input name="email" value="ada@example.com"></form>`;
    const form = document.querySelector("form")!;
    const preventDefault = vi.fn();
    const synthetic = new FakeSyntheticEvent("submit", form, new Event("submit"), preventDefault);

    values["subscribe"]!(synthetic);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(synthetic);
    expect(events[0]).toMatchObject({
      data: { email: "ada@example.com" },
      message:
        "The `actions.subscribe` action was fired by the user with these values:\n" +
        '- email: "ada@example.com"',
    });
  });

  it("omits data when nothing is reported", () => {
    const events: ActionEvent[] = [];
    const { values } = createActionsVariable({ ping: true }, (event) => events.push(event));
    values["ping"]!();
    expect(events[0]).not.toHaveProperty("data");
  });

  it("supports handler-less actions declared as true", () => {
    const events: ActionEvent[] = [];
    const { values } = createActionsVariable({ ping: true }, (event) => events.push(event));
    values["ping"]!();
    expect(events.map((e) => e.name)).toEqual(["ping"]);
  });

  it("works without an onAction listener", () => {
    const handler = vi.fn();
    const { values } = createActionsVariable({ go: handler }, undefined);
    values["go"]!();
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("createActionsVariable — dynamic", () => {
  it("resolves any name to a stable, firing action function", () => {
    const events: ActionEvent[] = [];
    const { values } = createActionsVariable({}, (event) => events.push(event), true);

    expect("choosePlanPro" in values).toBe(true);
    const fn = values["choosePlanPro"]!;
    expect(typeof fn).toBe("function");
    expect(values["choosePlanPro"]).toBe(fn); // stable identity per name

    fn("payload");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: "choosePlanPro",
      reference: "actions.choosePlanPro",
      message: "The `actions.choosePlanPro` action was fired by the user.",
      args: ["payload"],
      declared: false,
    });
  });

  it("keeps declared handlers alongside dynamic names", () => {
    const events: ActionEvent[] = [];
    const handler = vi.fn();
    const { values, type } = createActionsVariable(
      { submit: handler },
      (event) => events.push(event),
      true,
    );

    values["submit"]!();
    values["somethingElse"]!();

    expect(handler).toHaveBeenCalledOnce(); // only the declared action runs host code
    expect(events.map((e) => [e.name, e.declared])).toEqual([
      ["submit", true],
      ["somethingElse", false],
    ]);
    // The declared shape is unchanged; dynamic names resolve via the value.
    expect(type).toEqual({ submit: "function" });
  });

  it("leaves inherited Object.prototype members untouched", () => {
    const events: ActionEvent[] = [];
    const { values } = createActionsVariable({}, (event) => events.push(event), true);
    expect(values["toString"]).toBe(Object.prototype.toString);
    expect(String(values)).toBe("[object Object]");
    expect(events).toEqual([]);
  });

  it("only enumerates declared actions (dynamic names stay lazy)", () => {
    const { values } = createActionsVariable({ submit: true }, undefined, true);
    void values["invented"];
    expect(Object.keys(values)).toEqual(["submit"]);
  });
});
