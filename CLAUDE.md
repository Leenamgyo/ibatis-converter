# ibatis-migration-analyzer

Static analysis tool that parses legacy iBATIS 2.x XML Mappers into an AST,
resolves references (`include refid`, `resultMap extends`), analyzes
dynamic SQL / parameters / tables / columns, and converts everything to
MyBatis 3.x XML — never via string replacement.

Read `docs/` before making non-trivial changes:

- `docs/ARCHITECTURE.md` — the 8-stage pipeline, package responsibilities, core design rules
- `docs/SPEC_MAPPING.md` — which of the 27 original spec sections are implemented vs. stubbed, and where
- `docs/AST_REFERENCE.md` — every AST node type (`ast/ibatis`, `ast/mybatis`) field by field
- `docs/TESTING.md` — test layout, fixture catalog, how to add a new case

## Stack

Plain Node.js (ESM, `"type": "module"`), no TypeScript, no bundler.
- Core pipeline (`parser`, `ast`, `resolver`, `analyzer/dynamic`,
  `analyzer/parameter`) has **zero runtime dependencies** — a hand-rolled,
  line-tracking XML tokenizer, not a DOM library. Keep it that way; it's
  also what makes those stages runnable unmodified inside a browser
  Artifact (see `docs/ARCHITECTURE.md`).
- `analyzer/sql` / `analyzer/table` / `analyzer/lineage` (sections 7-10,
  26) depend on `node-sql-parser` — that dependency is intentionally
  scoped to those files only. `analyzer/lineage` consumes the AST the
  other two already produce; it never parses SQL itself.
- `interfaces/api` uses `express`, and also serves the UI as plain static
  files (`interfaces/api/public/{index.html,app.js,lineage.js,
  schema.js,datasets.js,styles.css,dashboard.css,schema.css}`) via `express.static` — no build step, no
  framework, no CDN, plain classic `<script>`s that share one top-level
  scope; they just `fetch()` the JSON API below them. Header tabs switch
  two screens (`showScreen()`): **분석** and **데이터셋** (schema-mapping
  datasets edited as JSON — `datasets.js`, stored as files under
  `data/datasets/` or `DATASET_DIR`). The analysis screen has **two views**,
  switched from a tablist at the top of the left menu (`showView()` in
  `app.js`): **리니지** (the dashboard graph — `lineage.js`) and **변환**
  (`schema.js` — the selected statement's column/table renames, with the
  iBATIS -> MyBatis syntax conversion as a toggle; renames marked
  red/green, syntax violet). Both views read the one statement the left
  tree has selected, so flipping between them never moves the tree or
  clears the selection. Keep the split: the lineage view must not render
  anything from either conversion (the 변환 view's tree badges are removed
  when it closes); the 변환 view owns the converted XML, the diff and the
  grading of both conversions. The Statements and Tables screens (spec sections
  24-25) were removed at the user's request; their API endpoints are
  untouched and still tested. Per-feature behaviour — the graph's rules,
  the dashboard, navigation, the sample project, the dev loop — is
  documented one file per feature in `docs/features/`; read the relevant
  one before changing that feature, and edit it when the feature changes. The lineage graph
  uses no diagram library: containment is nested DOM and edges are one
  measured SVG layer (see `docs/ARCHITECTURE.md`). Run `npm start` and open
  `http://localhost:3000`.
- The "Load sample" project is real files under
  `src/interfaces/api/public/samples/` (fetched at click time, listed in
  `manifest.json`) — one mapper per scenario, and the same files
  `test/integration/sampleProject.test.js` analyzes. Add a scenario there
  rather than inlining demo XML in `app.js`.
