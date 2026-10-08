import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMyBatisMapperSource } from '../../src/parser/mybatis/MyBatisMapperParser.js';
import { ProjectSession, DirectorySource } from '../../src/application/ProjectSession.js';
import { XmlGenerator } from '../../src/generator/xml/XmlGenerator.js';
import { migrateProject, parseArgs } from '../../src/interfaces/cli/migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(__dirname, '..', 'fixtures', 'mybatis-project');
const ORDER = 'src/main/resources/mapper/OrderMapper.xml';
const read = (rel) => fs.readFileSync(path.join(PROJECT, rel), 'utf8');

test('a MyBatis <mapper> parses into ast/mybatis and maps node by node onto the analysis AST', () => {
  const { mapper, sqlMap, diagnostics } = parseMyBatisMapperSource(read(ORDER), ORDER);
  assert.equal(diagnostics.errors.length, 0);
  assert.equal(mapper.namespace, 'shop.OrderMapper');
  const search = mapper.statements.find((s) => s.id === 'search');
  assert.deepEqual(search.otherAttributes, [['fetchSize', '100']], 'unmodelled attributes are kept');
  assert.deepEqual(search.children.filter((c) => c.type !== 'TextSql').map((c) => c.type), ['Include', 'Where', 'Bind']);
  assert.equal(mapper.resultMaps[0].results.map((r) => r.type).join(), 'Id,Result');

  const analysed = sqlMap.statements.find((s) => s.id === 'search');
  const where = analysed.children.find((c) => c.type === 'Dynamic');
  assert.deepEqual(where.trim, { prefix: 'WHERE', prefixOverrides: ['AND', 'OR'] });
  assert.deepEqual(where.children.filter((c) => c.type === 'Conditional').map((c) => c.conditionType), ['TEST', 'CHOOSE', 'TEST']);
  assert.equal(analysed.children.some((c) => c.type === 'Bind'), false, '<bind> has no SQL');
});

test('a MyBatis project is analysed like an iBATIS one: includes, <where>, <choose>, <foreach>, <set>', () => {
  const session = new ProjectSession(new DirectorySource(PROJECT)).open();
  try {
    const summary = session.summary();
    assert.deepEqual(summary.files.map((f) => [f.sourceFile, f.syntax]), [
      ['src/main/resources/mapper/Common.xml', 'mybatis'],
      [ORDER, 'mybatis'],
    ], 'target/ copies are not read');
    assert.equal(summary.errors.length, 0);

    const search = session.analyze('shop.OrderMapper.search');
    // the include resolved across files, the WHERE's leading AND trimmed, one <choose> branch, one <foreach> item
    assert.equal(search.sql, 'SELECT O.ORD_NO, O.TOT_AMT, C.CUST_NM FROM TB_ORD_H O JOIN TB_CUST_M C ON C.CUST_NO = O.CUST_NO WHERE O.ORD_NO = ? AND O.ORD_STAT_CD = \'A\' AND O.CUST_NO IN ( ? ) ORDER BY O.ORD_DT DESC');
    assert.deepEqual(search.tables.map((t) => t.name).sort(), ['TB_CUST_M', 'TB_ORD_H']);
    assert.equal(search.joins.length, 1);
    assert.deepEqual(search.includes, ['shop.Common.orderCols']);
    assert.deepEqual(search.parameters.map((p) => `${p.name}${p.jdbcType ? `:${p.jdbcType}` : ''}`), ['ordNo', 'stat:VARCHAR', 'id']);
    assert.equal(search.warnings.length, 0);

    const update = session.analyze('shop.OrderMapper.updateStatus');
    assert.equal(update.sql, 'UPDATE TB_ORD_H SET TOT_AMT = ?, ORD_STAT_CD = ? WHERE ORD_NO = ?', '<set> drops the trailing comma');

    const conversion = session.convertStatement('shop.OrderMapper.search');
    assert.deepEqual(conversion.events.map((e) => e.code), ['ALREADY_MYBATIS']);
    assert.match(conversion.xml, /<select id="search" parameterType="map" resultMap="orderMap" fetchSize="100">/);
  } finally {
    session.close();
  }
});

test('the schema migration rewrites a MyBatis mapper\'s SQL in place, keeping its MyBatis syntax', () => {
  const session = new ProjectSession(new DirectorySource(PROJECT)).open();
  try {
    const mapping = { TB_ORD_H: { targetTable: 'ORDERS', columns: { ORD_NO: 'ORDER_ID', ORD_STAT_CD: 'STATUS' } } };
    const result = session.schemaMigration('shop.OrderMapper.search', mapping);
    assert.match(result.statement.ibatisBefore, /<where>/);
    assert.match(result.statement.ibatisAfter, /FROM ORDERS O/);
    assert.match(result.statement.ibatisAfter, /AND O\.STATUS = #\{stat,jdbcType=VARCHAR\}/);
    assert.match(result.statement.ibatisAfter, /<choose>\s*<when test="stat == 'A'">/, 'the <choose> stays a <choose>');
    assert.match(result.fragments['shop.Common.orderCols'].ibatisAfter, /O\.ORDER_ID, O\.TOT_AMT, C\.CUST_NM/, 'the included fragment, from its includer\'s FROM');
    assert.ok(result.statement.events.some((e) => e.code === 'TABLE_RENAMED'));

    const file = session.migrateForFile(ORDER, mapping).results.get(ORDER);
    assert.equal(file.syntax, 'mybatis');
    const xml = new XmlGenerator().generate(file.mybatis.mapper);
    assert.match(xml, /UPDATE ORDERS/);
    assert.match(xml, /fetchSize="100"/);
  } finally {
    session.close();
  }
});

test('CLI on a MyBatis project: mappers copied unchanged, renames in mybatis-schema/', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mybatis-cli-'));
  const mappingFile = path.join(out, 'mapping.json');
  fs.writeFileSync(mappingFile, JSON.stringify({ TB_ORD_H: { targetTable: 'ORDERS' } }));
  try {
    const report = migrateProject(parseArgs([PROJECT, '--out', path.join(out, 'o'), '--mapping', mappingFile]));
    assert.equal(report.totals.mappers, 2);
    assert.equal(report.totals.mybatisMappers, 2);
    assert.equal(fs.readFileSync(path.join(out, 'o', 'mybatis', ORDER), 'utf8'), read(ORDER));
    assert.match(fs.readFileSync(path.join(out, 'o', 'mybatis-schema', ORDER), 'utf8'), /FROM ORDERS O/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
