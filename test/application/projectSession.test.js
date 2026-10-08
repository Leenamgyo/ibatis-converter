import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectSession, DirectorySource, createUploadSource } from '../../src/application/ProjectSession.js';
import { AnalyzerPipeline } from '../../src/application/AnalyzerPipeline.js';
import { scanProject } from '../../src/application/ProjectLoader.js';
import { SessionManager } from '../../src/interfaces/api/SessionManager.js';
import { generateProject } from '../fuzz/projectGen.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.join(__dirname, '..', '..', 'src', 'interfaces', 'api', 'public', 'samples');
const LEGACY_APP = path.join(__dirname, '..', 'fixtures', 'project-scan', 'legacy-app');

/**
 * The session must give exactly what the all-in-memory pipeline gives —
 * analyses, conversions, diagnostics, reports, the dependency graph — while
 * holding only a small cache (`maxFiles: 2` forces constant evict / reload).
 */
function assertSameAsPipeline(root) {
  const session = new ProjectSession(new DirectorySource(root), { maxFiles: 2, maxAnalyses: 3 }).open();
  const result = new AnalyzerPipeline().run(scanProject(root).mappers);
  try {
    for (const [qid, analysis] of result.statementAnalyses) {
      assert.deepEqual(session.analyze(qid), analysis, `analysis of ${qid}`);
      const conversion = session.convertStatement(qid);
      assert.equal(conversion.xml, result.mybatisConversions.get(qid).xml, `conversion of ${qid}`);
      assert.deepEqual(conversion.events, result.mybatisConversions.get(qid).events, `events of ${qid}`);
    }
    for (const [sourceFile, xml] of result.generatedMapperXml) assert.equal(session.convertFile(sourceFile).xml, xml, sourceFile);
    const summary = session.summary();
    const messages = (list) => list.map((d) => `${d.code} ${d.sourceFile}:${d.sourceLine} ${d.message}`).sort();
    assert.deepEqual(messages(summary.errors), messages(result.diagnostics.errors));
    assert.deepEqual(messages(summary.warnings), messages(result.diagnostics.warnings));
    assert.deepEqual(summary.circularReferences, result.circularReferences.map((c) => c.path));
    assert.deepEqual(session.meta.dependencyGraph.toJSON(), result.dependencyGraph.toJSON());
    const report = session.report();
    // the pipeline reads iBATIS only; the session also reads MyBatis mappers (compared on their own elsewhere)
    const mybatisFiles = new Set(session.files.filter((f) => f.syntax === 'mybatis').map((f) => f.sourceFile));
    assert.deepEqual(report.mappers.filter((m) => !mybatisFiles.has(m.sourceFile)), result.mapperReports);
    assert.deepEqual(report.tables, result.tableUsageReport);
    assert.deepEqual(report.tableDependencyGraph, result.tableDependencyGraph);
    assert.ok(session.mappers.count <= 2 && session.analyses.count <= 3, 'caches stay bounded');
    return result.statementAnalyses.size;
  } finally {
    session.close();
  }
}

test('ProjectSession matches AnalyzerPipeline on the sample project and the legacy-app folder', () => {
  assert.ok(assertSameAsPipeline(SAMPLES) > 50);
  assert.equal(assertSameAsPipeline(LEGACY_APP), 3);
});

