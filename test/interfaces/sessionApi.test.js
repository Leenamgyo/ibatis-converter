import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/interfaces/api/server.js';
import { isInSkippedDirectory } from '../../src/application/mapperDetection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCAN = path.join(__dirname, '..', 'fixtures', 'project-scan');
const LEGACY_APP = path.join(SCAN, 'legacy-app');

function startServer(options = {}) {
  const datasetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-datasets-'));
  const app = createApp({ datasetDir, sessionOptions: { sweepMs: 0, ...options } });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };
  const stop = () => {
    app.locals.sessions.closeAll();
    server.close();
    fs.rmSync(datasetDir, { recursive: true, force: true });
  };
  return { app, call, stop };
}

const files = () => fs.readdirSync(LEGACY_APP, { recursive: true })
  .filter((f) => f.endsWith('.xml') && !isInSkippedDirectory(f))
  .map((f) => ({ sourceFile: f, source: fs.readFileSync(path.join(LEGACY_APP, f), 'utf8') }));

test('POST /api/v1/projects returns the index only; statements load through their own endpoints', async () => {
  const { call, stop } = startServer();
  try {
    const opened = await call('POST', '/api/v1/projects', { files: files() });
    assert.equal(opened.status, 200);
    const { projectId, files: index, totals } = opened.body;
    assert.ok(projectId);
    assert.equal(totals.statements, 4); // 3 iBATIS + 1 already-MyBatis
    assert.ok(!JSON.stringify(opened.body).includes('<select'), 'no XML in the index');
    const id = index.flatMap((f) => f.statements)[0].qualifiedId;
    const q = `?projectId=${projectId}`;

    const analysis = await call('GET', `/api/v1/statements/${id}${q}`);
    assert.equal(analysis.status, 200);
    assert.equal(analysis.body.id, id);
    const xml = await call('GET', `/api/v1/statements/${id}/xml${q}`);
    assert.match(xml.body.xml, /^<select/);
    const preview = await call('GET', `/api/v1/statements/${id}/mybatis-preview${q}`);
    assert.match(preview.body.xml, /<mapper/);
    assert.equal((await call('GET', `/api/v1/statements/nope/xml${q}`)).status, 404);

    const stats = await call('GET', `/api/v1/projects/${projectId}/stats`);
    assert.ok(stats.body.cachedAnalyses >= 1);

    assert.equal((await call('DELETE', `/api/v1/projects/${projectId}`)).status, 204);
    assert.equal((await call('GET', `/api/v1/statements/${id}${q}`)).status, 404);
    assert.equal((await call('GET', `/api/v1/projects/${projectId}`)).status, 404);
  } finally {
    stop();
  }
});

test('per-statement schema migration and the summary run a dataset without the whole-project response', async () => {
  const { call, stop } = startServer();
  try {
    const { mapping } = JSON.parse(fs.readFileSync(path.join(SCAN, 'mapping.json'), 'utf8'));
    const { body: { projectId, files: index } } = await call('POST', '/api/v1/projects', { files: files() });
    const whole = await call('POST', `/api/v1/schema-migration?projectId=${projectId}`, { mapping });
    const summary = await call('POST', `/api/v1/schema-summary?projectId=${projectId}`, { mapping });
    assert.equal(summary.status, 200);
    for (const { qualifiedId } of index.flatMap((f) => f.statements)) {
      const one = await call('POST', `/api/v1/statements/${qualifiedId}/schema-migration?projectId=${projectId}`, { mapping });
      assert.equal(one.status, 200);
      const expected = whole.body.statements[qualifiedId];
      assert.equal(one.body.statement.mybatisAfter, expected.mybatisAfter, qualifiedId);
      assert.equal(one.body.statement.ibatisAfter, expected.ibatisAfter, qualifiedId);
      assert.deepEqual(one.body.statement.events, expected.events, qualifiedId);
      assert.equal(summary.body.statements[qualifiedId].schema.columns, expected.summary.columns, qualifiedId);
    }
    assert.equal(summary.body.total.columns, whole.body.summary.columns, 'project total');
    const file = index[0].sourceFile;
    const scoped = await call('POST', `/api/v1/schema-migration?projectId=${projectId}&file=${encodeURIComponent(file)}`, { mapping });
    assert.deepEqual(Object.keys(scoped.body.files), [file]);
    for (const id of scoped.body.files[file].statements) assert.equal(scoped.body.statements[id].mybatisAfter, whole.body.statements[id].mybatisAfter, id);
    for (const id of scoped.body.statements[scoped.body.files[file].statements[0]].includes) assert.ok(scoped.body.fragments[id], `included fragment ${id} is in the scoped result`);
    for (const id of scoped.body.files[file].statements) assert.ok(Array.isArray(scoped.body.statements[id].includeTree), `${id} has its include tree`);
    const bad = await call('POST', `/api/v1/statements/${index[0].statements[0].qualifiedId}/schema-migration?projectId=${projectId}`, { mapping: { T: 5 } });
    assert.equal(bad.status, 400);
  } finally {
    stop();
  }
});

test('POST /api/v1/projects/open reads a local folder in place; the cap closes the oldest session', async () => {
  const { call, stop } = startServer({ maxSessions: 1 });
  try {
    const first = await call('POST', '/api/v1/projects/open', { path: LEGACY_APP });
    assert.equal(first.status, 200);
    assert.equal(first.body.totals.statements, 4);
    assert.ok(first.body.skipped.length >= 1, 'non-mapper XML is listed as skipped');
    const second = await call('POST', '/api/v1/projects/open', { path: LEGACY_APP });
    assert.equal((await call('GET', `/api/v1/projects/${first.body.projectId}`)).status, 404, 'evicted');
    assert.equal((await call('GET', `/api/v1/projects/${second.body.projectId}`)).status, 200);
    assert.equal((await call('POST', '/api/v1/projects/open', { path: path.join(LEGACY_APP, 'nope') })).status, 400);
  } finally {
    stop();
  }
});

