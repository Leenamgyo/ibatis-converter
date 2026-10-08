# Testing

## Running

```
npm test
```

This runs `node --test "test/**/*.test.js"`. Two traps:

- **Bare `node --test`** also runs every `.js` file under any `test/`
  directory, because that is one of Node's default patterns. That includes
  the golden-file generators in `test/fixtures/**/generate*.js`, which
  silently rewrite the golden files before the golden tests read them, so
  those tests can never fail. Always use the glob, as `npm test` does.
- **`node --test test/`** (a directory) fails with `MODULE_NOT_FOUND` on
  this Node version (v25).

`test/fuzz/` contains seeded property tests. `schemaGrammar.test.js`
checks random SQL against its known migration. `runtimeDifferential.test.js`
renders random iBATIS dynamic SQL with reference iBATIS and MyBatis/OGNL
runtimes and compares the output. `projectCorpus.test.js` generates whole
legacy projects (`projectGen.js`) and checks the folder scan, refid
chains, diagnostics and MyBatis output. Use `FUZZ_PROJECTS=200` for a deep
run. Default sizes keep `npm test` fast; run
`FUZZ_SEEDS=200000 node --test test/fuzz/schemaGrammar.test.js` for a deep
run.

No build step, no TypeScript, no test framework dependency — everything
is `node:test` + `node:assert/strict`. This covers every backend package
(`src/**` except `interfaces/api/public`). The static UI
(`interfaces/api/public`) has no automated tests — there's no browser-test
runner in this project — and was instead verified by hand in a real Chrome
tab; see docs/SPEC_MAPPING.md's "Manual verification of the section 24-26
UI" note for exactly what was clicked through and the one real bug it
caught. If you change `public/*`, re-verify the same way (`npm start`,
open `http://localhost:4000`, click through Load sample -> Analyze -> a
statement in the lineage tree -> the MyBatis tab) rather than trusting
`npm test` alone.

## Layout

```
test/
  fixtures/            iBATIS mapper XML used by more than one test file
  parser/              XmlParser + IbatisMapperParser unit tests
  resolver/            SymbolTable + ReferenceResolver unit tests
  analyzer/            DynamicSqlAnalyzer / ParameterAnalyzer / SqlFlattener /
                        TableAnalyzer / StatementAnalyzer / LineageAnalyzer
                        unit tests
  converter/           MyBatisAstConverter unit tests (parameter/conditional/
                        dynamic/iterate/resultMap conversion + grading)
    schema/            SQL schema migration (converter/schema): plain-SQL cases,
                        plus mapper-level / pipeline cases over
                        fixtures/schema-migration/{content.xml,mapping.json};
                        the 10 reviewed scenario cases + their checked-in results
                        live in fixtures/schema-migration/{cases,results}/ (README
                        there), asserted by integration/schemaMigrationCases.test.js;
                        a generated ~2000-line legacy/new-schema oracle pair in
                        fixtures/schema-migration/large/, asserted by
                        integration/schemaMigrationLarge.test.js
  generator/           XmlGenerator unit tests (well-formedness via a
                        round-trip back through this project's own parseXml)
  report/              MapperReport / ProjectReport / MigrationSafetyAnalyzer
                        unit tests
  interfaces/          HTTP-level tests against `createApp()` (real requests
                        via `fetch` against an ephemeral `server.listen(0)`,
                        no mocking)
  integration/         AnalyzerPipeline end-to-end tests (multiple files at once),
                        including `sampleProject.test.js` (see below) and
                        `writeStatements.test.js` (INSERT/UPDATE/DELETE/PROCEDURE,
                        which the SELECT-only sample project no longer carries)
```

Each package under `src/` that has real behavior (not a stub) has a
corresponding directory here. When you implement a currently-stubbed
package (`analyzer/sql`, `converter/mybatis`, ...), add its test directory
at that point — don't pre-create empty ones.

## The sample project is the scenario matrix

`src/interfaces/api/public/samples/*.xml` is not demo filler. It is one
mapper per scenario - baseline reads, dynamic SQL, joins, subqueries,
UNION/CTE, refid, resultMap, a legacy report query, and the cases that
must degrade loudly - and it is what the UI's "Load sample" button loads
*and* what `test/integration/sampleProject.test.js` analyzes. Adding a
scenario means adding it there, so the dashboard demo and CI can never
drift apart.

