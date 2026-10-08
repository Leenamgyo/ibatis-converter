/**
 * Statements whose refids expand to tens of thousands of lines: a query with ~20
 * `<include>`s, each fragment including more (a layered DAG, so the same fragment is
 * spliced in at many places). The case that ran the server and the browser out of
 * memory / stack — kept here so it stays bounded:
 *   - the parser's AND chain is one level per term: every recursive walk over it
 *     (table / lineage analyzers) overflowed the stack -> balanced on parse
 *   - an analysis that large is not pinned in the cache
 *   - schema migration resolves every include site once (no per-marker indexOf)
 *   - a fragment's context comes from a fixed sample of its include sites, so the
 *     statement view, the file view and the project summary agree
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectSession, DirectorySource } from '../../src/application/ProjectSession.js';
import { SqlAnalyzer } from '../../src/analyzer/sql/SqlAnalyzer.js';
import { renderExpr } from '../../src/analyzer/lineage/index.js';

/** fragment L{k}_{w} has 15 conditions and includes `fan` fragments of layer k+1 */
function writeLayeredProject(root, { fan, layers, width = 8, includes = 20 }) {
  const common = ['<?xml version="1.0" encoding="UTF-8"?>', '<sqlMap namespace="common">'];
  for (let k = 0; k < layers; k++) {
    for (let w = 0; w < width; w++) {
      const conditions = Array.from({ length: 15 }, (_, i) => `    AND A.L${k}_C${w}_${i} = #p${i}#`);
      const nested = k + 1 < layers ? Array.from({ length: fan }, (_, f) => `    <include refid="common.L${k + 1}_${(w + f) % width}"/>`) : [];
      common.push(`  <sql id="L${k}_${w}">`, ...conditions, ...nested, '  </sql>');
    }
  }
  common.push('</sqlMap>');
  const report = ['<?xml version="1.0" encoding="UTF-8"?>', '<sqlMap namespace="rep">',
    '  <select id="big">SELECT A.ID, B.NM FROM TB_A A JOIN TB_B B ON A.ID = B.ID WHERE 1 = 1'];
  for (let i = 0; i < includes; i++) report.push(`    <isNotEmpty property="p${i}"><include refid="common.L0_${i % width}"/></isNotEmpty>`);
  report.push('  </select>', '</sqlMap>');
  fs.mkdirSync(path.join(root, 'common'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'common', 'Common_SQL.xml'), common.join('\n'));
  fs.writeFileSync(path.join(root, 'app', 'Rep_SQL.xml'), report.join('\n'));
}

const countTree = (tree) => tree.reduce((n, node) => n + 1 + countTree(node.children ?? []), 0);

function depthOf(node) {
  let max = 0;
  const stack = [[node, 1]];
  while (stack.length) {
    const [n, d] = stack.pop();
    if (n?.type !== 'binary_expr') continue;
    max = Math.max(max, d);
    stack.push([n.left, d + 1], [n.right, d + 1]);
  }
  return max;
}

test('a 20,000-term AND chain parses into a shallow tree, terms in order', () => {
  const terms = Array.from({ length: 20000 }, (_, i) => `C${i} = ${i}`);
  const { ast, error } = new SqlAnalyzer().parse(`SELECT 1 FROM T WHERE ${terms.join(' AND ')} OR (X = 1 AND Y = 2)`);
  assert.equal(error, null);
  const where = ast[0].where;
  assert.ok(depthOf(where) < 40, `depth ${depthOf(where)}`);
  const text = renderExpr(where); // recursive renderer: would overflow on the parser's own nesting
  assert.ok(text.startsWith('C0 = 0 AND C1 = 1 AND C2 = 2'), text.slice(0, 60));
  assert.ok(text.endsWith('C19999 = 19999 OR (X = 1 AND Y = 2)'), text.slice(-60));
});

