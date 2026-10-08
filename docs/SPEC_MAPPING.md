# Spec section -> implementation mapping

Original spec had 27 numbered sections plus a "핵심 구현 원칙" closing
section. Status legend: **DONE** (implemented + unit/integration tested),
**PARTIAL** (some real behavior exists, rest is stubbed), **STUB**
(interface exists, method body is `throw new Error(...not implemented...)`).

> Note: an earlier revision of this file briefly dropped sections 19-20
> (Mapper Report / Project Report) and renumbered everything after them.
> That didn't match the actual spec (which the rest of this repo, including
> `MapperReport.js`/`ProjectReport.js` and their tests, is built against),
> so the original 1-27 numbering is restored here.

| # | Section | Status | Where |
|---|---------|--------|-------|
| 0 | 전체 목표 / pipeline overview | — | this repo, see `docs/ARCHITECTURE.md` |
| 1 | 프로젝트 기본 구조 | **DONE** | `src/{parser,ast,resolver,analyzer,converter,generator,report,application,interfaces}` |
| 2 | iBATIS XML Parser | **DONE** | `src/parser/xml/*`, `src/parser/ibatis/IbatisMapperParser.js` |
| 3 | Symbol Table | **DONE** | `src/resolver/symbol/*` |
| 4 | refid / Reference Resolver | **DONE** | `src/resolver/reference/*` |
| 5 | Dynamic SQL 분석기 | **DONE** | `src/analyzer/dynamic/*` |
| 6 | Parameter 분석기 | **DONE** | `src/analyzer/parameter/*` |
| 7 | SQL 테이블 분석기 | **DONE** | `src/analyzer/sql/*`, `src/analyzer/table/TableAnalyzer.js` — including the read side of `INSERT INTO t (...) SELECT ...`, which is what puts an archive/copy statement's source tables into the table report and the dependency graph |
| 8 | 컬럼 분석기 | **DONE** | `src/analyzer/table/TableAnalyzer.js` (`ColumnUsage`) |
| 9 | JOIN 분석기 | **DONE** | `src/analyzer/table/TableAnalyzer.js` (`JoinRelation`) — INNER/LEFT/RIGHT/FULL/CROSS each keep their own `JoinType` (one shared `normalizeJoinType`, so the lineage graph and the table analysis never disagree), and a comma join (`FROM A, B WHERE A.X = B.X`) is recovered from the WHERE clause as `IMPLICIT_JOIN` (`analyzer/table/implicitJoins.js`) instead of being reported as "no joins" |
| 10 | WHERE 조건 분석기 | **DONE** | `src/analyzer/table/TableAnalyzer.js` (AND/OR `LogicalNode`/`ComparisonNode` tree) — dynamic-condition-to-SQL-condition linkage is via `ParameterUsage.dynamicCondition`, not a dedicated cross-reference structure yet |
| 11 | Statement 종합 분석 결과 | **DONE** | `src/analyzer/statement/StatementAnalyzer.js` — also carries `lineage` (see `src/analyzer/lineage/*`): the SELECT hierarchy + alias->source-column lineage the section 26 dashboard draws. Like the rest of the composite result it degrades to an empty lineage (never throws) when the flattened SQL didn't parse |
| 12 | Parameter 변환 (`#x#`->`#{x}`) | **DONE** | `src/converter/mybatis/ParameterConverter.js` — including iBATIS's inline `#prop:jdbcType#` / `#prop:jdbcType:nullValue#` forms, which map to MyBatis's own attribute syntax (`#{prop,jdbcType=NUMERIC}`); copying the colon form through produced `#{prop:NUMERIC}`, which MyBatis does not understand and which only fails at runtime. MyBatis has no inline `nullValue`, so that field is dropped with a MANUAL `UNSUPPORTED_NULL_VALUE` event |
| 13 | Dynamic Tag -> `<if>` 변환 | **DONE** | `src/converter/mybatis/ConditionalConverter.js`, plus `MyBatisAstConverter#withConnector`, which writes the iBATIS `prepend` connector into the `<if>` body (AND/OR in front, `,` at the end, an `<iterate>`'s connector into the `<foreach open>`). MyBatis only ever *strips* a connector, never inserts one, so without this two matching conditions rendered as `WHERE A = ? B = ?` — see docs/ARCHITECTURE.md |
| 14 | `dynamic` -> `where`/`set`/`trim` | **DONE** | `src/converter/mybatis/DynamicConverter.js` |
| 15 | `iterate` -> `foreach` | **DONE** | `src/converter/mybatis/IterateConverter.js` (including nested `<iterate>`: distinct `item` names + a `collection` rewritten relative to the outer loop variable) |
| 16 | resultMap/parameterMap 분석+변환 | **DONE** | extends-chain resolution via `ReferenceResolver#resolveResultMapExtends`; MyBatis conversion via `src/converter/mybatis/ResultMapConverter.js` (keeps `extends` as a direct MyBatis reference rather than flattening — MyBatis natively supports `<resultMap extends>` too; see the file's own doc comment). `parameterMap`-based statements are intentionally **not** auto-converted (positional `?` binding has no safe automatic `#{}` mapping) — flagged MANUAL instead, see `MyBatisAstConverter` |
| 17 | MyBatis XML Generator | **DONE** | `src/generator/xml/XmlGenerator.js` |
| 18 | Migration Safety Analyzer | **DONE** | `src/report/migration/MigrationSafetyAnalyzer.js`, fed by `ConversionEvent[]` from every `converter/mybatis/*` decision (see `src/converter/mybatis/ConversionEvent.js`) |
| 19 | Mapper 단위 Migration Report | **DONE** | `src/report/migration/MapperReport.js` |
| 20 | 프로젝트 전체 테이블 사용 리포트 | **DONE** | `src/report/migration/ProjectReport.js` |
| 21 | 테이블 Dependency Graph | **DONE** | `src/analyzer/dependency/DependencyAnalyzer.js#buildTableDependencyGraph` — table->table edges built strictly from `JoinRelation`s actually found in SQL (never inferred FKs), each edge carrying the supporting statement ids |
| 22 | Statement Dependency Graph | **DONE** | `DependencyAnalyzer#buildStatementDependencyTree` — the include/extends graph (`resolver/reference/DependencyGraph.js`) rendered as a cycle-safe tree, with resultMap extends chain and parameterMap reference kept as separate fields rather than folded into the include tree (per the spec's explicit "별도로 표현" wording). A statement's `resultMap`/`parameterMap` attribute is now itself resolved and recorded as a graph edge by `ReferenceResolver#linkStatementDependencies` (new — this link didn't exist before section 22 needed it) |
| 23 | 분석 API | **DONE** | `src/interfaces/api/server.js` — `POST /api/v1/projects/analyze` (also returns `generatedMapperXml` and `tableDependencyGraph`), `GET /api/v1/statements/:id`, `GET /api/v1/tables/:tableName`, `GET /api/v1/statements/:id/dependencies`, and `GET /api/v1/statements/:id/mybatis-preview` are all real (backed by per-`projectId` `ProjectSession`s: index + on-demand loading, see docs/features/large-projects.md) |
| 24 | 분석 화면 (4-pane UI) | **PARTIAL** | `src/interfaces/api/public/{index.html,app.js,lineage.js,schema.js,datasets.js,styles.css,dashboard.css,schema.css}` — plain static files with no build step, served by the same Express app (`express.static`) and driven entirely by `fetch` calls to the section 23 API. **One screen with two views**, switched from a `role="tablist"` at the top of the left menu: **리니지** (the section 26 dashboard, `lineage.js`) and **변환** (`schema.js`; it replaced the separate MyBatis tab, with the syntax conversion now a toggle on top of the column renames — see docs/features/schema-view.md). Both render the statement selected in the shared left tree, so switching view keeps the tree, its scroll position and the selection. The per-statement Mapper Tree / statement-structure screen was removed at the user's request ("Statements는 아직 없어도 되고"); its `/statements/:id` API is untouched and still tested, so the screen is UI work to re-add, not analysis work. The iBATIS screen deliberately shows nothing from the conversion — the converted XML, its migration events and its SAFE/WARNING/MANUAL/ERROR grading all live in the 변환 view |
| 25 | 테이블 분석 화면 | **NOT BUILT** | the Table Explorer tab was removed at the user's request ("Tables도 아직 없어도 되"). The data behind it is intact and tested — `ProjectReport` (section 20), `DependencyAnalyzer#buildTableDependencyGraph` (section 21) and the `/tables/:name` endpoint — so this is a UI-only gap |
| 26 | 변환 Diff 화면 + SQL Lineage Dashboard | **DONE** | Two things now live under this section. (a) The **diff**: the 변환 view (`public/schema.js`). It shows the selected statement only: original iBATIS on the left, and on the right the result with the column renames, in iBATIS syntax or (toggle) MyBatis 3. The two sides are line-paired and token-marked, with renames in red/green and MyBatis syntax in violet. The graded events of both conversions are listed below, and a whole-file mode lists every node of the file. (b) The **SQL Lineage Dashboard** (`public/lineage.js` + `dashboard.css`), a stat strip / XML tree / graph / mapping-panel layout: every SELECT is a cluster box, a subquery is drawn *inside* the SELECT that owns it (any depth), UNION branches are sibling clusters, `<include refid>` boxes carry the fragment's real SQL, `<dynamic>`/`<isXxx>`/`<iterate>` are dashed boxes, and the right panel resolves alias -> source table.column -> Java property. Hover highlights a node's neighbours, clicking a column-mapping row lights its whole lineage path, clusters collapse, and the graph pans/zooms with a minimap. Data comes from `analysis.lineage` (`analyzer/lineage`) plus the mapper XML itself — no new endpoint |
| 27 | 테스트 | **PARTIAL** | fixtures + tests exist for every implemented backend section, 1-23 (including `analyzer/lineage`: `test/fixtures/lineage-customer-statistics.xml` + `test/analyzer/lineageAnalyzer.test.js`) (`test/fixtures/*.xml`, `test/{parser,resolver,analyzer,converter,generator,report,interfaces,integration}`); the section 24-26 static frontend was verified by hand in a real browser (see below) rather than with automated tests — there's no browser-test runner in this project yet |

## Converter coverage added with the advanced sample

Found by `samples/advanced/adv-02-ibatis-syntax.xml`. Each of these was
being converted wrongly *and* graded SAFE before:

- `compareProperty`: now `<if test="a != b">`. It was compared to the
  string `'null'`.
- `isParameterPresent` / `isNotParameterPresent`: now `_parameter != null`.
  Before, the tag was dropped and its `WHERE` prepend went with it, which
  produced invalid SQL.
- `<isXxx open/close/removeFirstPrepend>` and `<dynamic open/close>`: now
  body text, and a `<trim>` (`prefix="WHERE ("`, `suffix=")"`). These
  attributes used to be silently dropped.
- A conditional `property` inside `<iterate>`: now rewritten to the foreach
  item (`groups[].x` becomes `item.x`). The old output failed at runtime
  with an OGNL error.
- `groupBy` becomes `<id>`. A nested `resultMap` becomes `<collection>`
  (with groupBy) or `<association>`. A nested `select` becomes
  `<association select>` (or `<collection>` for List types). These are
  graded WARNING. All three used to become a bare `<result>`.
- `<procedure>` becomes `statementType="CALLABLE"`.
- `isPropertyAvailable` is now WARNING (`!= null` is not "present").
- A statement's `cacheModel` is now WARNING (there is no per-statement
  equivalent).

## Converter fixes found by the differential runtime test

`test/fuzz/runtimeDifferential.test.js` renders random iBATIS dynamic SQL
with a reference iBATIS runtime and a reference MyBatis/OGNL runtime and
compares the SQL and the bound values. Every one of these had been converted
silently wrong and graded SAFE:

- **`compareValue="Y"` became `f == 'Y'`.** OGNL reads a one-character `'Y'`
  as a Character, and comparing it with a String throws
  NumberFormatException. Now `f == 'Y'.toString()`.
- **`<isNotEmpty property="ids">` around `<iterate property="ids">` became
  `ids != ''`.** An empty List is never `== ''`, so the condition passed and
  rendered `IN` with nothing after it. Now `ids.size() > 0`.
- **`isLessThan` and similar became `n < 5`.** OGNL treats null as 0,
  while iBATIS treats null as not comparable. Now guarded with `!= null`;
  two null `compareProperty` sides still count as equal, as in iBATIS.
- **A prepend-bearing conditional whose first content is another
  prepend-bearing tag (or an `<include>`)** rendered `OR OR …`. iBATIS drops
  the nested prepend. Now a `<trim prefixOverrides>`.
- **Prepend-less wrappers are transparent.** See docs/ARCHITECTURE.md (the
  SqlFlattener section).

Known OGNL difference that is left as is: `x != ''` is false for the number
`0`, while iBATIS `isNotEmpty` is true. The property's type isn't known
statically, so this is documented, not converted.

## Derived work beyond the 27 sections

| Feature | Status | Where |
|---|---|---|
| SQL schema migration (old -> new table/column names, per-table column maps, alias/scope-aware, dynamic SQL + `<include>` contexts) | **DONE** (backend + tests; no UI/API yet) | `src/converter/schema/*`, opt-in via `new AnalyzerPipeline({ schemaMigrationConverter })` -> `result.schemaMigration`; `test/converter/schema/*`; see `docs/features/schema-migration.md` |

## Manual verification of the section 24-26 UI

The static frontend is driven end-to-end in an actual Chrome tab against a
running `node src/interfaces/api/server.js`: Load sample -> Analyze -> the
SQL Lineage dashboard's stat strip, XML tree, nested-cluster graph and
alias/source/Java panels populate -> selecting a statement in the tree
redraws the graph for it -> the MyBatis tab lists the converted mappers and
shows a statement's converted XML with its migration events.

The walkthrough below describes the Statements and Tables tabs, which were
since removed; it is kept because the bug it records is about `styles.css`
and still applies.

One real bug was caught and fixed this way: `.screen[hidden]` needed an
explicit rule in `styles.css` because the class selector `.screen { display:
flex }` otherwise won the cascade over the browser's default `[hidden] {
display: none }` (equal specificity, author stylesheet wins), which made
both tab screens render at once.

Mermaid and the two diagrams it drew were removed with the Statements and
Tables tabs; nothing in the UI loads a diagram library any more. For the
record, they had been verified the same way in an earlier pass:
`user.getUserOrders`'s lineage diagram rendered `USER (U)` and `ORDERS (O)`
as cylinder nodes with a `LEFT_JOIN` edge and `USER_ID`/`ORDER_ID` dotted
edges into a `Result` node; `user.getUserList`'s dynamic-flow diagram
rendered `SQL` / `include baseColumns` / `WHERE` siblings under the root,
with `WHERE` leading into a `status != null` decision diamond; the Tables
tab's project-wide lineage diagram rendered `USER --1 stmt--> ORDERS`. No
console errors in any case.

The SQL Lineage Dashboard was verified the same way, in a real Chrome tab
against `npm start`, on the sample project's `stat.getCustomerOrderStatistics`
(the sample mapper `statistics.xml` exists for exactly this shape): the graph
rendered `MAIN` containing `S1 · Inline View · JOIN` containing
`S2 · Subquery · WHERE` (two levels of real nesting) plus
`S3 · Scalar Subquery · SELECT list`; the stat strip read 4 SELECT / 2
include / 5 tables / 1 join / 3 subqueries; hovering `PAYMENT (PM)` dimmed
everything unconnected and lit its two output edges; clicking the
`totalPayment` row in "SELECT 컬럼 매핑" lit `PAYMENT.PAYMENT_AMOUNT ->
S1 -> MAIN.totalPayment`; the breadcrumb read
`stat.getCustomerOrderStatistics › Main SELECT › S1 · Inline View · JOIN ›
S2 · Subquery · WHERE › TABLE ORDER_DETAIL (OD)`; "서브쿼리 접기" collapsed
3 clusters and "전체 펼치기" restored them; `stat.getCustomerDirectory`
rendered its UNION branch as a sibling cluster. The tablet (≈1000px) and
phone (≈420px) layouts were checked by loading the app in a fixed-width
iframe, since the test browser window itself could not be resized: at
≤1200px the right-hand panels move under the graph as a card grid, and at
≤860px everything stacks into one column with each cluster's
source/transform/output columns restacked vertically. Two real bugs were
caught this way: edges and "fit to screen" both computed zero geometry when
they ran while the screen was still `hidden` (now retried across frames),
and `table-layout: fixed` on the side tables broke the Java-mapping table's
column widths.

## Fixture coverage vs. the section-27 checklist

Implemented and covered by a fixture + test today:

simple select, dynamic WHERE, nested dynamic, isNull/isNotNull, isEqual/
isNotEqual (+ every other `isXxx`), iterate (incl. nested iterate), include,
nested include, cross mapper refid, missing refid, circular refid,
resultMap extends, parameterMap, selectKey, `$...$`, UPDATE dynamic SET,
INSERT/UPDATE/DELETE table operations (`write-statements/crud.xml`), JOIN (`join.xml`),
subquery — both FROM-derived-table and WHERE-IN (`subquery.xml`), UNION
(`union.xml`), multiple aliases + duplicate column names across tables
(`aliases-and-duplicate-columns.xml`), MySQL-flavored LIMIT
(`dialect-mysql.xml`), Oracle via the closest available dialect
(`dialect-oracle.xml`, see the SqlAnalyzer note below), an unusual dynamic
connector token forcing the `<trim>` fallback with a WARNING
(`dynamic-unusual-connector.xml`).

Not covered by a fixture, and not planned as one: full DTD/XSD validation
of generated MyBatis XML (only well-formedness is checked, by round-
tripping the generator's output back through this project's own XML
parser — see `test/generator/xmlGenerator.test.js`) and Oracle-only SQL
extensions (`ROWNUM`, `DUAL`, `(+)`, `MERGE`), which no available
node-sql-parser dialect can parse at all (see the dialect note below) —
there is no fixture that could pass for that case, only the documented
limitation.

## node-sql-parser dialect limitation (SqlAnalyzer)

node-sql-parser has no dedicated Oracle grammar, and its more ANSI-leaning
dialects (`transactsql`, `db2`, `postgresql`) reject the bare `?`
placeholder that `SqlFlattener` always produces for `#x#`/`$x$`. Passing
`dialect: 'oracle'` to `SqlAnalyzer` is therefore aliased to `mysql` — the
closest available dialect that both accepts `?` and parses portable ANSI
JOIN/subquery/UNION SQL that also happens to be valid Oracle SQL.
Oracle-only extensions (`ROWNUM`, `DUAL`, the `(+)` outer-join operator,
`MERGE`) are **not** supported by any available dialect and will fail to
parse — statements using them fall back to `StatementAnalyzer`'s
`SQL_PARSE_FAILED` warning path (tables/columns/joins/where come back
empty, everything else — dynamic SQL, parameters, includes — still
succeeds).

## Browser Artifact demo (paste iBATIS XML, see the analysis)

Because `parser/xml` -> `analyzer/parameter` has zero Node-specific
dependencies (see `docs/ARCHITECTURE.md`), those stages were also
published as a standalone HTML page where you paste a single iBATIS mapper
XML and get parsed statements / dynamic SQL tree / parameter usage /
diagnostics back instantly, client-side. That page is **not** part of
`src/` — it's a separately maintained bundle (inlined, no imports) because
Artifacts can't `import` local project files, and it intentionally stops
at section 6 (it does not embed `node-sql-parser`, so it has no
table/column/join/where analysis). If you change `parser/xml`,
`parser/ibatis`, `ast/ibatis`, `resolver/*`, `analyzer/dynamic`, or
`analyzer/parameter` in a way that matters for the demo, the artifact's
inlined copy needs to be re-synced by hand (or regenerated) — it will not
pick up the change automatically.
