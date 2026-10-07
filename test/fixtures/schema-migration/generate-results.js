/**
 * Regenerates test/fixtures/schema-migration/results/ from cases/*.xml:
 *
 *   node test/fixtures/schema-migration/generate-results.js
 *
 * Per case: <case>.mybatis.xml (iBATIS -> MyBatis syntax only),
 * <case>.migrated.xml (+ schema migration) and <case>.events.txt.
 * test/integration/schemaMigrationCases.test.js asserts the checked-in
 * results still match, so review the diff before committing a regeneration.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCase, listCases, resultsDir } from './cases.js';

const here = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(resultsDir, { recursive: true });
for (const name of listCases()) {
  const { mybatisXml, migratedXml, eventsText } = runCase(name);
  fs.writeFileSync(path.join(resultsDir, `${name}.mybatis.xml`), mybatisXml);
  fs.writeFileSync(path.join(resultsDir, `${name}.migrated.xml`), migratedXml);
  fs.writeFileSync(path.join(resultsDir, `${name}.events.txt`), eventsText);
  console.log(`${path.relative(here, resultsDir)}/${name}.*`);
}
