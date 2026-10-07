# Architecture

## Pipeline

```
iBATIS XML
    |
    v
[parser/xml]      hand-rolled, line-tracking XML tokenizer
    |               -> XmlDocument { root: XmlElement, sourceFile }
    v
[parser/ibatis]   XmlElement tree -> semantic AST
    |               -> SqlMapNode { statements, sqlFragments, resultMaps, parameterMaps, cacheModels }
    v
[resolver/symbol]     pass 1: scan every parsed mapper, register every
    |                 statement/fragment/resultMap/parameterMap/cacheModel
    |                 into one project-wide SymbolTable, keyed by
    |                 "<namespace>.<id>"
    v
[resolver/reference]  pass 2: follow <include refid> and
    |                 <resultMap extends> against the SymbolTable
    |                 -> { originalTree, resolvedTree } per statement
    |                 -> DependencyGraph (include/extends edges)
    |                 -> missing/circular reference diagnostics
    v
[analyzer/dynamic]    resolvedTree -> DynamicSql model
    |                 (DynamicGroup / DynamicCondition / DynamicIterate,
    |                 condition operators already standardized by the parser)
    v
[analyzer/parameter]  resolvedTree -> ParameterUsage[] (#x#/$x$/#x[]#,
    |                 clause classification, dynamicCondition linkage,
    |                 $...$ -> SQL_INJECTION warning)
    v
[analyzer/sql]        `SqlFlattener`: resolvedTree -> literal SQL text
    |                 (reproduces iBATIS's own dynamic-tag prepend
    |                 suppression rules — see the file's own doc comment),
    |                 then `SqlAnalyzer` parses it with node-sql-parser
    v
[analyzer/table]      node-sql-parser AST -> TableUsage[] / ColumnUsage[] /
    |                 JoinRelation[] / WHERE tree (LogicalNode/ComparisonNode),
    |                 folding subquery and UNION branches into the same
    |                 flat result (spec sections 7-10)
    v
[analyzer/lineage]    the same node-sql-parser AST -> the SELECT *hierarchy*
    |                 the dashboard draws: one LineageSelect per SELECT
    |                 (main / subquery / UNION branch / CTE) with its own
    |                 tables/joins/outputs and a `parentId`, plus
    |                 alias -> source column lineage followed through
    |                 derived tables (spec section 26). Where
    |                 `analyzer/table` deliberately flattens nesting away,
    |                 this stage deliberately keeps it
    v
[analyzer/statement]  composite StatementAnalysis per statement — combines
    |                 dynamic/parameter/table analyzer output; degrades to
    |                 empty tables/columns/joins + a SQL_PARSE_FAILED
    |                 warning (never throws) if the flattened SQL doesn't
    |                 parse (spec section 11)
    v
[converter/mybatis]   walks the ORIGINAL (unresolved) statement/fragment
    |                 tree — <include> stays an <include>, nothing is
    |                 inlined — converting node-to-node via
    |                 Parameter/Conditional/Dynamic/Iterate/ResultMap
    |                 converters, each returning its own graded
    |                 ConversionEvent[] (SAFE/WARNING/MANUAL) instead of a
    |                 bare warning list (spec sections 12-16)
    v
[generator/xml]       ast/mybatis MapperNode -> MyBatis mapper XML text;
    |                 leaf SQL text is emitted verbatim (re-escaped, never
    |                 reformatted); structural indentation is consistent
    |                 (spec section 17)
    v
[converter/schema]    OPTIONAL (AnalyzerPipeline `schemaMigrationConverter`):
    |                 old -> new schema table/column renames over the
    |                 converted MyBatis AST, returned separately as
    |                 `schemaMigration` (see docs/features/schema-migration.md).
    |                 Zero-dependency, lossless token-level edits, never
    |                 imports converter/mybatis
    v
[report/migration]    MigrationSafetyAnalyzer rolls a statement's
    |                 ConversionEvent[] into { SAFE, WARNING, MANUAL,
    |                 ERROR } counts (spec section 18); MapperReport
    |                 (per-file summary) and ProjectReport (project-wide
    |                 table usage report) are DONE (spec sections 19-20)
    v
[analyzer/dependency] DependencyAnalyzer: table->table graph from actual
    |                 JoinRelations (spec section 21), and per-statement
    |                 include/extends/resultMap/parameterMap dependency
    |                 trees built from the same resolver DependencyGraph
    |                 (spec section 22)
    v
[interfaces/api]      the section 23 JSON API, plus (spec sections 24-26)
                      a static, build-free frontend (interfaces/api/public)
                      served from the same Express app that just fetch()s
                      that API. One screen, two views switched from the
                      left menu: the SQL Lineage graph (lineage.js) and
                      the 변환 view (schema.js: renames + MyBatis toggle) — the converted
                      side stays a separate view so the lineage screen
                      never mixes the original mapper with the
                      conversion's opinions (see docs/SPEC_MAPPING.md)
```

