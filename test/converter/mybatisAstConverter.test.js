import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalyzerPipeline } from '../../src/application/AnalyzerPipeline.js';
import { MyBatisAstConverter } from '../../src/converter/mybatis/MyBatisAstConverter.js';
import { MigrationGrade } from '../../src/converter/mybatis/ConversionEvent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures');
const converter = new MyBatisAstConverter();

function originalTreeFor(fixtureName, qualifiedId) {
  const sourceFile = path.join(fixturesDir, fixtureName);
  const source = fs.readFileSync(sourceFile, 'utf8');
  const result = new AnalyzerPipeline().run([{ sourceFile, source }]);
  assert.equal(result.diagnostics.errors.length, 0, `unexpected diagnostics: ${JSON.stringify(result.diagnostics.errors)}`);
  return result.resolvedStatements.get(qualifiedId).originalTree;
}

function findChild(node, type) {
  return node.children.find((c) => c.type === type);
}

test('converts #x# to #{x} and a clean <dynamic prepend="WHERE"> to <where> with <if> conditions', () => {
  const { node, events } = converter.convertStatement(originalTreeFor('dynamic-where.xml', 'user.getUserList'));

  const where = findChild(node, 'Where');
  assert.ok(where, 'expected a Where node');
  const ifs = where.children.filter((c) => c.type === 'If');
  assert.equal(ifs.length, 2);
  assert.equal(ifs[0].test, 'userId != null');
  // The iBATIS `prepend="AND"` is written INTO the body: MyBatis's
  // <where> strips a leading AND, it never inserts one, so without this
  // two matching conditions would render as `WHERE A = ? B = ?`.
  assert.match(ifs[0].children[0].text, /^\s*AND\s+USER_ID = #\{userId\}/);
  assert.equal(ifs[1].test, 'status != null');
  assert.match(ifs[1].children[0].text, /^\s*AND\s/);

  assert.ok(events.every((e) => e.grade === MigrationGrade.SAFE));
  assert.ok(events.some((e) => e.code === 'DYNAMIC_TO_WHERE'));
  assert.ok(events.some((e) => e.code === 'CONDITIONAL_TO_IF'));
});

test('converts a clean <dynamic prepend="SET"> to <set>', () => {
  const { node, events } = converter.convertStatement(originalTreeFor('write-statements/update-dynamic-set.xml', 'user.updateUser'));
  const set = findChild(node, 'Set');
  assert.ok(set);
  assert.equal(set.children.filter((c) => c.type === 'If').length, 2);
  assert.ok(events.some((e) => e.code === 'DYNAMIC_TO_SET' && e.grade === MigrationGrade.SAFE));
});

test('falls back to an explicit <trim> with a WARNING when a WHERE group has an unexpected connector', () => {
  const { node, events } = converter.convertStatement(originalTreeFor('dynamic-unusual-connector.xml', 'misc.weirdWhere'));
  const trim = findChild(node, 'Trim');
  assert.ok(trim, 'expected a Trim node instead of Where');
  assert.equal(trim.prefix, 'WHERE');
  assert.match(trim.prefixOverrides, /AND /);
  assert.match(trim.prefixOverrides, /XOR /);

  const warning = events.find((e) => e.code === 'DYNAMIC_TRIM_INFERENCE');
  assert.ok(warning);
  assert.equal(warning.grade, MigrationGrade.WARNING);
});

test('converts a top-level <iterate> to <foreach> with #{item}', () => {
  const { node, events } = converter.convertStatement(originalTreeFor('iterate.xml', 'user.getUsersByIds'));
  const foreach = findChild(node, 'Foreach');
  assert.equal(foreach.collection, 'ids');
  assert.equal(foreach.item, 'item');
  assert.equal(foreach.open, '(');
  assert.equal(foreach.close, ')');
  assert.equal(foreach.separator, ',');
  assert.match(foreach.children[0].text, /#\{item\}/);
  assert.ok(events.every((e) => e.grade === MigrationGrade.SAFE));
});

test('assigns distinct item names to nested <iterate> and rewrites the inner collection relative to the outer item', () => {
  const { node } = converter.convertStatement(originalTreeFor('iterate.xml', 'user.getUsersByGroups'));
  const outer = findChild(node, 'Foreach');
  assert.equal(outer.item, 'item');
  assert.equal(outer.collection, 'groups');

  const inner = outer.children.find((c) => c.type === 'Foreach');
  assert.equal(inner.item, 'item2');
  assert.equal(inner.collection, 'item.subIds');
  assert.match(inner.children[0].text, /#\{item2\}/);
});

test('always converts $x$ to ${x} but raises a WARNING RAW_SQL_SUBSTITUTION event', () => {
  const { node, events } = converter.convertStatement(originalTreeFor('raw-substitution.xml', 'user.search'));
  const text = node.children.map((c) => c.text).join('');
  assert.match(text, /ORDER BY \$\{orderBy\}/);
  const warning = events.find((e) => e.code === 'RAW_SQL_SUBSTITUTION');
  assert.ok(warning);
  assert.equal(warning.grade, MigrationGrade.WARNING);
});

test('keeps <include refid> as a MyBatis <include> rather than inlining it', () => {
  const { node, events } = converter.convertStatement(originalTreeFor('include-basic.xml', 'user.getUser'));
  const include = findChild(node, 'Include');
  assert.equal(include.refid, 'baseColumns');
  assert.ok(events.some((e) => e.code === 'INCLUDE_KEPT' && e.grade === MigrationGrade.SAFE));
});

test('converts <selectKey type="pre"> to <selectKey order="BEFORE">', () => {
  const { node } = converter.convertStatement(originalTreeFor('write-statements/selectkey.xml', 'user.insertUser'));
  const selectKey = findChild(node, 'SelectKey');
  assert.equal(selectKey.order, 'BEFORE');
  assert.equal(selectKey.keyProperty, 'id');
});

test('flags a parameterMap-based statement as MANUAL', () => {
  const { events } = converter.convertStatement(originalTreeFor('parametermap.xml', 'user.getUserByParamMap'));
  const manual = events.find((e) => e.code === 'PARAMETER_MAP_STATEMENT');
  assert.ok(manual);
  assert.equal(manual.grade, MigrationGrade.MANUAL);
});

test('converts a resultMap, keeping extends as a direct MyBatis reference and flagging nullValue as MANUAL', () => {
  const sourceFile = path.join(fixturesDir, 'resultmap-extends.xml');
  const result = new AnalyzerPipeline().run([{ sourceFile, source: fs.readFileSync(sourceFile, 'utf8') }]);
  const [, userResult] = result.parsedMappers[0].sqlMap.resultMaps;
  const { node, events } = converter.convertResultMap(userResult);
  assert.equal(node.id, 'UserResult');
  assert.equal(node.extendsId, 'BaseResult');
  assert.equal(node.results[0].property, 'name');
  assert.ok(events.some((e) => e.code === 'RESULT_MAP_CONVERTED' && e.grade === MigrationGrade.SAFE));
});

// ---- OGNL traps found by the differential runtime test (test/fuzz/) ----
import { parseIbatisMapperSource } from '../../src/parser/ibatis/IbatisMapperParser.js';

function convertTests(body) {
  const { sqlMap } = parseIbatisMapperSource(`<sqlMap namespace="t"><select id="s">SELECT 1 ${body}</select></sqlMap>`, 't.xml');
  const tests = [];
  const walk = (n) => { if (n.type === 'If') tests.push(n.test); (n.children ?? []).forEach(walk); };
  converter.convertStatement(sqlMap.statements[0]).node.children.forEach(walk);
  return tests;
}

test("a one-character compareValue is a String in OGNL ('Y'.toString()), not a Character", () => {
  assert.deepEqual(convertTests('<isEqual property="f" compareValue="Y">X</isEqual><isEqual property="f" compareValue="AB">X</isEqual>'),
    ["f == 'Y'.toString()", "f == 'AB'"]);
});

test('ordering tests are guarded against null (OGNL treats null as 0; iBATIS as not comparable)', () => {
  assert.deepEqual(convertTests('<isLessThan property="n" compareValue="5">X</isLessThan><isGreaterEqual property="a" compareProperty="b">X</isGreaterEqual><isGreaterThan property="a" compareProperty="b">X</isGreaterThan>'), [
    'n != null and n < 5',
    '(a == null and b == null) or (a != null and b != null and a >= b)',
    'a != null and b != null and a > b',
  ]);
});

test('an emptiness test on an iterated property checks size(), not == \'\'', () => {
  assert.deepEqual(convertTests('<isNotEmpty property="ids">ID IN <iterate property="ids" open="(" close=")" conjunction=",">#ids[]#</iterate></isNotEmpty><isNotEmpty property="name">X</isNotEmpty>'),
    ['ids != null and ids.size() > 0', "name != null and name != ''"]);
});

test('a prepend-less conditional is transparent; a prepend-bearing one drops its first child\'s prepend at runtime', () => {
  const { sqlMap } = parseIbatisMapperSource(`<sqlMap namespace="t"><select id="s">SELECT 1 FROM T
    <dynamic prepend="WHERE">
      <isNotEmpty property="a" prepend="AND">A = #a#</isNotEmpty>
      <isPropertyAvailable property="w"><isEqual property="w" compareValue="Y" prepend="AND">W = 1</isEqual></isPropertyAvailable>
      <isNotEmpty property="g" prepend="OR"><isNotNull property="x" prepend="AND">X = #x#</isNotNull> AND G = #g#</isNotEmpty>
    </dynamic></select></sqlMap>`, 't.xml');
  const { node } = converter.convertStatement(sqlMap.statements[0]);
  const where = node.children.find((c) => c.type === 'Where');
  const [, wrapper, grouped] = where.children.filter((c) => c.type === 'If');
  // the wrapper adds no <trim>: its child keeps "AND", which <where> strips only when it comes first
  assert.equal(wrapper.children.some((c) => c.type === 'Trim'), false);
  assert.match(wrapper.children[0].children[0].text, /^\s*AND W = 1/);
  // the prepend-bearing tag: "OR" + a <trim> that strips the nested AND when the nested tag renders first
  assert.match(grouped.children[0].text, /OR/);
  const trim = grouped.children.find((c) => c.type === 'Trim');
  assert.equal(trim.prefixOverrides, 'AND ');
});
