# Schema migration scenario cases

10 iBATIS mappers in a legacy naming style (`cases/*.xml`) run through the
whole pipeline: iBATIS -> MyBatis syntax -> new schema. The mapping is in
`cases/mapping.json`. Each case's results are checked in under `results/`:

| File | Content |
|---|---|
| `NN-*.mybatis.xml` | syntax conversion only (`generatedMapperXml`) |
| `NN-*.migrated.xml` | plus the table/column renames (`schemaMigration.mapperXml`) |
| `NN-*.events.txt` | every graded decision (SAFE / WARNING / MANUAL) |

Each result was reviewed by hand. `test/integration/schemaMigrationCases.test.js`
checks that they still match, and also asserts the specific behaviour each
case exists for. After an intentional change, regenerate with
`node test/fixtures/schema-migration/generate-results.js` and review the diff.

## Mapping

| Legacy | New | Columns |
|---|---|---|
| `TB_CUST_M` | `CUSTOMER` | CUST_NO→CUSTOMER_ID, CUST_NM→CUSTOMER_NAME, RGN_CD→REGION_CODE, USE_YN→IS_ACTIVE, REG_DT→CREATED_AT |
| `TB_ORD_H` | `ORDERS` | ORD_NO→ORDER_ID, CUST_NO→CUSTOMER_ID, ORD_DT→ORDERED_AT, ORD_STAT_CD→STATUS, TOT_AMT→TOTAL_AMOUNT |
| `TB_ORD_D` | `ORDER_ITEM` | ORD_NO→ORDER_ID, ITEM_SEQ→LINE_NO, PRD_CD→PRODUCT_ID, ORD_QTY→QUANTITY, UNIT_PRC→UNIT_PRICE |
| `TB_PRD_M` | `PRODUCT` | PRD_CD→PRODUCT_ID, PRD_NM→PRODUCT_NAME, CTG_CD→CATEGORY_CODE, USE_YN→IS_SELLABLE |
| `TB_CMM_CD` | `COMMON_CODE` | GRP_CD→GROUP_CODE, CD→CODE, CD_NM→CODE_NAME, SORT_SEQ→SORT_ORDER |
| `LEGACY.TB_PAY_H` | `BILLING.PAYMENT` | PAY_NO→PAYMENT_ID, ORD_NO→ORDER_ID, PAY_AMT→AMOUNT, PAY_DT→PAID_AT |

`TB_LOG` and `TB_ORD_H_ARCH` are deliberately unmapped.

## Cases

| # | Case | What it shows | Events |
|---|---|---|---|
| 01 | single-table | alias kept, `AS` alias kept, unmapped column `UPD_DT` kept; unaliased SELECT against a `resultMap column="CUST_NO"` | SAFE 10 · WARNING 2 (`RESULT_COLUMN_RENAMED`) |
| 02 | join-same-column | `CUST_NO`/`ORD_NO` in several tables, each resolved through its alias; 4-table join; comma join | SAFE 28 |
| 03 | dynamic-search | `<isNotEmpty>`/`<isEqual>`/`<iterate>` bodies resolve against the statement's FROM; CDATA; `test=` untouched | SAFE 8 · WARNING 2 (`$sortColumn$`, `$sortDir$`) |
| 04 | include-fragments | FROM-less column-list and condition fragments get their context from include sites; `activeOnly` is included by a PRODUCT and a CUSTOMER statement | SAFE 9 · MANUAL 1 (`FRAGMENT_CONTEXT_CONFLICT`, left as is) |
| 05 | insert | `<selectKey>` is its own SQL (untouched); INSERT column list; `INSERT ... SELECT` where target and source are the same table under different aliases | SAFE 20 |
| 06 | update-dynamic-set | `<dynamic prepend="SET">` → `<set>`; correlated subquery in SET | SAFE 13 |
| 07 | delete-subquery | `NOT EXISTS` correlated, `IN (SELECT ...)`, Oracle `DELETE T WHERE` | SAFE 11 |
| 08 | derived-table | an inner rename follows out to `T.CUST_NO` → `T.CUSTOMER_ID`; `SELECT *` derived table exposes the base mapping; aliased `ORD_CNT` kept | SAFE 14 · WARNING 1 |
| 09 | cte-union | CTE whose body is a UNION with an unmapped archive table (output names come from branch 1); CTE over the code table | SAFE 15 |
| 10 | edge-cases | `LEGACY.TB_PAY_H` → `BILLING.PAYMENT`; string literal / `--` comment untouched; hint flagged; unmapped `TB_LOG` kept; `USE_YN` ambiguous between two tables | SAFE 12 · WARNING 3 · MANUAL 1 |

## Review notes: what a human still has to decide

- **01 / 08 / 10 `RESULT_COLUMN_RENAMED`**: an unaliased top-level SELECT
  item changed its result label. Update the resultMap / VO mapping, or
  turn on `preserveResultColumnNames` (`CUSTOMER_ID AS CUST_NO`).
- **03 `${sortColumn}`**: the caller passes legacy column names at
  runtime. That has to change in the Java code.
- **04 `activeOnly`**: one fragment means `IS_SELLABLE` in one place and
  `IS_ACTIVE` in another. Split it or pass `fragmentContexts`.
- **10 `ambiguousColumn`**: `WHERE USE_YN = 'Y'` over CUSTOMER and
  PRODUCT. Qualify it in the source SQL.
- **10 hint**: `/*+ INDEX(TB_ORD_H IDX_ORD_01) */`. Fix the table and
  index names by hand.
- **10 `logJoin`**: `ORD_STAT_CD` was renamed on the assumption that it
  belongs to ORDERS (WARNING), because the unmapped `TB_LOG` is in the
  same scope.
