import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalyzerPipeline } from '../../src/application/AnalyzerPipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures');

function readFixture(name) {
  const sourceFile = path.join(fixturesDir, name);
  return { sourceFile, source: fs.readFileSync(sourceFile, 'utf8') };
}

test('builds a table-centric usage report across a whole project (operations + column usage)', () => {
  const result = new AnalyzerPipeline().run([readFixture('join.xml'), readFixture('write-statements/crud.xml')]);
  assert.equal(result.diagnostics.errors.length, 0);

  const { tableUsageReport } = result;
  assert.ok(tableUsageReport.USER);
  assert.ok(tableUsageReport.ORDERS);

  // USER is READ by order.getOrdersWithUser (join.xml), and CREATE/UPDATE/DELETE-d by crud.xml.
  assert.deepEqual(tableUsageReport.USER.operations.READ, ['order.getOrdersWithUser']);
  assert.deepEqual(tableUsageReport.USER.operations.CREATE, ['user.insertUserPlain']);
  assert.deepEqual(tableUsageReport.USER.operations.UPDATE, ['user.updateUserStatus']);
  assert.deepEqual(tableUsageReport.USER.operations.DELETE, ['user.deleteUser']);

  assert.deepEqual(tableUsageReport.ORDERS.operations.READ, ['order.getOrdersWithUser']);

  // USER.STATUS is used in both the JOIN's WHERE (join.xml) and the UPDATE's SET (crud.xml).
  assert.equal(tableUsageReport.USER.columns.STATUS.WHERE, 1);
  assert.equal(tableUsageReport.USER.columns.STATUS.UPDATE_SET, 1);
});

test('excludes UNKNOWN/unresolved columns from the per-table column breakdown', () => {
  const result = new AnalyzerPipeline().run([readFixture('simple-select.xml')]);
  const { tableUsageReport } = result;
  assert.ok(tableUsageReport.USER, 'the table itself is still recorded via the FROM clause');
  assert.deepEqual(tableUsageReport.USER.columns, {}, 'unqualified/UNRESOLVED columns must not be attributed to USER');
});