The sample project is **SELECT-only**: it backs the UI's lineage and
dynamic-SQL screens, which are for reading legacy queries. Writes are not
untested — they moved to `test/fixtures/write-statements/` +
`test/integration/writeStatements.test.js`.

Two of those statements are deliberately broken (`frag.missingRefid`,
`frag.circularRefid`) and four are deliberately unparseable (`$...$` in a
table/ORDER BY position, mutually exclusive FROM branches, Oracle `(+)`);
the test asserts that exact list, so a *new* statement that silently stops
analyzing fails the build.

This sweep is what found the join-type collapse (FULL/CROSS reported as
`OUTER_JOIN`), the missing `INSERT ... SELECT` read side, the comma-join
blindness, the inline `#prop:jdbcType#` mis-parse, and the missing
`prepend` connectors in converted `<if>` bodies.

## Fixture catalog (`test/fixtures/*.xml`)

| File | Exercises |
|---|---|
| `simple-select.xml` | baseline `<select>` parsing + source location |
| `dynamic-where.xml` | `<dynamic prepend="WHERE">` with two `isNotNull` conditions |
| `nested-dynamic.xml` | `<dynamic>` nested inside a condition inside another `<dynamic>` |
| `conditions.xml` | all 12 standardized `isXxx` tags in one statement |
| `iterate.xml` | `<iterate>` (simple) and nested `<iterate>` |
| `include-basic.xml` | same-mapper `<include refid>` |
| `include-nested.xml` | fragment-includes-fragment, 3 levels deep |
| `cross-mapper/order.xml` + `cross-mapper/common.xml` | namespace-qualified refid across two files |
| `missing-refid.xml` | `<include refid>` with no matching `<sql>` |
| `circular-refid.xml` | `a -> b -> c -> a` include cycle |
| `resultmap-extends.xml` | 3-level `resultMap extends` chain, plus a `<select resultMap="UserDetailResult">` statement so the statement->resultMap dependency link (section 22) has something to resolve |
| `parametermap.xml` | `<parameterMap>` + `<parameter>` |
| `raw-substitution.xml` | `$orderBy$` -> `RAW_SQL_SUBSTITUTION`/`SQL_INJECTION` warning |
| `join.xml` | LEFT JOIN with a compound (AND) ON clause — the exact shape from the spec's own JOIN example |
| `subquery.xml` | a FROM-clause derived table, and a `WHERE ... IN (subquery)` |
| `union.xml` | `UNION` of two SELECTs, tables from both branches folded into one result |
| `aliases-and-duplicate-columns.xml` | two tables aliased `U`/`O`, both with a `STATUS` column — proves alias resolution doesn't conflate them |
| `dialect-mysql.xml` | MySQL-flavored `LIMIT offset, limit` |
| `dialect-oracle.xml` | portable ANSI JOIN/subquery SQL parsed via the `oracle` -> `mysql` dialect alias (see docs/SPEC_MAPPING.md for why) |
| `dynamic-unusual-connector.xml` | a `<dynamic prepend="WHERE">` child using `prepend="XOR"` — forces the `<trim>` fallback with a WARNING instead of `<where>` |
| `lineage-customer-statistics.xml` | the SELECT hierarchy the lineage dashboard draws: a JOINed inline view, a scalar subquery in the SELECT list, a subquery nested inside the inline view, a UNION branch, and a resultMap for alias -> Java field |
| `write-statements/` | **the only place with non-SELECT statements.** `crud.xml` (INSERT/UPDATE/DELETE as distinct `TableOperation`s), `selectkey.xml` (`<selectKey type="pre">` inside an `<insert>`), `update-dynamic-set.xml` (`<dynamic prepend="SET">` then a literal `WHERE` — clause tracking sticky-but-overridable), plus `{basic,dynamic,procedure}.xml`: both `<selectKey>` timings, a parameterMap insert graded MANUAL, `INSERT ... SELECT`'s read side, subquery-driven UPDATE/DELETE, `<dynamic prepend="SET">` -> `<set>`, and a `{ call ... }` `<procedure>` that must degrade to `SQL_PARSE_FAILED`. See `test/integration/writeStatements.test.js` |
| `dynamic-from-and-subquery.xml` | where dynamic SQL meets subqueries: a subquery in the SELECT list, a FROM-clause derived table, a conditionally-added JOIN, `<dynamic>` nested inside a subquery, a conditionally-added UNION branch — plus the one shape that can't flatten, two mutually exclusive branches each supplying the FROM table (`SQL_PARSE_FAILED`). See `test/analyzer/dynamicFromAndSubquery.test.js` |

