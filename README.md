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
npm test                 # 100+ tests, backend only (see docs/TESTING.md)
npm start                # serves the API + UI on http://localhost:3000
npm run dev              # same, but restarts on any src/ change
```

`npm run dev` uses Node's built-in `--watch` (no nodemon, no extra
dependency). It restarts the server when backend code under `src/`
changes; the static UI (`src/interfaces/api/public/*`) is read from disk
per request, so an edit there just needs a browser refresh. `npm run
test:watch` re-runs the suite the same way.

Open `http://localhost:3000`, click **Load sample** (or upload your own
`.xml` mapper files), then **Analyze**. From there:

- **Statements** tab — a mapper tree on the left; select a statement to see
  its tables/parameters/joins/dynamic conditions, its include/resultMap
  dependency tree, a **table/column lineage diagram** (which tables JOIN to
  which, and which columns flow into the result), a **dynamic SQL flow
  diagram** (`<if>`/`<where>`/`<set>`/`<foreach>` as a flowchart, each
  `<if test="...">` a decision node), the original iBATIS XML side-by-side
  with the generated MyBatis XML, and the graded list of conversion
  decisions.
- **Tables** tab — a project-wide table lineage diagram by default; pick a
  table to see every statement that reads, creates, updates, or deletes it,
  per-column usage counts, and which other tables it's actually JOINed to
  in the SQL.

## Using the API directly

```bash
curl -X POST http://localhost:3000/api/v1/projects/analyze \
  -H 'content-type: application/json' \
  -d '{"files":[{"sourceFile":"user.xml","source":"<sqlMap namespace=\"user\">...</sqlMap>"}]}'
```

| Method & path | Returns |
|---|---|
| `POST /api/v1/projects/analyze` | mapper reports, project-wide table usage report, table dependency graph, generated MyBatis XML per file, and a `projectId` for the routes below |
| `GET /api/v1/statements/:id` | full `StatementAnalysis` (tables, columns, joins, parameters, dynamic conditions, WHERE tree) |
| `GET /api/v1/statements/:id/dependencies` | include/extends/resultMap/parameterMap dependency tree |
| `GET /api/v1/statements/:id/mybatis-preview` | converted MyBatis XML for that one statement + its migration-safety summary |
| `GET /api/v1/tables/:tableName` | operations (with statement ids), column usage, related tables |

All four `GET` routes accept `?projectId=...` from the `analyze` response;
omitting it means "the most recently analyzed project" (this is a
single-user local tool, not a multi-tenant service — see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

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
  application/   AnalyzerPipeline — the one place every stage is wired together
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
