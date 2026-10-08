# How refids are found (the metadata, and the one rule)

## The metadata

Built once when a project opens (`application/ProjectMetadata.js`), in
three layers. See docs/ARCHITECTURE.md "Project metadata".

- **Registry.** Every file (namespace, kind, parsed, external) and every
  statement, `<sql>`, resultMap and parameterMap of the WHOLE project, keyed
  `namespace.id` (`SymbolTable`). One namespace may span many files and
  folders. `GET /api/v1/namespaces` shows it.
- **Lookup.** `resolver/reference/ReferenceIndex`, the one rule below. Ambiguity
  is an explicit result, not a side effect.
- **Graph.** Every statement resolved once over include-only stubs, by the
  same `ReferenceResolver` the analysis uses: include / extends / resultMap /
  parameterMap edges, reference diagnostics, cycles, unresolved refids.
  Derived queries read it: `includeTree` (per statement, at every depth,
  with the rule; no file read), `includedFragments`, `includerStatements`,
  `includeSites`, `resultMapChain`.

The analysis resolves the real ASTs with a ReferenceResolver over the SAME
symbol table and index, only loading nodes from files instead of stubs, so
the graph and the analysis can't disagree. Before this split, the metadata
was a stub resolver turned into the real one by patching getters onto its
symbols, and the lookup had copies in the converter and the browser. Each
fix landed in a different copy.

## The one rule — `ReferenceResolver#includeTarget(refid, writtenIn, rootNamespace)`

| rule | when |
|---|---|
| QUALIFIED | the refid is a qualified id (`ns.id`) |
| NAMESPACE | `<include>`'s own mapper has that id |
| GLOBAL_UNIQUE | a bare id defined exactly once in the project (iBATIS `useStatementNamespaces=false`). Also for MyBatis 3 mappers, which projects rely on: found, plus a `MYBATIS_BARE_REFID` warning, because MyBatis's own lookup prefixes the current namespace. A short-lived strict mode reported these as missing, which hid real cross-file references. |
| RUNTIME_SHADOWED | a bare refid inside a fragment, included from a statement of another namespace that has its own fragment of that id: iBATIS / MyBatis resolve against the statement's namespace |
| AUTHOR_NAMESPACE | …the statement's namespace has none: the fragment author's (MyBatis output writes it qualified) |
| MISSING / CIRCULAR | not found, or two candidates (ambiguous), or a cycle |

## Why refids were sometimes "not found" before (fixed)

Two components did not use this rule. Each had its own simplified copy of
the lookup, which looked up a nested bare refid only by the statement's
namespace:

- **The schema converter (변환 view).** It indexed only the mappers loaded
  for the file being converted. Since loading became per file (see
  large-projects.md), "unique in the project" was judged among those few
  files.
- **The lineage view.** It guessed fragments by name, client-side, and
  never expanded an `<include>` sitting inside a dynamic tag of a fragment.

On the generated test projects that was **245 of 5,166 nested includes
wrong in the converter (4.7%)** and **156 in the lineage view (3%)**. Both
missed the AUTHOR_NAMESPACE case above.

