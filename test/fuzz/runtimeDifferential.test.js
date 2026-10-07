import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateStatement, generateParams } from './ibatisGen.js';
import { renderIbatis, renderMybatis, RenderError } from './runtimes.js';
import { parseIbatisMapperSource } from '../../src/parser/ibatis/IbatisMapperParser.js';
import { MyBatisAstConverter } from '../../src/converter/mybatis/MyBatisAstConverter.js';

// Differential test of the iBATIS -> MyBatis converter: random dynamic-SQL
// statements, each rendered with random parameters by a reference iBATIS
// runtime (original AST) and a reference MyBatis/OGNL runtime (converted AST).
// Same parameters must give the same SQL and the same bound values.
// This is what found the 'Y' Character literal, the empty-List IN, and the
// null-in-ordering-test bugs. Bigger runs: FUZZ_SEEDS=30000 node --test ...
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 1500);
const PARAM_SETS = 12;

test(`converted dynamic SQL renders the same as iBATIS (${SEEDS} statements x ${PARAM_SETS} parameter sets)`, () => {
  const converter = new MyBatisAstConverter();
  const failures = [];
  for (let seed = 1; seed <= SEEDS && failures.length < 3; seed++) {
    const { xml } = generateStatement(seed);
    const { sqlMap, diagnostics } = parseIbatisMapperSource(xml, 'fuzz.xml');
    assert.equal(diagnostics.errors.length, 0, xml);
    const statement = sqlMap.statements[0];
    const { node } = converter.convertStatement(statement);
    const ibatisFragments = new Map(sqlMap.sqlFragments.map((f) => [f.id, f]));
    const mybatisFragments = new Map(sqlMap.sqlFragments.map((f) => [f.id, converter.convertSqlFragment(f).node]));
    for (let k = 0; k < PARAM_SETS; k++) {
      const params = generateParams(seed * 100 + k);
      let expected;
      try {
        expected = renderIbatis(statement, params, (id) => ibatisFragments.get(id));
      } catch (e) {
        if (e instanceof RenderError) continue; // iBATIS itself rejects these parameters
        throw e;
      }
      let actual;
      try {
        actual = renderMybatis(node, params, (id) => mybatisFragments.get(id));
      } catch (e) {
        if (!(e instanceof RenderError)) throw e;
        actual = { sql: `MyBatis error: ${e.message}`, params: [] };
      }
      if (actual.sql !== expected.sql || JSON.stringify(actual.params) !== JSON.stringify(expected.params)) {
        failures.push({ seed, params, xml, expected, actual });
        break;
      }
    }
  }
  assert.deepEqual(failures, []);
});
