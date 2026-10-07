import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalyzerPipeline } from '../../src/application/AnalyzerPipeline.js';
import { flattenToSql } from '../../src/analyzer/sql/SqlFlattener.js';
import { SqlAnalyzer } from '../../src/analyzer/sql/SqlAnalyzer.js';
import { TableAnalyzer } from '../../src/analyzer/table/TableAnalyzer.js';
import { TableOperation, ColumnUsedIn, ColumnResolution, JoinType } from '../../src/analyzer/table/model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures');
const sqlAnalyzer = new SqlAnalyzer();
const tableAnalyzer = new TableAnalyzer();

function analyzeStatement(fixtureName, qualifiedId, dialect = 'mysql') {
  const sourceFile = path.join(fixturesDir, fixtureName);
  const source = fs.readFileSync(sourceFile, 'utf8');
  const pipelineResult = new AnalyzerPipeline().run([{ sourceFile, source }]);
  assert.equal(pipelineResult.diagnostics.errors.length, 0, `unexpected diagnostics: ${JSON.stringify(pipelineResult.diagnostics.errors)}`);
  const { resolvedTree } = pipelineResult.resolvedStatements.get(qualifiedId);
  const sql = flattenToSql(resolvedTree);
  const { ast, error } = sqlAnalyzer.parse(sql, dialect);
  assert.equal(error, null, `SQL did not parse: "${sql}" -> ${error}`);
  return { sql, ...tableAnalyzer.analyze(ast) };
}

test('extracts LEFT JOIN as a table + column + JoinRelation, matching the spec example', () => {
  const { tables, joins, columns } = analyzeStatement('join.xml', 'order.getOrdersWithUser');

  assert.deepEqual(tables.map((t) => [t.name, t.alias, t.operation]), [
    ['USER', 'U', TableOperation.READ],
    ['ORDERS', 'O', TableOperation.READ],
  ]);

  assert.equal(joins.length, 1);
  assert.equal(joins[0].leftTable, 'USER');
  assert.equal(joins[0].rightTable, 'ORDERS');
  assert.equal(joins[0].type, JoinType.LEFT_JOIN);
  assert.equal(joins[0].conditions.length, 2);
  assert.equal(joins[0].conditions[0].left.table, 'USER');
  assert.equal(joins[0].conditions[0].right.table, 'ORDERS');
  assert.equal(joins[0].conditions[1].left.column, 'STATUS');
  assert.equal(joins[0].conditions[1].right.value, 'ACTIVE');

  // U.USER_ID = O.USER_ID AND O.STATUS = 'ACTIVE' -> 3 column refs (the literal isn't a column).
  const joinColumns = columns.filter((c) => c.usedIn === ColumnUsedIn.JOIN);
  assert.equal(joinColumns.length, 3);
});

test('resolves an alias-qualified column back to its real table name', () => {
  const { columns } = analyzeStatement('join.xml', 'order.getOrdersWithUser');
  const selectCols = columns.filter((c) => c.usedIn === ColumnUsedIn.SELECT);
  assert.deepEqual(selectCols.map((c) => `${c.table}.${c.column}`), ['USER.USER_ID', 'ORDERS.ORDER_ID']);
});

test('leaves an unqualified column UNRESOLVED against table UNKNOWN', () => {
  const { columns } = analyzeStatement('simple-select.xml', 'user.getUser');
  assert.ok(columns.every((c) => c.table === 'UNKNOWN' && c.resolution === ColumnResolution.UNRESOLVED));
});

test('discovers the table inside a FROM-clause subquery (derived table)', () => {
  const { tables, columns } = analyzeStatement('subquery.xml', 'order.getOrdersFromDerivedTable');
  assert.ok(tables.some((t) => t.name === 'ORDERS'), 'expected the subquery\'s own table to be discovered');
  assert.ok(tables.some((t) => t.derived && t.alias === 'T'), 'expected the derived table itself to be recorded');
  assert.ok(columns.some((c) => c.table === 'T' && c.column === 'ORDER_ID'));
});

