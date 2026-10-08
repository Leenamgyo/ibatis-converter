import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openProjectFolder, repositoryRoot } from '../../src/application/ReferenceDiscovery.js';
import { migrateProject, parseArgs } from '../../src/interfaces/cli/migrate.js';

/** a multi-module repository: the app module includes fragments of the common module next to it */
function makeRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refdisc-'));
  const repo = path.join(base, 'repo');
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  w('pom.xml', '<project><modules><module>app</module><module>common</module></modules></project>');
  w('common/pom.xml', '<project/>');
  w('common/src/main/resources/mapper/common/v1/CommonMapper.xml', `<mapper namespace="com.acme.common.CommonMapper">
  <sql id="paging">LIMIT #{size}</sql>
  <sql id="auditCols">REG_DT, <include refid="userCols"/></sql>
  <sql id="userCols">REG_ID</sql>
  <sql id="commonOnly">USE_YN = 'Y'</sql>
</mapper>`);
  w('common/src/main/resources/mapper/common/v1/Dup1.xml', '<mapper namespace="dup1"><sql id="twice">A</sql></mapper>');
  w('batch/src/main/resources/mapper/Dup2.xml', '<mapper namespace="dup2"><sql id="twice">B</sql></mapper>');
  w('app/pom.xml', '<project/>');
  w('app/src/main/resources/mapper/order/a/b/c/OrderMapper.xml', `<mapper namespace="com.acme.order.OrderMapper">
  <select id="list">SELECT ORD_NO, <include refid="com.acme.common.CommonMapper.auditCols"/> FROM T
    WHERE <include refid="commonOnly"/> <include refid="com.acme.common.CommonMapper.paging"/></select>
  <select id="amb">SELECT 1 FROM T WHERE <include refid="twice"/></select>
</mapper>`);
  // an unrelated project next to the repository: never searched
  fs.mkdirSync(path.join(base, 'other-project'), { recursive: true });
  fs.writeFileSync(path.join(base, 'other-project', 'X.xml'), '<mapper namespace="x"><sql id="twice">C</sql><sql id="commonOnly">NO</sql></mapper>');
  return { base, repo, app: path.join(repo, 'app') };
}

test('refids into another module are found outside the opened folder, inside its repository only', () => {
  const { base, repo, app } = makeRepo();
  try {
    assert.equal(repositoryRoot(app), repo, 'the .git root');
    const { session, references } = openProjectFolder(app);
    try {
      assert.equal(references.repoRoot, repo);
      const external = session.files.filter((f) => f.external).map((f) => f.sourceFile);
      assert.deepEqual(external, ['../common/src/main/resources/mapper/common/v1/CommonMapper.xml'], 'only the file that defines what was missing');
      const flat = (t) => t.flatMap((n) => [n.qualifiedId ?? `MISSING:${n.refid}`, ...flat(n.children ?? [])]);
      assert.deepEqual(flat(session.includeTree('com.acme.order.OrderMapper.list')), [
        'com.acme.common.CommonMapper.auditCols', 'com.acme.common.CommonMapper.userCols',
        'com.acme.common.CommonMapper.commonOnly', 'com.acme.common.CommonMapper.paging',
      ]);
      // "twice" is defined by two modules: not guessed (and the unrelated project's copy never counted)
      assert.deepEqual(flat(session.includeTree('com.acme.order.OrderMapper.amb')), ['MISSING:twice']);
      assert.ok(session.summary().errors.every((e) => e.message.includes('twice')));
    } finally {
      session.close();
    }
    // the CLI resolves through them but writes only the opened project's own files
    const out = path.join(base, 'out');
    const report = migrateProject(parseArgs([app, '--out', out]));
    assert.equal(report.totals.mappers, 1);
    assert.ok(fs.existsSync(path.join(out, 'mybatis/src/main/resources/mapper/order/a/b/c/OrderMapper.xml')));
    assert.equal(fs.readdirSync(out, { recursive: true }).some((f) => f.includes('CommonMapper')), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('no repository above the folder: nothing outside it is searched', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refdisc-plain-'));
  try {
    fs.mkdirSync(path.join(base, 'app'), { recursive: true });
    fs.writeFileSync(path.join(base, 'app', 'A.xml'), '<mapper namespace="a"><select id="q">SELECT 1 <include refid="shared"/></select></mapper>');
    fs.mkdirSync(path.join(base, 'neighbour'), { recursive: true });
    fs.writeFileSync(path.join(base, 'neighbour', 'B.xml'), '<mapper namespace="b"><sql id="shared">X</sql></mapper>');
    assert.equal(repositoryRoot(path.join(base, 'app')), null);
    const { session, references } = openProjectFolder(path.join(base, 'app'));
    assert.equal(references.files.length, 0);
    assert.equal(session.includeTree('a.q')[0].unresolved, 'MISSING');
    session.close();
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
