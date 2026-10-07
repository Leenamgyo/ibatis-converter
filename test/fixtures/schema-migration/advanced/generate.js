/**
 * Writes the generated parts of the "Load advanced" sample:
 *
 *   node test/fixtures/schema-migration/advanced/generate.js
 *
 *   public/samples/advanced/adv-01-mega-report.xml   the ~2000-line legacy query
 *   public/samples/advanced/schema-mapping.json      its legacy -> new mapping
 *   ./adv-01-mega-report.target.xml                  the same query hand-written on the new schema (oracle)
 *
 * adv-00-common.xml and adv-02-ibatis-syntax.xml are hand-written.
 * test/integration/advancedSample.test.js checks the files still match.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateMegaReport, mappingJson } from './megaReport.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const samplesDir = path.resolve(here, '../../../../src/interfaces/api/public/samples/advanced');
const { legacyXml, targetXml } = generateMegaReport();
fs.writeFileSync(path.join(samplesDir, 'adv-01-mega-report.xml'), legacyXml);
fs.writeFileSync(path.join(samplesDir, 'schema-mapping.json'), `${JSON.stringify(mappingJson(), null, 2)}\n`);
fs.writeFileSync(path.join(here, 'adv-01-mega-report.target.xml'), targetXml);
console.log(`adv-01-mega-report.xml: ${legacyXml.split('\n').length} lines`);
