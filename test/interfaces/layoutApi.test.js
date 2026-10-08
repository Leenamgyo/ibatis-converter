import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/interfaces/api/server.js';

function startServer() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-api-'));
  const app = createApp({ datasetDir: path.join(tmp, 'datasets'), layoutDir: path.join(tmp, 'layouts'), sessionOptions: { sweepMs: 0 } });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, key, body) => {
    const res = await fetch(`${base}/api/v1/layouts/${encodeURIComponent(key)}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };
  return { call, layoutDir: path.join(tmp, 'layouts'), stop: () => { app.locals.sessions.closeAll(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); } };
}

test('a lineage layout is saved per statement, read back, and deleted', async () => {
  const { call, layoutDir, stop } = startServer();
  try {
    const key = 'order.findOrders';
    assert.equal((await call('GET', key)).status, 404);
    const layout = { sourceFile: 'mapper/order.xml', offsets: { 'node:tbl:MAIN:C': [69, 147], 'cluster:MAIN': [60, -30] }, view: { scale: 0.8, tx: 8, ty: -12 } };
    const saved = await call('PUT', key, layout);
    assert.equal(saved.status, 200);
    const read = await call('GET', key);
    assert.deepEqual({ sourceFile: read.body.sourceFile, offsets: read.body.offsets, view: read.body.view }, layout);
    // the file name is a hash: no statement id becomes a path
    assert.ok(fs.readdirSync(layoutDir).every((f) => /^[0-9a-f]{40}\.json$/.test(f)));
    // an empty layout means "nothing to keep"
    assert.equal((await call('PUT', key, { offsets: {}, view: null })).status, 204);
    assert.equal((await call('GET', key)).status, 404);
    assert.equal((await call('DELETE', key)).status, 404);
  } finally {
    stop();
  }
});

test('an invalid layout is refused', async () => {
  const { call, stop } = startServer();
  try {
    assert.equal((await call('PUT', 'a.b', { offsets: { x: [1] } })).status, 400);
    assert.equal((await call('PUT', 'a.b', { offsets: { x: [1, 'y'] } })).status, 400);
    assert.equal((await call('PUT', 'a.b', { offsets: [] })).status, 400);
    assert.equal((await call('PUT', 'a.b', { offsets: { x: [1, 2] }, view: { scale: 0, tx: 0, ty: 0 } })).status, 400);
    assert.equal((await call('PUT', '../../etc', { offsets: { x: [1, 2] } })).status, 200, 'any id is just a hash key');
  } finally {
    stop();
  }
});
