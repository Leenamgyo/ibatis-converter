import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalyzerPipeline } from '../../src/application/AnalyzerPipeline.js';

/**
 * INSERT/UPDATE/DELETE/PROCEDURE coverage.
 *
 * The sample project (`public/samples/`) is SELECT-only — the UI's lineage
 * and dynamic-SQL screens are for reading legacy queries, not writes — but
 * the analyzer and converter handle writes too, so the statements that
 * used to carry that coverage live here instead:
 * `<selectKey>` in both timings, a parameterMap-driven insert the
 * converter refuses to auto-convert, `INSERT ... SELECT`'s read side,
 * subquery-driven UPDATE/DELETE, `<dynamic prepend="SET">` -> `<set>`,
 * and a `<procedure>` whose body no SQL dialect can parse.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures', 'write-statements');

const files = fs.readdirSync(fixturesDir).sort().map((name) => ({
  sourceFile: name,
  source: fs.readFileSync(path.join(fixturesDir, name), 'utf8'),
}));
const result = new AnalyzerPipeline().run(files);

const analysis = (id) => {
  const found = result.statementAnalyses.get(id);
  assert.ok(found, `no analysis for ${id}`);
  return found;
};
const lineageOf = (id) => analysis(id).lineage;

test('statement types, both selectKey timings, and a parameterMap statement left MANUAL', () => {
  assert.equal(analysis('basic.insertCustomer').type, 'INSERT');
  assert.equal(analysis('basic.updateCustomerEmail').type, 'UPDATE');
  assert.equal(analysis('basic.deleteCustomer').type, 'DELETE');

  const pre = result.mybatisConversions.get('basic.insertCustomer').events.map((e) => e.code);
  const post = result.mybatisConversions.get('basic.insertOrderWithPostKey').events.map((e) => e.code);
  assert.ok(pre.includes('SELECT_KEY_CONVERTED'));
  assert.ok(post.includes('SELECT_KEY_CONVERTED'));

  const viaParameterMap = result.mybatisConversions.get('basic.insertCustomerByParameterMap');
  assert.equal(viaParameterMap.safetySummary.MANUAL, 1);
  assert.ok(viaParameterMap.events.some((e) => e.code === 'PARAMETER_MAP_STATEMENT'));

  // INSERT ... SELECT: the read side is analyzed too, not just the target.
  const insertSelect = analysis('basic.archiveCustomersFromSelect');
  assert.deepEqual(insertSelect.tables.map((t) => t.name).sort(), ['ARCHIVED_CUSTOMER', 'CUSTOMER']);
});

test('a write statement is a lineage root of its own, not an empty graph', () => {
  const insert = lineageOf('basic.insertCustomer').selects[0];
  assert.equal(insert.role, 'WRITE');
  assert.equal(insert.operation, 'INSERT');
  assert.deepEqual(insert.tables.map((t) => t.name), ['CUSTOMER']);
  assert.deepEqual(insert.outputs.map((o) => o.alias), ['CUSTOMER_ID', 'CUSTOMER_NAME', 'EMAIL', 'STATUS', 'REGION_CODE']);

  // INSERT ... SELECT pairs written columns with the feeding SELECT's output.
  const archive = lineageOf('basic.archiveCustomersFromSelect');
  const source = archive.selects.find((s) => s.origin === 'INSERT_SELECT');
  assert.equal(source.parentId, 'MAIN');
  assert.deepEqual(source.tables.map((t) => t.name), ['CUSTOMER']);
  const byAlias = new Map(archive.columnLineage.map((c) => [c.alias, c]));
  assert.equal(byAlias.get('CUSTOMER_NAME').sourceTable, 'CUSTOMER');
  assert.equal(byAlias.get('CUSTOMER_NAME').sourceColumn, 'CUSTOMER_NAME');

  const update = lineageOf('basic.updateCustomerEmail').selects[0];
  assert.equal(update.role, 'WRITE');
  assert.deepEqual(update.outputs.map((o) => o.alias), ['EMAIL', 'UPDATED_AT']);
  assert.ok(update.where.includes('CUSTOMER_ID'));

  const del = lineageOf('basic.deleteCustomer').selects[0];
  assert.equal(del.operation, 'DELETE');
  assert.deepEqual(del.tables.map((t) => t.name), ['CUSTOMER']);

  const dynamicUpdate = lineageOf('dyn.updateOrderDynamicSet').selects[0];
  assert.equal(dynamicUpdate.role, 'WRITE');
  assert.equal(dynamicUpdate.outputs.length, 3);
});

test('a subquery inside an UPDATE/DELETE WHERE is a child of the write', () => {
  const update = lineageOf('basic.closeCustomersWithoutOrders');
  const updateChild = update.selects.find((s) => s.parentId === 'MAIN');
  assert.equal(updateChild.origin, 'WHERE');
  assert.deepEqual(updateChild.tables.map((t) => t.name), ['ORDERS']);
  // The write's own target is still the table being updated.
  assert.deepEqual(update.selects[0].tables.map((t) => t.name), ['CUSTOMER']);

  const del = lineageOf('basic.deleteOrphanOrderDetails');
  assert.equal(del.selects[0].operation, 'DELETE');
  const delChild = del.selects.find((s) => s.parentId === 'MAIN');
  assert.deepEqual(delChild.tables.map((t) => t.name), ['ORDERS']);

  // The table report attributes each side correctly.
  assert.ok(result.tableUsageReport.ORDER_DETAIL.operations.DELETE.includes('basic.deleteOrphanOrderDetails'));
  assert.ok(result.tableUsageReport.ORDERS.operations.READ.includes('basic.deleteOrphanOrderDetails'));
  assert.ok(result.tableUsageReport.CUSTOMER.operations.UPDATE.includes('basic.updateCustomerEmail'));
  assert.ok(result.tableUsageReport.CUSTOMER.operations.DELETE.includes('basic.deleteCustomer'));
});

test('<dynamic prepend="SET"> converts to <set>, with the comma where <set> can strip it', () => {
  const set = result.mybatisConversions.get('dyn.updateOrderDynamicSet').xml;
  assert.ok(set.includes('<set>'), 'a SET group must convert to <set>, not <where>/<trim>');
  assert.match(set, /STATUS = #\{status\},/);
  assert.match(set, /UPDATED_AT = #\{updatedAt\},/);
});

test('a <procedure> is parsed and converted even though its body is not SQL', () => {
  assert.equal(analysis('edge.callSettlementBatch').type, 'PROCEDURE');
  assert.ok(result.mybatisConversions.get('edge.callSettlementBatch').xml.includes('SETTLE_ORDERS'));
  // `{ call ... }` is not SQL any dialect parses, so analysis degrades.
  assert.deepEqual(analysis('edge.callSettlementBatch').warnings.map((w) => w.code), ['SQL_PARSE_FAILED']);
});

test('the unparseable procedure is the only statement here that fails SQL analysis', () => {
  const failed = [...result.statementAnalyses.values()]
    .filter((a) => a.warnings.some((w) => w.code === 'SQL_PARSE_FAILED'))
    .map((a) => a.id);
  assert.deepEqual(failed, ['edge.callSettlementBatch']);
  assert.deepEqual(result.diagnostics.errors, []);
});