`application/AnalyzerPipeline.js` is the only file that wires these stages
together end to end; every stage is otherwise independently importable and
independently unit-tested (`test/parser`, `test/resolver`, `test/analyzer`,
`test/report`, `test/interfaces`).

## Why the lineage graph is DOM boxes + an SVG edge layer, not a diagram library

The dashboard's core requirement is that a subquery is drawn *inside* the
SELECT that owns it, three levels deep if that's what the mapper does.
Expressing that as nested `<div>`s makes containment free: the browser
lays the boxes out, nesting is real nesting, and narrow viewports can
restack a cluster's columns with one media query. A graph library would
own layout instead, and every earlier attempt at this screen (mermaid
`subgraph`s) spent its complexity fighting the layout engine for exactly
that nesting.

So `public/lineage.js` renders boxes as DOM and computes *only* the edge
geometry, measured from the laid-out boxes (`getBoundingClientRect`,
divided by the current zoom scale) into one absolutely-positioned `<svg>`
inside the same transformed container — which means pan/zoom is a single
CSS transform on the parent and edges scale with it for free.

Two consequences worth knowing before editing that file:

- edges can only be measured when the graph is actually on screen (a box
  on a `hidden` screen has no geometry at all), so edge drawing and
  "fit to screen" both retry across frames until the screen is visible
  (`redrawEdgesWhenVisible` / `fitGraphWhenVisible`);
- a node inside a collapsed cluster has no geometry either, so an edge
  pointing into one is re-anchored to the collapsed cluster
  (`visibleAnchor`) rather than dropped.

## Why the converter writes `prepend` into the `<if>` body

iBATIS renders a conditional's `prepend` connector *at runtime*,
suppressing it for whichever sibling ends up first. MyBatis has no such
mechanism: `<where>`, `<set>` and `<trim>` only ever **strip** a connector
that the body already carries (`prefixOverrides`/`suffixOverrides`).

So `MyBatisAstConverter#withConnector` writes it in:

- `AND`/`OR` go in **front** of the body — `<where>` (and an inferred
  `<trim prefix="AND" prefixOverrides="AND ">`) drops the leading one;
- `,` goes at the **end** — `<set>` drops the trailing one;
- an `<iterate prepend="AND">` puts the connector in the `<foreach>`'s
  `open` (and a `,` in its `close`) instead of in a sibling text node,
  because open/close only render when the collection is non-empty — a
  sibling `AND` would survive an empty list and dangle.

