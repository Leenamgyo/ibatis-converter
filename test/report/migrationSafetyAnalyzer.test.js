import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalyzerPipeline } from '../../src/application/AnalyzerPipeline.js';
import { MyBatisAstConverter } from '../../src/converter/mybatis/MyBatisAstConverter.js';
import { MigrationSafetyAnalyzer } from '../../src/report/migration/MigrationSafetyAnalyzer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures');
const converter = new MyBatisAstConverter();
const safety = new MigrationSafetyAnalyzer();

function convert(fixtureName, qualifiedId) {
  const sourceFile = path.join(fixturesDir, fixtureName);
  const result = new AnalyzerPipeline().run([{ sourceFile, source: fs.readFileSync(sourceFile, 'utf8') }]);
  return converter.convertStatement(result.resolvedStatements.get(qualifiedId).originalTree);
}

test('summarizes a fully-safe conversion as all SAFE, zero elsewhere', () => {
  const { events } = convert('dynamic-where.xml', 'user.getUserList');
  const summary = safety.summarize(events);
  assert.ok(summary.SAFE > 0);
  assert.equal(summary.WARNING, 0);
  assert.equal(summary.MANUAL, 0);
  assert.equal(summary.ERROR, 0);
});

test('counts one WARNING for a $...$ raw substitution alongside its SAFE parameter/dynamic conversions', () => {
  const { events } = convert('raw-substitution.xml', 'user.search');
  const summary = safety.summarize(events);
  assert.equal(summary.WARNING, 1);
});

test('counts one MANUAL for a parameterMap-based statement', () => {
  const { events } = convert('parametermap.xml', 'user.getUserByParamMap');
  const summary = safety.summarize(events);
  assert.equal(summary.MANUAL, 1);
});
