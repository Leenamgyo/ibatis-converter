# SQL schema migration (old -> new table / column names)

A derived feature, separate from the iBATIS -> MyBatis *syntax* conversion:
while the mapper SQL is being migrated, rename legacy tables and columns to
the new schema's names. Lives in `src/converter/schema/`, has **zero
runtime dependencies**, and never imports `converter/mybatis` (it works on
plain SQL, or duck-types `ast/mybatis` nodes by `node.type`).

```
SqlSchemaMigrationConverter            convert(sql, contextTable) / convertMapper(s)(mapperNode, { fragmentContexts })
 ├─ SqlLexer         lossless tokens: WORD, QUOTED_IDENTIFIER, STRING, COMMENT, PARAM (#{} ${} #x# $x$ ? :x), ...
 ├─ TableResolver    tokens -> Scope tree, TableRef (schema/name/alias), ColumnRef sites
 ├─ ColumnConverter  ColumnRef -> owning ORIGINAL table -> that table's column map
 ├─ TableConverter   TableRef name tokens -> targetTable (aliases are separate tokens, untouched)
 └─ MigrationMapping Map<legacy table, TableMapping { targetTable, columns }>
```

Mapping (`test/fixtures/schema-migration/mapping.json` is a real one):

```json
{
  "OLD_COUNTRY":     { "targetTable": "COUNTRY",     "columns": { "COUNTRY_CD": "COUNTRY_CODE", "USE_YN": "IS_ENABLED" } },
  "LEGACY.OLD_CODE": { "targetTable": "MASTER.CODE", "columns": { "CD": "CODE" } }
}
```

Keys and lookups are case-insensitive; a schema-qualified key beats a
bare one; a `targetTable` with a schema replaces the SQL's schema,
otherwise the SQL's schema is kept.

## How it works

1. **Tokenize** losslessly. Joining the tokens reproduces the input
   byte-for-byte, so anything nobody edits — keywords, whitespace,
   comments, string literals, `#{}`/`${}` — comes out unchanged.