test('ProjectSession matches AnalyzerPipeline on generated deep-include projects (cross-namespace refids)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-corpus-'));
  try {
    for (const seed of [2, 11, 21, 23]) {
      const dir = path.join(tmp, `p${seed}`);
      generateProject(seed, dir);
      assert.ok(assertSameAsPipeline(dir) > 0, `seed ${seed}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('opening builds an index only; a statement loads just its own and its fragments\' files', () => {
  const session = new ProjectSession(new DirectorySource(SAMPLES), { maxFiles: 1 }).open();
  try {
    const { files, totals } = session.summary();
    assert.ok(totals.statements > 50 && files.every((f) => !('source' in f)), 'no file text in the index');
    session.mappers.clear();
    session.texts.clear();
    const id = files.flatMap((f) => f.statements).find((s) => s.includes > 0).qualifiedId;
    const xml = session.statementXml(id);
    assert.match(xml.xml, /^<select id="/);
    assert.match(xml.xml, /<\/select>$/);
    for (const fragment of Object.values(xml.fragments)) assert.match(fragment.xml, /^<sql id="[^"]+">[\s\S]*<\/sql>$/);
    session.analyze(id);
    const touched = new Set([xml.sourceFile, ...Object.values(xml.fragments).map((f) => f.sourceFile)]);
    assert.ok(session.loads <= touched.size * 3, `${session.loads} loads for ${touched.size} files`);
  } finally {
    session.close();
  }
  assert.throws(() => session.text('01-basic-select.xml'), /closed/);
});

test('an upload is written to a temporary directory and deleted on close; names are kept as uploaded', () => {
  const files = [
    { sourceFile: '/abs/path/a.xml', source: '<sqlMap namespace="a"><sql id="w">WHERE 1=1</sql></sqlMap>' },
    { sourceFile: '../b.xml', source: '<sqlMap namespace="b"><select id="q">SELECT X FROM T <include refid="a.w"/></select></sqlMap>' },
    { sourceFile: 'k.xml', source: '<?xml version="1.0" encoding="EUC-KR"?><sqlMap namespace="k"><select id="q">SELECT \'한글\' FROM T</select></sqlMap>' },
  ];
  const source = createUploadSource(files);
  const session = new ProjectSession(source).open();
  assert.ok(fs.existsSync(source.root));
  assert.deepEqual(session.files.map((f) => f.sourceFile), ['/abs/path/a.xml', '../b.xml', 'k.xml']);
  assert.ok(fs.readdirSync(source.root).every((n) => /^\d+\.xml$/.test(n)), 'stored under numbered names only');
  assert.match(session.statementXml('b.q').fragments['a.w'].xml, /WHERE 1=1/);
  assert.match(session.statementXml('k.q').xml, /한글/, 'already-decoded text is not decoded again');
  session.close();
  assert.equal(fs.existsSync(source.root), false);
});

test('per-statement schema migration agrees with migrating the whole project', () => {
  const root = path.join(__dirname, '..', 'fixtures', 'project-scan');
  const { mapping } = JSON.parse(fs.readFileSync(path.join(root, 'mapping.json'), 'utf8'));
  const session = new ProjectSession(new DirectorySource(LEGACY_APP), { maxFiles: 1 }).open();
  try {
    const all = session.migrateFiles(session.files.map((f) => f.sourceFile), mapping);
    const counts = session.schemaSummary(mapping).statements;
    for (const id of session.meta.statementIds) {
      const one = session.schemaMigration(id, mapping);
      const loc = session.meta.fileOf(id);
      const whole = all.get(loc);
      const localId = id.slice(id.lastIndexOf('.') + 1);
      const expected = whole.mybatis.events.filter((e) => e.statementId === localId).map(({ tokenIndex, ...e }) => e);
      assert.deepEqual(one.statement.events, expected, id);
      assert.ok(counts[id], `summary has ${id}`);
    }
    assert.ok(Object.values(counts).some((c) => c.schema.columns > 0), 'the mapping renames something');
  } finally {
    session.close();
  }
});

test('SessionManager closes idle sessions, the oldest past the cap, and on request', () => {
  let now = 0;
  const closed = [];
  const fake = (name) => ({ close: () => closed.push(name) });
  const sessions = new SessionManager({ ttlMs: 100, maxSessions: 2, sweepMs: 0, now: () => now });
  const a = sessions.add(fake('a'));
  now = 10;
  const b = sessions.add(fake('b'));
  now = 20;
  sessions.get(a); // a is now the most recently used
  sessions.add(fake('c'));
  assert.deepEqual(closed, ['b']);
  now = 125;
  sessions.sweep(); // a was last used at 20, c added at 20
  assert.deepEqual(closed.sort(), ['a', 'b', 'c']);
  assert.equal(sessions.get(a), undefined);
  const d = sessions.add(fake('d'));
  assert.equal(sessions.close(d), true);
  assert.equal(sessions.close(d), false);
  sessions.closeAll();
  void b;
});

test('includeTree follows <include> to every depth, in document order, cutting cycles', () => {
  const session = new ProjectSession(new DirectorySource(SAMPLES), { maxFiles: 1 }).open();
  try {
    const noRule = (tree) => tree.map(({ rule, children, ...n }) => ({ ...n, ...(children ? { children: noRule(children) } : {}) }));
    const rules = (tree) => tree.flatMap((n) => [n.rule, ...rules(n.children ?? [])]);
    assert.deepEqual(rules(session.includeTree('frag.nestedFragmentInclude')), ['NAMESPACE', 'NAMESPACE', 'QUALIFIED']);
    assert.deepEqual(rules(session.includeTree('frag.circularRefid')), ['NAMESPACE', 'NAMESPACE', 'CIRCULAR']);
    assert.deepEqual(noRule(session.includeTree('frag.nestedFragmentInclude')), [
      { refid: 'customerAndAudit', qualifiedId: 'frag.customerAndAudit', children: [
        { refid: 'customerColumns', qualifiedId: 'frag.customerColumns', children: [] },
        { refid: 'common.auditColumns', qualifiedId: 'common.auditColumns', children: [] },
      ] },
    ]);
    assert.deepEqual(noRule(session.includeTree('frag.circularRefid')), [
      { refid: 'circularA', qualifiedId: 'frag.circularA', children: [
        { refid: 'circularB', qualifiedId: 'frag.circularB', children: [{ refid: 'circularA', unresolved: 'CIRCULAR' }] },
      ] },
    ]);
    // a fragment's own tree, resolved in its own namespace
    assert.equal(session.includeTree('common.liveRowCondition').length, 2);
  } finally {
    session.close();
  }
});

test('includeTree resolves a nested bare refid against the including statement\'s namespace, as the runtime does', () => {
  const session = new ProjectSession(createUploadSource([
    { sourceFile: 'a.xml', source: '<sqlMap namespace="a"><sql id="cond">X = 1</sql><sql id="outer">WHERE <include refid="cond"/></sql></sqlMap>' },
    { sourceFile: 'b.xml', source: '<sqlMap namespace="b"><sql id="cond">Y = 2</sql><select id="q">SELECT 1 FROM T <include refid="a.outer"/></select></sqlMap>' },
  ])).open();
  try {
    const [outer] = session.includeTree('b.q');
    assert.equal(outer.qualifiedId, 'a.outer');
    assert.equal(outer.children[0].qualifiedId, 'b.cond', 'shadowed by the statement namespace');
    assert.equal(outer.children[0].rule, 'RUNTIME_SHADOWED');
    assert.equal(session.includeTree('a.outer')[0].qualifiedId, 'a.cond', 'on its own, its own namespace');
  } finally {
    session.close();
  }
});

test('search finds statements by id, file name, and by what their SQL uses — through <include> too', () => {
  const session = new ProjectSession(new DirectorySource(SAMPLES), { maxFiles: 2 }).open();
  try {
    const ids = (r) => r.files.flatMap((f) => Object.keys(f.statements)).sort();
    // a table / column in the SQL
    const region = session.search('region_code');
    assert.ok(region.statements > 0);
    for (const id of ids(region)) {
      const a = session.analyze(id);
      const text = session.statementXml(id);
      const all = [text.xml, ...Object.values(text.fragments).map((f) => f.xml)].join('\n').toLowerCase();
      assert.ok(all.includes('region_code') || a.sql.toLowerCase().includes('region_code'), id);
    }
    // a fragment's content reaches the statements that include it, wherever they are
    const viaRefid = session.search('activeCondition');
    const reasons = viaRefid.files.flatMap((f) => Object.values(f.statements).flat());
    assert.ok(reasons.some((r) => r.startsWith('refid:') || r === 'sql'));
    assert.ok(ids(viaRefid).length >= 2);
    // a file name
    const byFile = session.search('02-dynamic');
    assert.equal(byFile.matchedFiles, 1);
    assert.equal(byFile.files[0].sourceFile, '02-dynamic.xml');
    // nothing / blank
    assert.equal(session.search('zz_no_such_thing').files.length, 0);
    assert.equal(session.search('  ').files.length, 0);
  } finally {
    session.close();
  }
});

test('column removal guide: trace, fragment removable with its <include> sites, dynamic tag, resultMap mapping', () => {
  const session = new ProjectSession(createUploadSource([
    { sourceFile: 'cols.xml', source: `<sqlMap namespace="cols">
  <sql id="emailCol">C.EMAIL</sql>
  <sql id="baseCols">C.ID, C.NAME</sql>
</sqlMap>` },
    { sourceFile: 'cust.xml', source: `<sqlMap namespace="cust">
  <resultMap id="custMap" class="shop.Customer">
    <result property="id" column="ID"/>
    <result property="email" column="EMAIL"/>
  </resultMap>
  <select id="list" resultMap="custMap">
    SELECT <include refid="cols.baseCols"/>,
           <include refid="cols.emailCol"/>
      FROM CUSTOMER C
    <dynamic prepend="WHERE">
      <isNotEmpty property="email" prepend="AND">C.EMAIL = #email#</isNotEmpty>
      <isNotEmpty property="name" prepend="AND">C.NAME = #name#</isNotEmpty>
    </dynamic>
  </select>
  <select id="other" resultMap="custMap">SELECT <include refid="cols.baseCols"/> FROM CUSTOMER C</select>
</sqlMap>` },
  ])).open();
  try {
    const guide = session.columnRemovalGuide('cust.list', 'EMAIL');
    assert.equal(guide.found, true);
    assert.deepEqual(guide.trace[0].sources, [{ table: 'CUSTOMER', column: 'EMAIL', base: true }]);
    const kinds = guide.steps.map((s) => `${s.action}@${s.file}:${s.line}`);
    assert.ok(kinds.includes('REMOVE_SELECT_ITEM@cols.xml:2'), kinds.join(' '));
    assert.ok(kinds.includes('REMOVE_FRAGMENT@cols.xml:2'), 'the fragment holds only this column');
    assert.ok(kinds.includes('REMOVE_INCLUDE@cust.xml:8'), 'and its <include refid> site');
    assert.ok(kinds.includes('REMOVE_DYNAMIC_TAG@cust.xml:11'), 'a tag whose whole body is this column\'s condition');
    assert.ok(kinds.includes('CHECK_REFERENCE@cust.xml:11'));
    assert.ok(kinds.includes('REMOVE_RESULT_MAPPING@cust.xml:4'));
    const shared = guide.steps.find((s) => s.action === 'SHARED_RESULT_MAP');
    assert.deepEqual(shared.sharedBy, ['cust.other'], 'the resultMap is used by another statement');
    assert.ok(!kinds.some((k) => k.startsWith('REMOVE_DYNAMIC_TAG@cust.xml:12')), 'the NAME condition is not touched');

    // a column of a fragment other statements share: flagged, not removed
    const id = session.columnRemovalGuide('cust.list', 'NAME');
    assert.ok(id.steps.some((s) => s.action === 'SHARED_FRAGMENT' && s.sharedBy.includes('cust.other')));
    assert.equal(id.steps.some((s) => s.action === 'REMOVE_FRAGMENT'), false);
  } finally {
    session.close();
  }
});

test('refid accuracy: the schema converter resolves every include exactly as the project resolver does', async () => {
  const { SqlSchemaMigrationConverter } = await import('../../src/converter/schema/index.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'refid-accuracy-'));
  try {
    let resolved = 0;
    let wrong = 0;
    for (const seed of [1, 3, 6, 11]) {
      const dir = path.join(tmp, `p${seed}`);
      generateProject(seed, dir);
      const session = new ProjectSession(new DirectorySource(dir)).open();
      const truth = (r) => session.meta.includeTarget(r.refid, r.writtenIn, r.root).symbol?.qualifiedId ?? null;
      for (const file of session.files) {
        // only this file's neighbourhood is loaded — exactly the situation that used to drift
        const { results } = session.migrateForFile(file.sourceFile, {});
        const originals = [...results.values()].map((r) => r.ibatis.original);
        new SqlSchemaMigrationConverter({}).convertMappers(originals, {
          resolveInclude: (a, b, c) => session.meta.includeTarget(a, b, c).symbol?.qualifiedId ?? null,
          onInclude: (r) => { resolved++; if (r.qualifiedId !== truth(r)) wrong++; },
        });
      }
      session.close();
    }
    assert.ok(resolved > 1000, `${resolved} includes resolved`);
    assert.equal(wrong, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a MyBatis mapper\'s bare refid into another file is found, and flagged (MyBatis looks in its own namespace)', () => {
  const session = new ProjectSession(createUploadSource([
    { sourceFile: 'common.xml', source: '<sqlMap namespace="common"><sql id="cols">A, B</sql></sqlMap>' },
    { sourceFile: 'legacy.xml', source: '<sqlMap namespace="legacy"><select id="q">SELECT <include refid="cols"/> FROM T</select></sqlMap>' },
    { sourceFile: 'mb.xml', source: '<mapper namespace="mb"><select id="q">SELECT <include refid="cols"/> FROM T</select></mapper>' },
  ])).open();
  try {
    assert.equal(session.includeTree('legacy.q')[0].rule, 'GLOBAL_UNIQUE', 'iBATIS: a bare id unique in the project');
    const [include] = session.includeTree('mb.q');
    assert.equal(include.qualifiedId, 'common.cols', 'found in the other file');
    assert.equal(include.rule, 'GLOBAL_UNIQUE');
    assert.ok(session.summary().warnings.some((w) => w.code === 'MYBATIS_BARE_REFID' && w.sourceFile === 'mb.xml'), 'with the runtime caveat');
    assert.equal(session.summary().errors.length, 0);
  } finally {
    session.close();
  }
});

test('refid 쿼리에 통합: every <include> becomes its fragment\'s text (nested too), on all four sides', () => {
  const session = new ProjectSession(new DirectorySource(SAMPLES)).open();
  try {
    const mapping = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'schema-mapping.json'), 'utf8'));
    for (const id of ['frag.includeInsideDynamic', 'frag.nestedFragmentInclude', 'frag.crossMapperInclude']) {
      const plain = session.schemaMigration(id, mapping.mapping ?? mapping).statement;
      const inlined = session.schemaMigration(id, mapping.mapping ?? mapping, {}, { inlineRefid: true }).statement;
      for (const side of ['ibatisBefore', 'mybatisBefore']) {
        assert.match(plain[side], /<include /, `${id} ${side} has includes when not inlined`);
        assert.doesNotMatch(inlined[side], /<include /, `${id} ${side}`);
      }
      for (const [before, after] of [['ibatisBefore', 'ibatisAfter'], ['mybatisBefore', 'mybatisAfter']]) {
        if (inlined[after] !== undefined) assert.equal(inlined[after].split('\n').length, inlined[before].split('\n').length, `${id} ${after} lines up`);
      }
    }
    // the nested chain is spliced to its last depth
    const deep = session.schemaMigration('frag.nestedFragmentInclude', {}, {}, { inlineRefid: true }).statement.ibatisBefore;
    assert.match(deep, /CREATED_AT/, 'common.auditColumns, two includes down');
    // a cycle stays an <include> instead of looping
    assert.match(session.schemaMigration('frag.circularRefid', {}, {}, { inlineRefid: true }).statement.ibatisBefore, /<include refid="circularA"/);
  } finally {
    session.close();
  }
});

test('a namespace spread over files in different folders resolves, even when one file has broken XML', () => {
  const session = new ProjectSession(createUploadSource([
    { sourceFile: 'mod-a/common/Common_SQL.xml', source: '<sqlMap namespace="common">\n<sql id="asdf">A < 10 AND B <= 3</sql>\n<sql id="cols">X, Y</sql>\n</sqlMap>' },
    { sourceFile: 'mod-b/x/y/z/common/CommonPaging_SQL.xml', source: '<sqlMap namespace="common">\n<sql id="paging">LIMIT #size#</sql>\n<sql id="broken" <oops>\n</sqlMap>' },
    { sourceFile: 'mod-c/deep/er/still/common/CommonWhere_SQL.xml', source: '<sqlMap namespace="common"><sql id="live">USE_YN = \'Y\' <isNotEmpty property="x">AND X = #x#</sql></sqlMap>' },
    { sourceFile: 'mod-d/order/Order_SQL.xml', source: '<sqlMap namespace="order"><select id="q">SELECT <include refid="common.cols"/> FROM T WHERE <include refid="common.asdf"/> AND <include refid="common.live"/> <include refid="common.paging"/></select></sqlMap>' },
  ])).open();
  try {
    const tree = session.includeTree('order.q');
    assert.deepEqual(tree.map((n) => n.qualifiedId), ['common.cols', 'common.asdf', 'common.live', 'common.paging'], 'all four found, from three files');
    assert.equal(tree[3].unparsed, true, 'common.paging: registered from a file that does not parse');
    assert.equal(tree[3].file, 'mod-b/x/y/z/common/CommonPaging_SQL.xml');
    const { errors, warnings } = session.summary();
    assert.equal(errors.filter((e) => e.code === 'MISSING_REFERENCE').length, 0);
    assert.deepEqual(errors.map((e) => e.code), ['XML_PARSE_ERROR'], 'only the truly broken file errs');
    assert.ok(warnings.some((w) => w.code === 'XML_LENIENT_LT'));
    assert.ok(warnings.some((w) => w.code === 'XML_RECOVERED_UNCLOSED'));
    assert.match(session.analyze('order.q').sql, /SELECT X, Y FROM T WHERE A < 10 AND B <= 3 AND USE_YN = 'Y'/);
  } finally {
    session.close();
  }
});

test('statementXml carries the statement with its refids spliced in, to every depth (the lineage view reads it)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inlined-xml-'));
  try {
    fs.mkdirSync(path.join(root, 'common'), { recursive: true });
    fs.mkdirSync(path.join(root, 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'common', 'C.xml'), `<sqlMap namespace="c">
  <sql id="cond"><isNotEmpty property="name" prepend="AND">U.NAME = #name#</isNotEmpty> <include refid="inner"/></sql>
  <sql id="inner">AND U.USE_YN = 'Y'</sql>
</sqlMap>`);
    fs.writeFileSync(path.join(root, 'app', 'A.xml'), `<sqlMap namespace="a">
  <select id="q" resultClass="map">SELECT U.ID FROM TB_USER U WHERE 1 = 1 <include refid="c.cond"/></select>
</sqlMap>`);
    fs.writeFileSync(path.join(root, 'app', 'M.xml'), `<mapper namespace="m">
  <sql id="f"><if test="id != null">AND ID = #{id}</if></sql>
  <select id="q">SELECT ID FROM T WHERE 1 = 1 <include refid="f"/></select>
</mapper>`);
    const session = new ProjectSession(new DirectorySource(root)).open();
    const doc = session.statementXml('a.q');
    assert.match(doc.xml, /<include refid="c\.cond"\/>/, 'xml stays as written');
    assert.doesNotMatch(doc.inlinedXml, /<include/);
    assert.match(doc.inlinedXml, /<isNotEmpty[^>]*property="name"[^>]*>\s*U\.NAME = #name#\s*<\/isNotEmpty>/);
    assert.match(doc.inlinedXml, /U\.USE_YN = 'Y'/, 'a bare refid nested in another mapper\'s fragment is spliced too');
    assert.match(doc.inlinedXml, /^<select id="q" resultClass="map">/);
    const mybatis = session.statementXml('m.q').inlinedXml;
    assert.doesNotMatch(mybatis, /<include/);
    assert.match(mybatis, /<if test="id != null">\s*AND ID = #\{id\}\s*<\/if>/);
    session.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
