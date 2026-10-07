import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/interfaces/api/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const casesDir = path.join(__dirname, '..', 'fixtures', 'schema-migration', 'cases');
const MAPPING = JSON.parse(fs.readFileSync(path.join(casesDir, 'mapping.json'), 'utf8'));

async function withServer(fn) {
  const datasetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'datasets-'));
  const server = createApp({ datasetDir }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };
  try {
    await fn(call, datasetDir);
  } finally {
    server.close();
    fs.rmSync(datasetDir, { recursive: true, force: true });
  }
}

test('datasets: create, list, read, update, delete — stored as one JSON file each', () => withServer(async (call, dir) => {
  assert.deepEqual((await call('GET', '/api/v1/datasets')).body, []);

  const created = await call('PUT', '/api/v1/datasets/order-v2', { name: '주문 v2', mapping: MAPPING });
  assert.equal(created.status, 200);
  assert.equal(created.body.name, '주문 v2');
  assert.equal(created.body.validation.summary.tables, 6);
  assert.ok(fs.existsSync(path.join(dir, 'order-v2.json')));

  const list = (await call('GET', '/api/v1/datasets')).body;
  assert.deepEqual(list.map((d) => [d.id, d.tables, d.columns]), [['order-v2', 6, 27]]);

  const updated = await call('PUT', '/api/v1/datasets/order-v2', { name: '주문 v2.1', mapping: { TB_CUST_M: { targetTable: 'CUSTOMER' } } });
  assert.equal(updated.body.createdAt, created.body.createdAt);
  assert.equal((await call('GET', '/api/v1/datasets/order-v2')).body.name, '주문 v2.1');

  assert.equal((await call('DELETE', '/api/v1/datasets/order-v2')).status, 204);
  assert.equal((await call('GET', '/api/v1/datasets/order-v2')).status, 404);
}));

test('datasets: an invalid mapping or id is rejected with every problem listed', () => withServer(async (call) => {
  const bad = await call('PUT', '/api/v1/datasets/x', {
    mapping: { 'BAD TABLE': {}, T: { columns: { A: 1 } }, t: { targetTable: 'U' } },
  });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.validation.errors.map((e) => e.path), ['$["BAD TABLE"]', '$["T"].columns["A"]', '$["t"]']);
  assert.equal((await call('PUT', '/api/v1/datasets/..%2Fescape', { mapping: MAPPING })).status, 400);
  assert.equal((await call('POST', '/api/v1/datasets/validate', { mapping: [] })).body.valid, false);
}));

test('schema-migration: before/after per statement, fragment and file for an analyzed project', () => withServer(async (call) => {
  const files = ['02-join-same-column.xml', '04-include-fragments.xml'].map((f) => ({
    sourceFile: f, source: fs.readFileSync(path.join(casesDir, f), 'utf8'),
  }));
  const { body: project } = await call('POST', '/api/v1/projects/analyze', { files });
  await call('PUT', '/api/v1/datasets/legacy', { name: 'legacy', mapping: MAPPING });

  const { status, body } = await call('POST', `/api/v1/schema-migration?projectId=${project.projectId}`, { datasetId: 'legacy' });
  assert.equal(status, 200);

  const detail = body.statements['order.getOrderDetail'];
  assert.match(detail.mybatisBefore, /^<select id="getOrderDetail"/); // the node alone, no <?xml>/<mapper> wrapper
  assert.match(detail.mybatisBefore, /FROM TB_ORD_H H/);
  assert.match(detail.mybatisAfter, /FROM ORDERS H/);
  assert.ok(detail.summary.tables === 4 && detail.summary.columns > 10);
  assert.ok(detail.events.every((e) => e.tokenIndex === undefined)); // internal field not exposed

  const list = body.statements['product.listProducts'];
  assert.deepEqual(list.includes, ['product.productColumns', 'product.categoryFilter', 'product.activeOnly']);
  assert.match(body.fragments['product.productColumns'].mybatisAfter, /P\.PRODUCT_ID AS prdCd/);
  assert.equal(body.fragments['product.activeOnly'].summary.MANUAL, 1);

  assert.deepEqual(body.files['04-include-fragments.xml'].statements, ['product.listProducts', 'product.countProducts', 'product.countActiveCustomers']);
  assert.equal(body.summary.MANUAL, 1);

  // the four texts the 변환 view pairs: iBATIS / MyBatis, before / after the renames
  assert.match(detail.ibatisBefore, /^<select id="getOrderDetail" parameterClass="string"/);
  assert.match(detail.ibatisBefore, /H\.ORD_NO = #ordNo#/);
  assert.match(detail.ibatisAfter, /H\.ORDER_ID = #ordNo#/); // iBATIS syntax kept
  assert.match(detail.mybatisAfter, /H\.ORDER_ID = #\{ordNo\}/);
  assert.equal(detail.ibatisBefore.split('\n').length, detail.mybatisAfter.split('\n').length);
  assert.ok(detail.conversion.events.some((e) => e.code === 'HASH_PARAMETER'));
  assert.ok(body.fragments['product.categoryFilter'].conversion.events.some((e) => e.code === 'CONDITIONAL_TO_IF'));

  // no dataset at all: still the MyBatis conversion, no renames
  const none = await call('POST', `/api/v1/schema-migration?projectId=${project.projectId}`, {});
  assert.equal(none.status, 200);
  assert.equal(none.body.summary.columns, 0);
  assert.equal(none.body.statements['order.getOrderDetail'].ibatisAfter, undefined); // unchanged: left out

  // inline mapping works too, and preserveResultColumnNames is passed through
  const inline = await call('POST', `/api/v1/schema-migration?projectId=${project.projectId}`, {
    mapping: MAPPING, preserveResultColumnNames: true,
  });
  assert.equal(inline.status, 200);
  assert.equal((await call('POST', '/api/v1/schema-migration', { datasetId: 'nope' })).status, 404);
}));

test('a malformed JSON body gets a JSON 400, not an HTML error page', async () => {
  const datasetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'datasets-'));
  const server = createApp({ datasetDir }).listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/datasets/x`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{bad json',
    });
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.match((await res.json()).error, /not valid JSON/);
  } finally {
    server.close();
    fs.rmSync(datasetDir, { recursive: true, force: true });
  }
});
