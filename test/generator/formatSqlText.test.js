import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSqlText } from '../../src/generator/xml/formatSqlText.js';
import { layoutSqlText } from '../../src/generator/xml/layoutSqlText.js';
import { tokenize, TokenKind } from '../../src/converter/schema/SqlLexer.js';
import { ProjectSession, DirectorySource } from '../../src/application/ProjectSession.js';
import { generateProject } from '../fuzz/projectGen.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.join(__dirname, '..', '..', 'src', 'interfaces', 'api', 'public', 'samples');

test('clauses start lines, AND/OR indent, a SELECT list aligns, subqueries nest', () => {
  assert.equal(formatSqlText('SELECT C.ID, C.NAME FROM CUSTOMER C LEFT OUTER JOIN REGION R ON R.CODE = C.REGION WHERE C.ST = #{st} AND C.D BETWEEN #{a} AND #{b} OR C.G = \'VIP\' ORDER BY C.ID'), [
    'SELECT C.ID,',
    '       C.NAME',
    'FROM CUSTOMER C',
    'LEFT OUTER JOIN REGION R ON R.CODE = C.REGION',
    'WHERE C.ST = #{st}',
    '  AND C.D BETWEEN #{a} AND #{b}',
    "  OR C.G = 'VIP'",
    'ORDER BY C.ID',
  ].join('\n'));
  assert.equal(formatSqlText('SELECT A FROM T WHERE ID IN (SELECT ID FROM U WHERE F = 1) AND Z = 1'), [
    'SELECT A',
    'FROM T',
    'WHERE ID IN (',
    '    SELECT ID',
    '    FROM U',
    '    WHERE F = 1',
    ')',
    '  AND Z = 1',
  ].join('\n'));
});

test('MyBatis / iBATIS text stays intact: params, glued tokens, function parens, CASE, comments', () => {
  // a node inside <if> starting with AND is not pushed down
  assert.equal(formatSqlText('AND C.NAME LIKE \'%\' || #name# || \'%\''), "AND C.NAME LIKE '%' || #name# || '%'");
  // no whitespace added where there was none
  assert.equal(formatSqlText('SELECT A FROM TB_${yyyymm} X WHERE f(x)=1'), 'SELECT A\nFROM TB_${yyyymm} X\nWHERE f(x)=1');
  // FROM inside a function call, AND inside CASE: not clauses here
  assert.equal(formatSqlText('SELECT EXTRACT(YEAR FROM D), CASE WHEN A > 1 AND B < 2 THEN 1 END FROM T'), 'SELECT EXTRACT(YEAR FROM D),\n       CASE WHEN A > 1 AND B < 2 THEN 1 END\nFROM T');
  // a line comment ends its line; a hint stays inline
  assert.equal(formatSqlText('SELECT /*+ INDEX(T I) */ A -- note\n FROM T'), 'SELECT /*+ INDEX(T I) */ A -- note\nFROM T');
  // a.from is a column, not FROM
  assert.equal(formatSqlText('SELECT T.FROM, T.SET FROM T'), 'SELECT T.FROM,\n       T.SET\nFROM T');
});

const meaning = (sql) => tokenize(sql)
  .filter((t) => t.kind !== TokenKind.WHITESPACE)
  .map((t) => (t.kind === TokenKind.COMMENT && !t.text.startsWith('--') ? t.text.replace(/\s+/g, ' ').trim() : t.text));

test('formatting never changes SQL, and keeps a line comment last on its line — over every text block of the corpus', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'format-corpus-'));
  const roots = [SAMPLES, path.join(__dirname, '..', 'fixtures')];
  try {
    for (const seed of [2, 9, 17]) {
      generateProject(seed, path.join(tmp, `p${seed}`));
      roots.push(path.join(tmp, `p${seed}`));
    }
    let blocks = 0;
    for (const root of roots) {
      const session = new ProjectSession(new DirectorySource(root), { maxFiles: 4 }).open();
      for (const file of session.files) {
        if (!file.parsed) continue;
        const { sqlMap } = session.mapper(file.sourceFile);
        const walk = (node) => {
          if (node.type === 'TextSql' && node.text.trim()) {
            blocks++;
            const out = layoutSqlText(node.text, '  ', { format: true }).join('\n');
            assert.deepEqual(meaning(out), meaning(node.text), `${file.sourceFile}:${node.sourceLine}`);
            for (const line of out.split('\n')) {
              const at = line.indexOf('--');
              // whatever follows a line comment on its line would be commented out
              if (at !== -1 && !/'[^']*--/.test(line)) assert.ok(meaning(line.slice(at)).length <= 1, `${file.sourceFile}:${node.sourceLine}: ${line}`);
            }
          }
          for (const child of node.children ?? []) walk(child);
        };
        for (const node of [...sqlMap.statements, ...sqlMap.sqlFragments]) walk(node);
      }
      session.close();
    }
    assert.ok(blocks > 1000, `${blocks} blocks`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('with 쿼리 정렬 on, before / after a rename still line up line for line (the 변환 view pairs them)', () => {
  const session = new ProjectSession(new DirectorySource(SAMPLES)).open();
  try {
    const mapping = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'schema-mapping.json'), 'utf8'));
    let changed = 0;
    for (const id of session.meta.statementIds) {
      const plain = session.schemaMigration(id, mapping.mapping ?? mapping).statement;
      const formatted = session.schemaMigration(id, mapping.mapping ?? mapping, {}, { formatSql: true }).statement;
      for (const [before, after] of [['ibatisBefore', 'ibatisAfter'], ['mybatisBefore', 'mybatisAfter']]) {
        if (formatted[after] === undefined) continue;
        assert.equal(formatted[after].split('\n').length, formatted[before].split('\n').length, `${id} ${after}`);
      }
      if (formatted.ibatisBefore !== plain.ibatisBefore) changed++;
    }
    assert.ok(changed > 10, `${changed} statements laid out differently`);
  } finally {
    session.close();
  }
});
