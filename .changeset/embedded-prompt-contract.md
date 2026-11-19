---
"@ingenui/incremental-jsx-parser": patch
"ingenui": patch
---

The prompt contract no longer contradicts ingenui's message format. `formatPromptContract` takes a new `standalone` option (default `true`, unchanged output: the JSX is the model's whole output, with no prose or code fences around it). With `standalone: false` the contract only constrains what goes inside a UI block ("Inside a UI block, write only JSX — no nested code fences, no imports, no statements."). `formatGenUiPrompt` now uses that embedded form: its "UI contract" section used to say "Output raw JSX only — no prose, no markdown code fences", against the Markdown + `ui+jsx` fence format it describes just above.