- Tests: Node's built-in test runner. Run with `npm test`, which is
  `node --test "test/**/*.test.js"`. **Do not** run bare `node --test`:
  its default patterns include *every* `.js` under any `test/` directory,
  so it also executes the golden-file generators in `test/fixtures/**`
  (`generate*.js`), which rewrite the golden files that the golden tests
  compare against. Those tests then pass whatever the code does. That
  happened here and hid regressions until the fuzzing round caught it. Also
  **do not** pass a bare directory (`node --test test/`); on this Node
  version that fails with `MODULE_NOT_FOUND`. Use the quoted glob.
  `test/fuzz/` holds seeded fuzz/differential tests; set `FUZZ_SEEDS` for
  bigger runs. The
  `interfaces/api/public` UI has no automated test coverage — it was
  verified by hand in a real browser (see docs/SPEC_MAPPING.md's "Manual
  verification" note); if you change it, re-verify in a browser rather
  than assuming a passing `npm test` covers it.

## Core principle (do not violate)

Every transformation is a typed AST-to-AST mapping:

```
XML -> AST -> Reference Resolution -> Semantic Analysis -> MyBatis AST -> XML
```

Never `.replace()` on raw XML/SQL strings to "convert" a tag. If a
conversion can't be expressed as a node-to-node mapping yet, leave it as a
`throw new Error('... not implemented yet (spec section N)')` stub rather
than faking it with string substitution — that's the existing convention
in every unfinished `analyzer/`, `converter/`, `generator/`, `report/`
file, and it's there deliberately so half-implementations are loud, not
silent.

## Conventions specific to this repo

- **Diagnostics, not exceptions.** Parse/resolve/analyze failures go into
  a `DiagnosticBag` (`ParserWarning`/`ParserError`, see
  `src/parser/xml/ParserDiagnostics.js`) so one broken mapper file never
  aborts analysis of the rest of the project. Only truly-unrecoverable
  programmer errors should throw.
- **Two trees, never mutated.** `ReferenceResolver#resolve` returns
  `{ originalTree, resolvedTree }` as distinct objects
  (`cloneShallowWithChildren`) — never mutate a node coming out of the
  parser or the symbol table in place.
- **AST node discriminator is always `type`.** Every `ast/ibatis` /
  `ast/mybatis` node sets `this.type` in its constructor as a string
  discriminator (`'Statement'`, `'Dynamic'`, `'Conditional'`, ...) — code
  branches on `node.type`, not `instanceof`. This has bitten us twice
  already for exactly the reason you'd expect — a source attribute
  literally named `type`: iBATIS's `<selectKey type="pre|post">` is
  exposed as `ast/ibatis` `SelectKeyNode.timing`, and MyBatis's
  `<resultMap type="...">` (the mapped Java class) is exposed as
  `ast/mybatis` `ResultMapNode.resultType` — both `.type`, not renamed,
  silently and permanently overwrite the node-kind discriminator set by
  `super()`, and nothing warns you (see `src/ast/ibatis/nodes.js` and
  `src/ast/mybatis/nodes.js`). If you add a new node with an XML attribute
  literally named `type`, rename it the same way.
- **Namespace-qualified ids everywhere.** Symbol/dependency-graph keys are
  `${namespace}.${localId}` (or bare `localId` if a mapper has no
  namespace) — see `resolver/symbol/ProjectScanner.js#qualify`.
- **Package boundaries are real boundaries.** `parser` never imports
  `converter`; `analyzer` never imports `generator`; only
  `application/AnalyzerPipeline.js` is allowed to wire stages together.
  Keep it that way so each package stays independently unit-testable.

## Current status (see docs/SPEC_MAPPING.md for detail)

Fully implemented + tested: project skeleton, XML parser, iBATIS AST,
symbol table, reference resolver (include/refid + resultMap extends,
including missing/circular detection), Dynamic SQL Analyzer, Parameter
Analyzer, SQL flattening + parsing (`analyzer/sql`, via `node-sql-parser`),
Table/Column/Join/Where Analyzer (`analyzer/table`), the composite
`StatementAnalyzer` (`analyzer/statement`), the full MyBatis converter
(`converter/mybatis/*` — parameter/conditional/dynamic/iterate/resultMap,
each grading its own decisions SAFE/WARNING/MANUAL via `ConversionEvent`),
the XML generator (`generator/xml`), `MigrationSafetyAnalyzer`/
`MapperReport`/`ProjectReport` (`report/migration`), the table/statement
dependency graphs (`analyzer/dependency/DependencyAnalyzer`, spec sections
21-22), the SELECT-hierarchy/column lineage analyzer
(`analyzer/lineage`, carried on `StatementAnalysis.lineage`), and the full
analysis API — `analyze` (also returning
`generatedMapperXml` and `tableDependencyGraph`), `statements/:id`,
`tables/:name`, `statements/:id/dependencies`, and
`statements/:id/mybatis-preview` (`interfaces/api`), the optional SQL
schema migration stage (`converter/schema` — old -> new table/column
renames; zero-dependency, never imports `converter/mybatis`; see
`docs/features/schema-migration.md`), plus the Node-served
UI consuming that API (`interfaces/api/public`, spec sections 24-26 — SQL
Lineage dashboard, Statements, Tables, MyBatis).
Every spec section is now implemented.
