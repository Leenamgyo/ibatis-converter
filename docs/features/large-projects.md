# Large projects: index first, load on demand

A project is never held whole: not by the server, the browser, or the CLI.
`application/ProjectSession.js` replaced "run the pipeline over everything
and keep the result" for every interactive and batch path.
`AnalyzerPipeline` is still there, and it is the reference the session is
tested against.

## What opening a project does

`ProjectSession#open()` reads each file once, classifies it (root `<sqlMap>`)
and parses it. It keeps only an **index**:

- the file list (path, namespace, encoding, line count),
- every statement / fragment / resultMap id and line,
- per statement and fragment, a **stub** whose `children` are just its
  `<include>` nodes; per resultMap, its `extends`.

The text and the AST are dropped (a few stay in the bounded cache as a
bonus). The stubs go through the **same** `buildSymbolTable` and
`ReferenceResolver` as the pipeline, which yields the project-wide answers
without reading a file again:

- include chains, `includerNamespaces`,
- missing / circular / ambiguous / NESTED_REFID_* diagnostics,
- the dependency graph.

After that pass, the same symbol table becomes the "real" one: each
symbol's `node` is a getter that loads the real AST from the file cache.
The stubs are then collected.

## Loading on demand

| Need | What is loaded |
|---|---|
| a statement's analysis / conversion / XML | its file + its fragments' files |
| a file's 변환 view (`schema-migration?file=`) | the file, every fragment it includes, and up to `schemaSiteFiles` (30) files that include those fragments (their FROM context); past the cap a `FRAGMENT_CONTEXT_SAMPLED` WARNING says so |
| tree badges / project totals (`schema-summary`) | file by file; only counts are kept |
| reports, table usage (`report()`) | file by file; analyses are reduced to `{id, tables, joins}` |
| CLI `migrate` | file by file, each written as it is done (includer context uncapped, so output = whole-project run) |

The caches are `LruCache`s:
- **file text:** 32 MB / 32 entries,
- **parsed ASTs:** 16 files,
- **analyses:** 256.

`close()` drops the caches, the index and, for an upload, its temp directory.

## Server lifecycle (`interfaces/api/SessionManager.js`)

A session closes in any of these cases:
- after 30 min without a request,
- when a 5th one opens (the least recently used goes),
- on `DELETE /api/v1/projects/:id`.

The UI deletes its project when it opens another one and on `pagehide`.
An upload is written to a temp dir under numbered names: the uploaded
names are kept as ids but never used as paths. Its text is already decoded,
so it is read back as UTF-8.

`POST /api/v1/projects/open {path}` indexes a folder **in place**, with no
upload and no copy. Only loopback requests may use it.

## Browser

- The tree is drawn from the index. A project with more than 1500
  statements opens folded; the selected statement's file unfolds.
- Opening a statement fetches `GET /statements/:id` and
  `GET /statements/:id/xml`. The second returns its element, its
  fragments' and its resultMap chain, sliced from the files. The last 24
  are kept (`state.docs`).
- Picked files are held only until they are uploaded (`state.pendingFiles`).
- The 변환 view keeps the last 6 file results.

## Measured (50 files × 2000 lines, 9,488 statements, 100k lines)

| | before (pipeline) | after (session) |
|---|---|---|
| open | 2.7 s | 0.14 s server, 0.6 s to a drawn screen |
| open response | 40 MB | 1.6 MB (130 KB gzipped) |
| server heap kept per project | +123 MB, forever | ~18 MB index + bounded caches, freed on close |
| one statement | (preloaded) | ~10 ms analysis, ~2 ms XML |
| schema summary, whole project | (part of a 40 MB response) | 0.7 s, 69 KB |
| browser heap | everything | ~21 MB |

## Parity

Tests: `test/application/projectSession.test.js` and
`test/interfaces/sessionApi.test.js`. The session must equal the pipeline on
the samples, legacy-app and generated deep-include projects, with caches
squeezed to 2 files so it constantly evicts and reloads. The comparison
covers:

- analyses,
- conversions,
- diagnostics,
- reports,
- the dependency graph,
- per-statement / per-file schema migration vs the whole-project run.
