import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalyzerPipeline } from '../../src/application/AnalyzerPipeline.js';
import { flattenToSql } from '../../src/analyzer/sql/SqlFlattener.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures');

function resolvedTreeFor(fixtureName, qualifiedId) {
  const sourceFile = path.join(fixturesDir, fixtureName);
  const source = fs.readFileSync(sourceFile, 'utf8');
  const result = new AnalyzerPipeline().run([{ sourceFile, source }]);
  assert.equal(result.diagnostics.errors.length, 0, `unexpected diagnostics: ${JSON.stringify(result.diagnostics.errors)}`);
  return result.resolvedStatements.get(qualifiedId).resolvedTree;
}

test('a top-level <dynamic prepend="WHERE"> keeps its WHERE even though literal text precedes it', () => {
  const sql = flattenToSql(resolvedTreeFor('dynamic-where.xml', 'user.getUserList'));
  assert.equal(sql, 'SELECT USER_ID, USER_NAME FROM USER WHERE USER_ID = ? AND STATUS = ?');
});

test('the first condition inside a dynamic group drops its own AND/OR (no leading connector after WHERE)', () => {
  // Same fixture as above: the first isNotNull has prepend="AND" but it must not appear right after WHERE.
  const sql = flattenToSql(resolvedTreeFor('dynamic-where.xml', 'user.getUserList'));
  assert.doesNotMatch(sql, /WHERE\s+AND/);
});

test('a <dynamic prepend="SET"> drops the leading comma on the first column and keeps WHERE afterwards', () => {
  const sql = flattenToSql(resolvedTreeFor('write-statements/update-dynamic-set.xml', 'user.updateUser'));
  assert.equal(sql, 'UPDATE USER SET USER_NAME = ? , STATUS = ? WHERE USER_ID = ?');
});

test('nested <dynamic> inside a condition renders correctly and does not double its own prepend', () => {
  const sql = flattenToSql(resolvedTreeFor('nested-dynamic.xml', 'user.searchUsers'));
  assert.equal(sql, 'SELECT USER_ID FROM USER WHERE STATUS = ? AND ROLE = ?');
});

test('#prop# and $prop$ both become a bare "?" placeholder', () => {
  const sql = flattenToSql(resolvedTreeFor('raw-substitution.xml', 'user.search'));
  assert.equal(sql, 'SELECT USER_ID FROM USER ORDER BY ?');
});

test('a resolved <include> is spliced in as literal SQL text', () => {
  const sql = flattenToSql(resolvedTreeFor('include-basic.xml', 'user.getUser'));
  assert.equal(sql, 'SELECT USER_ID, USER_NAME FROM USER WHERE USER_ID = ?');
});

test('<iterate> is flattened as one representative item wrapped in open/close', () => {
  const sql = flattenToSql(resolvedTreeFor('iterate.xml', 'user.getUsersByIds'));
  assert.equal(sql, 'SELECT USER_ID FROM USER WHERE USER_ID IN ( ? )');
});

test('a prepend-less conditional wrapper is transparent: its AND survives when it is not first', async () => {
  const { parseIbatisMapperSource } = await import('../../src/parser/ibatis/IbatisMapperParser.js');
  const { flattenToSql } = await import('../../src/analyzer/sql/SqlFlattener.js');
  const { sqlMap } = parseIbatisMapperSource(`<sqlMap namespace="t"><select id="s">SELECT 1 FROM T
    <dynamic prepend="WHERE">
      <isNotEmpty property="a" prepend="AND">A = 1</isNotEmpty>
      <isPropertyAvailable property="w"><isEqual property="w" compareValue="Y" prepend="AND">W = 1</isEqual></isPropertyAvailable>
    </dynamic></select>
    <select id="first">SELECT 1 FROM T
    <dynamic prepend="WHERE">
      <isPropertyAvailable property="w"><isEqual property="w" compareValue="Y" prepend="AND">W = 1</isEqual></isPropertyAvailable>
    </dynamic></select></sqlMap>`, 't.xml');
  assert.match(flattenToSql(sqlMap.statements[0]).replace(/\s+/g, ' '), /WHERE A = 1 AND W = 1/);
  assert.match(flattenToSql(sqlMap.statements[1]).replace(/\s+/g, ' '), /WHERE W = 1/);
});
