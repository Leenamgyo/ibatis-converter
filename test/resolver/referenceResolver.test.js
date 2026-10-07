import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIbatisMapperSource } from '../../src/parser/ibatis/IbatisMapperParser.js';
import { buildSymbolTable } from '../../src/resolver/symbol/ProjectScanner.js';
import { ReferenceResolver } from '../../src/resolver/reference/ReferenceResolver.js';
import { DiagnosticBag } from '../../src/parser/xml/ParserDiagnostics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures');

function loadFixtureMapper(relativePath) {
  const file = path.join(fixturesDir, relativePath);
  const { sqlMap } = parseIbatisMapperSource(fs.readFileSync(file, 'utf8'), file);
  return { sourceFile: file, sqlMap };
}

function findStatement(sqlMap, id) {
  return sqlMap.statements.find((s) => s.id === id);
}

function walk(node, visit) {
  visit(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) walk(child, visit);
  }
}

function collectByType(root, type) {
  const found = [];
  walk(root, (n) => {
    if (n.type === type) found.push(n);
  });
  return found;
}

test('resolves a same-mapper <include refid> into a ResolvedIncludeNode', () => {
  const m = loadFixtureMapper('include-basic.xml');
  const { symbolTable, diagnostics } = buildSymbolTable([m]);
  const resolver = new ReferenceResolver(symbolTable, diagnostics);

  const stmt = findStatement(m.sqlMap, 'getUser');
  const { originalTree, resolvedTree } = resolver.resolve(stmt, 'user', 'user.getUser');

  assert.equal(diagnostics.errors.length, 0);
  assert.notEqual(originalTree, resolvedTree, 'resolver must not mutate/return the original tree object');
  assert.equal(originalTree.children.find((c) => c.type === 'Include').refid, 'baseColumns', 'original tree stays untouched');

  const resolvedIncludes = collectByType(resolvedTree, 'ResolvedInclude');
  assert.equal(resolvedIncludes.length, 1);
  assert.equal(resolvedIncludes[0].qualifiedId, 'user.baseColumns');
  const text = resolvedIncludes[0].children.map((c) => c.text).join('');
  assert.match(text, /USER_ID, USER_NAME/);

  const deps = resolver.dependencyGraph.getDependencies('user.getUser');
  assert.deepEqual(deps, [{ to: 'user.baseColumns', kind: 'INCLUDE' }]);
});

test('recursively resolves multi-level nested includes (include-in-include-in-include)', () => {
  const m = loadFixtureMapper('include-nested.xml');
  const { symbolTable, diagnostics } = buildSymbolTable([m]);
  const resolver = new ReferenceResolver(symbolTable, diagnostics);

  const stmt = findStatement(m.sqlMap, 'getUser');
  const { resolvedTree } = resolver.resolve(stmt, 'common', 'common.getUser');

  assert.equal(diagnostics.errors.length, 0);
  const qualifiedIds = collectByType(resolvedTree, 'ResolvedInclude').map((n) => n.qualifiedId).sort();
  assert.deepEqual(qualifiedIds, ['common.activeCondition', 'common.baseWhere', 'common.memberCondition']);
});

test('resolves a namespace-qualified refid pointing into a different mapper file', () => {
  const orderMapper = loadFixtureMapper('cross-mapper/order.xml');
  const commonMapper = loadFixtureMapper('cross-mapper/common.xml');
  const { symbolTable, diagnostics } = buildSymbolTable([orderMapper, commonMapper]);
  const resolver = new ReferenceResolver(symbolTable, diagnostics);

  const stmt = findStatement(orderMapper.sqlMap, 'getOrders');
  const { resolvedTree } = resolver.resolve(stmt, 'order', 'order.getOrders');

  assert.equal(diagnostics.errors.length, 0);
  const includes = collectByType(resolvedTree, 'ResolvedInclude');
  assert.equal(includes.length, 1);
  assert.equal(includes[0].qualifiedId, 'common.pagination');
});

test('reports a missing refid as a diagnostic and marks the node UnresolvedInclude(MISSING) instead of throwing', () => {
  const m = loadFixtureMapper('missing-refid.xml');
  const { symbolTable, diagnostics } = buildSymbolTable([m]);
  const resolver = new ReferenceResolver(symbolTable, diagnostics);

  const stmt = findStatement(m.sqlMap, 'getUser');
  const { resolvedTree } = resolver.resolve(stmt, 'user', 'user.getUser');

  assert.equal(diagnostics.errors.length, 1);
  assert.equal(diagnostics.errors[0].code, 'MISSING_REFERENCE');

  const unresolved = collectByType(resolvedTree, 'UnresolvedInclude');
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].reason, 'MISSING');
  assert.equal(unresolved[0].refid, 'doesNotExist');
});

test('detects a circular <include> chain (A -> B -> C -> A) without a stack overflow', () => {
  const m = loadFixtureMapper('circular-refid.xml');
  const { symbolTable, diagnostics } = buildSymbolTable([m]);
  const resolver = new ReferenceResolver(symbolTable, diagnostics);

  const stmt = findStatement(m.sqlMap, 'getRow');
  const { resolvedTree } = resolver.resolve(stmt, 'circular', 'circular.getRow');

  assert.equal(diagnostics.errors.filter((e) => e.code === 'CIRCULAR_REFERENCE').length, 1);
  assert.equal(resolver.circularReferences.length, 1);
  assert.deepEqual(resolver.circularReferences[0].path, [
    'circular.getRow',
    'circular.a',
    'circular.b',
    'circular.c',
    'circular.a',
  ]);

  const unresolved = collectByType(resolvedTree, 'UnresolvedInclude');
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].reason, 'CIRCULAR');
});

test('resolves a <resultMap extends> chain into resolvedParent pointers', () => {
  const m = loadFixtureMapper('resultmap-extends.xml');
  const { symbolTable, diagnostics } = buildSymbolTable([m]);
  const resolver = new ReferenceResolver(symbolTable, diagnostics);

  const detail = m.sqlMap.resultMaps.find((r) => r.id === 'UserDetailResult');
  const chain = resolver.resolveResultMapExtends(detail, 'user');

  assert.equal(diagnostics.errors.length, 0);
  assert.deepEqual(chain.map((r) => r.id), ['UserDetailResult', 'UserResult', 'BaseResult']);
  assert.equal(detail.resolvedParent.id, 'UserResult');
  assert.equal(detail.resolvedParent.resolvedParent.id, 'BaseResult');
  assert.equal(detail.resolvedParent.resolvedParent.resolvedParent, null);

  const edgeKinds = resolver.dependencyGraph.getDependencies('user.UserDetailResult');
  assert.deepEqual(edgeKinds, [{ to: 'user.UserResult', kind: 'EXTENDS' }]);
});

test('reports an unresolved resultMap extends as a diagnostic instead of throwing', () => {
  const m = loadFixtureMapper('resultmap-extends.xml');
  // Mutate a clone's extends to point at something that doesn't exist.
  const bogus = { ...m.sqlMap.resultMaps[1], extends: 'NoSuchResultMap' };
  const { symbolTable } = buildSymbolTable([m]);
  const diagnostics = new DiagnosticBag();
  const resolver = new ReferenceResolver(symbolTable, diagnostics);

  resolver.resolveResultMapExtends(bogus, 'user');
  assert.equal(diagnostics.errors.length, 1);
  assert.equal(diagnostics.errors[0].code, 'MISSING_REFERENCE');
});