test('discovers the table inside a WHERE ... IN (subquery)', () => {
  const { tables } = analyzeStatement('subquery.xml', 'order.getUsersWithOrders');
  assert.deepEqual(tables.map((t) => t.name).sort(), ['ORDERS', 'USER']);
});

test('folds a UNION\'s second SELECT tables into the same result', () => {
  const { tables } = analyzeStatement('union.xml', 'report.getActiveIds');
  assert.deepEqual(tables.map((t) => t.name), ['USER', 'ARCHIVED_USER']);
});

test('INSERT is modeled as a CREATE operation with its target columns', () => {
  const { tables, columns } = analyzeStatement('write-statements/crud.xml', 'user.insertUserPlain');
  assert.equal(tables.length, 1);
  assert.equal(tables[0].name, 'USER');
  assert.equal(tables[0].alias, null);
  assert.equal(tables[0].operation, TableOperation.CREATE);
  assert.equal(tables[0].derived, false);
  assert.deepEqual(columns.map((c) => c.column), ['USER_ID', 'USER_NAME', 'STATUS']);
  assert.ok(columns.every((c) => c.usedIn === ColumnUsedIn.INSERT));
});

test('UPDATE is modeled as an UPDATE operation with UPDATE_SET columns', () => {
  const { tables, columns } = analyzeStatement('write-statements/crud.xml', 'user.updateUserStatus');
  assert.equal(tables[0].operation, TableOperation.UPDATE);
  const setCols = columns.filter((c) => c.usedIn === ColumnUsedIn.UPDATE_SET);
  assert.deepEqual(setCols.map((c) => c.column), ['STATUS']);
});

test('DELETE is modeled as a DELETE operation', () => {
  const { tables } = analyzeStatement('write-statements/crud.xml', 'user.deleteUser');
  assert.equal(tables[0].name, 'USER');
  assert.equal(tables[0].operation, TableOperation.DELETE);
});

test('handles multiple aliases and duplicate column names across tables without conflating them', () => {
  const { columns } = analyzeStatement('aliases-and-duplicate-columns.xml', 'report.getUserOrderStatus');
  const selectCols = columns.filter((c) => c.usedIn === ColumnUsedIn.SELECT);
  assert.deepEqual(selectCols.map((c) => `${c.table}.${c.column}`), ['USER.STATUS', 'ORDERS.STATUS']);
  const whereCols = columns.filter((c) => c.usedIn === ColumnUsedIn.WHERE);
  assert.deepEqual(whereCols.map((c) => `${c.table}.${c.column}`), ['USER.STATUS', 'ORDERS.STATUS']);
});

test('parses MySQL-flavored LIMIT syntax', () => {
  const { tables } = analyzeStatement('dialect-mysql.xml', 'user.getUserPage', 'mysql');
  assert.equal(tables[0].name, 'USER');
});

test('parses portable ANSI JOIN/subquery SQL under the "oracle" dialect alias', () => {
  const { tables, joins } = analyzeStatement('dialect-oracle.xml', 'user.getUserWithLatestOrder', 'oracle');
  assert.deepEqual(tables.map((t) => t.name), ['USER', 'ORDERS']);
  assert.equal(joins[0].type, JoinType.INNER_JOIN);
});

test('builds an AND/OR WHERE tree matching the spec\'s shape', () => {
  const { ast } = sqlAnalyzer.parse("SELECT * FROM USER WHERE USER_ID = ? AND (STATUS = 'ACTIVE' OR STATUS = 'READY')");
  const { where } = tableAnalyzer.analyze(ast);
  assert.equal(where.kind, 'AND');
  assert.equal(where.children.length, 2);
  assert.equal(where.children[0].kind, 'COMPARISON');
  assert.equal(where.children[1].kind, 'OR');
  assert.equal(where.children[1].children.length, 2);
  assert.equal(where.children[1].children[0].right.value, 'ACTIVE');
  assert.equal(where.children[1].children[1].right.value, 'READY');
});

test('reports a parse failure as a diagnostic-friendly error instead of throwing', () => {
  const { ast, error } = sqlAnalyzer.parse('SELECT FROM WHERE', 'mysql');
  assert.equal(ast, null);
  assert.ok(typeof error === 'string' && error.length > 0);
});
