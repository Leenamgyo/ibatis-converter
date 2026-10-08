# How refids are found (the metadata, and the one rule)

## The metadata

Opening a project builds the index (`ProjectSession#open`). The refid
metadata it builds is:

- **Symbol table** (`resolver/symbol`): every statement, `<sql>`,
  resultMap and parameterMap of the WHOLE project, keyed
  `namespace.id`. A bare-id index sits beside it.
- **Include graph** (`DependencyGraph`, plus `includes` / `includedBy`
  sets in the session): every `<include>` edge, found by resolving each
  statement once against the symbol table, nested fragments included.
  Searching it is a graph walk: what a statement includes, transitively
  (`includedFragments`); which statements a fragment reaches
  (`includerStatements`); where it is included (`includeSites`).
- **Include tree** per statement (`includeTree`, sent with the statement
  and with the 변환 view's result): which fragment each `<include>`
  resolved to, in document order, at every depth, and by which **rule**.

All of it is built from the whole project, never from the files that
happen to be loaded.

## The one rule — `ReferenceResolver#includeTarget(refid, writtenIn, rootNamespace)`

| rule | when |
|---|---|
| QUALIFIED | the refid is a qualified id (`ns.id`) |
| NAMESPACE | `<include>`'s own mapper has that id |
| GLOBAL_UNIQUE | a bare id defined exactly once in the project (iBATIS `useStatementNamespaces=false`). **Not for MyBatis 3 mappers**: MyBatis looks in its own namespace only (`strictNamespaces`) |
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
