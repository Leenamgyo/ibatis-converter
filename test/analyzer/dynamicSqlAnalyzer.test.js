import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalyzerPipeline } from '../../src/application/AnalyzerPipeline.js';
import { DynamicSqlAnalyzer } from '../../src/analyzer/dynamic/DynamicSqlAnalyzer.js';
import { ConditionType } from '../../src/ast/ibatis/enums.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures');

function resolvedTreeFor(fixtureName, qualifiedId) {
  const sourceFile = path.join(fixturesDir, fixtureName);
  const source = fs.readFileSync(sourceFile, 'utf8');
  const result = new AnalyzerPipeline().run([{ sourceFile, source }]);
  assert.equal(result.diagnostics.errors.length, 0, `unexpected parse/resolve errors: ${JSON.stringify(result.diagnostics.errors)}`);
  return result.resolvedStatements.get(qualifiedId).resolvedTree;
}

const analyzer = new DynamicSqlAnalyzer();

test('converts <dynamic prepend="WHERE"> with two isNotNull conditions', () => {
  const tree = resolvedTreeFor('dynamic-where.xml', 'user.getUserList');
  const [group] = analyzer.analyze(tree);

  assert.equal(group.kind, 'DYNAMIC_GROUP');
  assert.equal(group.prepend, 'WHERE');
  assert.equal(group.children.length, 2);

  const [userIdCond, statusCond] = group.children;
  assert.equal(userIdCond.kind, 'CONDITION');
  assert.equal(userIdCond.operator, ConditionType.IS_NOT_NULL);
  assert.equal(userIdCond.property, 'userId');
  assert.equal(userIdCond.prepend, 'AND');
  assert.equal(userIdCond.sql, 'USER_ID = #userId#');
  assert.equal(userIdCond.children.length, 0);

  assert.equal(statusCond.property, 'status');
  assert.equal(statusCond.sql, 'STATUS = #status#');
});

test('keeps nested <dynamic> as a nested tree rather than flattening it', () => {
  const tree = resolvedTreeFor('nested-dynamic.xml', 'user.searchUsers');
  const [outerGroup] = analyzer.analyze(tree);

  const statusCond = outerGroup.children[0];
  assert.equal(statusCond.property, 'status');

  const innerGroup = statusCond.children.find((c) => c.kind === 'DYNAMIC_GROUP');
  assert.ok(innerGroup, 'expected a nested DynamicGroup inside the status condition');
  assert.equal(innerGroup.prepend, 'AND');

  const roleCond = innerGroup.children.find((c) => c.kind === 'CONDITION');
  assert.equal(roleCond.property, 'role');
  assert.equal(roleCond.operator, ConditionType.IS_NOT_NULL);
  assert.equal(roleCond.sql, 'ROLE = #role#');
});

test('standardizes every isXxx tag into the matching ConditionType operator', () => {
  const tree = resolvedTreeFor('conditions.xml', 'cond.allConditions');
  const [group] = analyzer.analyze(tree);
  const operators = group.children.map((c) => c.operator);

  assert.deepEqual(operators, [
    ConditionType.IS_NULL,
    ConditionType.IS_NOT_NULL,
    ConditionType.IS_EMPTY,
    ConditionType.IS_NOT_EMPTY,
    ConditionType.EQUAL,
    ConditionType.NOT_EQUAL,
    ConditionType.GREATER_THAN,
    ConditionType.GREATER_EQUAL,
    ConditionType.LESS_THAN,
    ConditionType.LESS_EQUAL,
    ConditionType.PROPERTY_AVAILABLE,
    ConditionType.NOT_PROPERTY_AVAILABLE,
  ]);

  const eq = group.children.find((c) => c.operator === ConditionType.EQUAL);
  assert.equal(eq.compareValue, '1');
});

test('converts nested <iterate> into a nested DynamicIterate tree', () => {
  const tree = resolvedTreeFor('iterate.xml', 'user.getUsersByGroups');
  const [outerIter] = analyzer.analyze(tree);

  assert.equal(outerIter.kind, 'ITERATE');
  assert.equal(outerIter.property, 'groups');
  assert.equal(outerIter.open, 'AND (');
  assert.equal(outerIter.conjunction, 'OR');

  const innerIter = outerIter.children.find((c) => c.kind === 'ITERATE');
  assert.ok(innerIter, 'expected a nested DynamicIterate');
  assert.equal(innerIter.property, 'groups[].subIds');
});

test('collectConditions recursively gathers every condition across nested groups', () => {
  const tree = resolvedTreeFor('nested-dynamic.xml', 'user.searchUsers');
  const groups = analyzer.analyze(tree);
  const conditions = DynamicSqlAnalyzer.collectConditions(groups);
  assert.deepEqual(conditions.map((c) => c.property), ['status', 'role']);
});
