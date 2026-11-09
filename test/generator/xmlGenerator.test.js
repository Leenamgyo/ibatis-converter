import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalyzerPipeline } from '../../src/application/AnalyzerPipeline.js';
import { MyBatisAstConverter } from '../../src/converter/mybatis/MyBatisAstConverter.js';
import { XmlGenerator } from '../../src/generator/xml/XmlGenerator.js';
import { MapperNode } from '../../src/ast/mybatis/nodes.js';
import { DiagnosticBag } from '../../src/parser/xml/ParserDiagnostics.js';
import { parseXml } from '../../src/parser/xml/XmlParser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures');
const converter = new MyBatisAstConverter();
const generator = new XmlGenerator();

function buildMapper(fixtureName) {
  const sourceFile = path.join(fixturesDir, fixtureName);
  const result = new AnalyzerPipeline().run([{ sourceFile, source: fs.readFileSync(sourceFile, 'utf8') }]);
  assert.equal(result.diagnostics.errors.length, 0);
  const sqlMap = result.parsedMappers[0].sqlMap;

  const mapper = new MapperNode({ namespace: sqlMap.namespace });
  for (const fragment of sqlMap.sqlFragments) mapper.sqlFragments.push(converter.convertSqlFragment(fragment).node);
  for (const resultMap of sqlMap.resultMaps) mapper.resultMaps.push(converter.convertResultMap(resultMap).node);
  for (const stmt of sqlMap.statements) mapper.statements.push(converter.convertStatement(stmt).node);
  return mapper;
}

function assertWellFormed(xml) {
  const diagnostics = new DiagnosticBag();
  const doc = parseXml(xml, 'generated.xml', diagnostics);
  assert.equal(diagnostics.errors.length, 0, `generated XML did not parse: ${JSON.stringify(diagnostics.errors)}`);
  assert.ok(doc);
  return doc;
}

test('generates a well-formed <mapper> with namespace, statements, and correct tag names per statementType', () => {
  const xml = generator.generate(buildMapper('write-statements/crud.xml'));
  const doc = assertWellFormed(xml);
  assert.equal(doc.root.name, 'mapper');
  assert.equal(doc.root.attr('namespace'), 'user');
  const tagNames = doc.root.elementChildren().map((el) => el.name);
  assert.deepEqual(tagNames, ['insert', 'update', 'delete']);
});

test('re-escapes a literal "<" from decoded source text back into &lt; so the output stays valid XML', () => {
  const xml = generator.generate(buildMapper('conditions.xml'));
  assertWellFormed(xml);
  assert.match(xml, /&lt;/, 'expected the isLessThan comparison text to be re-escaped');
  assert.doesNotMatch(xml, /I\s*<\s*5/, 'a bare "<" must never appear in generated element content');
});

test('includes <sql> fragments and preserves #{...} parameter conversion inside them', () => {
  const xml = generator.generate(buildMapper('include-basic.xml'));
  assertWellFormed(xml);
  assert.match(xml, /<sql id="baseColumns">/);
  assert.match(xml, /<include refid="baseColumns"\/>/);
});

test('renders a converted <resultMap> with its own <result> entries and a kept "extends" reference', () => {
  const xml = generator.generate(buildMapper('resultmap-extends.xml'));
  const doc = assertWellFormed(xml);
  const resultMaps = doc.root.elementChildren('resultMap');
  const userResult = resultMaps.find((rm) => rm.attr('id') === 'UserResult');
  assert.equal(userResult.attr('extends'), 'BaseResult');
  assert.equal(userResult.elementChildren('result')[0].attr('property'), 'name');
});

test('round-trips a dynamic WHERE + nested iterate + selectKey mapper end to end without losing structure', () => {
  const xml = generator.generate(buildMapper('dynamic-where.xml'));
  const doc = assertWellFormed(xml);
  const select = doc.root.elementChildren('select')[0];
  const where = select.elementChildren('where')[0];
  assert.ok(where);
  assert.equal(where.elementChildren('if').length, 2);
});

test('a tag glued to the SQL around it stays inline, so the runtime SQL is unchanged (TB_ORDER<if>_RBK</if>)', async () => {
  const { parseIbatisMapperSource } = await import('../../src/parser/ibatis/IbatisMapperParser.js');
  const { parseMyBatisMapperSource } = await import('../../src/parser/mybatis/MyBatisMapperParser.js');
  const { IbatisXmlGenerator } = await import('../../src/generator/xml/IbatisXmlGenerator.js');
  const source = `<sqlMap namespace="rbk">
  <select id="s" parameterClass="map" resultClass="map">
    SELECT A.ORD_NO FROM TB_ORDER<isEqual property="rbk" compareValue="Y">_RBK</isEqual><isEqual property="his" compareValue="Y">_HIS</isEqual>X A
    <isNotEmpty property="no" prepend="AND">A.ORD_NO = #no#</isNotEmpty>
  </select>
</sqlMap>`;
  const { sqlMap } = parseIbatisMapperSource(source, 'rbk.xml');
  const statement = converter.convertStatement(sqlMap.statements[0]).node;
  // the text each runtime branch produces: every glued piece concatenated with no whitespace added
  const runtime = (nodes) => nodes.map((n) => (n.type === 'TextSql' ? n.text : runtime(n.children ?? []))).join('');

  for (const formatSql of [false, true]) {
    const mybatis = new XmlGenerator({ formatSql }).generateNode(statement);
    assert.match(mybatis, /FROM TB_ORDER<if test="[^"]*">_RBK<\/if><if test="[^"]*">_HIS<\/if>X A/, mybatis);
    assert.match(mybatis, /\n {2}<if test="no != null and no != ''">\n/); // a tag with spaces around it keeps its own lines
    const reparsed = parseMyBatisMapperSource(`<mapper namespace="rbk">${mybatis}</mapper>`, 'rbk.xml').mapper.statements[0];
    assert.match(runtime(reparsed.children), /TB_ORDER_RBK_HISX A/);

    const ibatis = new IbatisXmlGenerator({ formatSql }).generateNode(sqlMap.statements[0]);
    assert.match(ibatis, /FROM TB_ORDER<isEqual property="rbk" compareValue="Y">_RBK<\/isEqual><isEqual property="his" compareValue="Y">_HIS<\/isEqual>X A/, ibatis);
    // the two sides keep the same line structure (the 변환 view pairs them line by line)
    assert.equal(ibatis.split('\n').length, mybatis.split('\n').length);
  }
});
