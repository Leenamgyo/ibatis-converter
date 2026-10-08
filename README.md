# ibatis-migration-analyzer

A static analysis tool for migrating legacy **iBATIS 2.x** XML Mappers to
**MyBatis 3.x** — built as a real compiler-style pipeline (XML → AST →
reference resolution → semantic analysis → target AST → XML), not a
find-and-replace script. Every `#userId#` → `#{userId}`, every
`<dynamic prepend="WHERE">` → `<where>`, every `<include refid>` is a typed,
tested, AST-to-AST transformation, and every one of those decisions is
graded **SAFE / WARNING / MANUAL / ERROR** so a migration can be reviewed
instead of trusted blindly.

```
iBATIS XML
  → XML Parsing            (hand-rolled, line-tracking, zero dependencies)
  → iBATIS AST
  → Symbol Table / Reference Resolver   (include/refid, resultMap extends)
  → Dynamic SQL Analyzer
  → SQL / Table / Column / JOIN / WHERE Analyzer   (node-sql-parser)
  → MyBatis AST Converter               (graded ConversionEvents)
  → MyBatis XML Generator
  → Migration Report                    (per-mapper + project-wide)
```

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the full pipeline
and the non-obvious design decisions behind it (why the XML parser is
hand-rolled, how dynamic-tag prepend suppression works, how nested
`<iterate>` gets safe MyBatis `item`/`collection` names, and more).

## What it can tell you

- Which tables and columns a statement touches, and how (`SELECT` / `WHERE`
  / `JOIN` / `ORDER BY` / `INSERT` / `UPDATE SET` / ...), including through
  subqueries and `UNION`
- Which statements would break if you changed a given table, column, or
  `<sql>` fragment — a project-wide dependency graph, not just per-file
- Every `<include refid>` chain fully resolved (nested, cross-mapper,
  missing, or circular — reported as a diagnostic, never a crash)
- A converted MyBatis mapper for every statement, with a
  SAFE/WARNING/MANUAL/ERROR breakdown of exactly what changed and why
- All of the above through a JSON API and a small built-in web UI — no
  build step, paste or upload your mapper and go

## Quick start

```bash
npm install
npm test                 # node --test "test/**/*.test.js" (see docs/TESTING.md)
npm start                # serves the API + UI on http://localhost:3000
npm run dev              # same, but restarts on any src/ change
```

### A whole project folder, from the command line

```bash
npm run migrate -- /path/to/legacy-project --out migration-output \
                   [--mapping schema-mapping.json] [--preserve-result-columns] \
                   [--fail-on manual|warning]
```

It finds every iBATIS mapper under the folder by its root element
(`<sqlMap>`). It skips `pom.xml`, Spring/log4j/web.xml, `sqlMapConfig.xml`
and mappers that are already MyBatis. It never descends into `target/`,
`build/`, `node_modules/`, `.git/` …, because Maven's `target/classes` holds
a copy of every mapper. It decodes EUC-KR / MS949 when the XML declares it.
It writes:

- `mybatis/<same path>`: the MyBatis 3 mappers
- `mybatis-schema/<same path>`: the same mappers with the old -> new
  table/column renames from `--mapping` (a mapping or an exported dataset
  JSON)
- `report.md` / `report.json`: what a human has to review, per file, and
  every XML file that was skipped and why

`--fail-on` exits with code 2 when that grade occurs, for CI. The source
tree is never written to.

### In the browser

Open `http://localhost:3000`. Click **프로젝트 폴더** and pick a project
folder (same mapper detection as the CLI, running in the browser), or use
**Upload mapper XML**, **Load sample** or **Load advanced**. Then:

- **리니지**: the SQL lineage graph of the selected statement.
- **변환**: the statement's old -> new table/column renames. The **MyBatis
  문법 변환** switch adds the iBATIS -> MyBatis syntax conversion. Renames
  are marked red/green and syntax is marked violet, with the review list and
  graded decisions alongside.
- **데이터셋** (header): old -> new schema mappings, edited as JSON with
  live validation.

## Using the API directly

```bash
curl -X POST http://localhost:3000/api/v1/projects/analyze \
  -H 'content-type: application/json' \
  -d '{"files":[{"sourceFile":"user.xml","source":"<sqlMap namespace=\"user\">...</sqlMap>"}]}'
```

