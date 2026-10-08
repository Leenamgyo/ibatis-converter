# MyBatis 3 mappers as input

A project's mappers can be iBATIS 2 `<sqlMap>`, MyBatis 3 `<mapper>`, or
both, as in a project mid-migration. Every XML with SQL is read. Before,
a MyBatis project such as `../demo` showed "iBATIS 매퍼를 찾지 못했습니다".

## How it is read (`parser/mybatis/MyBatisMapperParser.js`)

Two typed trees, no string rewriting:

- **`mapper` (`ast/mybatis`)**: the file as written. `ast/mybatis` gained
  `Choose` / `When` / `Otherwise` / `Bind`, and
  `StatementNode.otherAttributes` (`useGeneratedKeys`, `keyProperty`,
  `fetchSize`, … kept and written back unchanged).
- **`sqlMap` (`ast/ibatis`)**: mapped node by node from it, for the
  resolver and every analyzer:

  | MyBatis | analysis AST |
  |---|---|
  | `<if test>` | `Conditional TEST` (no prepend: transparent) |
  | `<choose>` / `<when>` / `<otherwise>` | `Conditional CHOOSE` of `WHEN` / `OTHERWISE`; the flattener takes the first non-empty branch (alternatives, not a sequence) |
  | `<where>` / `<set>` / `<trim>` | `Dynamic` with `trim` `{prefix, suffix, prefixOverrides, suffixOverrides}` |
  | `<foreach>` | `Iterate` (collection, open, close, separator) |
  | `<include>`, `<selectKey>`, `<sql>`, `<resultMap>` | their iBATIS counterparts |
  | `<bind>` | nothing (no SQL) |

  Text from a MyBatis file is marked `spaced`: MyBatis joins the SQL of
  separate tags with a space, iBATIS doesn't. `#{x,jdbcType=…}` / `${x}`
  are parameters in `ParameterAnalyzer` and `?` in the flattener.

## What each view does with it

- **리니지.** Exactly as for iBATIS: tables, joins, includes across files,
  lineage. The guards panel also lists `<if>` / `<when>` / `<foreach>`.
- **변환.** No syntax conversion applies. The left side is the MyBatis
  original (`원본 · MyBatis`), the right side is the same MyBatis with the
  dataset's renames. Each statement's conversion grade is one SAFE
  `ALREADY_MYBATIS`. The schema migration runs on the MyBatis AST, so
  `<choose>` stays `<choose>` and `fetchSize` stays.
- **CLI.** `mybatis/<path>` is the file copied unchanged.
  `mybatis-schema/<path>` holds the renames. `report.md` counts them
  ("이미 MyBatis n개").

Top-level `<cache>` / `<cache-ref>` / `<parameterMap>` are ignored. Other
unknown tags are diagnosed (`UNSUPPORTED_TAG`), and so are `<include>`
`<property>` values (`INCLUDE_PROPERTY_IGNORED`).

Tests: `test/parser/myBatisInput.test.js` on
`test/fixtures/mybatis-project/` (cross-file include, `<where>`,
`<choose>`, `<foreach>`, `<set>`, `<bind>`, a `target/` copy that must not
be read).
