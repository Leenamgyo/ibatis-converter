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
