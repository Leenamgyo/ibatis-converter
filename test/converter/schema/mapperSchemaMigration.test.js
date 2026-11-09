import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalyzerPipeline } from '../../../src/application/AnalyzerPipeline.js';
import {
  MapperNode, StatementNode, SqlFragmentNode, TextSqlNode, IfNode, WhereNode, ForeachNode, IncludeNode,
} from '../../../src/ast/mybatis/nodes.js';
import { SqlSchemaMigrationConverter, SchemaMigrationCode, SchemaMigrationGrade } from '../../../src/converter/schema/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(__dirname, '..', '..', 'fixtures', 'schema-migration');
const MAPPING = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'mapping.json'), 'utf8'));

function withChildren(node, children) {
  node.children = children;
  return node;
}

/** SELECT ... FROM OLD_CONTENT <where><if test="APP_ID != null">AND APP_ID = #{APP_ID}</if><foreach open="AND CONTENT_ID IN (" ...></where> */
function contentMapper() {
  const mapper = new MapperNode({ namespace: 'content' });
  mapper.sqlFragments = [
    withChildren(new SqlFragmentNode({ id: 'appFilter' }), [new TextSqlNode({ text: '\n    AND APP_ID = #{appId}\n  ' })]),
  ];
  mapper.statements = [
    withChildren(new StatementNode({ id: 'find', statementType: 'SELECT' }), [
      new TextSqlNode({ text: '\n    SELECT APP_ID AS appId\n    FROM OLD_CONTENT\n  ' }),
      withChildren(new WhereNode(), [
        withChildren(new IfNode({ test: 'APP_ID != null and USE_YN == \'Y\'' }), [
          new TextSqlNode({ text: 'AND APP_ID = #{APP_ID}' }),
        ]),
        withChildren(new ForeachNode({ collection: 'CONTENT_ID', item: 'id', open: 'AND CONTENT_ID IN (', close: ')', separator: ',' }), [
          new TextSqlNode({ text: '#{id}' }),
        ]),
      ]),
    ]),
    withChildren(new StatementNode({ id: 'count', statementType: 'SELECT' }), [
      new TextSqlNode({ text: 'SELECT COUNT(*) FROM OLD_CONTENT WHERE 1 = 1 ' }),
      new IncludeNode({ refid: 'appFilter' }),
    ]),
  ];
  return mapper;
}

test('dynamic <if>/<where>/<foreach>: bodies resolve against the statement\'s FROM; test= and collection= are untouched', () => {
  const input = contentMapper();
  const { mapper } = new SqlSchemaMigrationConverter(MAPPING).convertMapper(input);
  const [find] = mapper.statements;

  assert.equal(find.children[0].text, '\n    SELECT APPLICATION_ID AS appId\n    FROM CONTENT\n  ');
  const [ifNode, foreach] = find.children[1].children;
  assert.equal(ifNode.test, 'APP_ID != null and USE_YN == \'Y\'');
  assert.equal(ifNode.children[0].text, 'AND APPLICATION_ID = #{APP_ID}');
  assert.equal(foreach.collection, 'CONTENT_ID');
  assert.equal(foreach.open, 'AND ID IN (');
  assert.equal(foreach.children[0].text, '#{id}');
});

test('the input mapper AST is never mutated', () => {
  const input = contentMapper();
  const before = JSON.stringify(input);
  const { mapper } = new SqlSchemaMigrationConverter(MAPPING).convertMapper(input);
  assert.equal(JSON.stringify(input), before);
  assert.notEqual(mapper.statements[0], input.statements[0]);
  assert.equal(mapper.statements[0].constructor, StatementNode);
});

test('a FROM-less <sql> fragment takes its table from the statements that include it', () => {
  const { mapper, events } = new SqlSchemaMigrationConverter(MAPPING).convertMapper(contentMapper());
  assert.equal(mapper.sqlFragments[0].children[0].text, '\n    AND APPLICATION_ID = #{appId}\n  ');
  // the including statement keeps its <include>, and its own events don't repeat the fragment's
  assert.equal(mapper.statements[1].children[1].type, 'Include');
  const inferred = events.find((e) => e.code === SchemaMigrationCode.FRAGMENT_CONTEXT_INFERRED);
  assert.equal(inferred.statementId, 'appFilter');
  assert.equal(events.filter((e) => e.statementId === 'count' && e.code === SchemaMigrationCode.COLUMN_RENAMED).length, 0);
});

