import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIbatisMapperSource } from '../../src/parser/ibatis/IbatisMapperParser.js';
import { StatementType, ConditionType } from '../../src/ast/ibatis/enums.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures');

function parseFixture(name) {
  const file = path.join(fixturesDir, name);
  const source = fs.readFileSync(file, 'utf8');
  return parseIbatisMapperSource(source, file);
}

test('parses a simple select statement with source location', () => {
  const { sqlMap, diagnostics } = parseFixture('simple-select.xml');
  assert.equal(diagnostics.errors.length, 0);
  assert.equal(sqlMap.namespace, 'user');
  assert.equal(sqlMap.statements.length, 1);

  const stmt = sqlMap.statements[0];
  assert.equal(stmt.id, 'getUser');
  assert.equal(stmt.statementType, StatementType.SELECT);
  assert.equal(stmt.parameterClass, 'int');
  assert.equal(stmt.resultClass, 'User');
  assert.equal(stmt.sourceFile, path.join(fixturesDir, 'simple-select.xml'));
  assert.ok(Number.isInteger(stmt.sourceLine));

  const sqlText = stmt.children.map((c) => c.text).join('');
  assert.match(sqlText, /WHERE USER_ID = #userId#/);
});

test('parses <dynamic prepend="WHERE"> with nested conditional children', () => {
  const { sqlMap, diagnostics } = parseFixture('dynamic-where.xml');
  assert.equal(diagnostics.errors.length, 0);
  const stmt = sqlMap.statements[0];
  const dynamic = stmt.children.find((c) => c.type === 'Dynamic');
  assert.ok(dynamic, 'expected a Dynamic node');
  assert.equal(dynamic.prepend, 'WHERE');
  const conditions = dynamic.children.filter((c) => c.type === 'Conditional');
  assert.equal(conditions.length, 2);
  assert.equal(conditions[0].conditionType, ConditionType.IS_NOT_NULL);
  assert.equal(conditions[0].property, 'userId');
  assert.equal(conditions[0].prepend, 'AND');
});

test('keeps nested <dynamic> as a tree, not flattened', () => {
  const { sqlMap, diagnostics } = parseFixture('nested-dynamic.xml');
  assert.equal(diagnostics.errors.length, 0);
  const stmt = sqlMap.statements[0];
  const outer = stmt.children.find((c) => c.type === 'Dynamic');
  const statusCond = outer.children.find((c) => c.type === 'Conditional');
  const innerDynamic = statusCond.children.find((c) => c.type === 'Dynamic');
  assert.ok(innerDynamic, 'expected nested Dynamic inside the isNotNull condition');
  const roleCond = innerDynamic.children.find((c) => c.type === 'Conditional');
  assert.equal(roleCond.conditionType, ConditionType.IS_NOT_NULL);
  assert.equal(roleCond.property, 'role');
});

test('standardizes every isXxx tag to the matching ConditionType', () => {
  const { sqlMap, diagnostics } = parseFixture('conditions.xml');
  assert.equal(diagnostics.errors.length, 0);
  const stmt = sqlMap.statements[0];
  const dynamic = stmt.children.find((c) => c.type === 'Dynamic');
  const conditions = dynamic.children.filter((c) => c.type === 'Conditional');
  const types = conditions.map((c) => c.conditionType);
  assert.deepEqual(types, [
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
  const eq = dynamic.children.find((c) => c.conditionType === ConditionType.EQUAL);
  assert.equal(eq.compareValue, '1');
});

test('parses <iterate> including nested iterate', () => {
  const { sqlMap, diagnostics } = parseFixture('iterate.xml');
  assert.equal(diagnostics.errors.length, 0);

  const simple = sqlMap.statements.find((s) => s.id === 'getUsersByIds');
  const iter = simple.children.find((c) => c.type === 'Iterate');
  assert.equal(iter.property, 'ids');
  assert.equal(iter.open, '(');
  assert.equal(iter.close, ')');
  assert.equal(iter.conjunction, ',');

  const nested = sqlMap.statements.find((s) => s.id === 'getUsersByGroups');
  const outerIter = nested.children.find((c) => c.type === 'Iterate');
  const innerIter = outerIter.children.find((c) => c.type === 'Iterate');
  assert.ok(innerIter, 'expected a nested <iterate>');
  assert.equal(innerIter.property, 'groups[].subIds');
});

test('parses <include refid> as an IncludeNode without resolving it', () => {
  const { sqlMap, diagnostics } = parseFixture('include-basic.xml');
  assert.equal(diagnostics.errors.length, 0);
  assert.equal(sqlMap.sqlFragments.length, 1);
  assert.equal(sqlMap.sqlFragments[0].id, 'baseColumns');

  const stmt = sqlMap.statements[0];
  const include = stmt.children.find((c) => c.type === 'Include');
  assert.equal(include.refid, 'baseColumns');
});

test('parses <resultMap extends> and nested <result> entries', () => {
  const { sqlMap, diagnostics } = parseFixture('resultmap-extends.xml');
  assert.equal(diagnostics.errors.length, 0);
  assert.equal(sqlMap.resultMaps.length, 3);

  const detail = sqlMap.resultMaps.find((r) => r.id === 'UserDetailResult');
  assert.equal(detail.extends, 'UserResult');
  assert.equal(detail.class, 'UserDetail');
  assert.equal(detail.results.length, 1);
  assert.equal(detail.results[0].property, 'email');
  assert.equal(detail.results[0].column, 'EMAIL');
});

test('parses <parameterMap> and its <parameter> entries', () => {
  const { sqlMap, diagnostics } = parseFixture('parametermap.xml');
  assert.equal(diagnostics.errors.length, 0);
  assert.equal(sqlMap.parameterMaps.length, 1);
  const pm = sqlMap.parameterMaps[0];
  assert.equal(pm.id, 'userParam');
  assert.equal(pm.parameters.length, 2);
  assert.equal(pm.parameters[0].property, 'id');
  assert.equal(pm.parameters[0].jdbcType, 'NUMERIC');

  const stmt = sqlMap.statements[0];
  assert.equal(stmt.parameterMap, 'userParam');
});

test('parses <selectKey> inside an insert statement', () => {
  const { sqlMap, diagnostics } = parseFixture('write-statements/selectkey.xml');
  assert.equal(diagnostics.errors.length, 0);
  const stmt = sqlMap.statements[0];
  assert.equal(stmt.statementType, StatementType.INSERT);
  const selectKey = stmt.children.find((c) => c.type === 'SelectKey');
  assert.ok(selectKey);
  assert.equal(selectKey.keyProperty, 'id');
  assert.equal(selectKey.timing, 'pre');
  const sqlText = selectKey.children.map((c) => c.text).join('');
  assert.match(sqlText, /SELECT NEXT VALUE FOR USER_SEQ/);
});

test('records a ParserError (not a thrown exception) for a missing required id', () => {
  const { sqlMap, diagnostics } = parseFromSource('<sqlMap namespace="x"><select>SELECT 1</select></sqlMap>');
  assert.equal(sqlMap.statements.length, 0);
  assert.equal(diagnostics.errors.length, 1);
  assert.equal(diagnostics.errors[0].code, 'MISSING_ID_ATTR');
});

function parseFromSource(source) {
  return parseIbatisMapperSource(source, 'inline.xml');
}
