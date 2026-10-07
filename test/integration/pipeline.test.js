import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalyzerPipeline } from '../../src/application/AnalyzerPipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures');

function readFixture(relativePath) {
  const sourceFile = path.join(fixturesDir, relativePath);
  return { sourceFile, source: fs.readFileSync(sourceFile, 'utf8') };
}

test('end-to-end: parse -> AST -> symbol table -> reference resolution across a small multi-file project', () => {
  const files = [
    readFixture('cross-mapper/order.xml'),
    readFixture('cross-mapper/common.xml'),
    readFixture('include-nested.xml'),
    readFixture('circular-refid.xml'),
    readFixture('missing-refid.xml'),
  ];

  const pipeline = new AnalyzerPipeline();
  const result = pipeline.run(files);

  // A broken file (missing/circular refid) must not stop the rest of the
  // project from being parsed and resolved.
  assert.equal(result.parsedMappers.length, 5);
  assert.ok(result.parsedMappers.every((m) => m.sqlMap !== null));

  assert.ok(result.resolvedStatements.has('order.getOrders'));
  assert.ok(result.resolvedStatements.has('common.getUser'));
  assert.ok(result.resolvedStatements.has('circular.getRow'));
  assert.ok(result.resolvedStatements.has('user.getUser'));

  const errorCodes = result.diagnostics.errors.map((e) => e.code).sort();
  assert.deepEqual(errorCodes, ['CIRCULAR_REFERENCE', 'MISSING_REFERENCE']);

  assert.equal(result.circularReferences.length, 1);

  // cross-mapper include edge shows up in the project-wide dependency graph
  const orderDeps = result.dependencyGraph.getDependencies('order.getOrders');
  assert.deepEqual(orderDeps, [{ to: 'common.pagination', kind: 'INCLUDE' }]);
});
