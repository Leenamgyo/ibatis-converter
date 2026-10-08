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
    assert.equal(totals.statements, 3);
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
    assert.equal(first.body.totals.statements, 3);
    assert.ok(first.body.skipped.length >= 1, 'non-mapper XML is listed as skipped');
    const second = await call('POST', '/api/v1/projects/open', { path: LEGACY_APP });
    assert.equal((await call('GET', `/api/v1/projects/${first.body.projectId}`)).status, 404, 'evicted');
    assert.equal((await call('GET', `/api/v1/projects/${second.body.projectId}`)).status, 200);
    assert.equal((await call('POST', '/api/v1/projects/open', { path: path.join(LEGACY_APP, 'nope') })).status, 400);
  } finally {
    stop();
  }
});
