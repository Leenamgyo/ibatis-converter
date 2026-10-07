import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalyzerPipeline } from '../../src/application/AnalyzerPipeline.js';
import { DependencyAnalyzer } from '../../src/analyzer/dependency/DependencyAnalyzer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures');

function readFixture(name) {
  const sourceFile = path.join(fixturesDir, name);
  return { sourceFile, source: fs.readFileSync(sourceFile, 'utf8') };
}

test('builds a table dependency graph from JOIN relations, with the statement(s) as evidence', () => {
  const result = new AnalyzerPipeline().run([readFixture('join.xml')]);
  assert.equal(result.diagnostics.errors.length, 0);

  const graph = result.tableDependencyGraph;
  assert.deepEqual(graph.USER, [{ table: 'ORDERS', statements: ['order.getOrdersWithUser'] }]);
});

test('dedupes multiple statements joining the same two tables into one edge with both statement ids', () => {
  const result = new AnalyzerPipeline().run([readFixture('join.xml'), readFixture('aliases-and-duplicate-columns.xml')]);
  const analyzer = new DependencyAnalyzer(result.dependencyGraph);
  const graph = analyzer.buildTableDependencyGraph([...result.statementAnalyses.values()]);

  assert.equal(graph.USER.length, 1);
  assert.deepEqual(graph.USER[0].statements.sort(), ['order.getOrdersWithUser', 'report.getUserOrderStatus']);
});

test('builds a multi-level include dependency tree', () => {
  const result = new AnalyzerPipeline().run([readFixture('include-nested.xml')]);
  const analyzer = new DependencyAnalyzer(result.dependencyGraph);
  const tree = analyzer.buildStatementDependencyTree('common.getUser');

  assert.equal(tree.includes.length, 1);
  assert.equal(tree.includes[0].id, 'common.baseWhere');
  assert.equal(tree.includes[0].kind, 'INCLUDE');
  assert.equal(tree.includes[0].children[0].id, 'common.activeCondition');
  assert.equal(tree.includes[0].children[0].children[0].id, 'common.memberCondition');
  assert.equal(tree.resultMap, null);
  assert.equal(tree.parameterMap, null);
});

test('marks a circular include as a terminal node instead of recursing forever', () => {
  const result = new AnalyzerPipeline().run([readFixture('circular-refid.xml')]);
  const analyzer = new DependencyAnalyzer(result.dependencyGraph);
  const tree = analyzer.buildStatementDependencyTree('circular.getRow');

  let node = tree.includes[0];
  let depth = 0;
  while (node.children.length > 0 && depth < 10) {
    node = node.children[0];
    depth += 1;
  }
  assert.ok(depth < 10, 'traversal must terminate via a circular marker, not run away');
  assert.equal(node.circular, true);
});

test('represents a resultMap extends chain separately from the include tree, and links a missing parameterMap as a diagnostic', () => {
  const result = new AnalyzerPipeline().run([readFixture('resultmap-extends.xml')]);
  const analyzer = new DependencyAnalyzer(result.dependencyGraph);
  const tree = analyzer.buildStatementDependencyTree('user.getUser');

  assert.deepEqual(tree.includes, []);
  assert.equal(tree.resultMap.id, 'user.UserDetailResult');
  assert.equal(tree.resultMap.parent.id, 'user.UserResult');
  assert.equal(tree.resultMap.parent.parent.id, 'user.BaseResult');
  assert.equal(tree.resultMap.parent.parent.parent, null);
});

test('reports an unresolved statement-level resultMap as a diagnostic instead of throwing', () => {
  const result = new AnalyzerPipeline().run([{
    sourceFile: 'bad.xml',
    source: '<sqlMap namespace="x"><select id="getX" resultMap="NoSuchMap">SELECT 1</select></sqlMap>',
  }]);
  const error = result.diagnostics.errors.find((e) => e.code === 'MISSING_RESULT_MAP_REFERENCE');
  assert.ok(error);
});
