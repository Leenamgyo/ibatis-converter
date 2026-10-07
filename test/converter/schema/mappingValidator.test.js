import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMappingDefinition } from '../../../src/converter/schema/index.js';

test('a well-formed mapping is valid and summarised', () => {
  const result = validateMappingDefinition({
    OLD_T: { targetTable: 'NEW_T', columns: { A: 'B', C: 'D' } },
    'LEGACY.OLD_U': { targetTable: 'MASTER.U' },
    KEEP: { columns: { X: 'Y' } },
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.summary, { tables: 3, renamedTables: 2, columns: 3 });
  assert.deepEqual(result.warnings, []);
});

test('every problem is reported with its path, not just the first', () => {
  const result = validateMappingDefinition({
    'NOT A TABLE': { targetTable: 'X' },
    T1: 'COUNTRY',
    T2: { targetTable: 3, columns: { A: 'B', a: 'C', 'B.C': 'D', E: '' } },
    t2: {},
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map((e) => e.path), [
    '$["NOT A TABLE"]', '$["T1"]', '$["T2"].targetTable',
    '$["T2"].columns["a"]', '$["T2"].columns["B.C"]', '$["T2"].columns["E"]', '$["t2"]',
  ]);
});

test('suspicious but usable mappings are warnings', () => {
  const result = validateMappingDefinition({
    T: { targetTable: 'U', columns: { A: 'Z', B: 'Z', C: 'C' }, extra: true },
    EMPTY: {},
  });
  assert.equal(result.valid, true);
  assert.equal(result.warnings.length, 4);
});

test('a non-object is rejected outright', () => {
  for (const value of [null, [], 'x', 3]) assert.equal(validateMappingDefinition(value).valid, false);
});
