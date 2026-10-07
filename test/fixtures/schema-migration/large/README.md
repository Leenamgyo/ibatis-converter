# Large (~2000-line) oracle case

`largeMapper.js` generates one mapper from templates whose table/column
names are placeholders. It renders the mapper twice:

- `legacy-mapper.xml`: legacy schema (`TB_ORD_H.ORD_NO`, ...), the input to the migration
- `target-mapper.xml`: the same mapper as if hand-written on the new schema (`ORDERS.ORDER_ID`, ...)

`result/migrated.xml` (legacy -> MyBatis + schema migration) must be
byte-identical to `result/expected.xml` (target -> MyBatis only).
`result/events.txt` lists every graded decision.

Strings, comments, hints, `$sortColumn$` and the unmapped `TB_LOG` are
written literally, so they are the same in both versions. The tool must
leave them alone.

Coverage: single-table / 4-way joins / comma-free ANSI joins with
same-named columns, `<dynamic>` + isNotEmpty/isNotNull/isEqual/CDATA/
`<iterate>`, column-list and filter `<sql>` fragments (context inferred from
include sites), INSERT with `<selectKey>`, INSERT ... SELECT, dynamic SET,
correlated UPDATE, DELETE with NOT EXISTS / IN, derived-table aggregates,
CTEs, UNION ALL, scalar + EXISTS subqueries, `LEGACY.TB_PAY_H` ->
`BILLING.PAYMENT`.

Regenerate with `node test/fixtures/schema-migration/large/generate.js`.
`test/integration/schemaMigrationLarge.test.js` checks the oracle, these
files, five more seeds, and the "fragment nothing includes" warnings.
