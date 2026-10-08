import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanProject } from '../../src/application/ProjectLoader.js';
import { detectXmlEncoding, rootElementName, classifyXml, isInIgnoredDirectory, copyScore } from '../../src/application/mapperDetection.js';
import { migrateProject, parseArgs } from '../../src/interfaces/cli/migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, '..', 'fixtures', 'project-scan');
const project = path.join(fixture, 'legacy-app');

test('scanProject finds only iBATIS mappers and skips build output / non-mapper XML', () => {
  const { mappers, skipped } = scanProject(project);
  assert.deepEqual(mappers.map((m) => m.sourceFile), [
    'src/main/resources/sqlmap/customer/Customer_SQL.xml',
    'src/main/resources/sqlmap/order/Order_SQL.xml',
  ]);
  // target/classes (a Maven copy) and node_modules are never read
  assert.ok(!mappers.some((m) => m.sourceFile.startsWith('target/') || m.sourceFile.includes('node_modules')));
  assert.deepEqual(Object.fromEntries(skipped.map((s) => [s.sourceFile, s.kind])), {
    'pom.xml': 'OTHER',
    'src/main/resources/log4j.xml': 'OTHER',
    'src/main/resources/mybatis/AlreadyConverted.xml': 'MYBATIS_MAPPER',
    'src/main/resources/sqlmap/sqlMapConfig.xml': 'IBATIS_CONFIG',
    'src/main/webapp/WEB-INF/web.xml': 'OTHER',
  });
});

test('an EUC-KR mapper is decoded by its declared encoding', () => {
  const customer = scanProject(project).mappers.find((m) => m.sourceFile.endsWith('Customer_SQL.xml'));
  assert.equal(customer.encoding, 'euc-kr');
  assert.match(customer.source, /고객 조회/);
  assert.match(customer.source, /'사용'/);
});

test('encoding / root element / skipped-directory detection', () => {
  const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
  assert.equal(detectXmlEncoding(ascii('<?xml version="1.0" encoding="MS949"?><a/>')), 'euc-kr');
  assert.equal(detectXmlEncoding(ascii('<a/>')), 'utf-8');
  assert.equal(detectXmlEncoding(Uint8Array.from([0xef, 0xbb, 0xbf, 0x3c])), 'utf-8');
  assert.equal(rootElementName('<?xml version="1.0"?>\n<!-- c -->\n<!DOCTYPE x [ <!ENTITY a "b"> ]>\n<sqlMap namespace="x">'), 'sqlMap');
  assert.equal(classifyXml('<mapper namespace="x"/>'), 'MYBATIS_MAPPER');
  assert.equal(classifyXml('not xml'), 'UNREADABLE');
  // only tool / VCS folders are skipped by name; build-named folders can hold the real mappers
  assert.equal(isInIgnoredDirectory('node_modules/x/a.xml'), true);
  assert.equal(isInIgnoredDirectory('target/classes/a.xml'), false);
  assert.equal(isInIgnoredDirectory('src/main/java/com/acme/erp/out/a.xml'), false);
  // …which only decide which of two copies of the same mapper is the copy
  assert.ok(copyScore('target/classes/sqlmap/a.xml') > copyScore('src/main/resources/sqlmap/a.xml'));
  assert.ok(copyScore('WebContent/WEB-INF/classes/sqlmap/a.xml') > copyScore('src/sqlmap/a.xml'));
  assert.equal(copyScore('src/main/java/com/acme/erp/out/bin/build/a.xml'), 0, 'package folders named out/bin/build are source');
});

test('CLI: converts a project folder into out/, mirroring paths, with a report', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-'));
  try {
    const report = migrateProject(parseArgs([project, '--out', out, '--mapping', path.join(fixture, 'mapping.json')]));
    // two iBATIS mappers + one already-MyBatis mapper (kept as written, still schema-migrated)
    assert.equal(report.totals.mappers, 3);
    assert.equal(report.totals.mybatisMappers, 1);
    assert.equal(report.totals.statements, 4);
    assert.equal(report.totals.errors, 0);
    assert.equal(report.totals.tables, 3);

    const converted = fs.readFileSync(path.join(out, 'mybatis/src/main/resources/sqlmap/order/Order_SQL.xml'), 'utf8');
    assert.match(converted, /<if test="bigOnly == 'Y'\.toString\(\)">/);
    assert.match(converted, /FROM TB_ORD_H O/);
    const migrated = fs.readFileSync(path.join(out, 'mybatis-schema/src/main/resources/sqlmap/customer/Customer_SQL.xml'), 'utf8');
    assert.match(migrated, /SELECT C\.CUSTOMER_ID, C\.CUSTOMER_NAME \/\* 고객명 \*\//); // EUC-KR source, Korean intact
    assert.match(migrated, /FROM CUSTOMER C/);

    const md = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
    // target/classes/…/Order_SQL.xml is read and recognised as a copy of the source mapper (by content)
    assert.match(md, /매퍼 3개 \(이미 MyBatis 1개: 원본 그대로 복사, 스키마 변환만 적용\) · statement 4개 · 건너뛴 XML 5개/);
    assert.match(md, /target\/classes\/sqlmap\/order\/Order_SQL\.xml — 같은 매퍼의 빌드 복사본 \(원본: src\/main\/resources\/sqlmap\/order\/Order_SQL\.xml\)/);
    assert.match(md, /Customer_SQL\.xml \(euc-kr\)/);
    assert.ok(JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8')).files.length === 3);
    const already = 'src/main/resources/mybatis/AlreadyConverted.xml';
    assert.equal(fs.readFileSync(path.join(out, 'mybatis', already), 'utf8'), fs.readFileSync(path.join(project, already), 'utf8'), 'a MyBatis mapper is copied unchanged');
    // the source tree is untouched
    assert.equal(fs.existsSync(path.join(project, 'mybatis')), false);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('CLI argument errors', () => {
  assert.throws(() => parseArgs(['a', 'b']), /하나만/);
  assert.throws(() => parseArgs(['a', '--fail-on', 'x']), /manual 또는 warning/);
  assert.throws(() => migrateProject(parseArgs([project, '--out', project])), /달라야/);
});

test('classifyHead decides from a file\'s first bytes, and asks for the whole file only when it must', async () => {
  const { classifyHead, HEAD_BYTES } = await import('../../src/application/mapperDetection.js');
  const bytes = (t) => new TextEncoder().encode(t);
  assert.equal(classifyHead(bytes('<sqlMap namespace="a">'), false), 'IBATIS_MAPPER');
  assert.equal(classifyHead(bytes('<?xml version="1.0"?><beans>'), false), 'OTHER');
  const longComment = `<!-- ${'x'.repeat(HEAD_BYTES)}`;
  assert.equal(classifyHead(bytes(longComment).subarray(0, HEAD_BYTES), false), null, 'root past the head: read it whole');
  assert.equal(classifyHead(bytes('<!-- only a comment -->'), true), 'UNREADABLE');
});
