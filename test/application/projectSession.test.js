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
    assert.deepEqual(session.graph.dependencyGraph.toJSON(), result.dependencyGraph.toJSON());
    const report = session.report();
    assert.deepEqual(report.mappers, result.mapperReports);
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
    for (const id of session.statementIds) {
      const one = session.schemaMigration(id, mapping);
      const loc = session.fileByQualifiedId.get(id);
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
    assert.deepEqual(session.includeTree('frag.nestedFragmentInclude'), [
      { refid: 'customerAndAudit', qualifiedId: 'frag.customerAndAudit', children: [
        { refid: 'customerColumns', qualifiedId: 'frag.customerColumns', children: [] },
        { refid: 'common.auditColumns', qualifiedId: 'common.auditColumns', children: [] },
      ] },
    ]);
    assert.deepEqual(session.includeTree('frag.circularRefid'), [
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
    assert.equal(session.includeTree('a.outer')[0].qualifiedId, 'a.cond', 'on its own, its own namespace');
  } finally {
    session.close();
  }
});