test('fragmentContexts names a fragment\'s table explicitly (spec: contextTable)', () => {
  const mapper = new MapperNode({ namespace: 'country' });
  mapper.sqlFragments = [
    withChildren(new SqlFragmentNode({ id: 'byCode' }), [new TextSqlNode({ text: 'AND c.COUNTRY_CD = #{code} AND USE_YN = \'Y\'' })]),
  ];
  const { mapper: migrated } = new SqlSchemaMigrationConverter(MAPPING)
    .convertMapper(mapper, { fragmentContexts: { 'country.byCode': 'OLD_COUNTRY c' } });
  assert.equal(migrated.sqlFragments[0].children[0].text, 'AND c.COUNTRY_CODE = #{code} AND IS_ENABLED = \'Y\'');
});

test('a FROM that lives in an included fragment still counts for the including statement', () => {
  const mapper = new MapperNode({ namespace: 'country' });
  mapper.sqlFragments = [
    withChildren(new SqlFragmentNode({ id: 'fromCountry' }), [new TextSqlNode({ text: 'FROM OLD_COUNTRY c' })]),
  ];
  mapper.statements = [
    withChildren(new StatementNode({ id: 'list', statementType: 'SELECT' }), [
      new TextSqlNode({ text: 'SELECT c.COUNTRY_CD ' }),
      new IncludeNode({ refid: 'fromCountry' }),
      new TextSqlNode({ text: ' WHERE c.USE_YN = \'Y\'' }),
    ]),
  ];
  const { mapper: migrated } = new SqlSchemaMigrationConverter(MAPPING).convertMapper(mapper);
  assert.equal(migrated.statements[0].children[0].text, 'SELECT c.COUNTRY_CODE ');
  assert.equal(migrated.statements[0].children[2].text, ' WHERE c.IS_ENABLED = \'Y\'');
  assert.equal(migrated.sqlFragments[0].children[0].text, 'FROM COUNTRY c');
});

test('alternative <if> branches in a FROM position each name a table', () => {
  const mapper = new MapperNode({ namespace: 'country' });
  mapper.statements = [
    withChildren(new StatementNode({ id: 'pick', statementType: 'SELECT' }), [
      new TextSqlNode({ text: 'SELECT c.COUNTRY_NM FROM ' }),
      withChildren(new IfNode({ test: 'detail' }), [new TextSqlNode({ text: 'OLD_CODE_DETAIL c' })]),
      new TextSqlNode({ text: '\n' }),
      withChildren(new IfNode({ test: '!detail' }), [new TextSqlNode({ text: 'OLD_COUNTRY c' })]),
      withChildren(new IfNode({ test: 'code != null' }), [new TextSqlNode({ text: ' WHERE c.COUNTRY_CD = #{code}' })]),
    ]),
  ];
  const { mapper: migrated, events } = new SqlSchemaMigrationConverter(MAPPING).convertMapper(mapper);
  const [, first, , second, where] = migrated.statements[0].children;
  assert.equal(first.children[0].text, 'CODE_DETAIL c');
  assert.equal(second.children[0].text, 'COUNTRY c');
  // `c` is declared once per branch, and only one of them remaps COUNTRY_CD: no single answer
  assert.equal(where.children[0].text, ' WHERE c.COUNTRY_CD = #{code}');
  const ambiguous = events.find((e) => e.code === SchemaMigrationCode.COLUMN_AMBIGUOUS);
  assert.equal(ambiguous.grade, SchemaMigrationGrade.MANUAL);
  assert.match(ambiguous.message, /OLD_CODE_DETAIL c and OLD_COUNTRY c/);
});

