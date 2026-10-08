# AST reference

Every node's discriminator field is `type` (a plain string, not a class
check — see the "AST node discriminator" rule in the root `CLAUDE.md`).
`sourceFile`/`sourceLine` are present on every `ast/ibatis` node; `ast/mybatis`
nodes don't carry source location since they're synthesized, not parsed.

## `src/ast/ibatis/enums.js`

- `StatementType`: `SELECT | INSERT | UPDATE | DELETE | PROCEDURE`
- `ConditionType`: `IS_NULL | IS_NOT_NULL | IS_EMPTY | IS_NOT_EMPTY | EQUAL | NOT_EQUAL | GREATER_THAN | GREATER_EQUAL | LESS_THAN | LESS_EQUAL | PROPERTY_AVAILABLE | NOT_PROPERTY_AVAILABLE`
- `CONDITION_TAG_MAP`: `isNull -> IS_NULL`, `isEqual -> EQUAL`, etc. — the parser uses this once, downstream code should never need to know the original tag name.
- `STATEMENT_TAG_MAP`: `select -> SELECT`, `procedure -> PROCEDURE`, etc.
- `SymbolType`: `STATEMENT | SQL_FRAGMENT | RESULT_MAP | PARAMETER_MAP | CACHE_MODEL`

## `src/ast/ibatis/nodes.js`

| Node | Key fields | Notes |
|---|---|---|
| `SqlMapNode` | `namespace`, `statements[]`, `sqlFragments[]`, `resultMaps[]`, `parameterMaps[]`, `cacheModels[]` | root of one parsed mapper file |
| `StatementNode` | `id`, `statementType`, `parameterClass`, `parameterMap`, `resultClass`, `resultMap`, `cacheModel`, `fetchSize`, `timeout`, `remapResults`, `children[]` | `<select>`/`<insert>`/`<update>`/`<delete>`/`<procedure>` |
| `SqlFragmentNode` | `id`, `children[]` | `<sql id="...">` |
| `TextSqlNode` | `text` | raw literal SQL between tags |
| `DynamicNode` | `prepend`, `open`, `close`, `children[]` | `<dynamic prepend="WHERE\|SET" open="(" close=")">` |
| `ConditionalNode` | `conditionType`, `property`, `compareValue`, `compareProperty`, `prepend`, `open`, `close`, `removeFirstPrepend`, `children[]` | any standardized `isXxx` tag, incl. `isParameterPresent` / `isNotParameterPresent` |
| `IterateNode` | `property`, `open`, `close`, `conjunction`, `prepend`, `children[]` | `<iterate>`, can nest |
| `IncludeNode` | `refid` | `<include refid>`, unresolved — only ever appears in a parser-output (unresolved) tree |
| `SelectKeyNode` | `keyProperty`, `resultClass`, `timing` (**not** `type` — see collision note in root `CLAUDE.md`), `children[]` | `<selectKey type="pre\|post">` |
| `ResultMapNode` | `id`, `class`, `extends`, `groupBy`, `resolvedParent` (set by resolver, else `null`), `results[]` | `<resultMap>` |
| `ResultNode` | `property`, `column`, `jdbcType`, `javaType`, `typeHandler`, `nullValue`, `select`, `resultMap` (nested) | `<result>` |
| `ParameterMapNode` | `id`, `class`, `parameters[]` | `<parameterMap>` |
| `ParameterNode` | `property`, `jdbcType`, `javaType`, `typeHandler`, `nullValue`, `mode` | `<parameter>` |
| `CacheModelNode` | `id`, `cacheType` | minimal — `<cacheModel type="...">` |
| `UnresolvedIncludeNode` | `refid`, `reason` (`'MISSING'\|'CIRCULAR'`), `path` (only when `CIRCULAR`) | only appears in a **resolved** tree, replacing an `<include>` the resolver couldn't follow |
| `ResolvedIncludeNode` | `refid`, `qualifiedId`, `children[]` | only appears in a **resolved** tree, replacing a successfully-followed `<include>`; `children` is the recursively-resolved content of the target `SqlFragmentNode` |