test('a project can arrive in batches: /uploads, /uploads/:id/files, /uploads/:id/open', async () => {
  const { call, stop } = startServer();
  try {
    const { body: { uploadId } } = await call('POST', '/api/v1/uploads');
    const all = files();
    for (const f of all) {
      const sent = await call('POST', `/api/v1/uploads/${uploadId}/files`, { files: [f] });
      assert.equal(sent.status, 200);
    }
    assert.equal((await call('POST', `/api/v1/uploads/${uploadId}/files`, { files: [all[0]] })).status, 400, 'a duplicate name is refused');
    assert.equal((await call('POST', `/api/v1/uploads/${uploadId}/files`, { files: 'x' })).status, 400);
    const opened = await call('POST', `/api/v1/uploads/${uploadId}/open`);
    assert.equal(opened.status, 200);
    assert.equal(opened.body.totals.statements, 4);
    assert.equal((await call('POST', `/api/v1/uploads/${uploadId}/open`)).status, 404, 'an upload opens once');
    assert.equal((await call('POST', '/api/v1/uploads/nope/files', { files: [] })).status, 404);
  } finally {
    stop();
  }
});

test('GET /api/v1/fs/dirs lists folder names only (no dot or build folders), for the in-app folder picker', async () => {
  const { call, stop } = startServer();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-dirs-'));
  try {
    for (const d of ['projA', 'projB', '.git', 'node_modules', 'target']) fs.mkdirSync(path.join(root, d));
    fs.writeFileSync(path.join(root, 'a.xml'), '<x/>');
    fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
    const listed = await call('GET', `/api/v1/fs/dirs?path=${encodeURIComponent(root)}`);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.dirs, ['projA', 'projB']);
    assert.equal(listed.body.xmlHere, 1);
    assert.equal(listed.body.parent, path.dirname(fs.realpathSync(root)) === path.dirname(root) ? path.dirname(root) : listed.body.parent);
    assert.equal((await call('GET', `/api/v1/fs/dirs?path=${encodeURIComponent(path.join(root, 'nope'))}`)).status, 400);
    const opened = await call('POST', '/api/v1/projects/open', { path: path.join(root, 'projA') });
    assert.equal(opened.status, 200, 'a listed folder opens in place');
  } finally {
    stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('GET /api/v1/version names the UI build, uncached, so an old tab can tell it is stale', async () => {
  const { call, stop } = startServer();
  try {
    const first = await call('GET', '/api/v1/version');
    assert.equal(first.status, 200);
    assert.match(first.body.ui, /^\d+$/);
    assert.deepEqual((await call('GET', '/api/v1/version')).body, first.body, 'stable while nothing changes');
  } finally {
    stop();
  }
});

test('GET /api/v1/search filters a project by ids, paths and SQL text', async () => {
  const { call, stop } = startServer();
  try {
    const { body: { projectId } } = await call('POST', '/api/v1/projects', { files: files() });
    const found = await call('GET', `/api/v1/search?q=TB_ORD_H&projectId=${projectId}`);
    assert.equal(found.status, 200);
    assert.ok(found.body.statements >= 1);
    assert.ok(found.body.files.every((f) => Object.values(f.statements).every((r) => r.includes('sql') || r.includes('id'))));
    assert.equal((await call('GET', `/api/v1/search?q=nothing_like_this&projectId=${projectId}`)).body.files.length, 0);
  } finally {
    stop();
  }
});

test('formatSql (쿼리 정렬) changes only the layout of the returned texts', async () => {
  const { call, stop } = startServer();
  try {
    const { mapping } = JSON.parse(fs.readFileSync(path.join(SCAN, 'mapping.json'), 'utf8'));
    const { body: { projectId, files: index } } = await call('POST', '/api/v1/projects', { files: files() });
    const file = index[0].sourceFile;
    const url = `/api/v1/schema-migration?projectId=${projectId}&file=${encodeURIComponent(file)}`;
    const plain = (await call('POST', url, { mapping })).body;
    const formatted = (await call('POST', url, { mapping, formatSql: true })).body;
    const squash = (s) => s.replace(/\s+/g, '');
    for (const id of Object.keys(plain.statements)) {
      assert.equal(squash(formatted.statements[id].mybatisBefore), squash(plain.statements[id].mybatisBefore), id);
      assert.deepEqual(formatted.statements[id].events, plain.statements[id].events, id);
    }
  } finally {
    stop();
  }
});

test('GET /api/v1/statements/:id/column-guide returns a removal guide (and needs a column)', async () => {
  const { call, stop } = startServer();
  try {
    const { body: { projectId, files: index } } = await call('POST', '/api/v1/projects', { files: files() });
    const id = index.flatMap((f) => f.statements).find((s) => s.type === 'SELECT').qualifiedId;
    const analysis = (await call('GET', `/api/v1/statements/${id}?projectId=${projectId}`)).body;
    const column = analysis.lineage.columnLineage[0].alias ?? analysis.lineage.columnLineage[0].sourceColumn;
    const guide = await call('GET', `/api/v1/statements/${id}/column-guide?column=${encodeURIComponent(column)}&projectId=${projectId}`);
    assert.equal(guide.status, 200);
    assert.equal(guide.body.found, true);
    assert.ok(guide.body.steps.some((s) => s.action === 'REMOVE_SELECT_ITEM'));
    assert.equal((await call('GET', `/api/v1/statements/${id}/column-guide?projectId=${projectId}`)).status, 400);
  } finally {
    stop();
  }
});
