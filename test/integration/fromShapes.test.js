import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalyzerPipeline } from '../../src/application/AnalyzerPipeline.js';
import { SqlSchemaMigrationConverter } from '../../src/converter/schema/index.js';
import { SqlAnalyzer } from '../../src/analyzer/sql/SqlAnalyzer.js';
import { TableAnalyzer } from '../../src/analyzer/table/TableAnalyzer.js';

// The two ways legacy mappers join: comma joins (`FROM A a, B b WHERE ...`, with or
// without Oracle `(+)`), and a FROM that comes from <include refid> — a table list,
// the whole FROM clause, or one more table after a written one.
// Fixtures: test/fixtures/from-shapes/{common,from-shapes}.xml
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'from-shapes');
const files = ['common.xml', 'from-shapes.xml'].map((f) => ({ sourceFile: f, source: fs.readFileSync(path.join(dir, f), 'utf8') }));
const MAPPING = {
  TB_ORD_H: { targetTable: 'ORDERS', columns: { ORD_NO: 'ORDER_ID', CUST_NO: 'CUSTOMER_ID', ORD_STAT_CD: 'STATUS', TOT_AMT: 'TOTAL_AMOUNT' } },
  TB_CUST_M: { targetTable: 'CUSTOMER', columns: { CUST_NO: 'CUSTOMER_ID', CUST_NM: 'CUSTOMER_NAME' } },
  TB_ORD_D: { targetTable: 'ORDER_ITEM', columns: { ORD_NO: 'ORDER_ID', ITEM_SEQ: 'LINE_NO', PRD_CD: 'PRODUCT_ID' } },
};
const result = new AnalyzerPipeline({ schemaMigrationConverter: new SqlSchemaMigrationConverter(MAPPING) }).run(files);
const analysis = (id) => result.statementAnalyses.get(`fromShapes.${id}`);
const joins = (id) => analysis(id).joins.map((j) => `${j.type} ${j.leftTable}-${j.rightTable}`);
const tables = (id) => analysis(id).tables.filter((t) => !t.derived).map((t) => t.name).sort();
const migrated = (file) => result.schemaMigration.mapperXml.get(file);

test('nothing in the fixtures is a parse or reference error', () => {
  assert.deepEqual(result.diagnostics.errors, []);
  for (const [id, a] of result.statementAnalyses) assert.ok(!a.warnings.some((w) => w.code === 'SQL_PARSE_FAILED'), id);
});

test('comma joins are recovered from WHERE as joins', () => {
  assert.deepEqual(tables('commaJoin'), ['TB_CUST_M', 'TB_ORD_D', 'TB_ORD_H']);
  assert.deepEqual(joins('commaJoin'), ['IMPLICIT_JOIN TB_CUST_M-TB_ORD_H', 'IMPLICIT_JOIN TB_ORD_D-TB_ORD_H']);
});

test('Oracle (+) parses, and is the LEFT JOIN it means (optional side on the right)', () => {
  // WHERE C.CUST_NO(+) = H.CUST_NO: H kept, C optional
  assert.deepEqual(joins('commaOuterJoin'), ['LEFT_JOIN TB_ORD_H-TB_CUST_M']);
  assert.equal(analysis('commaOuterJoin').lineage.selects[0].joins[0].type, 'LEFT_JOIN');
});

test('FROM <include>: tables and joins come through the include', () => {
  assert.deepEqual(tables('fromIncludeTables'), ['TB_CUST_M', 'TB_ORD_H']);
  assert.deepEqual(joins('fromIncludeTables'), ['IMPLICIT_JOIN TB_CUST_M-TB_ORD_H']); // condition from another include
  assert.deepEqual(joins('includeWholeFrom'), ['INNER_JOIN TB_ORD_H-TB_CUST_M']);
  assert.deepEqual(joins('fromMixed'), ['IMPLICIT_JOIN TB_ORD_D-TB_ORD_H']);
  assert.deepEqual(tables('fromIncludeUnqualified'), ['TB_ORD_D']);
});

test('a subquery in FROM is not a table', () => {
  assert.deepEqual(tables('commaInSubquery'), ['TB_CUST_M', 'TB_ORD_H']);
  assert.ok(!('X' in result.tableUsageReport));
});