test('a statement whose nested refids expand to ~25,000 lines analyses and migrates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'large-includes-'));
  try {
    writeLayeredProject(root, { fan: 4, layers: 4 });
    // a small analysis budget: this statement's analysis is bigger, so it is not kept
    const session = new ProjectSession(new DirectorySource(root), { maxAnalysisBytes: 1024 * 1024 }).open();
    assert.equal(countTree(session.includeTree('rep.big')), 20 * (1 + 4 + 16 + 64));

    const analysis = session.analyze('rep.big');
    assert.deepEqual(analysis.warnings.filter((w) => w.code === 'SQL_PARSE_FAILED'), []);
    assert.deepEqual(analysis.tables.map((t) => t.name ?? t.table).sort(), ['TB_A', 'TB_B']);
    assert.ok(analysis.columns.some((c) => c.column === 'L3_C0_14'), 'columns of the deepest fragments are seen');
    assert.match(analysis.lineage.selects[0].where, /L3_C7_14/);
    assert.equal(session.analyses.count, 0, 'an analysis over its budget is not cached');

    const mapping = { TB_A: { targetTable: 'TB_A', columns: { L3_C0_0: 'NEW_DEEP' } } };
    const plain = session.schemaMigration('rep.big', mapping);
    assert.match(plain.fragments['common.L3_0'].ibatisAfter, /A\.NEW_DEEP/, 'a fragment four includes deep is migrated');
    const inline = session.schemaMigration('rep.big', mapping, {}, { inlineRefid: true });
    const before = inline.statement.ibatisBefore;
    const after = inline.statement.ibatisAfter;
    assert.doesNotMatch(before, /<include/);
    assert.equal(before.split('\n').length, after.split('\n').length);
    // every one of the paths into L3_0 is spliced in, and each is renamed
    assert.equal((after.match(/A\.NEW_DEEP/g) ?? []).length, (before.match(/A\.L3_C0_0 /g) ?? []).length);
    assert.ok((before.match(/A\.L3_C0_0 /g) ?? []).length > 100);
    session.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a fragment migrates the same in the statement view, the file view and the summary when its sites are sampled', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sampled-sites-'));
  try {
    // one FROM-less fragment, included by 6 statements in 6 files, half over TB_X and half over TB_Y
    fs.mkdirSync(path.join(root, 'common'), { recursive: true });
    fs.writeFileSync(path.join(root, 'common', 'C.xml'), '<sqlMap namespace="c"><sql id="cols">COL_A, COL_B</sql></sqlMap>');
    for (let m = 0; m < 6; m++) {
      fs.mkdirSync(path.join(root, `m${m}`), { recursive: true });
      const table = m < 3 ? 'TB_X' : 'TB_Y';
      fs.writeFileSync(path.join(root, `m${m}`, 'M.xml'), `<sqlMap namespace="m${m}"><select id="q">SELECT <include refid="c.cols"/> FROM ${table}</select><select id="other">SELECT Z FROM TB_Z</select></sqlMap>`);
    }
    const mapping = { TB_X: { targetTable: 'TB_X', columns: { COL_A: 'X_A' } }, TB_Y: { targetTable: 'TB_Y', columns: { COL_A: 'Y_A' } } };
    const session = new ProjectSession(new DirectorySource(root), { schemaSites: 2 }).open();
    const views = [0, 3, 5].map((m) => session.schemaMigration(`m${m}.q`, mapping).fragments['c.cols']);
    for (const view of views) {
      assert.deepEqual(view, views[0], 'the same fragment result whichever statement is viewed');
      assert.ok(view.events.some((e) => e.code === 'FRAGMENT_CONTEXT_SAMPLED'));
    }
    const file = session.migrateForFile('m5/M.xml', mapping);
    const tag = (r) => r.mybatis.events.filter((e) => e.statementId === 'cols').map(({ tokenIndex, ...e }) => e);
    assert.deepEqual(tag(file.results.get('common/C.xml')), views[0].events.filter((e) => e.code !== 'FRAGMENT_CONTEXT_SAMPLED'));
    // the summary adds the same fragment events to every includer
    const counts = session.schemaSummary(mapping).statements;
    const tally = (events) => events.filter((e) => e.code !== 'FRAGMENT_CONTEXT_SAMPLED').length;
    for (let m = 0; m < 6; m++) {
      const one = session.schemaMigration(`m${m}.q`, mapping);
      const expected = one.statement.events.length + tally(one.fragments['c.cols'].events);
      const got = counts[`m${m}.q`].schema;
      assert.equal(got.SAFE + got.WARNING + got.MANUAL + got.ERROR, expected, `m${m}.q`);
    }
    session.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
