/**
 * Refid torture test: generated projects that mix every way real legacy
 * projects write and scatter `<include refid>` targets, each include with a
 * KNOWN intended target, checked against the session's include tree — by
 * path and by upload. "Not found" is only acceptable where the generator
 * made the reference genuinely ambiguous.
 *
 * Patterns (picked at random per include):
 *   QUALIFIED     refid="ns.id"
 *   SPLIT_NS      bare id of the same namespace, defined in ANOTHER file of that
 *                 namespace (one namespace spread over files in different folders)
 *   GLOBAL        bare id unique in the project, defined in another namespace
 *   DOTTED        <sql id="grp.name"> inside a namespaced file, referenced as "grp.name"
 *   SAME_COPIES   one fragment copy-pasted (identical SQL) into several modules, bare refid
 *   NEAR_COPY     different SQL in several modules, the one in the includer's folder meant
 *   SPACED        refid=" ns.id " (stray spaces)
 *   LT_FILE       target in a file whose SQL has an unescaped "<" (parsed leniently)
 *   BROKEN_FILE   target in a file too broken to parse (registered from its text; unparsed)
 * plus: deep folders with out/bin/build/classes segments, namespaces with stray spaces,
 * MyBatis files, nested include chains through other fragments (qualified).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectSession, DirectorySource, UploadSource } from '../../src/application/ProjectSession.js';
import { rng } from './sqlGrammar.js';

const PATTERNS = ['QUALIFIED', 'SPLIT_NS', 'GLOBAL', 'DOTTED', 'SAME_COPIES', 'NEAR_COPY', 'SPACED', 'LT_FILE', 'BROKEN_FILE'];
const DIRS = ['src', 'main', 'resources', 'sqlmap', 'out', 'bin', 'build', 'classes', 'dao', 'impl', 'v2', 'legacy', 'erp', 'kr', 'co'];

export function generateTortureProject(seed, root) {
  const r = rng(seed * 7919 + 13);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const deepDir = (mod) => [...Array.from({ length: 3 + Math.floor(r() * 12) }, () => pick(DIRS)), mod];
  const files = []; // { rel, namespace, mybatis, broken, lt, fragments: [{ id, body }], statements: [{ id, includes: [refid] }] }
  const newFile = (mod, namespace, opts = {}) => {
    const f = { rel: path.join(...deepDir(mod), `${namespace.replace(/\W/g, '_')}_${files.length}.xml`), namespace, mybatis: false, broken: false, lt: false, fragments: [], statements: [], ...opts };
    files.push(f);
    return f;
  };
  let n = 0;
  const uid = (p) => `${p}${seed}_${n++}`;
  const expectations = []; // { statement qid, expected: [qid | 'AMBIGUOUS'], unparsed: Set }

  const modules = ['order', 'customer', 'billing', 'stats', 'admin'];
  const statementFiles = modules.map((mod) => newFile(mod, mod, { mybatis: r() < 0.25 }));
  for (const sf of statementFiles) {
    for (let s = 0; s < 3 + Math.floor(r() * 5); s++) {
      const st = { id: `q${s}`, includes: [] };
      const expected = [];
      const unparsed = new Set();
      for (let k = 0; k < 1 + Math.floor(r() * 4); k++) {
        // MyBatis files: bare refids into other files are resolved too (with a warning)
        const pattern = pick(PATTERNS);
        const body = `${pattern}_${uid('c')} = 1`;
        if (pattern === 'QUALIFIED' || pattern === 'SPACED') {
          const t = newFile(pick(modules), uid('ns'));
          const id = uid('f');
          // half of the qualified targets include another fragment themselves (a nested chain)
          if (r() < 0.5) {
            const inner = newFile(pick(modules), uid('inner'));
            const innerId = uid('g');
            inner.fragments.push({ id: innerId, body: `INNER_${innerId} = 1` });
            t.fragments.push({ id, body, nested: `${inner.namespace}.${innerId}` });
            expected.push(`${t.namespace}.${id}`, `${inner.namespace}.${innerId}`);
          } else {
            t.fragments.push({ id, body });
            expected.push(`${t.namespace}.${id}`);
          }
          st.includes.push(pattern === 'SPACED' ? `  ${t.namespace}.${id} ` : `${t.namespace}.${id}`);
        } else if (pattern === 'SPLIT_NS') {
          if (sf.mybatis) { k--; continue; } // MyBatis: a namespace is one file
          const t = newFile(pick(modules), sf.namespace); // same namespace, another file / folder
          const id = uid('split');
          t.fragments.push({ id, body });
          st.includes.push(id);
          expected.push(`${sf.namespace}.${id}`);
        } else if (pattern === 'GLOBAL') {
          const t = newFile(pick(modules), uid('g'));
          const id = uid('uniq');
          t.fragments.push({ id, body });
          st.includes.push(id);
          expected.push(`${t.namespace}.${id}`);
        } else if (pattern === 'DOTTED') {
          const t = newFile(pick(modules), uid('emul'));
          const id = `${uid('grp')}.cols`;
          t.fragments.push({ id, body });
          st.includes.push(id);
          expected.push(`${t.namespace}.${id}`);
        } else if (pattern === 'SAME_COPIES') {
          const id = uid('same');
          const copies = Array.from({ length: 2 + Math.floor(r() * 3) }, () => newFile(pick(modules), uid('copy')));
          for (const c of copies) c.fragments.push({ id, body: `SAME_${id} = 1` });
          st.includes.push(id);
          expected.push(copies.map((c) => `${c.namespace}.${id}`).sort()[0]);
        } else if (pattern === 'NEAR_COPY') {
          const id = uid('near');
          const near = { rel: path.join(path.dirname(sf.rel), `Near_${n++}.xml`), namespace: uid('nearns'), mybatis: false, broken: false, lt: false, fragments: [{ id, body: `NEAR_${id} = 1` }], statements: [] };
          files.push(near);
          const far = { rel: path.join('zz', 'other', 'module', `Far_${n++}.xml`), namespace: uid('farns'), mybatis: false, broken: false, lt: false, fragments: [{ id, body: `FAR_${id} = 1` }], statements: [] };
          files.push(far);
          st.includes.push(id);
          expected.push(`${near.namespace}.${id}`);
        } else if (pattern === 'LT_FILE') {
          const t = newFile(pick(modules), uid('lt'), { lt: true });
          const id = uid('ltf');
          t.fragments.push({ id, body: `A_${id} < 10 AND B <= 3` });
          st.includes.push(`${t.namespace}.${id}`);
          expected.push(`${t.namespace}.${id}`);
        } else if (pattern === 'BROKEN_FILE') {
          const t = newFile(pick(modules), uid('broken'), { broken: true });
          const id = uid('bf');
          t.fragments.push({ id, body });
          st.includes.push(`${t.namespace}.${id}`);
          expected.push(`${t.namespace}.${id}`);
          unparsed.add(`${t.namespace}.${id}`);
        }
      }
      sf.statements.push(st);
      expectations.push({ qid: `${sf.namespace}.${st.id}`, expected, unparsed });
    }
  }

  // render
  const nsAttr = (ns) => (r() < 0.15 ? ` ${ns} ` : ns); // stray spaces around a namespace now and then
  for (const f of files) {
    const tag = f.mybatis ? 'mapper' : 'sqlMap';
    const lines = [`<?xml version="1.0" encoding="UTF-8"?>`, `<${tag} namespace="${nsAttr(f.namespace)}">`];
    for (const fr of f.fragments) {
      lines.push(`  <sql id="${fr.id}">${fr.body}${fr.nested ? ` AND <include refid="${fr.nested}"/>` : ''}</sql>`);
    }
    for (const st of f.statements) {
      lines.push(`  <select id="${st.id}">SELECT 1 FROM T_${st.id} WHERE 1 = 1`);
      for (const ref of st.includes) lines.push(`    AND <include refid="${ref}"/>`);
      lines.push('  </select>');
    }
    if (f.broken) lines.push('  <sql id="oops" <broken-tag>');
    lines.push(`</${tag}>`);
    const full = path.join(root, f.rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, lines.join('\n'));
  }
  return expectations;
}

test('refid torture: every pattern of writing and scattering refids resolves to the intended fragment', () => {
  const seeds = Number(process.env.TORTURE_SEEDS ?? 0) || (Number(process.env.FUZZ_SEEDS ?? 0) > 0 ? 200 : 40);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'refid-torture-'));
  const problems = [];
  let includes = 0;
  try {
    for (let seed = 1; seed <= seeds && problems.length < 8; seed++) {
      const dir = path.join(tmp, `t${seed}`);
      const expectations = generateTortureProject(seed, dir);
      const all = fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.xml'));
      for (const source of [new DirectorySource(dir), new UploadSource(all.map((f) => ({ sourceFile: f.split(path.sep).join('/'), source: fs.readFileSync(path.join(dir, f), 'utf8') })))]) {
        const how = source instanceof UploadSource ? 'upload' : 'path';
        const session = new ProjectSession(source).open();
        for (const { qid, expected, unparsed } of expectations) {
          const got = [];
          const flags = [];
          const walk = (tree) => {
            for (const node of tree) {
              got.push(node.qualifiedId ?? `NOT_FOUND(${node.refid})`);
              if (node.unparsed) flags.push(node.qualifiedId);
              walk(node.children ?? []);
            }
          };
          walk(session.includeTree(qid));
          includes += expected.length;
          if (JSON.stringify(got) !== JSON.stringify(expected)) problems.push({ seed, how, qid, got, expected });
          for (const u of unparsed) if (!flags.includes(u)) problems.push({ seed, how, qid, kind: 'unparsed flag missing', fragment: u });
        }
        const missing = session.summary().errors.filter((e) => e.code === 'MISSING_REFERENCE');
        if (missing.length) problems.push({ seed, how, kind: 'MISSING_REFERENCE reported', messages: missing.map((e) => e.message).slice(0, 3) });
        session.close();
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  assert.deepEqual(problems, []);
  assert.ok(includes > 1000, `${includes} includes checked`);
});
