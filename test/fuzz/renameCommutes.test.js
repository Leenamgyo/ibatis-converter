import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateStatement } from './ibatisGen.js';
import { parseIbatisMapperSource } from '../../src/parser/ibatis/IbatisMapperParser.js';
import { MyBatisAstConverter } from '../../src/converter/mybatis/MyBatisAstConverter.js';
import { SqlSchemaMigrationConverter } from '../../src/converter/schema/index.js';
import { MapperNode } from '../../src/ast/mybatis/nodes.js';
import { XmlGenerator } from '../../src/generator/xml/index.js';

// The 변환 view shows renames applied to iBATIS (toggle off) and to MyBatis
// (toggle on). Both must agree: rename-then-convert == convert-then-rename,
// with the same graded decisions. This caught `TB_ORD_H_$yyyymm$` losing its
// MANUAL on the iBATIS side.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 800);
const converter = new MyBatisAstConverter();
const xml = new XmlGenerator();

function compare(sqlMap, mapping) {
  const migrator = new SqlSchemaMigrationConverter(mapping);
  const [{ mapper: renamedIbatis, events: ibatisEvents }] = migrator.convertMappers([sqlMap]);
  const converted = new MapperNode({ namespace: sqlMap.namespace });
  converted.statements = sqlMap.statements.map((s) => converter.convertStatement(s).node);
  converted.sqlFragments = sqlMap.sqlFragments.map((f) => converter.convertSqlFragment(f).node);
  const [{ mapper: renamedMybatis, events: mybatisEvents }] = migrator.convertMappers([converted]);
  const decisions = (events, id) => events.filter((e) => e.statementId === id).map((e) => `${e.grade}:${e.code}:${e.replacement}`).sort();
  return sqlMap.statements.flatMap((s, i) => {
    const a = xml.generateNode(converter.convertStatement(renamedIbatis.statements[i]).node);
    const b = xml.generateNode(renamedMybatis.statements[i]);
    const problems = [];
    if (a !== b) problems.push({ id: s.id, kind: 'text', a, b });
    if (JSON.stringify(decisions(ibatisEvents, s.id)) !== JSON.stringify(decisions(mybatisEvents, s.id))) {
      problems.push({ id: s.id, kind: 'events', a: decisions(ibatisEvents, s.id), b: decisions(mybatisEvents, s.id) });
    }
    return problems;
  });
}

test(`renaming commutes with the MyBatis conversion (${SEEDS} random statements)`, () => {
  const columns = ['ID', 'X', 'G', 'S', 'FA', 'FB', 'FC', ...Array.from({ length: 30 }, (_, i) => `C${i + 1}`)];
  const mapping = { T: { targetTable: 'NT', columns: Object.fromEntries(columns.map((c) => [c, `N_${c}`])) } };
  const problems = [];
  for (let seed = 1; seed <= SEEDS && problems.length < 3; seed++) {
    problems.push(...compare(parseIbatisMapperSource(generateStatement(seed).xml, 'fuzz.xml').sqlMap, mapping));
  }
  assert.deepEqual(problems, []);
});

test('renaming commutes with the MyBatis conversion on every sample / case mapper', () => {
  const sets = [
    ['src/interfaces/api/public/samples', 'src/interfaces/api/public/samples/schema-mapping.json'],
    ['src/interfaces/api/public/samples/advanced', 'src/interfaces/api/public/samples/advanced/schema-mapping.json'],
    ['test/fixtures/schema-migration/cases', 'test/fixtures/schema-migration/cases/mapping.json'],
  ];
  for (const [dir, mappingFile] of sets) {
    const mapping = JSON.parse(fs.readFileSync(path.join(ROOT, mappingFile), 'utf8'));
    for (const file of fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.xml'))) {
      const { sqlMap } = parseIbatisMapperSource(fs.readFileSync(path.join(ROOT, dir, file), 'utf8'), file);
      assert.deepEqual(compare(sqlMap, mapping), [], file);
    }
  }
});