| Method & path | Returns |
|---|---|
| `POST /api/v1/projects` `{files}` | the project **index** (files, statement / fragment ids, include usage, diagnostics) and a `projectId`; nothing is analysed yet |
| `POST /api/v1/projects/open` `{path}` | the same for a folder on this machine, read in place (loopback requests only) |
| `GET /api/v1/projects/:id` · `DELETE /api/v1/projects/:id` | the index again · close the project (caches and uploaded copy dropped) |
| `POST /api/v1/projects/analyze` `{files}` | the original all-in-one response: mapper reports, table usage, table dependency graph, MyBatis XML per file |
| `GET /api/v1/statements/:id` | full `StatementAnalysis` (tables, columns, joins, parameters, dynamic conditions, WHERE tree, lineage) |
| `GET /api/v1/statements/:id/xml` | the statement's original XML, its included fragments' and its resultMap chain |
| `GET /api/v1/statements/:id/dependencies` | include/extends/resultMap/parameterMap dependency tree |
| `GET /api/v1/statements/:id/mybatis-preview` | converted MyBatis XML for that one statement + its migration-safety summary |
| `GET /api/v1/tables/:tableName` | operations (with statement ids), column usage, related tables |
| `POST /api/v1/schema-migration[?file=]` `{datasetId \| mapping}` | old -> new renames, before/after per statement and fragment: one file (`?file=`) or the whole project |
| `POST /api/v1/statements/:id/schema-migration` · `POST /api/v1/schema-summary` | the same for one statement · per-statement counts and the project total |
| `GET/PUT/DELETE /api/v1/layouts/:id` | the lineage graph's saved arrangement for a statement (dragged offsets + zoom/pan), stored under `data/layouts/` |

Project routes accept `?projectId=...`; omitting it means the most recently
opened project. Projects are sessions: an index plus bounded caches, closed
after 30 idle minutes (see
[docs/features/large-projects.md](docs/features/large-projects.md)).

## Project layout

```
src/
  parser/        XML tokenizer + iBATIS tag parser → AST
  ast/           the iBATIS and MyBatis AST node definitions
  resolver/      symbol table + include/extends reference resolution
  analyzer/      dynamic SQL, parameter, SQL/table/column/join/where,
                 per-statement composite, table/statement dependency graphs
  converter/     iBATIS AST → MyBatis AST, graded SAFE/WARNING/MANUAL
  generator/     MyBatis AST → XML text
  report/        per-mapper report, project table-usage report, safety summary
  application/   ProjectSession (index + on-demand, used by API/UI/CLI) and
                 AnalyzerPipeline (everything at once, the reference)
  interfaces/
    api/         Express JSON API
    api/public/  the static web UI (no build step) served from the same app
test/            node:test suites + fixtures, mirroring the src/ layout
docs/            architecture, spec-to-code mapping, AST reference, testing guide
```

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — pipeline stages, design rationale, non-obvious gotchas
- **[docs/SPEC_MAPPING.md](docs/SPEC_MAPPING.md)** — every spec section, its implementation status, and where to find it
- **[docs/AST_REFERENCE.md](docs/AST_REFERENCE.md)** — every AST/model type, field by field
- **[docs/TESTING.md](docs/TESTING.md)** — test layout, fixture catalog, how to add a case
- **[CLAUDE.md](CLAUDE.md)** — contributor-facing conventions and pitfalls specific to this codebase

## Status

Every stage of the pipeline above is implemented and tested — parsing,
reference resolution, dynamic SQL / table / column / join / where analysis,
the MyBatis converter and XML generator, migration safety grading, both
report types, both dependency graphs, the full API, and the UI. See
[docs/SPEC_MAPPING.md](docs/SPEC_MAPPING.md) for the section-by-section
detail and the known limitations that remain (Oracle-only SQL syntax like
`ROWNUM`/`DUAL`/`MERGE` has no parser support yet; the UI has no automated
test coverage, only manual browser verification).

## Requirements

Node.js ≥ 18. No TypeScript, no bundler, no framework beyond Express for
the API — the entire dependency footprint is `express` and `node-sql-parser`
(the latter scoped to the SQL/table analyzer only).
