import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutSqlText } from '../../src/generator/xml/layoutSqlText.js';
import { tokenize, TokenKind } from '../../src/converter/schema/SqlLexer.js';
import { ProjectSession, DirectorySource } from '../../src/application/ProjectSession.js';
import { generateProject } from '../fuzz/projectGen.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('a text block is re-indented to its depth, keeping relative indentation, without blank-line noise', () => {
  assert.deepEqual(layoutSqlText('\n        SELECT A,\n               B\n          FROM T\n      ', '    '), [
    '    SELECT A,',
    '           B',
    '      FROM T',
  ]);
  assert.deepEqual(layoutSqlText('\n   \n\t\n', '  '), [], 'whitespace only: nothing');
  assert.deepEqual(layoutSqlText('AND X = #{x}', '      '), ['      AND X = #{x}'], 'text on the tag\'s own line');
  assert.deepEqual(layoutSqlText('AND X = 1\n            AND Y = 2', '  '), ['  AND X = 1', '  AND Y = 2'], 'the first line does not set the common indent');
  assert.deepEqual(layoutSqlText('\n\tSELECT 1\n\t\tFROM DUAL', ''), ['SELECT 1', '    FROM DUAL'], 'tabs count as 4 columns');
});

test('lines inside a multi-line string literal are kept byte for byte', () => {
  const text = "\n      SELECT 'line one   \n   still   the literal' AS T\n        FROM DUAL\n";
  assert.deepEqual(layoutSqlText(text, '  '), [
    "  SELECT 'line one   ",
    '   still   the literal\' AS T',
    '    FROM DUAL',
  ]);
  // an apostrophe in a comment does not open a literal
  assert.deepEqual(layoutSqlText("\n    -- it's a comment\n    SELECT 1\n", ''), ["-- it's a comment", 'SELECT 1']);
  assert.deepEqual(layoutSqlText("\n    /* it's */ SELECT 1\n      FROM T\n", ''), ["/* it's */ SELECT 1", '  FROM T']);
  // '' is an escaped quote, not the end of the literal
  assert.deepEqual(layoutSqlText("\n  SELECT 'it''s\n  x'\n", ''), ["SELECT 'it''s", "  x'"]);
});

/** the SQL a text block means: its tokens, whitespace dropped, comments whitespace-normalised */
const meaning = (sql) => tokenize(sql)
  .filter((t) => t.kind !== TokenKind.WHITESPACE)
  .map((t) => (t.kind === TokenKind.COMMENT ? t.text.replace(/\s+/g, ' ').trim() : t.text));

test('layout never changes SQL: same tokens (strings whole) for every text block of the samples, fixtures and generated projects', () => {
  const roots = [
    path.join(__dirname, '..', '..', 'src', 'interfaces', 'api', 'public', 'samples'),
    path.join(__dirname, '..', 'fixtures'),
  ];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-corpus-'));
  try {
    for (const seed of [1, 7, 13, 21]) {
      const dir = path.join(tmp, `p${seed}`);
      generateProject(seed, dir);
      roots.push(dir);
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
            const laidOut = layoutSqlText(node.text, '    ').join('\n');
            assert.deepEqual(meaning(laidOut), meaning(node.text), `${file.sourceFile}:${node.sourceLine}`);
          }
          for (const child of node.children ?? []) walk(child);
        };
        for (const node of [...sqlMap.statements, ...sqlMap.sqlFragments]) walk(node);
      }
      session.close();
    }
    assert.ok(blocks > 1000, `${blocks} text blocks checked`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