The connector is spliced *inside* the text node's existing leading or
trailing whitespace, so the SQL itself is still emitted byte-for-byte
(XmlGenerator's "SQL 내용 임의 변경 금지" rule) and the generated mapper
keeps its indentation.

This was a silent-correctness bug until the sample-project scenario sweep
found it: bodies were emitted with no connector at all and graded SAFE, so
two matching conditions rendered as `WHERE A = ? B = ?`.

## Why a hand-rolled XML parser instead of a DOM library

Two reasons, both load-bearing:

1. **Line numbers.** Every diagnostic (`ParserWarning`/`ParserError`) and
   every AST node needs `sourceFile`/`sourceLine` for the eventual
   diff/navigation UI (spec sections 24-26). A generic DOM library doesn't
   expose that without extra plumbing.
2. **Runs anywhere, including a browser Artifact.** `parser/xml`,
   `parser/ibatis`, `ast/*`, `resolver/*`, `analyzer/dynamic`, and
   `analyzer/parameter` use no Node built-ins at all (`node:fs` only shows
   up in `application/ProjectLoader.js`, which is a thin wrapper these
   stages don't depend on). That means the exact same source files can be
   inlined into a static HTML page and run client-side for a
   paste-iBATIS-XML-and-see-the-analysis demo, with no server and no
   bundler. Don't introduce a DOM/XML npm dependency into these packages —
   it would break that property.

## Why `analyzer/sql` is deliberately separate from `analyzer/dynamic`

The spec calls this out explicitly ("SQL 분석과 iBATIS 구조 분석을 분리한다"):
dynamic-tag structure (isNull, iterate, dynamic prepend, ...) is an iBATIS
templating concern, while table/column/join/WHERE structure is a SQL
semantics concern. `analyzer/dynamic` only ever looks at
`DynamicNode`/`ConditionalNode`/`IterateNode`; `analyzer/sql`/`analyzer/table`
only ever look at flattened SQL text run through a real SQL parser
(node-sql-parser). Neither imports the other's node types — the only
thing that crosses the boundary is the literal SQL *string* `SqlFlattener`
produces.

`analyzer/parameter`'s `usedIn` classification predates `analyzer/sql` and
still does its own lightweight clause-keyword scan rather than consulting
the real SQL AST (see the comment at the top of `ParameterAnalyzer.js`) —
this is now a known, not-yet-paid-down gap rather than a hard blocker: the
two classifications can disagree on an edge case the keyword scan gets
wrong (e.g. a computed expression spanning clause keywords). Reconciling
them — either by having `ParameterAnalyzer` consult `TableAnalyzer`'s
output, or by cross-checking the two in `StatementAnalyzer` and emitting a
diagnostic on mismatch — is open follow-up work, not scheduled to a
specific spec section.

## Diagnostics flow

`DiagnosticBag` (`parser/xml/ParserDiagnostics.js`) is threaded through
every stage by reference (`diagnostics.merge(...)` / `diagnostics.warn(...)`
/ `diagnostics.error(...)`), so `AnalyzerPipeline.run()` returns one flat
`{ warnings, errors }` list spanning parse errors, duplicate-symbol
warnings, missing/circular reference errors, etc. — regardless of which
file or which stage produced them. This is what lets a project with a
handful of broken mappers still produce a usable report for everything
else (see the `test/integration/pipeline.test.js` fixture that mixes a
clean cross-mapper include with a missing-refid file and a circular-refid
file in one run).

## Resolution model: original vs. resolved trees

`ReferenceResolver#resolve(rootNode, namespace, qualifiedId)` never mutates
`rootNode` or any `SqlFragmentNode` sitting in the `SymbolTable` (a
fragment can be included from many places; mutating it in place would
corrupt every other include site). Instead it returns a freshly cloned
`resolvedTree` where only the nodes on an include path are new objects
(`cloneShallowWithChildren` — same class via `Object.create(getPrototypeOf(node))`,
same fields via `Object.assign`, new `children`). `<include>` becomes
either:
- `ResolvedIncludeNode { refid, qualifiedId, children }` — success, children
  are the recursively-resolved content of the target fragment;
- `UnresolvedIncludeNode { refid, reason: 'MISSING' }` — no symbol found;
- `UnresolvedIncludeNode { refid, reason: 'CIRCULAR', path }` — the target
  qualifiedId is already on the current resolution stack.

`resultMap extends` resolution is simpler and *does* mutate its target
node, but only ever the `resolvedParent` annotation field that exists on
`ResultMapNode` for exactly this purpose — see
`ReferenceResolver#resolveResultMapExtends`.

## SqlFlattener's prepend-suppression rule (the trickiest bit of the pipeline)

**Transparent conditionals.** A conditional tag with no `prepend` (and no
`removeFirstPrepend` / `open` / `close`) is transparent. Its children take
part in the *enclosing* tag's "first content" rule, as iBATIS 2.3's
`SqlTagContext` does ("look to the parent"). The flattener (`SqlFlattener`),
the converter (`MyBatisAstConverter` / `DynamicConverter`) and the fuzz
reference runtime (`test/fuzz/runtimes.js`) all implement this. Without it,
the everyday `<isPropertyAvailable><isEqual prepend="AND">` wrapper lost its
AND whenever it wasn't first, which produced broken SQL. In MyBatis, a
prepend-bearing conditional wraps its body in `<trim prefixOverrides>`
listing the prepends of the children that can render first (looking
through transparent wrappers and `<include>`s), because which child comes
first is only known at runtime.


`analyzer/sql/SqlFlattener.js` has to reproduce one specific piece of
iBATIS runtime behavior to turn a dynamic-tag tree into parseable SQL: a
`<dynamic prepend="WHERE|SET">`/`isXxx`/`<iterate>` tag's own `prepend`
attribute is dropped — not substituted with anything — whenever it is the
first non-empty piece of content inside an ENCLOSING conditional tag,
because the enclosing tag's own prepend already served as the connector
when *it* was placed among *its* siblings. At the statement/fragment root
(no enclosing conditional tag), nothing is ever suppressed. Getting the
two roles conflated is an easy, silent-looking bug (it produces almost-
plausible SQL like `WHERE AND x` or a stray leading comma before the first
`SET` column) — if you touch this file, `test/analyzer/sqlFlattener.test.js`
has a case for exactly that regression (`assert.doesNotMatch(sql,
/WHERE\s+AND/)`).

Known simplification: a resolved `<include>`'s spliced-in content is
flattened as its own independent scope rather than participating in the
*surrounding* scope's suppression accounting — see the doc comment at the
top of `SqlFlattener.js` for the case this doesn't handle correctly.

## StatementAnalyzer's degrade-not-throw contract

`analyzer/statement/StatementAnalyzer.js` (section 11) is the one place
that has to reconcile "SQL semantics" (which can fail to parse — dialect
gaps, or a `SqlFlattener` edge case like the nested-`<iterate>` case in
`test/fixtures/iterate.xml`'s `getUsersByGroups`) with "iBATIS structure"
(which basically never fails once resolution has succeeded). When
`SqlAnalyzer` reports a parse error, `StatementAnalyzer` does **not**
throw and does **not** drop the whole statement — it returns
`tables: []`, `columns: []`, `joins: []`, `where: null`, plus one
`{ code: 'SQL_PARSE_FAILED' }` warning, while `dynamicConditions`,
`parameters`, and `includes` (none of which depend on a successful SQL
parse) are still fully populated. `test/analyzer/statementAnalyzer.test.js`
has a case asserting exactly this partial-success shape.

## The analysis API's in-memory project store

`GET /api/v1/statements/:id` and `GET /api/v1/tables/:tableName` need to
look something up by an id that's only unique *within* one
`POST /api/v1/projects/analyze` run. `interfaces/api/server.js` keeps each
run's full pipeline result in a module-level `Map<projectId, result>`
(returned from `analyze` as `projectId`, also accepted as a `?projectId=`
query param on the GET routes; omitting it falls back to "the most
recently analyzed project"). This is intentionally the simplest thing that
works for the tool's actual usage pattern — one local user driving one
analysis at a time — not a general multi-tenant session store; there's no
eviction, so a long-running server process will accumulate project
results in memory for as long as it stays up.

## Grading every converter decision, not just the risky ones

`converter/mybatis/ConversionEvent.js` defines `{ grade, code, message,
sourceFile, sourceLine }` with `grade` one of `SAFE | WARNING | MANUAL |
ERROR`. Every converter (`ParameterConverter`, `ConditionalConverter`,
`DynamicConverter`, `IterateConverter`, `ResultMapConverter`,
`MyBatisAstConverter`) returns a full list of these — including the SAFE
ones — rather than a bare "problems" array, specifically so
`MigrationSafetyAnalyzer` (section 18) can produce the spec's per-statement
`SAFE n / WARNING n / MANUAL n / ERROR n` summary. If you add a new
converter decision, grade it honestly rather than omitting the event for
"obviously fine" cases — an empty event list and "10 SAFE events" look
identical to a human skimming a diff, but only one of them lets the safety
summary actually count anything.

`DynamicConverter`'s grading in particular encodes a specific judgment
call, worth knowing before you touch it: `<where>`/`<set>` are SAFE
whenever the group's own children only use the connector MyBatis's sugar
tag itself strips (`AND`/`OR` for `<where>`, `,` for `<set>`); a
faithfully-inferred `<trim>` for a group that was never claiming to be a
WHERE/SET idiom (a nested `<dynamic prepend="AND">`, say) is *also* SAFE,
because the `prefixOverrides` it's built from are directly observed, not
guessed; only a WHERE/SET group whose children mix in a connector *outside*
`{AND, OR}` / `{","}` is WARNING-graded, because that's a real deviation
from the idiom node-sql-parser and MyBatis's sugar tags assume.
`test/converter/mybatisAstConverter.test.js`'s
`dynamic-unusual-connector.xml` case exists specifically to keep that
WARNING path from silently regressing to SAFE (or vice versa).

## Nested `<iterate>`: item names and collection rewriting

MyBatis's `<foreach>` has no loop-relative syntax equivalent to iBATIS's
`#outer[].inner[]#` — a nested loop's `item` name must be unique, and its
`collection` must be an OGNL expression relative to the *current* scope
(the outer loop's `item`), not the original bracket path. `MyBatisAstConverter`
assigns item names by nesting depth (`item`, `item2`, `item3`, ...) and
uses `ParameterConverter#resolveCollectionExpression` /
`resolveExpression` (same underlying prefix-matching logic, one for the
`<foreach collection>` attribute, one for `#{...}` references inside the
loop body) walking an `iterateStack` of `{ property, item }` pairs built up
as conversion descends into each `<iterate>`. Get this wrong and the
generated mapper doesn't just look different — it throws an OGNL property-
not-found error at runtime, because `groups` genuinely isn't in scope
inside the inner `<foreach>`. See `test/fixtures/iterate.xml`'s
`getUsersByGroups` and its converter test for the case this guards.

## One DependencyGraph, four edge kinds, no separate classes

`resolver/reference/DependencyGraph.js` (`addEdge(from, to, kind)` /
`getDependencies(id)` / `getDependents(id)`) was originally built for
`<include>` resolution alone (`kind: 'INCLUDE'` / `'INCLUDE_MISSING'`) and
`resultMap extends` (`kind: 'EXTENDS'`). Section 22 needed a statement's
`resultMap`/`parameterMap` attribute represented as a dependency too, so
`ReferenceResolver#linkStatementDependencies` (new) adds `'RESULT_MAP'` /
`'PARAMETER_MAP'` edges into the *same* graph rather than introducing a
parallel structure — `analyzer/dependency/DependencyAnalyzer` then just
filters `getDependencies(id)` by `kind` to build the include tree, the
resultMap chain, and the parameterMap reference as three separate fields
(spec section 22's explicit "별도로 표현" requirement), all from one
project-wide graph. If you add a new kind of statement-level reference
that should show up in dependency reporting, follow the same pattern:
teach `ReferenceResolver` to resolve it and record an edge with a new
`kind` string, rather than building a second graph.

`analyzer/dependency/DependencyAnalyzer#buildTableDependencyGraph` is
unrelated to this graph — it's built fresh from `StatementAnalysis.joins`
(actual `JoinRelation`s discovered by `analyzer/table`), because spec
section 21 is explicit that table-to-table dependency must come from SQL
actually observed, not from `resultMap`/`parameterMap`/include structure.
