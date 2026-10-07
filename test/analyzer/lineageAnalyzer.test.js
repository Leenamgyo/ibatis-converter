import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalyzerPipeline } from '../../src/application/AnalyzerPipeline.js';
import { LineageAnalyzer } from '../../src/analyzer/lineage/LineageAnalyzer.js';
import { SqlAnalyzer } from '../../src/analyzer/sql/SqlAnalyzer.js';
import { SelectOrigin, SelectRole } from '../../src/analyzer/lineage/model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures');

function analyzeFixture(fixtureName) {
  const sourceFile = path.join(fixturesDir, fixtureName);
  const source = fs.readFileSync(sourceFile, 'utf8');
  return new AnalyzerPipeline().run([{ sourceFile, source }]);
}

function lineageOfSql(sql) {
  const { ast, error } = new SqlAnalyzer().parse(sql);
  assert.equal(error, null);
  return new LineageAnalyzer().analyze(ast);
}

test('keeps one node per SELECT, linked parent -> child, for a statement with FROM/SELECT-list/nested subqueries', () => {
  const result = analyzeFixture('lineage-customer-statistics.xml');
  const analysis = result.statementAnalyses.get('stat.getCustomerOrderStatistics');
  assert.deepEqual(analysis.warnings, []);

  const { selects } = analysis.lineage;
  const main = selects.find((s) => s.role === SelectRole.MAIN);
  assert.equal(main.id, 'MAIN');
  assert.equal(main.origin, SelectOrigin.ROOT);
  assert.deepEqual(main.tables.map((t) => t.name), ['CUSTOMER', 'P1']);
  assert.equal(main.joins[0].type, 'LEFT_JOIN');

  // The JOINed inline view, the scalar subquery in the SELECT list, and
  // the subquery nested inside the inline view's WHERE.
  const children = selects.filter((s) => s.parentId === 'MAIN');
  assert.deepEqual(children.map((s) => s.origin).sort(), [SelectOrigin.JOIN, SelectOrigin.SELECT_LIST]);

  const inlineView = children.find((s) => s.origin === SelectOrigin.JOIN);
  assert.equal(inlineView.alias, 'P1');
  assert.deepEqual(inlineView.tables.map((t) => t.name), ['PAYMENT']);
  assert.deepEqual(inlineView.groupBy, ['PM.CUSTOMER_ID']);

  const nested = selects.find((s) => s.parentId === inlineView.id);
  assert.equal(nested.origin, SelectOrigin.WHERE);
  assert.equal(nested.depth, 2);
  assert.deepEqual(nested.tables.map((t) => t.name), ['ORDER_DETAIL']);

  assert.equal(analysis.lineage.counts.subqueries, 3);
});

test('follows a final SELECT alias back through a derived table to its real source column', () => {
  const result = analyzeFixture('lineage-customer-statistics.xml');
  const { columnLineage } = result.statementAnalyses.get('stat.getCustomerOrderStatistics').lineage;

  const byAlias = new Map(columnLineage.map((c) => [c.alias, c]));

  // Straight column: alias-qualified in the SELECT list.
  assert.equal(byAlias.get('CUSTOMER_ID').sourceTable, 'CUSTOMER');

  // Through the JOINed inline view: totalPayment <- P1.TOTAL_PAYMENT <- PAYMENT.PAYMENT_AMOUNT.
  const total = byAlias.get('totalPayment');
  assert.equal(total.sourceTable, 'PAYMENT');
  assert.equal(total.sourceColumn, 'PAYMENT_AMOUNT');
  assert.equal(total.path.length, 1);

  // Through a scalar subquery: lastOrderDate <- ORDERS.ORDER_DATE.
  const last = byAlias.get('lastOrderDate');
  assert.equal(last.sourceTable, 'ORDERS');
  assert.equal(last.sourceColumn, 'ORDER_DATE');
});

test('records UNION branches as siblings carrying their set operator', () => {
  const result = analyzeFixture('lineage-customer-statistics.xml');
  const { selects, counts } = result.statementAnalyses.get('stat.getCustomerOrderStatisticsUnion').lineage;

  const branch = selects.find((s) => s.role === SelectRole.UNION_BRANCH);
  assert.equal(branch.origin, SelectOrigin.UNION);
  assert.equal(branch.setOperator, 'UNION ALL');
  assert.deepEqual(branch.tables.map((t) => t.name), ['ARCHIVED_CUSTOMER']);
  assert.equal(counts.unions, 1);
});

test('names a WITH CTE and keeps it as a child of the SELECT that reads it', () => {
  const { selects } = lineageOfSql(
    'WITH RECENT AS (SELECT ORDER_ID, CUSTOMER_ID FROM ORDERS WHERE STATUS = 1) SELECT R.ORDER_ID FROM RECENT R',
  );
  const cte = selects.find((s) => s.role === SelectRole.CTE);
  assert.equal(cte.alias, 'RECENT');
  assert.equal(cte.parentId, 'MAIN');
  assert.deepEqual(cte.tables.map((t) => t.name), ['ORDERS']);
});

test('degrades to an empty lineage instead of throwing when the SQL never parsed', () => {
  const result = analyzeFixture('dynamic-from-and-subquery.xml');
  const analysis = result.statementAnalyses.get('edge.mutuallyExclusiveFromBranches');
  assert.equal(analysis.warnings[0].code, 'SQL_PARSE_FAILED');
  assert.deepEqual(analysis.lineage.selects, []);
  assert.deepEqual(analysis.lineage.columnLineage, []);
});
