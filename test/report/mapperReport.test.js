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

test('summarizes one mapper file: statement counts by type, fragment/resultMap counts, and tables touched', () => {
  const result = new AnalyzerPipeline().run([readFixture('write-statements/crud.xml')]);
  assert.equal(result.diagnostics.errors.length, 0);

  const [report] = result.mapperReports;
  assert.equal(report.namespace, 'user');
  assert.equal(report.statementCount, 3);
  assert.equal(report.byType.INSERT, 1);
  assert.equal(report.byType.UPDATE, 1);
  assert.equal(report.byType.DELETE, 1);
  assert.equal(report.byType.SELECT, 0);
  assert.deepEqual(report.tables, ['USER']);
  assert.equal(report.errorCount, 0);
  assert.equal(report.statements.length, 3);
});

test('rolls a $...$ parameter warning up into the mapper-level warning count', () => {
  const result = new AnalyzerPipeline().run([readFixture('raw-substitution.xml')]);
  const [report] = result.mapperReports;
  assert.equal(report.warningCount, 1);
});

test('a file that fails to parse still produces a report with zero statements rather than throwing', () => {
  const result = new AnalyzerPipeline().run([{ sourceFile: 'broken.xml', source: '<sqlMap namespace="x"><select></select>' }]);
  const [report] = result.mapperReports;
  assert.equal(report.statementCount, 0);
  assert.ok(report.errorCount >= 1);
});
