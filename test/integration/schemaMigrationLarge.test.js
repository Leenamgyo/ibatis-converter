import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalyzerPipeline } from '../../src/application/AnalyzerPipeline.js';
import { SqlSchemaMigrationConverter, SchemaMigrationCode } from '../../src/converter/schema/index.js';
import { generateLargeMapper, mappingJson } from '../fixtures/schema-migration/large/largeMapper.js';

// Oracle test: the same ~2000-line mapper is generated once on the legacy
// schema and once as if hand-written on the new schema. Migrating the legacy
// one must give byte-for-byte the MyBatis XML of converting the new one.
// See test/fixtures/schema-migration/large/ (generate.js writes the files).

const largeDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'schema-migration', 'large');

function migrate(source, converter = new SqlSchemaMigrationConverter(mappingJson())) {
  const result = new AnalyzerPipeline({ schemaMigrationConverter: converter }).run([{ sourceFile: 'large.xml', source }]);
  return { result, xml: result.schemaMigration.mapperXml.get('large.xml'), events: result.schemaMigration.events.get('large.xml') };
}

function convertOnly(source) {
  return new AnalyzerPipeline().run([{ sourceFile: 'large.xml', source }]).generatedMapperXml.get('large.xml');
}

test('2000-line mapper: migrating the legacy schema equals the hand-written new-schema mapper', () => {
  const { legacyXml, targetXml } = generateLargeMapper();
  assert.ok(legacyXml.split('\n').length >= 2000);
  const { result, xml, events } = migrate(legacyXml);
  assert.equal(result.diagnostics.errors.length, 0);
  assert.equal(xml, convertOnly(targetXml));
  // nothing silently skipped and nothing guessed: only the expected review items
  const review = new Set(events.filter((e) => e.grade !== 'SAFE').map((e) => e.code));
  assert.deepEqual([...review].sort(), [
    SchemaMigrationCode.HINT_NOT_MIGRATED, SchemaMigrationCode.RESULT_COLUMN_RENAMED, SchemaMigrationCode.RUNTIME_SUBSTITUTION,
  ].sort());
});

test('the checked-in 2000-line files are what the generator produces', () => {
  const { legacyXml, targetXml } = generateLargeMapper();
  assert.equal(fs.readFileSync(path.join(largeDir, 'legacy-mapper.xml'), 'utf8'), legacyXml);
  assert.equal(fs.readFileSync(path.join(largeDir, 'target-mapper.xml'), 'utf8'), targetXml);
  assert.equal(fs.readFileSync(path.join(largeDir, 'result', 'migrated.xml'), 'utf8'), migrate(legacyXml).xml);
});

test('oracle holds across other generator seeds', () => {
  for (const seed of [1, 2, 3, 11, 42]) {
    const { legacyXml, targetXml } = generateLargeMapper({ seed, minLines: 1000 });
    assert.equal(migrate(legacyXml).xml, convertOnly(targetXml), `seed ${seed}`);
  }
});

test('fragments nothing includes are left as is and reported, never silently skipped', () => {
  const source = `<?xml version="1.0" encoding="UTF-8"?>
<sqlMap namespace="large">
  <sql id="orphanColumns">C.CUST_NO AS custNo, C.CUST_NM AS custNm</sql>
  <sql id="orphanFilter">AND USE_YN = #useYn#</sql>
</sqlMap>`;
  const { xml, events } = migrate(source);
  assert.match(xml, /C\.CUST_NO AS custNo, C\.CUST_NM AS custNm/);
  assert.match(xml, /AND USE_YN = #\{useYn\}/);
  const codes = events.map((e) => `${e.statementId}:${e.code}`);
  assert.ok(codes.includes('orphanColumns:UNRESOLVED_QUALIFIER'));
  assert.ok(codes.includes('orphanFilter:NO_TABLE_CONTEXT'));

  // fragmentContexts on the converter resolves them, through the pipeline too
  const withContext = new SqlSchemaMigrationConverter(mappingJson(), {
    fragmentContexts: { 'large.orphanColumns': 'TB_CUST_M C', orphanFilter: 'TB_CUST_M' },
  });
  const fixed = migrate(source, withContext);
  assert.match(fixed.xml, /C\.CUSTOMER_ID AS custNo, C\.CUSTOMER_NAME AS custNm/);
  assert.match(fixed.xml, /AND IS_ACTIVE = #\{useYn\}/);
  assert.ok(fixed.events.every((e) => e.grade === 'SAFE'));
});