test('schema migration: a table-list fragment included after FROM is renamed as a FROM list', () => {
  const common = migrated('common.xml');
  assert.match(common, /<sql id="orderTables">\s+ORDERS H, CUSTOMER C\s+<\/sql>/);
  assert.match(common, /FROM ORDERS H\s+INNER JOIN CUSTOMER C ON C\.CUSTOMER_ID = H\.CUSTOMER_ID/);
  assert.match(common, /AND C\.CUSTOMER_ID = H\.CUSTOMER_ID/);
  const shapes = migrated('from-shapes.xml');
  assert.match(shapes, /<sql id="itemTable">\s+ORDER_ITEM D\s+<\/sql>/);
  assert.match(shapes, /FROM ORDERS H, CUSTOMER C, ORDER_ITEM D/);
  assert.match(shapes, /WHERE C\.CUSTOMER_ID\(\+\) = H\.CUSTOMER_ID/);
  assert.match(shapes, /SELECT ORDER_ID, LINE_NO FROM\s+<include refid="itemTable"\/>\s+WHERE ORDER_ID = #\{ordNo\}/);
  // statement side: aliases defined inside the include resolve
  assert.match(shapes, /SELECT H\.ORDER_ID, C\.CUSTOMER_NAME\s+FROM\s+<include refid="fromCommon\.orderTables"\/>/);
  const inferred = [...result.schemaMigration.events.values()].flat().filter((e) => e.code === 'FRAGMENT_CONTEXT_INFERRED');
  assert.ok(inferred.some((e) => e.statementId === 'orderTables' && /FROM clause/.test(e.message)));
  assert.ok(inferred.some((e) => e.statementId === 'itemTable' && /FROM clause/.test(e.message)));
  // the only non-SAFE events are the expected result-label changes
  const review = [...result.schemaMigration.events.values()].flat().filter((e) => e.grade !== 'SAFE');
  assert.ok(review.every((e) => e.code === 'RESULT_COLUMN_RENAMED'), JSON.stringify(review.filter((e) => e.code !== 'RESULT_COLUMN_RENAMED')));
});

test('a fragment included both as a FROM list and elsewhere is a conflict, not a guess', () => {
  const conflict = new AnalyzerPipeline({ schemaMigrationConverter: new SqlSchemaMigrationConverter(MAPPING) }).run([{
    sourceFile: 'c.xml',
    source: `<sqlMap namespace="c">
      <sql id="frag">TB_ORD_D D</sql>
      <select id="a">SELECT D.ORD_NO FROM <include refid="frag"/></select>
      <select id="b">SELECT D.ORD_NO FROM TB_ORD_H H WHERE EXISTS (SELECT 1 FROM TB_ORD_H X WHERE X.ORD_NO = <include refid="frag"/>)</select>
    </sqlMap>`,
  }]);
  const events = conflict.schemaMigration.events.get('c.xml');
  assert.ok(events.some((e) => e.statementId === 'frag' && e.code === 'FRAGMENT_CONTEXT_CONFLICT' && e.grade === 'MANUAL'));
});

test('CTE bodies count; a CTE referenced in FROM is derived, not a table', () => {
  const { ast } = new SqlAnalyzer().parse('WITH R AS (SELECT O.CUSTOMER_ID FROM ORDERS O JOIN PAYMENT P ON P.ORDER_ID = O.ORDER_ID) '
    + 'SELECT C.NAME FROM CUSTOMER C, R WHERE R.CUSTOMER_ID = C.CUSTOMER_ID');
  const t = new TableAnalyzer().analyze(ast);
  assert.deepEqual(t.tables.filter((x) => !x.derived).map((x) => x.name).sort(), ['CUSTOMER', 'ORDERS', 'PAYMENT']);
  assert.deepEqual(t.tables.filter((x) => x.derived).map((x) => x.name), ['R']);
  assert.ok(t.joins.some((j) => j.type === 'INNER_JOIN' && j.leftTable === 'ORDERS' && j.rightTable === 'PAYMENT'));
});