`cross-mapper/` is its own subdirectory specifically so
`test/integration/pipeline.test.js` can point `ProjectLoader`-style code at
a directory containing more than one file without also picking up the
single-file fixtures at the top level.

### `test/fixtures/complex/` — a realistic multi-file project

Unlike the fixtures above (each isolating one narrow behavior),
`test/fixtures/complex/` is a 25-file, SELECT-only "small realistic
project": a `common.xml` of shared fragments plus 24 domain mappers for an
e-commerce schema (users/roles/permissions, catalog, inventory,
orders/payments/shipping, coupons/cart/wishlist, notifications/audit
logs, and cross-domain reporting). It exists to prove the pipeline holds
up at realistic scale — many files, many namespaces, many cross-mapper
`<include refid>` edges — with every dynamic
SQL/iterate/resultMap-extends/selectKey/parameterMap shape combined in the
same run, including a `RIGHT JOIN` (every other join fixture in the
project is `LEFT`/`INNER`) and a same-file `<sql>`/`<include refid>` in
`report.xml` alongside the namespace-qualified ones in `common.xml`.
`test/fixtures/complex/model/*.java` are reference-only JavaBean POJOs
(not compiled or run by this Node project) whose fields were generated
from every `parameterClass`/`resultMap class` and `#property#`/`<result
property>` binding in that project, so the iBATIS-XML-to-Java-property
match for every mapper is easy to eyeball. `test/integration/
complexFixtures.test.js` runs the full pipeline over it once and pins
down the known-unusual statements (two intentional `SQL_PARSE_FAILED`
sites, four `RAW_SQL_SUBSTITUTION` sites, one `MANUAL`-graded
`parameterMap` conversion) by diagnostic code, per the convention below. A
curated 9-file subset of the same project (`common`, `user`, `role`,
`permission`, `product`, `category`, `order`, `orderItem`, `report.xml`)
was once wired into the web UI's "Load sample" button; the UI now loads
`public/samples/` instead (see "The sample project is the scenario matrix"
above), so `test/fixtures/complex/` is purely a scale test for the
pipeline.

Every fixture in this catalog is now exercised by at least one converter
and/or generator test too (`test/converter`, `test/generator`), not just
the parser/resolver/analyzer layers — a fixture that only proves parsing
is an incomplete fixture once the corresponding converter exists. Not
covered, and not expected to be: full MyBatis DTD/XSD validation (only
well-formedness is checked) and Oracle-only SQL syntax that no available
node-sql-parser dialect can parse at all (see docs/SPEC_MAPPING.md).

## Conventions

- One `test(...)` per behavior, named as a full sentence describing the
  expected behavior (not "test 1", not the method name alone) — e.g.
  `'detects a circular <include> chain (A -> B -> C -> A) without a stack overflow'`.
  These names are the actual test output; a future contributor should be
  able to `npm test` and understand what broke from the name alone.
- Diagnostics assertions check `.code` (e.g. `'CIRCULAR_REFERENCE'`,
  `'MISSING_REFERENCE'`, `'DUPLICATE_SYMBOL'`, `'RAW_SQL_SUBSTITUTION'`),
  not `.message` substrings, wherever a code exists — message text is
  allowed to change for readability, codes are the stable contract.
- Prefer loading a fixture file over an inline XML string when the
  scenario is reusable or already listed in the catalog above; use an
  inline string (see `ibatisParser.test.js`'s `parseFromSource` helper)
  only for a one-off edge case not worth a named fixture.
- Integration tests (`test/integration/`) should combine at least one
  "broken" file (missing/circular reference) with otherwise-valid files in
  the same run, to keep proving the partial-failure guarantee described in
  `docs/ARCHITECTURE.md` — don't let it regress to "integration test only
  covers the happy path."
