---
"@ingenui/incremental-jsx-parser": patch
"ingenui": patch
---

Separate pure logic from side effects. **Breaking (`/core`):** `createParser` now takes the schema checks as one `checks: SchemaChecks` option (build it with the new `createSchemaChecks(schema)`) instead of the flat `isKnownComponent` / `isKnownVariable` / `isAllowedElement` / `checkProp` callbacks, and `TreeBuilderOptions` is no longer exported. The AST node types are now `readonly`, matching the frozen nodes the parser has always handed out. Parse errors are still reported synchronously by the `write()` that completes them, now once the chunk is fully parsed. `validateOpeningTag` and `validateVariable` are exported as the pure functions behind the schema errors. Streaming is faster with small chunks (the live snapshot copies less), and a streamed ingenui message renders with fewer, larger UI-block updates.
