import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalyzerPipeline } from '../../src/application/AnalyzerPipeline.js';
import { SqlSchemaMigrationConverter } from '../../src/converter/schema/index.js';
import { generateMegaReport, mappingJson } from '../fixtures/schema-migration/advanced/megaReport.js';

// The "Load advanced" sample (src/interfaces/api/public/samples/advanced/):
// a ~2000-line single report query and a mapper of hard iBATIS 2 syntax.
// See test/fixtures/schema-migration/advanced/ for the generator + oracle.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const samplesDir = path.join(__dirname, '..', '..', 'src', 'interfaces', 'api', 'public', 'samples', 'advanced');
const fixtureDir = path.join(__dirname, '..', 'fixtures', 'schema-migration', 'advanced');
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const manifest = JSON.parse(read(samplesDir, 'manifest.json'));
const files = () => manifest.files.map((f) => ({ sourceFile: f, source: read(samplesDir, f) }));

function run({ withSchema = true } = {}) {
  const mapping = JSON.parse(read(samplesDir, 'schema-mapping.json'));
  return new AnalyzerPipeline(withSchema ? { schemaMigrationConverter: new SqlSchemaMigrationConverter(mapping) } : {}).run(files());
}

test('generated sample files are what the generator produces', () => {
  const { legacyXml, targetXml } = generateMegaReport();
  assert.equal(read(samplesDir, 'adv-01-mega-report.xml'), legacyXml);
  assert.equal(read(fixtureDir, 'adv-01-mega-report.target.xml'), targetXml);
  assert.deepEqual(JSON.parse(read(samplesDir, 'schema-mapping.json')), mappingJson());
  assert.ok(legacyXml.split('\n').length >= 2000);
});

test('the advanced project parses, resolves and converts with no errors', () => {
  const result = run();
  assert.deepEqual(result.diagnostics.errors, []);
  assert.deepEqual(result.diagnostics.warnings, []); // isParameterPresent is a real tag now, not "unsupported"
});

test('2000-line report: the SQL analyzer still parses it (38 CTEs, 160 joins)', () => {
  const analysis = run({ withSchema: false }).statementAnalyses.get('advReport.monthlySettlementReport');
  assert.deepEqual(analysis.warnings, []);
  assert.equal(analysis.lineage.counts.ctes, 37);
  assert.ok(analysis.lineage.counts.joins >= 150);
});

test('2000-line report: schema migration equals the same query hand-written on the new schema', () => {
  const migrated = run().schemaMigration;
  const expected = new AnalyzerPipeline().run([
    { sourceFile: 'adv-00-common.xml', source: read(samplesDir, 'adv-00-common.xml') },
    { sourceFile: 'adv-01-mega-report.xml', source: read(fixtureDir, 'adv-01-mega-report.target.xml') },
  ]);
  assert.equal(migrated.mapperXml.get('adv-01-mega-report.xml'), expected.generatedMapperXml.get('adv-01-mega-report.xml'));
  const events = migrated.events.get('adv-01-mega-report.xml');
  assert.ok(events.every((e) => e.grade === 'SAFE'));
  assert.ok(events.filter((e) => e.code === 'COLUMN_RENAMED').length > 1000);
});

test('hard iBATIS syntax converts to MyBatis without silently changing meaning', () => {
  const result = run({ withSchema: false });
  const xml = result.generatedMapperXml.get('adv-02-ibatis-syntax.xml');
  // compareProperty compares two properties, not a literal
  assert.match(xml, /<if test="statCd != prevStatCd">/);
  // isParameterPresent keeps its WHERE
  assert.match(xml, /<if test="_parameter != null">\s+WHERE CUST_NO = #\{value\}/);
  // dynamic open/close -> trim
  assert.match(xml, /<trim prefix="WHERE \(" suffix="\)" prefixOverrides="AND ">/);
  // a property inside <iterate> is rewritten to the foreach item
  assert.match(xml, /<if test="item\.qtyList != null and item\.qtyList\.size\(\) &gt; 0">/);
  // OGNL traps: one-char literal, null in an ordering test
  assert.match(xml, /<if test="useMaxAmt == 'Y'\.toString\(\)">/);
  assert.match(xml, /<if test="itemCount != null and itemCount &gt; 0">/);
  assert.doesNotMatch(xml, /test="groups\[\]/);
  // groupBy / nested resultMap / nested select
  assert.match(xml, /<id property="ordNo" column="ORD_NO"\/>/);
  assert.match(xml, /<collection property="items" resultMap="advSyntax\.orderItem"\/>/);
  assert.match(xml, /<association property="prdNm" column="PRD_CD" select="advSyntax\.getProductName"\/>/);
  // procedure -> CALLABLE
  assert.match(xml, /<update id="closeMonth" parameterType="map" statementType="CALLABLE">/);

  const graded = (id) => result.mybatisConversions.get(id).events.filter((e) => e.grade !== 'SAFE').map((e) => `${e.grade}:${e.code}`);
  assert.deepEqual(graded('advSyntax.searchOrders').sort(), [
    'MANUAL:UNSUPPORTED_NULL_VALUE', 'WARNING:CACHE_MODEL_DROPPED', 'WARNING:PROPERTY_AVAILABLE_APPROXIMATED',
    'WARNING:RAW_SQL_SUBSTITUTION', 'WARNING:RAW_SQL_SUBSTITUTION',
  ]);
  assert.deepEqual(graded('advSyntax.updateOrderStatus'), ['MANUAL:PARAMETER_MAP_STATEMENT']);
});

test('hard iBATIS syntax: schema migration of Oracle (+), runtime table names, MERGE and nested fragments', () => {
  const { mapperXml, events } = run().schemaMigration;
  const xml = mapperXml.get('adv-02-ibatis-syntax.xml');
  assert.match(xml, /WHERE S\.CATEGORY_ID\(\+\) = C\.CATEGORY_ID/);
  assert.match(xml, /CONNECT BY PRIOR C\.CATEGORY_ID = C\.PARENT_CATEGORY_ID/);
  assert.match(xml, /FROM TB_ORD_H_\$\{yyyymm\}/);
  assert.match(xml, /INSERT \(GROUP_CODE, CODE, CODE_NAME, SORT_ORDER, REG_DT\)/);
  assert.match(xml, /VALUES \(S\.GRP_CD, S\.CD, S\.CD_NM/); // the USING subquery's own aliases stay
  assert.match(mapperXml.get('adv-00-common.xml'), /AND O\.STATUS IN/);

  const review = [...events.get('adv-00-common.xml'), ...events.get('adv-02-ibatis-syntax.xml')]
    .filter((e) => e.grade !== 'SAFE' && e.code !== 'RESULT_COLUMN_RENAMED')
    .map((e) => `${e.statementId}:${e.grade}:${e.code}`);
  assert.deepEqual(review, [
    'searchOrders:WARNING:RUNTIME_SUBSTITUTION',
    'searchOrders:WARNING:RUNTIME_SUBSTITUTION',
    'monthlyArchive:MANUAL:DYNAMIC_IDENTIFIER',
  ]);
});
