import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalyzerPipeline } from '../../../src/application/AnalyzerPipeline.js';
import { SqlSchemaMigrationConverter } from '../../../src/converter/schema/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const casesDir = path.join(here, 'cases');
export const resultsDir = path.join(here, 'results');

export function listCases() {
  return fs.readdirSync(casesDir).filter((f) => f.endsWith('.xml')).sort().map((f) => f.replace(/\.xml$/, ''));
}

/** Runs one case mapper through the pipeline with cases/mapping.json. */
export function runCase(name) {
  const mapping = JSON.parse(fs.readFileSync(path.join(casesDir, 'mapping.json'), 'utf8'));
  const sourceFile = `${name}.xml`;
  const source = fs.readFileSync(path.join(casesDir, sourceFile), 'utf8');
  const result = new AnalyzerPipeline({ schemaMigrationConverter: new SqlSchemaMigrationConverter(mapping) })
    .run([{ sourceFile, source }]);
  const events = result.schemaMigration.events.get(sourceFile);
  const eventsText = events
    .map((e) => `[${e.grade}] ${e.statementId} ${e.code}: ${e.message}`)
    .join('\n') + '\n';
  return {
    result,
    events,
    mybatisXml: result.generatedMapperXml.get(sourceFile),
    migratedXml: result.schemaMigration.mapperXml.get(sourceFile),
    eventsText,
  };
}
