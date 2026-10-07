import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalyzerPipeline } from '../../src/application/AnalyzerPipeline.js';
import { ParameterAnalyzer } from '../../src/analyzer/parameter/ParameterAnalyzer.js';
import { ParameterBindingType, ParameterUsedIn } from '../../src/analyzer/parameter/ParameterUsage.js';
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

const analyzer = new ParameterAnalyzer();

test('extracts a plain #prop# usage and classifies it by the literal WHERE keyword', () => {
  const tree = resolvedTreeFor('simple-select.xml', 'user.getUser');
  const { parameters, warnings } = analyzer.analyze(tree);

  assert.equal(warnings.length, 0);
  assert.equal(parameters.length, 1);
  const [p] = parameters;
  assert.equal(p.name, 'userId');
  assert.equal(p.expression, 'userId');
  assert.equal(p.bindingType, ParameterBindingType.HASH);
  assert.equal(p.usedIn, ParameterUsedIn.WHERE);
  assert.equal(p.dynamicCondition, null);
});

test('classifies parameters under <dynamic prepend="WHERE"> as WHERE even without a literal WHERE keyword, and links dynamicCondition', () => {
  const tree = resolvedTreeFor('dynamic-where.xml', 'user.getUserList');
  const { parameters, warnings } = analyzer.analyze(tree);

  assert.equal(warnings.length, 0);
  assert.equal(parameters.length, 2);

  const [userIdParam, statusParam] = parameters;
  assert.equal(userIdParam.name, 'userId');
  assert.equal(userIdParam.usedIn, ParameterUsedIn.WHERE);
  assert.equal(userIdParam.dynamicCondition.property, 'userId');
  assert.equal(userIdParam.dynamicCondition.operator, ConditionType.IS_NOT_NULL);

  assert.equal(statusParam.name, 'status');
  assert.equal(statusParam.usedIn, ParameterUsedIn.WHERE);
  assert.equal(statusParam.dynamicCondition.property, 'status');
});

test('extracts #ids[]# from <iterate> as parameter "ids" and keeps the WHERE clause set before the iterate', () => {
  const tree = resolvedTreeFor('iterate.xml', 'user.getUsersByIds');
  const { parameters } = analyzer.analyze(tree);

  assert.equal(parameters.length, 1);
  assert.equal(parameters[0].name, 'ids');
  assert.equal(parameters[0].expression, 'ids[]');
  assert.equal(parameters[0].usedIn, ParameterUsedIn.WHERE);
});

test('classifies a dynamic SET block as UPDATE_SET and correctly reverts to WHERE afterwards', () => {
  const tree = resolvedTreeFor('write-statements/update-dynamic-set.xml', 'user.updateUser');
  const { parameters } = analyzer.analyze(tree);

  const byName = Object.fromEntries(parameters.map((p) => [p.name, p]));
  assert.equal(byName.name.usedIn, ParameterUsedIn.UPDATE_SET);
  assert.equal(byName.status.usedIn, ParameterUsedIn.UPDATE_SET);
  assert.equal(byName.id.usedIn, ParameterUsedIn.WHERE);
});

test('flags every $...$ usage with a RAW_SQL_SUBSTITUTION / SQL_INJECTION warning', () => {
  const tree = resolvedTreeFor('raw-substitution.xml', 'user.search');
  const { parameters, warnings } = analyzer.analyze(tree);

  assert.equal(parameters.length, 1);
  assert.equal(parameters[0].bindingType, ParameterBindingType.DOLLAR);
  assert.equal(parameters[0].name, 'orderBy');
  assert.equal(parameters[0].usedIn, ParameterUsedIn.ORDER_BY);

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'RAW_SQL_SUBSTITUTION');
  assert.equal(warnings[0].risk, 'SQL_INJECTION');
  assert.equal(warnings[0].parameter, 'orderBy');
});
