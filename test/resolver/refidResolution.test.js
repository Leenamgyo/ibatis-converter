import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalyzerPipeline } from '../../src/application/AnalyzerPipeline.js';
import { flattenToSql } from '../../src/analyzer/sql/SqlFlattener.js';

// How a refid / resultMap reference is resolved and how it is written for MyBatis.
const run = (files) => new AnalyzerPipeline().run(files.map(([sourceFile, source]) => ({ sourceFile, source })));
const sql = (result, id) => flattenToSql(result.resolvedStatements.get(id).resolvedTree).replace(/\s+/g, ' ');

test('a bare refid into another mapper (useStatementNamespaces=false) resolves, and MyBatis gets it qualified', () => {
  const result = run([
    ['common.xml', '<sqlMap namespace="common"><sql id="activeOnly">AND USE_YN = \'Y\'</sql><resultMap id="base" class="map"><result property="id" column="ID"/></resultMap></sqlMap>'],
    ['order.xml', '<sqlMap namespace="order"><resultMap id="row" class="map" extends="base"><result property="n" column="N"/></resultMap><select id="list" resultMap="base">SELECT ID FROM T WHERE 1 = 1 <include refid="activeOnly"/></select></sqlMap>'],
  ]);
  assert.deepEqual(result.diagnostics.errors, []);
  assert.match(sql(result, 'order.list'), /AND USE_YN = 'Y'/);
  const xml = result.generatedMapperXml.get('order.xml');
  assert.match(xml, /<include refid="common\.activeOnly"\/>/);
  assert.match(xml, /resultMap="common\.base"/);
  assert.match(xml, /extends="common\.base"/);
});

test('the same bare id in two mappers is ambiguous: reported, not guessed', () => {
  const result = run([
    ['a.xml', '<sqlMap namespace="a"><sql id="cond">AND A = 1</sql></sqlMap>'],
    ['b.xml', '<sqlMap namespace="b"><sql id="cond">AND B = 1</sql></sqlMap>'],
    ['c.xml', '<sqlMap namespace="c"><select id="s">SELECT 1 FROM T WHERE 1 = 1 <include refid="cond"/></select></sqlMap>'],
  ]);
  assert.equal(result.diagnostics.errors.length, 1);
  assert.match(result.diagnostics.errors[0].message, /"cond" is ambiguous: a\.cond, b\.cond/);
});

test('a bare refid nested in another mapper\'s fragment resolves against the INCLUDING statement\'s namespace', () => {
  // iBATIS and MyBatis both apply the statement's namespace to every include, nested ones too
  const result = run([
    ['lib.xml', '<sqlMap namespace="lib"><sql id="outer">AND OUTER = 1 <include refid="inner"/></sql><sql id="inner">AND LIB_INNER = 1</sql></sqlMap>'],
    ['shadow.xml', '<sqlMap namespace="shadow"><sql id="inner">AND SHADOW_INNER = 1</sql><select id="s">SELECT 1 FROM T WHERE 1 = 1 <include refid="lib.outer"/></select></sqlMap>'],
    ['plain.xml', '<sqlMap namespace="plain"><select id="s">SELECT 1 FROM T WHERE 1 = 1 <include refid="lib.outer"/></select></sqlMap>'],
  ]);
  // shadow.s: the runtime takes shadow.inner — analysed the same way, with a warning
  assert.match(sql(result, 'shadow.s'), /SHADOW_INNER/);
  assert.ok(result.diagnostics.warnings.some((w) => w.code === 'NESTED_REFID_SHADOWED'));
  // plain.s: the runtime finds no plain.inner (an error in iBATIS); analysed as the author meant
  assert.match(sql(result, 'plain.s'), /LIB_INNER/);
  assert.ok(result.diagnostics.warnings.some((w) => w.code === 'NESTED_REFID_NAMESPACE'));
  // one MyBatis fragment can't serve both includers: kept as written, graded MANUAL
  const events = result.fragmentConversions.get('lib.outer').events;
  assert.ok(events.some((e) => e.code === 'REFID_DEPENDS_ON_INCLUDER' && e.grade === 'MANUAL'));
  assert.match(result.generatedMapperXml.get('lib.xml'), /<include refid="inner"\/>/);
});

test('a fragment included from other mappers, with no shadowing, gets its bare refids qualified', () => {
  const result = run([
    ['lib.xml', '<sqlMap namespace="lib"><sql id="outer">AND OUTER = 1 <include refid="inner"/></sql><sql id="inner">AND LIB_INNER = 1</sql></sqlMap>'],
    ['app.xml', '<sqlMap namespace="app"><select id="s">SELECT 1 FROM T WHERE 1 = 1 <include refid="lib.outer"/></select></sqlMap>'],
  ]);
  assert.match(result.generatedMapperXml.get('lib.xml'), /<include refid="lib\.inner"\/>/);
  assert.ok(result.fragmentConversions.get('lib.outer').events.some((e) => e.code === 'REFERENCE_QUALIFIED'));
});

test('local refids used only locally stay as written', () => {
  const result = run([['a.xml', '<sqlMap namespace="a"><sql id="f">AND X = 1</sql><select id="s">SELECT 1 FROM T WHERE 1 = 1 <include refid="f"/></select></sqlMap>']]);
  assert.match(result.generatedMapperXml.get('a.xml'), /<include refid="f"\/>/);
  assert.deepEqual(result.diagnostics.warnings, []);
});
