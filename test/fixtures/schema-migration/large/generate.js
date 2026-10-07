/**
 * Writes the default ~2000-line case to disk so it can be read:
 *
 *   node test/fixtures/schema-migration/large/generate.js
 *
 *   legacy-mapper.xml      input: iBATIS mapper on the legacy schema
 *   target-mapper.xml      the same mapper written by hand on the new schema (the oracle)
 *   mapping.json           legacy -> new mapping
 *   result/migrated.xml    legacy-mapper.xml -> MyBatis + schema migration
 *   result/expected.xml    target-mapper.xml -> MyBatis only (must equal migrated.xml)
 *   result/events.txt      graded decisions
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateLargeMapper, mappingJson } from './largeMapper.js';
import { AnalyzerPipeline } from '../../../../src/application/AnalyzerPipeline.js';
import { SqlSchemaMigrationConverter } from '../../../../src/converter/schema/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { legacyXml, targetXml, statementCount } = generateLargeMapper();
const mapping = mappingJson();
const migrated = new AnalyzerPipeline({ schemaMigrationConverter: new SqlSchemaMigrationConverter(mapping) })
  .run([{ sourceFile: 'large.xml', source: legacyXml }]);
const expected = new AnalyzerPipeline().run([{ sourceFile: 'large.xml', source: targetXml }]);
const events = migrated.schemaMigration.events.get('large.xml');

fs.mkdirSync(path.join(here, 'result'), { recursive: true });
fs.writeFileSync(path.join(here, 'legacy-mapper.xml'), legacyXml);
fs.writeFileSync(path.join(here, 'target-mapper.xml'), targetXml);
fs.writeFileSync(path.join(here, 'mapping.json'), `${JSON.stringify(mapping, null, 2)}\n`);
fs.writeFileSync(path.join(here, 'result', 'migrated.xml'), migrated.schemaMigration.mapperXml.get('large.xml'));
fs.writeFileSync(path.join(here, 'result', 'expected.xml'), expected.generatedMapperXml.get('large.xml'));
fs.writeFileSync(path.join(here, 'result', 'events.txt'),
  `${events.map((e) => `[${e.grade}] ${e.statementId} ${e.code}: ${e.message}`).join('\n')}\n`);
console.log(`${legacyXml.split('\n').length} lines, ${statementCount} statements, ${events.length} events`);
