import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateProject } from './projectGen.js';
import { renderIbatis, RenderError } from './runtimes.js';
import { rng } from './sqlGrammar.js';
import { scanProject } from '../../src/application/ProjectLoader.js';
import { AnalyzerPipeline } from '../../src/application/AnalyzerPipeline.js';
import { flattenToSql } from '../../src/analyzer/sql/SqlFlattener.js';
import { parseXml } from '../../src/parser/xml/XmlParser.js';
import { migrateProject, parseArgs } from '../../src/interfaces/cli/migrate.js';

// Whole generated legacy projects (test/fuzz/projectGen.js): deep folders, build copies,
// config noise, EUC-KR files, and <include refid> chains across files and namespaces in
// all three iBATIS styles (qualified, global bare ids, mixed). Per project:
//   - the folder scan finds exactly the mappers
//   - every statement's expanded SQL has its fragments in the right order
//   - only the deliberate missing / ambiguous / circular references are diagnosed
//   - in the MyBatis output every <include> resolves by MyBatis' own rule, expands to the
//     same fragments, and renders the same SQL as iBATIS for random parameters
//   - the CLI writes one converted file per mapper
// Bigger runs: FUZZ_PROJECTS=200 node --test test/fuzz/projectCorpus.test.js
const PROJECTS = Number(process.env.FUZZ_PROJECTS ?? 20);

/** MyBatis resolves a refid without a dot in the STATEMENT's namespace, nested includes too */
const mybatisRefid = (refid, statementNamespace) => (refid.includes('.') ? refid : `${statementNamespace}.${refid}`);

function mybatisDocuments(generatedMapperXml) {
  const fragments = new Map();
  const statements = new Map();
  for (const [file, xml] of generatedMapperXml) {
    const root = parseXml(xml, file).root;
    assert.ok(root, `${file}: generated MyBatis XML must parse`);
    const ns = root.attr('namespace');
    for (const el of root.elementChildren()) {
      if (el.name === 'sql') fragments.set(`${ns}.${el.attr('id')}`, el);
      if (['select', 'insert', 'update', 'delete'].includes(el.name)) statements.set(`${ns}.${el.attr('id')}`, { el, ns });
    }
  }
  return { fragments, statements };
}

