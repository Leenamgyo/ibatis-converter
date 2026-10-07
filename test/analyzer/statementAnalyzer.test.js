import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalyzerPipeline } from '../../src/application/AnalyzerPipeline.js';
import { StatementAnalyzer } from '../../src/analyzer/statement/StatementAnalyzer.js';
import { TableOperation } from '../../src/analyzer/table/model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures');
const analyzer = new StatementAnalyzer();

function analyzeStatement(fixtureName, qualifiedId) {
  const sourceFile = path.join(fixturesDir, fixtureName);
  const source = fs.readFileSync(sourceFile, 'utf8');
  const result = new AnalyzerPipeline().run([{ sourceFile, source }]);
  assert.equal(result.diagnostics.errors.length, 0);
  const { originalTree, resolvedTree } = result.resolvedStatements.get(qualifiedId);
  return analyzer.analyze(originalTree, resolvedTree, qualifiedId);
}

test('combines table/parameter/dynamic analysis into one StatementAnalysis for a JOIN + dynamic WHERE statement', () => {
  const analysis = analyzeStatement('join.xml', 'order.getOrdersWithUser');
  assert.equal(analysis.id, 'order.getOrdersWithUser');
  assert.equal(analysis.type, 'SELECT');
  assert.deepEqual(analysis.tables.map((t) => t.name), ['USER', 'ORDERS']);
  assert.equal(analysis.joins.length, 1);
  assert.equal(analysis.parameters.length, 1);
  assert.equal(analysis.parameters[0].name, 'status');
  assert.equal(analysis.warnings.length, 0);
  assert.match(analysis.sql, /LEFT JOIN ORDERS/);
});

test('resolves include ids and flags $...$ as a warning in the same composite result', () => {
  const analysis = analyzeStatement('include-basic.xml', 'user.getUser');
  assert.deepEqual(analysis.includes, ['user.baseColumns']);
  assert.equal(analysis.warnings.length, 0);

  const withDollar = analyzeStatement('raw-substitution.xml', 'user.search');
  assert.equal(withDollar.warnings.length, 1);
  assert.equal(withDollar.warnings[0].code, 'RAW_SQL_SUBSTITUTION');
});

test('surfaces dynamic conditions and table operation for a CREATE (INSERT) statement', () => {
  const analysis = analyzeStatement('write-statements/crud.xml', 'user.insertUserPlain');
  assert.equal(analysis.tables[0].operation, TableOperation.CREATE);
  assert.deepEqual(analysis.dynamicConditions, []);
});

test('degrades gracefully (empty tables, SQL_PARSE_FAILED warning) instead of throwing when flattened SQL is unparseable', () => {
  // The nested <iterate> in this fixture produces syntactically invalid SQL when
  // flattened to a single representative item — see docs/SPEC_MAPPING.md.
  const analysis = analyzeStatement('iterate.xml', 'user.getUsersByGroups');
  assert.deepEqual(analysis.tables, []);
  assert.deepEqual(analysis.columns, []);
  assert.equal(analysis.where, null);
  assert.ok(analysis.warnings.some((w) => w.code === 'SQL_PARSE_FAILED'));
  // But the parts of the analysis that don't depend on a real SQL parse still work:
  assert.equal(analysis.parameters.length > 0, true);
});