Now:
- the converter is given the resolver's lookup (`convertMappers({
  resolveInclude })`): 153,022 include resolutions, 0 different from the
  resolver;
- the lineage view expands from the server's include tree;
- `test/application/projectSession.test.js` keeps both, plus the MyBatis
  strict rule, under test.

## A namespace spread over many files, and files with broken XML (fixed)

The registry is built at open: every file's namespace and ids go into the
symbol table, and one namespace (`common`) may span any number of files in
any folders. `GET /api/v1/namespaces` lists namespace → files → `<sql>` ids.

Before, a file entered the registry only if it parsed as strict XML. One
unescaped `<` in SQL (`A < 10`, `<=`, `<>`) or one unclosed `<isNotEmpty>`
dropped the WHOLE file, and every `common.xxx` into it was "not found".

Now:
- **Lenient parser** (`parser/xml/XmlParser.js`). A `<` that can't start a
  tag is SQL text (`XML_LENIENT_LT`). An element closed by its parent's
  closing tag, or never closed, is recovered (`XML_RECOVERED_UNCLOSED`). A
  closing tag matching nothing open is dropped
  (`XML_RECOVERED_STRAY_CLOSE`). Each is a warning with its line; the file
  keeps all its ids.
- **Registry from the text** (`scanMapperIds`). A file still too broken to
  parse has its namespace, `<sql>` and statement ids read from its text and
  registered anyway. A refid into it is found, flagged
  `unparsed` with the file ("파일 파싱 오류"), never "not found"; its
  statements are listed in the tree, greyed.
- **Case-only mismatch.** When an id differs only in letter case, the
  error says `did you mean "common.live"? (ids are case-sensitive)`.
- **The browser gets XML regenerated from the parsed AST**
  (`statementXml`), so its strict parser never rejects a file that needed
  lenient parsing.

## Files that never reached the metadata (fixed)

A refid is only as findable as the file its fragment lives in. File
discovery used to skip, **by folder name, anywhere in the path**, every
folder called `target`, `build`, `bin`, `out`, `dist` or `classes` (meant
for build copies). It also didn't follow symlinked folders. So the
metadata simply lacked:

- a package `…/erp/out/…` or `…/batch/build/…`, deep in a source tree;
- a legacy project whose only sqlMaps are in `WEB-INF/classes`;
- a module linked in by a symlink.

Every refid into those files was "not found". The hard generated
corpus (`generateProject(seed, dir, { hard: true })`: trees 20+ deep,
such package names at every level, a WEB-INF/classes layout, a symlinked
module) found **0 of 107** mappers.

Now:
- only tool / VCS folders (`node_modules`, `.git`, `.idea`, …) are skipped
  by name (`IGNORED_DIRECTORIES`); symlinked folders are followed, each
  real folder once.
- A build copy is recognised by CONTENT (`ProjectSession#open`): files with
  the same kind, namespace and ids are one mapper. The one that looks least
  like build output stays (`copyScore`: a top-level `target/`, `build/`, … >
  `…/target/classes/`, `…/build/resources/` > `WEB-INF/classes` > source).
  The others are listed as `BUILD_COPY` with the original's path. A file
  with no second copy stays wherever it is.
- The browser's folder upload and folder walk skip only the same tool
  folders and leave copies to the server.

`test/fuzz/projectCorpus.test.js` ("hard folder layouts") checks, against
the generator's ground truth, by path and by upload: every mapper found,
every statement's refid chain exact (12 projects in `npm test`, 40 with
`FUZZ_SEEDS`). On `../demo`, the `bin/` and `build/` copies are recognised
as copies of the `src/` mappers. Each missing refid is now reported once per
`<include>`, not once per statement that reaches it.

## Fragments in another module (outside the opened folder)

MyBatis loads mappers from the whole classpath, so a module's refids often
point into a common module next to it. Opening only the module used to
leave those "not found". Now, when opening a folder by path (경로 열기 /
프로젝트 폴더 on this machine, and the CLI), unresolved refids are looked up
**outside** it (`application/ReferenceDiscovery.js`, `openProjectFolder`):

- **Where:** only inside the repository the folder belongs to: the nearest
  ancestor with `.git`, else a multi-module build root (an ancestor with
  pom.xml / build.gradle / settings.gradle). Never a plain parent folder
  (`~/projects/*` are unrelated projects), never the home or root folder.
- **What:** only files that define something missing. That is a qualified
  refid's namespace, read from the file's head, or a bare refid's
  `<sql id>`, which must be defined by exactly one file there.
- **Rounds:** up to 3, since a fragment found outside may include another.
- **How they're used:** they join the project as `external` reference files
  (`ReferencedSource`, names like `../common/…/CommonMapper.xml`). They are
  used for resolution and analysis, shown last in the tree under
  "프로젝트 밖 · refid 참조", and never written out by the CLI.
- **Uploads:** a browser upload holds only the chosen folder, so it can't
  look outside. Its status says to open the folder by path instead.

Test: `test/application/referenceDiscovery.test.js`. A `.git` repo with
app / common / batch modules: qualified, bare and nested refids into common
are found; a bare id defined in two modules is not guessed; an unrelated
folder next to the repo is never read; the CLI writes only the app's files.

## Showing it

- Every refid in the 변환 view and the lineage refid boxes carries its rule
  (hover for the explanation).
- **refid 쿼리에 통합** (off by default) chooses where fragments appear:
  - off: listed below the query, each nested include indented under its
    fragment, with its own before/after diff.
  - on: the query as ONE text, copy-ready. On the server
    (`ProjectSession#inlineIncludes`, request `inlineRefid`), every
    `<include>` is replaced, as an AST step, by the nodes of the fragment it
    resolves to, by the same rule, recursively. All four sides (iBATIS /
    MyBatis, before / after renames) are spliced, so renames inside
    fragments show in place. A cycle or an unresolvable refid stays an
    `<include>`.