A resolved `StatementNode`/`SqlFragmentNode` (the `resolvedTree` returned by
`ReferenceResolver#resolve`) is the same class as the original, just a
distinct clone whose `children` may contain `ResolvedIncludeNode`/
`UnresolvedIncludeNode` in place of any `IncludeNode` that used to be
there — see `cloneShallowWithChildren` in
`src/resolver/reference/ReferenceResolver.js`.

## `src/ast/mybatis/nodes.js` (target side, populated by `converter/mybatis`)

| Node | Key fields | Corresponds to |
|---|---|---|
| `MapperNode` | `namespace`, `statements[]`, `sqlFragments[]`, `resultMaps[]` | `<mapper namespace="...">` |
| `StatementNode` | `id`, `statementType`, `parameterType`, `resultType`, `resultMap`, `children[]` | `<select>`/`<insert>`/`<update>`/`<delete>` |
| `SqlFragmentNode` | `id`, `children[]` | `<sql id="...">` |
| `TextSqlNode` | `text` | literal SQL, must stay byte-for-byte from the source per spec section 17 |
| `IfNode` | `test`, `children[]` | `<if test="...">` |
| `WhereNode` | `children[]` | `<where>` |
| `SetNode` | `children[]` | `<set>` |
| `TrimNode` | `prefix`, `suffix`, `prefixOverrides`, `suffixOverrides`, `children[]` | `<trim>` |
| `ForeachNode` | `collection`, `item`, `index`, `open`, `close`, `separator`, `children[]` | `<foreach>` |
| `IncludeNode` | `refid` | `<include refid>` |
| `SelectKeyNode` | `keyProperty`, `resultType`, `order` (`'BEFORE'\|'AFTER'`) | `<selectKey>` |
| `ResultMapNode` | `id`, `resultType` (**not** `type` — same collision fix as `ast/ibatis`'s `SelectKeyNode.timing`; renders back out as the `type` XML attribute), `extendsId`, `results[]` | `<resultMap>` |
| `ResultNode` | `property`, `column`, `jdbcType`, `javaType`, `typeHandler` | `<result>` |
| `IdNode` | `property`, `column`, `jdbcType`, `javaType` | `<id>` (from an iBATIS `groupBy` property) |
| `AssociationNode` | `property`, `column`, `javaType`, `resultMap`, `select` | `<association>` (nested resultMap without groupBy, or nested select) |
| `CollectionNode` | `property`, `column`, `javaType`, `ofType`, `resultMap`, `select` | `<collection>` (nested resultMap under groupBy, or a List-typed nested select) |

`StatementNode.callable` (true for an iBATIS `<procedure>`) renders `statementType="CALLABLE"` on a `<select>` (when it maps results) or `<update>`.

## Analyzer output models (not AST, but immutable report/API-facing shapes)

`src/analyzer/dynamic/DynamicSqlModel.js`:
- `DynamicGroup { prepend, sql, children[] }` — from a `DynamicNode`
- `DynamicCondition { property, operator, compareValue, prepend, sql, children[] }` — from a `ConditionalNode`; `operator` is a `ConditionType` value
- `DynamicIterate { property, open, close, conjunction, prepend, sql, children[] }` — from an `IterateNode`

`sql` on each is the flattened, trimmed text of that node's own direct
`TextSqlNode` children only — nested dynamic/conditional/iterate structure
lives in `children`, it is never inlined into `sql`.

`src/analyzer/parameter/ParameterUsage.js`:
- `ParameterUsage { name, expression, bindingType, usedIn, jdbcType, nullValue, dynamicCondition, sourceFragment, sourceFile, sourceLine }` — `name` is the property alone, with `jdbcType`/`nullValue` split out of iBATIS's inline `#property:jdbcType[:nullValue]#` form (parsed once in `ast/ibatis/inlineParameter.js`, shared with the converter); `expression` keeps the raw token text
  - `bindingType`: `HASH` (`#x#`) or `DOLLAR` (`$x$`)
  - `usedIn`: `SELECT | WHERE | JOIN | ORDER_BY | GROUP_BY | HAVING | INSERT_VALUE | UPDATE_SET | OTHER` — see the clause-tracking state machine documented at the top of `ParameterAnalyzer.js` for exactly how this is derived (a heuristic keyword scan, independent of `analyzer/sql`'s real parse — see docs/ARCHITECTURE.md's note on reconciling the two)
  - `dynamicCondition`: shallow copy of the nearest enclosing `ConditionalNode`'s `{ property, operator, compareValue, prepend }`, or `null`
  - a `DOLLAR` usage always has a matching warning in the analyzer's returned `warnings[]` with `code: 'RAW_SQL_SUBSTITUTION'`, `risk: 'SQL_INJECTION'`

`src/analyzer/table/model.js` (populated by `TableAnalyzer` from the
node-sql-parser AST that `SqlAnalyzer`/`SqlFlattener` produce):
- `TableUsage { name, alias, operation, derived }` — `operation` is a `TableOperation` (`READ | CREATE | UPDATE | DELETE`); `derived: true` for a FROM-clause subquery's own pseudo-table entry
- `ColumnUsage { table, column, usedIn, resolution }` — `usedIn` is a `ColumnUsedIn` (`SELECT | WHERE | JOIN | ORDER_BY | GROUP_BY | HAVING | INSERT | UPDATE_SET`); `resolution` is `RESOLVED` or `UNRESOLVED` (`table` is the literal string `'UNKNOWN'` when unresolved — an unqualified column is *always* left unresolved, even with only one table in scope, per spec section 8)
- `JoinRelation { leftTable, rightTable, type, conditions[] }` — `type` is a `JoinType` (`JOIN | INNER_JOIN | LEFT_JOIN | RIGHT_JOIN | FULL_JOIN | CROSS_JOIN | IMPLICIT_JOIN | OUTER_JOIN`, normalized by the shared `normalizeJoinType` in `analyzer/table/model.js` so `analyzer/table` and `analyzer/lineage` always agree). `IMPLICIT_JOIN` is a comma join recovered from the WHERE clause (`FROM A, B WHERE A.X = B.X`, see `analyzer/table/implicitJoins.js`) — the form most legacy mappers use; `conditions` is a flat list of the ON clause's top-level `ComparisonNode`/`LogicalNode`/`ExpressionNode` entries (chained ANDs are split into separate list entries, not nested)
- `Operand { kind, table, column, value, dataType, resolution, raw }` — one side of a comparison; `kind` is one of `COLUMN | PARAMETER | LITERAL | SUBQUERY | STAR | LIST | EXPRESSION`
- `ComparisonNode { kind: 'COMPARISON', operator, left, right }` — a WHERE/ON leaf
- `LogicalNode { kind: 'AND'|'OR', children[] }` — chained same-operator comparisons are flattened into one n-ary node here, not left as a binary tree (see `flattenLogical` in `TableAnalyzer.js`)
- `ExpressionNode { kind: 'EXPRESSION', raw }` — anything not specially modeled yet (CASE, most function calls, ...); degrades gracefully instead of throwing

Table/column resolution is one flat scope per statement: every subquery
found in FROM or in a WHERE/HAVING expression, and every UNION branch, has
its tables/columns/joins/where folded into the *same* result rather than
kept nested — see `docs/ARCHITECTURE.md` and `TableAnalyzer.js`'s own doc
comment for what this trades away (subquery-scoped column resolution).

`src/analyzer/statement/StatementAnalyzer.js` produces one
`StatementAnalysis` per statement (not a class — a plain object, so it
serializes directly for the JSON API):
```
{ id, type, tables, parameters, includes, columns, joins, where,
  dynamicConditions, lineage, warnings, sql }
```
- `id`: the namespace-qualified id (e.g. `"user.getUserList"`)
- `type`: the statement's `StatementType`
- `includes`: qualifiedIds of every `ResolvedIncludeNode` found anywhere in the resolved tree (deduplicated, in document order)
- `dynamicConditions`: every `DynamicCondition` found anywhere in the dynamic-SQL tree, recursively flattened (`DynamicSqlAnalyzer.collectConditions`) — not just the top-level ones
- `sql`: the flattened SQL text `SqlFlattener` produced (useful for the diff/preview UI even before a real MyBatis converter exists)
- `lineage`: the SELECT hierarchy (see below) — the nesting `tables`/`columns`/`joins` deliberately flatten away
- if the flattened `sql` fails to parse, `tables`/`columns`/`joins` come back `[]`, `lineage` comes back empty, and `where` comes back `null`, and `warnings` gains one `{ code: 'SQL_PARSE_FAILED', sql, message }` entry — everything else in the object is still fully populated (see docs/ARCHITECTURE.md's "degrade-not-throw contract")

`src/analyzer/lineage/LineageAnalyzer.js` (`analyze(ast)`), the section 26 dashboard's model:
```
{ selects: LineageSelect[], columnLineage: ColumnLineage[],
  counts: { selects, subqueries, unions, ctes, joins } }

LineageSelect {
  id,            // 'MAIN' | 'S1', 'S2', ... | 'U1', 'U2', ...
  role,          // SelectRole: MAIN | SUBQUERY | UNION_BRANCH | CTE | WRITE
  operation,     // WRITE nodes only: INSERT | UPDATE | DELETE
  origin,        // SelectOrigin: ROOT | FROM | JOIN | SELECT_LIST | WHERE | HAVING | UNION | CTE | INSERT_SELECT
  parentId,      // the SELECT that owns this one (null for the statement's own SELECT)
  alias, depth, distinct, setOperator,
  tables:  [{ name, alias, derived, selectId }],   // `selectId` set when the "table" is a derived table
  joins:   [{ type, table, alias, derived, selectId, on }],
  outputs: [{ expression, alias, sourceTable, sourceColumn, sourceRefs, aggregate, selectId }],
  groupBy: string[], orderBy: string[], where, having, limit,
  children: string[],
}

ColumnLineage {           // one per final SELECT column
  alias, expression, aggregate,
  sourceTable, sourceColumn,          // followed through derived tables
  path: [{ selectId, column }],       // the hops in between
}
```
- A `WRITE` node is an INSERT/UPDATE/DELETE root kept in the same list: its `tables` is the target table, its `outputs` are the columns written (INSERT column list / UPDATE SET assignments), and a feeding `INSERT ... SELECT` or a WHERE subquery hangs off it as a child. `INSERT ... SELECT` also produces real `columnLineage`, paired positionally with the feeding SELECT's outputs.
- `origin` says *why* a subquery exists, which is what the UI draws as containment; `role` separates a nested SELECT from a UNION branch (a sibling, not a child).
- An output column keeps `sourceTable`/`sourceColumn` only when its expression reads exactly one column: `SUM(PM.PAYMENT_AMOUNT)` has an unambiguous origin, `A.X + B.Y` does not — the ambiguous case leaves them `null` and lists every reference in `sourceRefs` rather than guessing.
- Like every other analyzer here it never throws: an AST shape it doesn't recognise produces fewer nodes.

`src/report/migration/MapperReport.js` (`build(sqlMap, statementAnalyses, fileDiagnostics)`):
```
{ sourceFile, namespace, statementCount, byType, sqlFragmentCount,
  resultMapCount, parameterMapCount, tables, warningCount, errorCount,
  statements }
```
`statements` is the same `StatementAnalysis[]` passed in — a `MapperReport` is a summary *plus* the full detail, not a replacement for it.

`src/report/migration/ProjectReport.js` (`build(mapperReports)`), a plain object keyed by table name:
```
{
  [tableName]: {
    operations: { READ: string[], CREATE: string[], UPDATE: string[], DELETE: string[] }, // statement ids
    columns: { [columnName]: { [ColumnUsedIn]: number } } // usage counts
  }
}
```
Only columns with a `RESOLVED` table are attributed here — `UNKNOWN`/`UNRESOLVED` columns are excluded rather than guessed at.

## `src/converter/mybatis/ConversionEvent.js`

- `MigrationGrade`: `SAFE | WARNING | MANUAL | ERROR`
- `ConversionEvent { grade, code, message, sourceFile, sourceLine }` — every converter (`ParameterConverter`, `ConditionalConverter`, `DynamicConverter`, `IterateConverter`, `ResultMapConverter`, `MyBatisAstConverter`) returns a full list of these, SAFE decisions included, not just problems (see docs/ARCHITECTURE.md's "Grading every converter decision" note). `codes` in use today: `HASH_PARAMETER`, `RAW_SQL_SUBSTITUTION` (WARNING), `CONDITIONAL_TO_IF`, `DYNAMIC_TO_WHERE`, `DYNAMIC_TO_SET`, `DYNAMIC_TRIM_INFERENCE` (SAFE or WARNING depending on whether the group deviated from the WHERE/SET idiom — see `DynamicConverter.js`), `ITERATE_TO_FOREACH`, `INCLUDE_KEPT`, `SELECT_KEY_CONVERTED`, `RESULT_MAP_CONVERTED`, `UNSUPPORTED_NULL_VALUE` (MANUAL), `PARAMETER_MAP_STATEMENT` (MANUAL).

`src/converter/mybatis/MyBatisAstConverter.js`:
- `convertStatement(statementNode)` and `convertSqlFragment(sqlFragmentNode)` both take the **original** (unresolved) iBATIS node — `<include>` is kept as a MyBatis `<include refid>`, never inlined — and return `{ node, events: ConversionEvent[] }`.
- `convertResultMap(resultMapNode)` delegates straight to `ResultMapConverter`.
- Internally threads an `iterateStack: { property, item }[]` through the recursive walk so nested `<iterate>` gets distinct MyBatis `item` names (`item`, `item2`, `item3`, ...) and both `#{...}` references and `<foreach collection>` resolve correctly relative to the current loop scope — see `ParameterConverter#resolveExpression`/`resolveCollectionExpression` and the "Nested `<iterate>`" note in docs/ARCHITECTURE.md.

## `src/generator/xml/XmlGenerator.js`

`generate(mapperNode)` -> XML text. No model of its own — it's a pure
renderer over `ast/mybatis` nodes. Every structural tag gets consistent
2-space-per-level indentation, and leaf `TextSqlNode.text` is laid out at
its tag's depth (`layoutSqlText`, shared with `IbatisXmlGenerator`).
- Whitespace-only text emits no line.
- A block is dedented by its common indentation and re-indented, so
  relative alignment is kept.
- A line that starts inside a multi-line string literal is kept byte for
  byte.
- Only indentation and blank lines change, then `&`/`<`/`>` are re-escaped.
- `test/generator/layoutSqlText.test.js` checks, over every text block of
  the samples, fixtures and generated projects, that the SQL tokens
  (string literals whole) are identical. There is no MyBatis DTD/XSD validation — only well-formedness
is checked, in tests, by round-tripping the output back through this
project's own `parseXml`.

## `src/report/migration/MigrationSafetyAnalyzer.js`

`summarize(conversionEvents)` -> `{ SAFE, WARNING, MANUAL, ERROR }` counts.
Pure aggregation over whatever `ConversionEvent[]` you hand it — typically
`MyBatisAstConverter.convertStatement(...).events` for one statement, per
the spec's per-statement summary example.

## `src/analyzer/dependency/DependencyAnalyzer.js`

Built from `resolver/reference/DependencyGraph` (see docs/ARCHITECTURE.md's
"One DependencyGraph, four edge kinds" note for how `INCLUDE`/`EXTENDS`/
`RESULT_MAP`/`PARAMETER_MAP` edges all share one graph).

- `buildTableDependencyGraph(statementAnalyses)` -> `{ [tableName]: { table, statements }[] }` — built fresh from every `StatementAnalysis.joins` (i.e. actual `JoinRelation`s found in SQL, never inferred foreign keys), with same-table-pair edges from different statements deduplicated into one entry whose `statements` lists every contributing statement id.
- `buildStatementDependencyTree(qualifiedId)` -> `{ id, includes, resultMap, parameterMap }`:
  - `includes`: `{ kind: 'INCLUDE'|'INCLUDE_MISSING', id, circular, children[] }[]`, recursive and cycle-safe (a node already on the current path becomes `{ circular: true, children: [] }` instead of recursing forever)
  - `resultMap`: `{ id, circular, parent }` (recursing through `EXTENDS` edges) or `null` if the statement has no `resultMap` attribute
  - `parameterMap`: the resolved parameterMap qualifiedId, or `null`

`resultMap`/`parameterMap` are kept as separate fields rather than mixed
into `includes`, per the spec's explicit "include/refid뿐 아니라
resultMap/parameterMap dependency도 별도로 표현한다".
