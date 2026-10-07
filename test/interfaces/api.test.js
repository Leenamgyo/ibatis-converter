import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/interfaces/api/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures');

function startServer() {
  const server = createApp().listen(0);
  const port = server.address().port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function readFixture(name) {
  const sourceFile = path.join(fixturesDir, name);
  return { sourceFile, source: fs.readFileSync(sourceFile, 'utf8') };
}

test('POST /api/v1/projects/analyze returns mappers/tables/dependencies for a valid project', async () => {
  const { server, baseUrl } = startServer();
  try {
    const res = await fetch(`${baseUrl}/api/v1/projects/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [readFixture('join.xml')] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.projectId);
    assert.equal(body.mappers.length, 1);
    assert.equal(body.mappers[0].namespace, 'order');
    assert.ok(body.tables.USER);
    assert.ok(body.tables.ORDERS);
    assert.equal(body.errors.length, 0);
    assert.deepEqual(body.tableDependencyGraph.USER, [{ table: 'ORDERS', statements: ['order.getOrdersWithUser'] }]);
  } finally {
    server.close();
  }
});

test('GET /api/v1/statements/:id/dependencies returns the include dependency tree', async () => {
  const { server, baseUrl } = startServer();
  try {
    await fetch(`${baseUrl}/api/v1/projects/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [readFixture('include-nested.xml')] }),
    });

    const res = await fetch(`${baseUrl}/api/v1/statements/common.getUser/dependencies`);
    assert.equal(res.status, 200);
    const tree = await res.json();
    assert.equal(tree.includes[0].id, 'common.baseWhere');
    assert.equal(tree.includes[0].children[0].id, 'common.activeCondition');
  } finally {
    server.close();
  }
});

test('GET /api/v1/statements/:id returns the full StatementAnalysis for an analyzed project', async () => {
  const { server, baseUrl } = startServer();
  try {
    const analyzeRes = await fetch(`${baseUrl}/api/v1/projects/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [readFixture('join.xml')] }),
    });
    const { projectId } = await analyzeRes.json();

    const res = await fetch(`${baseUrl}/api/v1/statements/order.getOrdersWithUser?projectId=${projectId}`);
    assert.equal(res.status, 200);
    const analysis = await res.json();
    assert.equal(analysis.id, 'order.getOrdersWithUser');
    assert.equal(analysis.joins.length, 1);
  } finally {
    server.close();
  }
});

test('GET /api/v1/tables/:tableName returns operations + column usage for a known table', async () => {
  const { server, baseUrl } = startServer();
  try {
    await fetch(`${baseUrl}/api/v1/projects/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [readFixture('write-statements/crud.xml')] }),
    });

    // No ?projectId= — falls back to "most recently analyzed project".
    const res = await fetch(`${baseUrl}/api/v1/tables/USER`);
    assert.equal(res.status, 200);
    const table = await res.json();
    assert.equal(table.name, 'USER');
    assert.deepEqual(table.operations.CREATE, ['user.insertUserPlain']);
  } finally {
    server.close();
  }
});

test('GET /api/v1/statements/:id 404s for an unknown id instead of throwing', async () => {
  const { server, baseUrl } = startServer();
  try {
    await fetch(`${baseUrl}/api/v1/projects/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [readFixture('write-statements/crud.xml')] }),
    });
    const res = await fetch(`${baseUrl}/api/v1/statements/does.notExist`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('GET /api/v1/statements/:id/mybatis-preview returns converted XML and a migration safety summary', async () => {
  const { server, baseUrl } = startServer();
  try {
    await fetch(`${baseUrl}/api/v1/projects/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [readFixture('dynamic-where.xml')] }),
    });

    const res = await fetch(`${baseUrl}/api/v1/statements/user.getUserList/mybatis-preview`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.xml, /<where>/);
    assert.match(body.xml, /#\{userId\}/);
    assert.ok(body.safetySummary.SAFE > 0);
    assert.equal(body.safetySummary.ERROR, 0);
  } finally {
    server.close();
  }
});

test('GET /api/v1/statements/:id/mybatis-preview 404s when no project has been analyzed yet', async () => {
  const { server, baseUrl } = startServer();
  try {
    const res = await fetch(`${baseUrl}/api/v1/statements/anything/mybatis-preview`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('POST /api/v1/projects/analyze rejects a malformed request body', async () => {
  const { server, baseUrl } = startServer();
  try {
    const res = await fetch(`${baseUrl}/api/v1/projects/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: 'not-an-array' }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});