2. **Resolve** (`TableResolver`). One BLOCK scope per statement /
   parenthesised subquery / CTE body, one QUERY scope per
   SELECT/INSERT/UPDATE/DELETE/MERGE (UNION branches are siblings,
   `INSERT ... SELECT`'s SELECT is a child of the INSERT). Each scope
   holds its TableRefs: the alias -> original-table map. CTE names and
   derived tables are TableRefs too, so they shadow a mapped table of the
   same name.
3. **Columns** (`ColumnConverter`), decided against *original* names:
   `q.COL` through the alias map (innermost scope outward, so correlated
   subqueries work); unqualified `COL` by the nearest scope that has any
   tables; a FROM-less fragment defers outward to the `contextTable`
   scope. A derived table / CTE gets a virtual column map from its own
   SELECT list, so `(SELECT CD FROM OLD_CODE_DETAIL) t` makes `t.CD` ->
   `t.CODE` outside.
4. **Tables** (`TableConverter`), name tokens only, plus a qualifier that
   names a table directly (`OLD_COUNTRY.COUNTRY_CD`).
5. **Apply** all edits once. Because steps 3-4 only *record* edits against
   the immutable token stream, renaming a table can never lose the key a
   column's mapping is filed under.

On a mapper, every SQL piece of one statement — TextSql, the implied
`WHERE`/`SET` of `<where>`/`<set>`, `<trim prefix/suffix>`, `<foreach
open/close>` — is one token stream, so a column inside `<if>` resolves
against the statement's FROM. `test=`/`collection=` are attributes and are
never tokenized. An `<include>`d fragment is spliced in read-only (its
FROM counts for the includer) and converted on its own, using
`fragmentContexts[ns.id]` if given, otherwise the tables its include sites
see (`fragmentContexts` can also be given to the `SqlSchemaMigrationConverter`
constructor, which is how it reaches a pipeline run). A fragment nothing
includes has no context: its legacy columns are left as is and reported
(`NO_TABLE_CONTEXT` / `UNRESOLVED_QUALIFIER`). A fragment
included in a FROM clause (`FROM <include refid="tables"/>`,
`FROM a A, <include .../>`) is read as the continuation of that FROM: its
`TB_X X, TB_Y Y` is a table list and gets renamed (the scanner records the
clause state at each include marker). If two include sites would convert it differently, it is left alone and
flagged as MANUAL. Consecutive `<if>`s
at a table position are treated as alternatives (`FROM <if>A</if><if>B</if>`).
Each alternative is its own table. The word after one alternative's
`</if>` is never read as its alias: it is the next alternative. A word
right after the whole group is the alias of every alternative
(`FROM <include refid="table"/> O`, where the fragment is the
table-choice logic). `O.COL` then maps cleanly only if every alternative
maps `COL` the same way; otherwise it is `COLUMN_AMBIGUOUS` (MANUAL).
Such a fragment's own table list comes from its FROM include sites, so
the 변환 view's 사용 테이블 shows every table it can choose
(sample: `frag.tableChosenByRefid`).

A table name can also be built from pieces glued to it (no whitespace):

- **A conditional suffix**, as in `TB_ORDER<isEqual property="rbkYn">_RBK</isEqual> A`.
  - TB_ORDER and TB_ORDER_RBK are both tables, each with alias `A`.
    TB_ORDER_RBK is a ref without a token of its own (`variantOf`), so `A.COL`
    resolves against both.
  - Only the base token is renamed. At runtime, the suffixed table becomes
    (the base's new name) + `_RBK`. `CONDITIONAL_TABLE_SUFFIX` is SAFE when
    that is what the mapping wants for TB_ORDER_RBK, and MANUAL otherwise.
  - This works inline or inside the `<sql>` that names the table (samples:
    `edge.rollbackTableSuffix`, `frag.rollbackTableViaRefid`).
  - The XML generators (`generator/xml/inlineGlue.js`, both iBATIS and
    MyBatis) write such a glued tag inline:
    `FROM SALES_ORDER<if test="…">_RBK</if> O`. Putting it on its own line, as
    for every other tag, would insert whitespace and turn `_RBK` into an
    alias in the converted mapper.
- **A variable**: `FROM $tableName$ T`, `TB_ORD_$yyyymm$ M`, `${t}`.
  - The table is listed as written (`dynamic`) and is never renamed.
  - `RUNTIME_SUBSTITUTION` / `DYNAMIC_IDENTIFIER` still flag it.

## Grading (`SchemaMigrationEvent`, same SAFE/WARNING/MANUAL vocabulary)

| Code | Grade | When |
|---|---|---|
| `TABLE_RENAMED`, `COLUMN_RENAMED` | SAFE | resolved unambiguously |
| `COLUMN_ASSUMED` | WARNING | renamed, but an unmapped table shares the scope |
| `CONDITIONAL_TABLE_SUFFIX` | SAFE / MANUAL | `TB<if>_RBK</if>`: the base's new name + suffix is / isn't what the mapping says the suffixed table becomes |
| `COLUMN_AMBIGUOUS` | MANUAL | two tables in scope (or one alias declared by alternative branches) map it differently — left as is |
| `NO_TABLE_CONTEXT` | WARNING | unqualified legacy column with no table anywhere in scope — an un-included fragment, or `convert()` without `contextTable` |
| `UNRESOLVED_QUALIFIER` | WARNING | `x.COL`, `x` not in scope, `COL` is a legacy column somewhere |
| `RESULT_COLUMN_RENAMED` | WARNING | an unaliased top-level SELECT item changed the result label (resultMap `column=`, auto-mapping) |
| `RESULT_COLUMN_ALIASED` | SAFE | `preserveResultColumnNames: true` kept the old label: `COUNTRY_CODE AS COUNTRY_CD` |
| `RUNTIME_SUBSTITUTION` | WARNING | `${}` / `$x$` — its runtime value is not migrated |
| `DYNAMIC_IDENTIFIER` | MANUAL / WARNING | `${}` glued to a name (`TB_ORD_H_${yyyymm}`): a table built at runtime — MANUAL when its fixed part is a mapped legacy table |
| `HINT_NOT_MIGRATED` | WARNING | `/*+ ... */` names a renamed table (hints are comments) |
| `FRAGMENT_CONTEXT_INFERRED` / `_CONFLICT` | SAFE / MANUAL | see above |

UI: the 변환 view and the 데이터셋 editor — see [schema-view.md](schema-view.md).

## Why no SQL-parser library here

`node-sql-parser` is already a dependency of `analyzer/sql`, but it is the
wrong tool for *rewriting*: it regenerates SQL from its AST, losing
comments, hints, formatting and keyword case; it fails on
fragments (`AND APP_ID = #{appId}`) and dynamic-SQL pieces, which is most
of the input here; and its dialect gaps (Oracle `(+)`, `CONNECT BY`,
MERGE variants) would turn into whole statements left unconverted. The
job only needs to know *where* table references, aliases and scopes start
and end. A structural scanner can do that losslessly, and it degrades
gracefully on any SQL: what it doesn't understand stays untouched.

## Known limits

- Unqualified columns in a correlated subquery that belong to the *outer*
  table are resolved against the inner scope's tables (no catalog to tell
  which table really has the column). Qualify them.
- A column-list fragment's (`<sql>` with no SELECT) items don't raise
  `RESULT_COLUMN_RENAMED`, and `<resultMap column=...>` is not rewritten.
- An INSERT / MERGE ... INSERT column list resolves against the INTO target
  only; Oracle `col(+)` is a column reference; a subquery/CTE whose output
  columns are all named only "owns" those names (so it doesn't turn other
  unqualified columns into WARNING guesses).
- `${}` and hints are reported, not rewritten. Stored-procedure bodies,
  `CONNECT BY` pseudo-columns and vendor table functions are only
  scanned structurally.
- An unmapped table's columns are unknown, so an unqualified column next
  to one is a WARNING guess rather than a decision.
