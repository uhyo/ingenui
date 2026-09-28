---
"@ingenui/incremental-jsx-parser": patch
---

The prompt contract (`formatPromptContract`, and so `formatGenUiPrompt`) no longer claims text is "rendered literally". It now says text follows JSX rules — HTML entities are decoded and line breaks/indentation collapse to single spaces — still recommends writing characters directly, and lists `&lt;` / `&#123;` alongside `{"<"}` for a literal `<` or `{`.
