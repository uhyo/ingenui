/**
 * The demo's GenUI schema — plain data, shared by both sides:
 *
 * - the Worker (`worker/index.ts`) builds the system prompt from it and
 *   validates every streamed message against it (`ingenui/server`);
 * - the client binds the React components to it (`bindGenUi` in
 *   `components.tsx`) and renders.
 *
 * No React, no implementations: importing it on the server pulls in nothing
 * client-side.
 */
import { defineGenUiSchema } from "ingenui/schema";

export const demoSchema = defineGenUiSchema({
  components: {
    Card: { props: {}, description: "A bordered panel grouping related content." },
    CardHeader: { props: {}, description: "The header row of a Card (a Title and Badges)." },
    CardBody: { props: {}, description: "The body of a Card." },
    Title: { props: {}, description: "A heading." },
    Text: { props: {}, description: "A paragraph of text." },
    Badge: {
      props: { tone: "string" },
      description: 'A small status pill. tone: "neutral" | "info" | "success" | "warning".',
    },
    Button: {
      props: { variant: "string", onClick: "function" },
      description: 'A button. variant: "primary" | "ghost". Wire onClick to an action.',
    },
    Avatar: { props: { initials: "string", name: "string" }, description: "A round avatar." },
    Stat: {
      props: { label: "string", value: "node" },
      description: "A big number (value) with a caption (label).",
    },
    Row: { props: {}, description: "Lays its children out horizontally." },
    List: { props: {}, description: "A bulleted list of Items." },
    Item: { props: {}, description: "One List entry." },
    Callout: {
      props: { tone: "string" },
      description: 'A highlighted note. tone: "info" | "warning".',
    },
    // Forms: the model asks for input through these components, never raw
    // HTML. Their descriptions tell it the HTML semantics (what the action
    // reports), which is the app's responsibility.
    Form: {
      props: { onSubmit: "function", submitLabel: "string" },
      description:
        "A form (an HTML <form>) ending in a submit button labeled submitLabel. Wire " +
        "onSubmit to an action: on submit, that action reports the value of every " +
        "TextField / Select inside the form, by its name. Use it whenever you need the " +
        "user to type or pick something.",
    },
    TextField: {
      props: {
        name: "string",
        label: "string",
        placeholder: "string",
        defaultValue: "string",
        multiline: "boolean",
        required: "boolean",
      },
      description:
        "A labeled text input (an HTML <input>, or a <textarea> with multiline). Only " +
        "inside a Form; its value is reported under name when the form is submitted. " +
        "required: the form can't be submitted while it is empty.",
    },
    Select: {
      props: { name: "string", label: "string", defaultValue: "string" },
      description:
        "A labeled dropdown (an HTML <select>) whose children are Option elements. Only " +
        "inside a Form; the chosen Option's value is reported under name when the form " +
        "is submitted.",
    },
    Option: {
      props: { value: "string" },
      description:
        "One choice of a Select: value is what gets reported; its children are the label.",
    },
  },
  actions: {
    addToCart: { description: "Add the product shown in the UI to the user's cart." },
  },
  // Dynamic actions (the default): the model may also invent action names.
});