test('pipeline: iBATIS mapper -> MyBatis -> new schema, as a separate output', () => {
  const sourceFile = path.join(fixtureDir, 'content.xml');
  const source = fs.readFileSync(sourceFile, 'utf8');
  const result = new AnalyzerPipeline({ schemaMigrationConverter: new SqlSchemaMigrationConverter(MAPPING) })
    .run([{ sourceFile, source }]);
  assert.equal(result.diagnostics.errors.length, 0);

  // the plain syntax conversion is untouched
  assert.match(result.generatedMapperXml.get(sourceFile), /FROM OLD_CONTENT c/);

  const xml = result.schemaMigration.mapperXml.get(sourceFile);
  assert.match(xml, /SELECT c\.APPLICATION_ID AS appId, c\.TITLE AS title\s+FROM CONTENT c/);
  assert.match(xml, /<if test="appId != null">\s+AND c\.APPLICATION_ID = #\{appId\}/);
  assert.match(xml, /AND ID IN/);
  assert.match(xml, /ORDER BY \$\{order\}/);
  assert.match(xml, /UPDATE CONTENT\s+<set>/);
  assert.match(xml, /APPLICATION_ID = #\{appId\},/);
  assert.match(xml, /WHERE ID = #\{contentId\}/);
  assert.match(xml, /<sql id="appFilter">\s+AND APPLICATION_ID = #\{appId\}/);
  assert.doesNotMatch(xml, /OLD_CONTENT|OLD_COUNTRY/);

  const events = result.schemaMigration.events.get(sourceFile);
  // activeFilter is included from an OLD_CONTENT (USE_YN -> ENABLED) and an
  // OLD_COUNTRY (USE_YN -> IS_ENABLED) statement: no single answer, so left as is
  const conflict = events.find((e) => e.code === SchemaMigrationCode.FRAGMENT_CONTEXT_CONFLICT);
  assert.equal(conflict.statementId, 'activeFilter');
  assert.equal(conflict.grade, SchemaMigrationGrade.MANUAL);
  assert.match(xml, /<sql id="activeFilter">\s+AND USE_YN = 'Y'/);
});

test('pipeline without a schema converter reports no schema migration', () => {
  const sourceFile = path.join(fixtureDir, 'content.xml');
  const result = new AnalyzerPipeline().run([{ sourceFile, source: fs.readFileSync(sourceFile, 'utf8') }]);
  assert.equal(result.schemaMigration, null);
});

test('iBATIS AST: renames applied while iBATIS syntax is kept, prepends read as SQL', async () => {
  const { parseIbatisMapperSource } = await import('../../../src/parser/ibatis/IbatisMapperParser.js');
  const { IbatisXmlGenerator } = await import('../../../src/generator/xml/IbatisXmlGenerator.js');
  const { sqlMap } = parseIbatisMapperSource(`<?xml version="1.0" encoding="UTF-8"?>
<sqlMap namespace="content">
  <select id="find" parameterClass="map" resultClass="map">
    SELECT APP_ID AS appId FROM OLD_CONTENT
    <dynamic prepend="WHERE">
      <isNotEmpty property="appId" prepend="AND">APP_ID = #appId:VARCHAR#</isNotEmpty>
      <isNotEmpty property="ids" prepend="AND">
        CONTENT_ID IN <iterate property="ids" open="(" close=")" conjunction=",">#ids[]#</iterate>
      </isNotEmpty>
    </dynamic>
  </select>
</sqlMap>`, 'content.xml');
  const before = JSON.stringify(sqlMap);
  const { mapper, events } = new SqlSchemaMigrationConverter(MAPPING).convertMapper(sqlMap);
  assert.equal(JSON.stringify(sqlMap), before); // input untouched

  const xml = new IbatisXmlGenerator().generateNode(mapper.statements[0]);
  // without the <dynamic prepend="WHERE"> in the stream, APP_ID right after OLD_CONTENT would read as its alias
  assert.match(xml, /SELECT APPLICATION_ID AS appId FROM CONTENT/);
  assert.match(xml, /<isNotEmpty property="appId" prepend="AND">/);
  assert.match(xml, /APPLICATION_ID = #appId:VARCHAR#/);
  assert.match(xml, /ID IN/);
  assert.match(xml, /<iterate property="ids" open="\(" close="\)" conjunction=",">/);
  assert.ok(events.every((e) => e.grade === SchemaMigrationGrade.SAFE));
});

test('IbatisXmlGenerator output parses back to the same statement structure', async () => {
  const { parseIbatisMapperSource } = await import('../../../src/parser/ibatis/IbatisMapperParser.js');
  const { IbatisXmlGenerator } = await import('../../../src/generator/xml/IbatisXmlGenerator.js');
  const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'interfaces', 'api', 'public', 'samples', 'advanced', 'adv-02-ibatis-syntax.xml'), 'utf8');
  const { sqlMap } = parseIbatisMapperSource(source, 'adv.xml');
  const generator = new IbatisXmlGenerator();
  const body = sqlMap.statements.map((s) => generator.generateNode(s)).join('\n');
  const { sqlMap: again, diagnostics } = parseIbatisMapperSource(`<sqlMap namespace="advSyntax">\n${body}\n</sqlMap>`, 'again.xml');
  assert.equal(diagnostics.errors.length, 0);
  const shape = (node) => ({
    type: node.type,
    ...(node.type === 'Conditional' ? { c: node.conditionType, p: node.property, cv: node.compareValue, cp: node.compareProperty, pre: node.prepend } : {}),
    // the generator re-indents text to its depth (layoutSqlText): compare the SQL, not its indentation
    ...(node.type === 'TextSql' ? { t: node.text.replace(/\s+/g, ' ').trim() } : {}),
    // whitespace-only text (e.g. around a CDATA section) carries no SQL
    children: (node.children ?? []).filter((c) => c.type !== 'TextSql' || c.text.trim()).map(shape),
  });
  assert.deepEqual(again.statements.map(shape), sqlMap.statements.map(shape));
});

/** FROM <include refid="table"/> O — the fragment is the table-choice logic, one table per <if> */
function tableChoiceMapper() {
  const mapper = new MapperNode({ namespace: 'pick' });
  mapper.sqlFragments = [
    withChildren(new SqlFragmentNode({ id: 'table' }), [
      withChildren(new IfNode({ test: "scope == 'A'" }), [new TextSqlNode({ text: ' TB_A ' })]),
      withChildren(new IfNode({ test: "scope == 'B'" }), [new TextSqlNode({ text: ' TB_B ' })]),
      withChildren(new IfNode({ test: "scope == 'C'" }), [new TextSqlNode({ text: ' TB_C ' })]),
    ]),
  ];
  mapper.statements = [
    withChildren(new StatementNode({ id: 'viaRefid', statementType: 'SELECT' }), [
      new TextSqlNode({ text: 'SELECT O.SAME_COL FROM ' }),
      new IncludeNode({ refid: 'table' }),
      new TextSqlNode({ text: ' O WHERE O.ID = #{id}' }),
    ]),
    withChildren(new StatementNode({ id: 'inline', statementType: 'SELECT' }), [
      new TextSqlNode({ text: 'SELECT O.SAME_COL FROM ' }),
      withChildren(new IfNode({ test: 'a' }), [new TextSqlNode({ text: ' TB_A ' })]),
      withChildren(new IfNode({ test: 'b' }), [new TextSqlNode({ text: ' TB_B ' })]),
      new TextSqlNode({ text: ' O WHERE O.ID = 1' }),
    ]),
  ];
  return mapper;
}

const TABLE_CHOICE_MAPPING = {
  TB_A: { targetTable: 'A2', columns: { SAME_COL: 'NEW_COL' } },
  TB_B: { targetTable: 'B2', columns: { SAME_COL: 'NEW_COL' } },
};

test('a table chosen by <if> alternatives (inline or in a FROM <include>): every alternative is a table, renamed, listed', () => {
  const [{ mapper, events, tables }] = new SqlSchemaMigrationConverter(TABLE_CHOICE_MAPPING).convertMappers([tableChoiceMapper()]);
  const names = (id) => tables.get(id).map((t) => t.table);

  // the next alternative is never read as the previous one's alias
  assert.deepEqual(names('inline'), ['TB_A', 'TB_B']);
  const inline = mapper.statements[1].children;
  assert.equal(inline[1].children[0].text, ' A2 ');
  assert.equal(inline[2].children[0].text, ' B2 ');
  // the alias after the alternatives is each one's; both map SAME_COL alike -> renamed
  assert.equal(inline[0].text, 'SELECT O.NEW_COL FROM ');

  // through the fragment: all three, the alias written after the include belongs to each
  assert.deepEqual(names('viaRefid'), ['TB_A', 'TB_B', 'TB_C']);
  assert.ok(tables.get('viaRefid').every((t) => t.viaRefid && t.aliases[0] === 'O'));
  assert.deepEqual(tables.get('viaRefid').map((t) => [t.mapped, t.targetTable]), [[true, 'A2'], [true, 'B2'], [false, null]]);
  // TB_C has no mapping, so under it O.SAME_COL keeps its name: a real ambiguity, left for a human
  assert.equal(mapper.statements[0].children[0].text, 'SELECT O.SAME_COL FROM ');
  assert.ok(events.some((e) => e.statementId === 'viaRefid' && e.code === SchemaMigrationCode.COLUMN_AMBIGUOUS && /TB_C O/.test(e.message)));
  assert.ok(!events.some((e) => e.code === 'UNRESOLVED_QUALIFIER'), JSON.stringify(events));

  // the fragment itself lists the tables it chooses between
  assert.deepEqual(names('table'), ['TB_A', 'TB_B', 'TB_C']);
  assert.deepEqual(mapper.sqlFragments[0].children.map((c) => c.children[0].text), [' A2 ', ' B2 ', ' TB_C ']);
});

test('alternatives that map the aliased column differently are MANUAL, never silently picked', () => {
  const mapping = { TB_A: { targetTable: 'A2', columns: { SAME_COL: 'COL_A' } }, TB_B: { targetTable: 'B2', columns: { SAME_COL: 'COL_B' } } };
  const [{ events }] = new SqlSchemaMigrationConverter(mapping).convertMappers([tableChoiceMapper()]);
  assert.ok(events.some((e) => e.statementId === 'viaRefid' && e.code === SchemaMigrationCode.COLUMN_AMBIGUOUS && e.grade === SchemaMigrationGrade.MANUAL));
});