/** markers (and text) of a MyBatis statement, includes expanded by MyBatis' rule */
function renderMybatis(el, ns, fragments, params, stack = []) {
  let sql = '';
  const markers = [];
  for (const child of el.children ?? []) {
    if (child.kind === 'text') {
      sql += child.text.replace(/#\{[^}]*\}/g, '?');
      markers.push(...[...child.text.matchAll(/\/\*F:([^*]+)\*\//g)].map((m) => m[1]));
    } else if (child.name === 'include') {
      const id = mybatisRefid(child.attr('refid'), ns);
      const target = fragments.get(id);
      if (!target && /noSuchFragment/.test(id)) continue; // the generator's deliberate missing refid
      if (!target) throw new Error(`unresolvable refid "${child.attr('refid')}" in ${ns}`);
      if (stack.includes(id)) throw new Error('CYCLE');
      const inner = renderMybatis(target, ns, fragments, params, [...stack, id]);
      sql += inner.sql;
      markers.push(...inner.markers);
    } else if (child.name === 'if') {
      const m = /^(\w+) != null and \1 != ''$/.exec(child.attr('test'));
      const inner = renderMybatis(child, ns, fragments, params, stack);
      markers.push(...inner.markers);
      if (params && m && params[m[1]] != null && params[m[1]] !== '') sql += inner.sql;
    } else if (child.name === 'trim') {
      const inner = renderMybatis(child, ns, fragments, params, stack);
      markers.push(...inner.markers);
      const body = inner.sql.trim();
      const strip = (child.attr('prefixOverrides') ?? '').split('|').filter(Boolean).find((o) => body.toUpperCase().startsWith(o.toUpperCase()));
      sql += ` ${strip ? body.slice(strip.length) : body} `;
    } else {
      const inner = renderMybatis(child, ns, fragments, params, stack);
      sql += inner.sql;
      markers.push(...inner.markers);
    }
  }
  return { sql, markers };
}

const normalize = (s) => s.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();

test(`generated legacy projects: scan, refid chains, diagnostics, MyBatis output (${PROJECTS} projects)`, () => {
  const problems = [];
  for (let seed = 1; seed <= PROJECTS && problems.length < 5; seed++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `corpus${seed}-`));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), `corpus-out${seed}-`));
    try {
      const truth = generateProject(seed, dir);
      const scan = scanProject(dir);
      if (JSON.stringify(scan.mappers.map((m) => m.sourceFile).sort()) !== JSON.stringify(truth.mappers)) problems.push({ seed, kind: 'scan' });

      const result = new AnalyzerPipeline().run(scan.mappers);
      const nestedWarned = result.diagnostics.warnings.some((w) => /NESTED_REFID/.test(w.code));
      for (const e of result.diagnostics.errors) {
        const deliberate = /noSuchFragment/.test(e.message)
          || truth.expectedAmbiguous.some((id) => e.message.includes(`"${id}" is ambiguous`))
          || (e.code === 'CIRCULAR_REFERENCE' && (truth.expectedCircular.length || nestedWarned));
        if (!deliberate) problems.push({ seed, kind: 'diagnostic', message: e.message });
      }
      for (const id of truth.expectedAmbiguous) {
        if (!result.diagnostics.errors.some((e) => e.message.includes(`"${id}" is ambiguous`))) problems.push({ seed, kind: 'ambiguity not reported', id });
      }

      const expanded = new Map();
      for (const st of truth.statements) {
        const markers = [...flattenToSql(result.resolvedStatements.get(st.qualifiedId).resolvedTree).matchAll(/\/\*F:([^*]+)\*\//g)].map((m) => m[1]);
        expanded.set(st.qualifiedId, markers);
        if (JSON.stringify(markers) !== JSON.stringify(st.markers)) problems.push({ seed, kind: 'expansion', id: st.qualifiedId, got: markers, expected: st.markers });
      }

      const { fragments, statements } = mybatisDocuments(result.generatedMapperXml);
      const perIncluder = new Set([...result.fragmentConversions].filter(([, c]) => c.events.some((e) => e.code === 'REFID_DEPENDS_ON_INCLUDER')).map(([q]) => q));
      const ibatisFragments = new Map();
      for (const { sqlMap } of result.parsedMappers) for (const f of sqlMap?.sqlFragments ?? []) ibatisFragments.set(`${sqlMap.namespace}.${f.id}`, f);
      const byLocal = new Map();
      for (const q of ibatisFragments.keys()) { const id = q.split('.').pop(); byLocal.set(id, [...(byLocal.get(id) ?? []), q]); }
      const ibatisLookup = (refid, ns) => ibatisFragments.get(refid) ?? ibatisFragments.get(`${ns}.${refid}`)
        ?? (byLocal.get(refid)?.length === 1 ? ibatisFragments.get(byLocal.get(refid)[0]) : null);

      for (const { sqlMap } of result.parsedMappers) {
        for (const statement of sqlMap?.statements ?? []) {
          const qid = `${sqlMap.namespace}.${statement.id}`;
          const expected = expanded.get(qid) ?? [];
          if (truth.expectedCircular.includes(qid) || statement.id === 'usesDuplicate' || expected.some((m) => perIncluder.has(m))) continue;
          const { el, ns } = statements.get(qid);
          let mybatis;
          try {
            mybatis = renderMybatis(el, ns, fragments, null);
          } catch (e) {
            if (e.message === 'CYCLE') continue;
            problems.push({ seed, kind: 'mybatis include', id: qid, message: e.message });
            continue;
          }
          if (JSON.stringify(mybatis.markers) !== JSON.stringify(expected)) problems.push({ seed, kind: 'mybatis expansion', id: qid, got: mybatis.markers, expected });
          for (let k = 0; k < 3; k++) {
            const r = rng(seed * 1000 + k);
            const params = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`p${i}`, r() < 0.5 ? 'v' : null]));
            let ibatisSql;
            try {
              // iBATIS fails the statement when an include resolves to nothing: nothing to compare then
              ibatisSql = renderIbatis(statement, params, (refid, at) => {
                const found = ibatisLookup(refid, at);
                if (!found) throw new RenderError(`no fragment ${refid} in ${at}`);
                return found;
              }, sqlMap.namespace).sql;
            } catch (e) {
              if (e instanceof RenderError) continue;
              throw e;
            }
            const mybatisSql = renderMybatis(el, ns, fragments, params).sql;
            if (normalize(ibatisSql) !== normalize(mybatisSql)) {
              problems.push({ seed, kind: 'runtime', id: qid, ibatis: normalize(ibatisSql), mybatis: normalize(mybatisSql) });
              break;
            }
          }
        }
      }

      const report = migrateProject(parseArgs([dir, '--out', out]));
      // generated projects also hold an already-MyBatis mapper: read too now, but not one of the truth's iBATIS mappers
      if (report.totals.mappers - report.totals.mybatisMappers !== truth.mappers.length) problems.push({ seed, kind: 'cli' });
      for (const m of truth.mappers) if (!fs.existsSync(path.join(out, 'mybatis', m))) problems.push({ seed, kind: 'cli output', file: m });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(out, { recursive: true, force: true });
    }
  }
  assert.deepEqual(problems, []);
});

