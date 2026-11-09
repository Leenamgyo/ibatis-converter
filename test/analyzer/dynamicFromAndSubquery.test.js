import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalyzerPipeline } from '../../src/application/AnalyzerPipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, '..', 'fixtures', 'dynamic-from-and-subquery.xml');

function analyze() {
  const pipeline = new AnalyzerPipeline();
  return pipeline.run([{ sourceFile: fixture, source: fs.readFileSync(fixture, 'utf8') }]).statementAnalyses;
}

const tableNames = (analysis) => analysis.tables.map((t) => t.name).sort();
const warningCodes = (analysis) => (analysis.warnings ?? []).map((w) => w.code);

test('a subquery in the SELECT list contributes its table without hiding the outer FROM table', () => {
  const analysis = analyze().get('edge.subqueryInSelectList');
  assert.deepEqual(tableNames(analysis), ['PRODUCTS', 'PRODUCT_REVIEWS']);
  assert.deepEqual(warningCodes(analysis), []);
});

test('a FROM-clause subquery is reported as a derived table alongside the real table it reads', () => {
  const analysis = analyze().get('edge.subqueryInFrom');
  const derived = analysis.tables.filter((t) => t.derived).map((t) => t.name);
  const real = analysis.tables.filter((t) => !t.derived).map((t) => t.name);
  assert.deepEqual(derived, ['T']);
  assert.deepEqual(real, ['ORDERS']);
  assert.deepEqual(warningCodes(analysis), []);
});

test('a JOIN added by a conditional tag is still analyzed as a JOIN', () => {
  const analysis = analyze().get('edge.dynamicJoin');
  assert.deepEqual(tableNames(analysis), ['ORDERS', 'USERS']);
  assert.equal(analysis.joins.length, 1);
  assert.equal(analysis.joins[0].joinType ?? analysis.joins[0].type, 'INNER_JOIN');
});

test('dynamic SQL nested inside a subquery flattens without disturbing the outer statement', () => {
  const analysis = analyze().get('edge.dynamicInsideSubquery');
  assert.deepEqual(tableNames(analysis), ['ORDERS', 'USERS']);
  assert.deepEqual(warningCodes(analysis), []);
});

test('a UNION branch supplied by a conditional tag contributes its table too', () => {
  const analysis = analyze().get('edge.dynamicUnionBranch');
  assert.deepEqual(tableNames(analysis), ['ARCHIVED_USERS', 'USERS']);
  assert.deepEqual(warningCodes(analysis), []);
});

test('two mutually exclusive branches supplying the FROM table: a dynamic table name, both tables reported', () => {
  // Keeping both branches would give "FROM ARCHIVED_ORDERS O ORDERS O"; each branch is
  // flattened on its own instead (SqlFlattener#tableChoices) and the results merged.
  const analysis = analyze().get('edge.mutuallyExclusiveFromBranches');
  assert.deepEqual(warningCodes(analysis), []);
  assert.deepEqual(tableNames(analysis), ['ARCHIVED_ORDERS', 'ORDERS']);
  assert.deepEqual(analysis.tables.map((t) => [t.alias, t.choice.group, t.choice.label]), [['O', 'choice0', '분기 1/2'], ['O', 'choice0', '분기 2/2']]);
  assert.deepEqual(analysis.columns.map((c) => `${c.table}.${c.column}`).sort(), ['ARCHIVED_ORDERS.ORDER_ID', 'ARCHIVED_ORDERS.STATUS', 'ORDERS.ORDER_ID', 'ORDERS.STATUS']);
  // the lineage SELECT reads both, so the graph can draw them as one dynamic table
  assert.deepEqual(analysis.lineage.selects[0].tables.map((t) => t.name), ['ARCHIVED_ORDERS', 'ORDERS']);
});

test('genuinely unparseable SQL degrades to SQL_PARSE_FAILED instead of throwing', () => {
  const analysis = analyze().get('edge.unparseableConnectBy');
  assert.deepEqual(warningCodes(analysis), ['SQL_PARSE_FAILED']);
  assert.deepEqual(analysis.tables, []);
  assert.deepEqual(analysis.joins, []);
});

test('the unparseable statement does not stop the other statements in the same file from being analyzed', () => {
  const analyses = analyze();
  assert.equal(analyses.size, 7);
  const withWarnings = [...analyses.entries()].filter(([, a]) => (a.warnings ?? []).length).map(([id]) => id);
  assert.deepEqual(withWarnings, ['edge.unparseableConnectBy']);
});
