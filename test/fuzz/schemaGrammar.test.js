import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate, rng, MAPPING } from './sqlGrammar.js';
import { SqlSchemaMigrationConverter } from '../../src/converter/schema/index.js';

// Seeded fuzzing of converter/schema. The generator (sqlGrammar.js) writes
// each random statement with placeholder names and renders it twice:
// legacy (input) and target (the only correct output). Bigger runs:
//   FUZZ_SEEDS=200000 node --test test/fuzz/schemaGrammar.test.js
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 3000);
const converter = new SqlSchemaMigrationConverter(MAPPING);

test(`random statements migrate exactly to their target (${SEEDS} seeds)`, () => {
  const failures = [];
  for (let seed = 1; seed <= SEEDS && failures.length < 3; seed++) {
    const { legacy, target } = generate(seed);
    const { sql } = converter.convert(legacy);
    if (sql !== target) failures.push({ seed, legacy, got: sql, expected: target });
  }
  assert.deepEqual(failures, []);
});

test(`random token soup never throws and is lossless when nothing maps (${SEEDS} seeds)`, () => {
  const atoms = ['SELECT', 'FROM', 'WHERE', '(', ')', ',', '.', '*', "'", '"', '`', '[', ']', '--', '/*', '*/', '#{', '}', '${',
    '#', '$', '?', ':x', '::', '(+)', 'O_ACCT', 'ID', 'a1', 'AS', 'JOIN', 'ON', 'WITH', 'UNION', 'INSERT', 'INTO', 'VALUES',
    'UPDATE', 'SET', 'DELETE', 'MERGE', 'USING', 'WHEN', 'CASE', 'END', ';', '\n', ' ', 'APP.O_ACCT', 'LEG.O_FEE', 'OVER', '=', '한글'];
  const empty = new SqlSchemaMigrationConverter({});
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    let sql = '';
    for (let i = 0, n = 1 + Math.floor(r() * 40); i < n; i++) sql += atoms[Math.floor(r() * atoms.length)] + (r() < 0.5 ? ' ' : '');
    assert.equal(empty.convert(sql).sql, sql, `seed ${seed}`);
    converter.convert(sql);
    converter.convert(sql, ['O_ACCT a', 'LEG.O_FEE']);
  }
});