test('hard folder layouts: deep trees, out/bin/build/classes packages, WEB-INF/classes only, a symlinked module — every mapper found, every refid chain exact', async () => {
  const { ProjectSession, DirectorySource, UploadSource } = await import('../../src/application/ProjectSession.js');
  const { isInIgnoredDirectory } = await import('../../src/application/mapperDetection.js');
  const seeds = Number(process.env.FUZZ_SEEDS ?? 0) > 0 ? 40 : 12;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hard-corpus-'));
  const problems = [];
  let chains = 0;
  let deepest = 0;
  try {
    for (let seed = 1; seed <= seeds; seed++) {
      const dir = path.join(tmp, `h${seed}`);
      const truth = generateProject(seed, dir, { hard: true });
      deepest = Math.max(deepest, truth.maxDirDepth);
      // the same project opened by path, and uploaded with every mapper XML (build copies too)
      const all = fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.xml') && !isInIgnoredDirectory(f));
      const sources = [
        new DirectorySource(dir),
        new UploadSource(all.map((f) => ({ sourceFile: f.split(path.sep).join('/'), source: fs.readFileSync(path.join(dir, f), 'latin1') }))),
      ];
      for (const source of sources) {
        const how = source instanceof UploadSource ? 'upload' : 'path';
        const session = new ProjectSession(source).open();
        const found = new Set(session.files.filter((f) => f.syntax === 'ibatis').map((f) => f.sourceFile));
        for (const m of truth.mappers) if (!found.has(m)) problems.push({ seed, how, kind: 'mapper-not-found', m });
        if (found.size !== truth.mappers.length) problems.push({ seed, how, kind: 'mapper-count', found: found.size, expected: truth.mappers.length });
        for (const st of truth.statements) {
          const flat = [];
          const walk = (t) => { for (const n of t) { if (n.qualifiedId) flat.push(n.qualifiedId); walk(n.children ?? []); } };
          walk(session.includeTree(st.qualifiedId));
          chains++;
          if (JSON.stringify(flat) !== JSON.stringify(st.markers)) problems.push({ seed, how, kind: 'refid-chain', id: st.qualifiedId, got: flat, expected: st.markers });
        }
        session.close();
      }
      fs.rmSync(truth.extraDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  assert.ok(deepest >= 20, `trees go ${deepest} folders deep`);
  assert.ok(chains > 500, `${chains} refid chains checked`);
  assert.deepEqual(problems.slice(0, 5), []);
});
