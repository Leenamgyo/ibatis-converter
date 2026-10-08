/**
 * Generates whole legacy iBATIS projects on disk — deep directory trees,
 * many mappers, cross-file / cross-namespace <include refid> chains,
 * resultMap extends chains, and the noise a real project has around its
 * mappers — together with the ground truth a test can check them against.
 *
 * Every <sql> fragment's text carries a unique marker comment
 * (`/*F:<qualified id>*\/`), so the order of markers in a statement's
 * fully-expanded SQL proves the include chain was followed correctly.
 *
 * Refid styles (per project), matching how iBATIS 2 resolves includes:
 *  - QUALIFIED  useStatementNamespaces=true: other mappers' fragments are
 *               referenced as `namespace.id`, own ones as bare `id`
 *  - GLOBAL     useStatementNamespaces=false (the iBATIS default): every
 *               fragment id is global, referenced bare from any file
 *  - MIXED      both
 */
import fs from 'node:fs';
import path from 'node:path';
import { rng } from './sqlGrammar.js';

/** EUC-KR bytes for a few Korean words (no EUC-KR encoder ships with Node). */
const EUCKR = {
  고객: [0xb0, 0xed, 0xb0, 0xb4],
  주문: [0xc1, 0xd6, 0xb9, 0xae],
  조회: [0xc1, 0xb6, 0xc8, 0xb8],
  사용: [0xbb, 0xe7, 0xbf, 0xeb],
};

const LAYOUTS = [
  (mod, sub) => ['src', 'main', 'resources', 'sqlmap', mod, ...sub],
  (mod, sub) => ['src', 'main', 'java', 'com', 'acme', 'legacy', mod, 'dao', 'sqlmap', ...sub],
  (mod, sub) => ['WebContent', 'WEB-INF', 'sql', mod, ...sub],
  (mod, sub) => ['modules', `${mod}-core`, 'src', 'main', 'resources', 'kr', 'co', 'acme', mod, 'persistence', 'ibatis', ...sub],
];

/**
 * hard: real mapper folders a name filter would wrongly drop — package segments named
 * out / bin / build / dist / classes / target at any depth, a WEB-INF/classes-only
 * legacy layout, trees 20+ levels deep, one module behind a symlinked folder — with
 * the usual build copies around them. Each file picks its own layout.
 */
const HARD_LAYOUTS = [
  (mod, sub) => ['src', 'main', 'java', 'com', 'acme', 'erp', 'out', mod, 'bin', 'dao', 'build', 'persistence', 'dist', 'classes', 'sqlmap', ...sub],
  (mod, sub) => ['WebContent', 'WEB-INF', 'classes', 'sqlmap', mod, ...sub],
  (mod, sub) => ['modules', `${mod}-api`, 'src', 'main', 'resources', 'kr', 'co', 'acme', 'target', mod, 'out', 'inbound', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'mapper', ...sub],
  (mod, sub) => ['apps', 'legacy', 'build', 'scripts', 'sql', mod, 'bin', ...sub],
];

export function generateProject(seed, rootDir, { hard = false } = {}) {
  const r = rng(seed * 104729 + 7);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const chance = (p) => r() < p;
  const style = pick(['QUALIFIED', 'GLOBAL', 'MIXED']);
  const projectLayout = pick(LAYOUTS);
  const layoutFor = () => (hard ? pick(HARD_LAYOUTS) : projectLayout);
  const linkedModule = hard ? 'customer' : null; // in hard mode, this module's files sit behind a symlink
  const longNamespaces = chance(0.5);
  const modules = ['order', 'customer', 'product', 'billing', 'stats', 'common', 'admin', 'batch'].slice(0, 3 + Math.floor(r() * 6));

  const files = []; // { rel, namespace, fragments: [{ id, children: [refs] }], statements: [...], resultMaps, encoding }
  let fragCounter = 0;
  const allFragments = []; // { qid, id, file }

  // ---- mapper files ----
  const fileCount = 4 + Math.floor(r() * 14);
  for (let f = 0; f < fileCount; f++) {
    const mod = modules[f % modules.length];
    const sub = Array.from({ length: Math.floor(r() * (hard ? 9 : 4)) }, (_, k) => pick(['impl', 'v2', 'legacy', 'read', 'write', 'ext', 'tmp', ...(hard ? ['out', 'bin', 'build', 'dist'] : [])]) + (k ? k : ''));
    const name = `${mod[0].toUpperCase()}${mod.slice(1)}${f}_SQL.xml`;
    const rel = mod === linkedModule
      ? path.join('linked', `${mod}-shared`, ...sub, name) // reached through a symlinked folder
      : path.join(...layoutFor()(mod, sub), name);
    const namespace = longNamespaces ? `kr.co.acme.${mod}.${name.replace('_SQL.xml', '')}Mapper` : `${mod}${f}`;
    const file = { rel, namespace, fragments: [], statements: [], resultMaps: [], encoding: chance(0.2) ? 'EUC-KR' : 'UTF-8' };
    const nFrag = Math.floor(r() * 4);
    for (let k = 0; k < nFrag; k++) {
      const id = style === 'QUALIFIED' ? `frag${k}` : `frag${++fragCounter}`; // GLOBAL ids must be unique project-wide
      const fragment = { id, qid: `${namespace}.${id}`, file, refs: [] };
      file.fragments.push(fragment);
      allFragments.push(fragment);
    }
    files.push(file);
  }

  /** how `from` (in fromFile) writes a reference to fragment `to` */
  const refidFor = (fromFile, to) => {
    if (to.file === fromFile) return chance(0.2) ? to.qid : to.id;
    if (style === 'QUALIFIED') return to.qid;
    if (style === 'GLOBAL') return to.id;
    return chance(0.5) ? to.qid : to.id;
  };

  // fragment -> fragment edges only point "backwards" (lower index), so chains are acyclic
  allFragments.forEach((fragment, i) => {
    if (i === 0) return;
    for (let k = 0, n = chance(0.6) ? 1 + Math.floor(r() * 2) : 0; k < n; k++) {
      const target = allFragments[Math.floor(r() * i)];
      fragment.refs.push({ target, refid: refidFor(fragment.file, target), wrapped: chance(0.3) });
    }
  });

  // the same bare fragment id defined in several mappers (a common fragment copied into modules)
  const expectedAmbiguous = [];
  const expectedDuplicates = []; // { id, chosen, rule }
  const extraFile = (rel, namespace) => {
    const file = { rel, namespace, fragments: [], statements: [], resultMaps: [], encoding: 'UTF-8' };
    files.push(file);
    return file;
  };
  if (style !== 'QUALIFIED' && files.length >= 3) {
    const c = files[0];
    if (chance(0.5)) {
      // different SQL: the copy in the includer's own folder wins
      const id = `dup${seed}`;
      const near = extraFile(path.join(path.dirname(c.rel), `DupNear${seed}_SQL.xml`), `dupnear${seed}`);
      const far = extraFile(path.join('zz-far', 'elsewhere', `DupFar${seed}_SQL.xml`), `dupfar${seed}`);
      const nearFragment = { id, qid: `${near.namespace}.${id}`, file: near, refs: [] };
      near.fragments.push(nearFragment);
      far.fragments.push({ id, qid: `${far.namespace}.${id}`, file: far, refs: [] });
      c.statements.push({ id: 'usesNearDuplicate', refs: [{ target: nearFragment, refid: id }], column: 'S_DUPN' });
      expectedDuplicates.push({ id, chosen: nearFragment.qid, rule: 'REFID_NEAREST_DUPLICATE' });
    }
    if (chance(0.5)) {
      // the same SQL copied into two modules: one fragment
      const id = `same${seed}`;
      const a = extraFile(path.join('zz-mod-a', 'sql', `SameA${seed}_SQL.xml`), `samea${seed}`);
      const b = extraFile(path.join('zz-mod-b', 'sql', `SameB${seed}_SQL.xml`), `sameb${seed}`);
      const first = { id, qid: `${a.namespace}.${id}`, file: a, refs: [], text: `/*F:${a.namespace}.${id}*/ AND F_${id} = 1` };
      a.fragments.push(first);
      b.fragments.push({ id, qid: `${b.namespace}.${id}`, file: b, refs: [], text: first.text });
      c.statements.push({ id: 'usesSameDuplicate', refs: [{ target: first, refid: id }], column: 'S_DUPS' });
      expectedDuplicates.push({ id, chosen: first.qid, rule: 'REFID_DUPLICATE_SAME' });
    }
    if (chance(0.4)) {
      // different SQL, equally far from the includer: genuinely ambiguous, never guessed
      const id = `tie${seed}`;
      const a = extraFile(path.join('zz-tie', `TieA${seed}_SQL.xml`), `tiea${seed}`);
      const b = extraFile(path.join('zz-tie', `TieB${seed}_SQL.xml`), `tieb${seed}`);
      a.fragments.push({ id, qid: `${a.namespace}.${id}`, file: a, refs: [] });
      b.fragments.push({ id, qid: `${b.namespace}.${id}`, file: b, refs: [] });
      c.statements.push({ id: 'usesTie', refs: [{ missing: true, refid: id }], column: 'S_TIE' });
      expectedAmbiguous.push(id);
    }
  }
  const expectedMissing = [];
  const expectedCircular = [];
  if (allFragments.length && chance(0.4)) {
    const host = pick(allFragments);
    host.refs.push({ missing: true, refid: `${host.file.namespace}.noSuchFragment${seed}` });
    expectedMissing.push(host.qid);
  }

  // statements
  let markerColumn = 0;
  for (const file of files) {
    const n = 1 + Math.floor(r() * 5);
    for (let k = 0; k < n; k++) {
      const refs = [];
      for (let j = 0, m = allFragments.length ? Math.floor(r() * 4) : 0; j < m; j++) {
        const target = pick(allFragments);
        refs.push({ target, refid: refidFor(file, target), wrapped: chance(0.4) });
      }
      file.statements.push({ id: `stmt${k}`, refs, column: `S_${++markerColumn}` });
    }
  }
  if (files.length >= 2 && chance(0.3)) {
    // a circular pair in a dedicated pair of fragments, used by one statement
    const [a, b] = [files[0], files[1]];
    const fa = { id: `cycA${seed}`, qid: `${a.namespace}.cycA${seed}`, file: a, refs: [] };
    const fb = { id: `cycB${seed}`, qid: `${b.namespace}.cycB${seed}`, file: b, refs: [] };
    fa.refs.push({ target: fb, refid: fb.qid });
    fb.refs.push({ target: fa, refid: fa.qid });
    a.fragments.push(fa);
    b.fragments.push(fb);
    a.statements.push({ id: 'usesCycle', refs: [{ target: fa, refid: fa.id }], column: `S_${++markerColumn}` });
    expectedCircular.push(`${a.namespace}.usesCycle`);
  }

  // resultMap extends chains across files
  const resultMaps = [];
  for (const file of files) {
    if (!chance(0.5)) continue;
    const rm = { id: `rm${resultMaps.length}`, file, parent: resultMaps.length && chance(0.7) ? pick(resultMaps) : null };
    rm.extendsRef = rm.parent ? (rm.parent.file === file ? rm.parent.id : (style === 'GLOBAL' ? rm.parent.id : `${rm.parent.file.namespace}.${rm.parent.id}`)) : null;
    file.resultMaps.push(rm);
    resultMaps.push(rm);
  }

  // ---- render ----
  const renderRef = (ref, indent) => {
    const include = `${indent}<include refid="${ref.refid}"/>`;
    if (!ref.wrapped) return include;
    return `${indent}<isNotEmpty property="p${Math.floor(r() * 5)}" prepend="AND">\n${include}\n${indent}</isNotEmpty>`;
  };
  const korean = (word, file) => (file.encoding === 'EUC-KR' ? `\u0000K${word}\u0000` : word);
  const renderFile = (file) => {
    const lines = [
      `<?xml version="1.0" encoding="${file.encoding}"?>`,
      '<!DOCTYPE sqlMap PUBLIC "-//ibatis.apache.org//DTD SQL Map 2.0//EN" "http://ibatis.apache.org/dtd/sql-map-2.dtd">',
      `<!-- ${korean('주문', file)} ${korean('조회', file)} mapper -->`,
      `<sqlMap namespace="${file.namespace}">`,
    ];
    for (const rm of file.resultMaps) {
      lines.push(`  <resultMap id="${rm.id}" class="java.util.HashMap"${rm.extendsRef ? ` extends="${rm.extendsRef}"` : ''}>`, `    <result property="c${rm.id}" column="C_${rm.id.toUpperCase()}"/>`, '  </resultMap>');
    }
    for (const fragment of file.fragments) {
      lines.push(`  <sql id="${fragment.id}">`, `    ${fragment.text ?? `/*F:${fragment.qid}*/ AND F_${fragment.id} = 1`}`);
      for (const ref of fragment.refs) lines.push(renderRef(ref, '    '));
      lines.push('  </sql>');
    }
    for (const st of file.statements) {
      const rm = file.resultMaps[0];
      lines.push(`  <select id="${st.id}" parameterClass="map" ${rm ? `resultMap="${rm.id}"` : 'resultClass="java.util.HashMap"'}>`,
        `    SELECT ${st.column} /* ${korean('고객', file)} */ FROM T_${st.column} WHERE 1 = 1`);
      for (const ref of st.refs) lines.push(renderRef(ref, '    '));
      lines.push(`    AND USE_YN = '${korean('사용', file)}'`, '  </select>');
    }
    lines.push('</sqlMap>', '');
    const text = lines.join('\n');
    if (file.encoding !== 'EUC-KR') return Buffer.from(text, 'utf8');
    // assemble EUC-KR: ASCII as is, marked Korean words from the table
    const out = [];
    for (const part of text.split(/\u0000K|\u0000/)) {
      if (EUCKR[part]) out.push(...EUCKR[part]);
      else out.push(...Buffer.from(part, 'latin1'));
    }
    return Buffer.from(out);
  };

  // hard mode: `linked/` is a symlink to a folder OUTSIDE the project (a shared checkout)
  const linkedTarget = `${rootDir}-linked-src`;
  if (hard) {
    fs.mkdirSync(linkedTarget, { recursive: true });
    fs.mkdirSync(rootDir, { recursive: true });
    fs.symlinkSync(linkedTarget, path.join(rootDir, 'linked'), 'dir');
  }
  const write = (rel, bytes) => {
    const full = path.join(rootDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, bytes);
  };
  for (const file of files) write(file.rel, renderFile(file));

  // noise: build copies (must be skipped), config files, a converted mapper, unrelated XML
  const first = files[0];
  write(path.join('target', 'classes', 'sqlmap', path.basename(first.rel)), renderFile(first));
  write(path.join('build', 'resources', 'main', path.basename(first.rel)), renderFile(first));
  write(path.join('bin', path.basename(first.rel)), renderFile(first));
  write('pom.xml', '<?xml version="1.0"?><project><artifactId>p</artifactId></project>\n');
  write(path.join(path.dirname(first.rel), 'sqlMapConfig.xml'), `<?xml version="1.0"?>\n<!DOCTYPE sqlMapConfig PUBLIC "x" "y">\n<sqlMapConfig><settings useStatementNamespaces="${style !== 'GLOBAL'}"/>${files.map((f) => `<sqlMap resource="${f.rel}"/>`).join('')}</sqlMapConfig>\n`);
  write(path.join('src', 'main', 'resources', 'mybatis', 'Done.xml'), '<?xml version="1.0"?><mapper namespace="done"><select id="x">SELECT 1</select></mapper>\n');
  write(path.join('src', 'main', 'resources', 'log4j.xml'), '<?xml version="1.0"?><log4j:configuration xmlns:log4j="x"/>\n');

  // ---- ground truth ----
  const byQid = new Map(allFragments.map((f) => [f.qid, f]));
  for (const file of files) for (const f of file.fragments) byQid.set(f.qid, f);
  /**
   * How a refid string resolves, the way iBATIS / MyBatis do at runtime: a qualified id,
   * else the INCLUDING STATEMENT's namespace, else a project-wide unique bare id; when the
   * runtime finds nothing, the tool falls back to the fragment's own namespace.
   */
  const allQids = new Map();
  for (const file of files) for (const f of file.fragments) allQids.set(f.qid, f);
  const byLocal = new Map();
  for (const f of allQids.values()) byLocal.set(f.id, [...(byLocal.get(f.id) ?? []), f]);
  // several fragments of one id: identical text -> the first by qualified id; else the one sharing
  // the most folders with the referencing file; a tie -> unresolved (an independent statement of
  // the tool's policy, so the corpus checks it rather than mirrors it)
  const posix = (p) => p.split(path.sep).join('/');
  const sharedFolders = (x, y) => {
    const a = posix(x).split('/').slice(0, -1);
    const b = posix(y).split('/').slice(0, -1);
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  };
  const textOf = (f) => f.text ?? `/*F:${f.qid}*/ AND F_${f.id} = 1|${f.refs.map((r) => r.refid).join(',')}`;
  const pickDuplicate = (refid, fromFile) => {
    const candidates = [...(byLocal.get(refid) ?? [])].sort((x, y) => x.qid.localeCompare(y.qid));
    if (candidates.length === 1) return candidates[0];
    if (candidates.length < 2) return null;
    if (candidates.every((f) => textOf(f) === textOf(candidates[0]) && !f.refs.length)) return candidates[0];
    const best = Math.max(...candidates.map((f) => sharedFolders(fromFile, f.file.rel)));
    const nearest = candidates.filter((f) => sharedFolders(fromFile, f.file.rel) === best);
    return nearest.length === 1 ? nearest[0] : null;
  };
  const lookup = (refid, ns, fromFile) => allQids.get(refid) ?? allQids.get(`${ns}.${refid}`) ?? pickDuplicate(refid, fromFile);
  const resolveRef = (refid, lexicalNs, rootNs, fromFile) => lookup(refid, rootNs, fromFile) ?? lookup(refid, lexicalNs, fromFile);
  /** markers in the order the fully expanded SQL must contain them */
  const expand = (refs, lexicalNs, rootNs, stack, fromFile) => refs.flatMap((ref) => {
    const target = resolveRef(ref.refid, lexicalNs, rootNs, fromFile);
    if (!target || stack.includes(target.qid)) return [];
    return [target.qid, ...expand(target.refs, target.file.namespace, rootNs, [...stack, target.qid], target.file.rel)];
  });
  const statements = files.flatMap((file) => file.statements.map((st) => ({
    qualifiedId: `${file.namespace}.${st.id}`,
    file: file.rel.split(path.sep).join('/'),
    markers: expand(st.refs, file.namespace, file.namespace, [], file.rel),
    circular: expectedCircular.includes(`${file.namespace}.${st.id}`),
  })));
  const depthOf = (refs, stack = []) => Math.max(0, ...refs.filter((x) => x.target && !stack.includes(x.target.qid)).map((x) => 1 + depthOf(x.target.refs, [...stack, x.target.qid])));
  return {
    seed,
    style,
    /** a folder outside rootDir to delete too (hard mode's symlink target), or null */
    extraDir: hard ? linkedTarget : null,
    mappers: files.map((f) => f.rel.split(path.sep).join('/')).sort(),
    statements,
    fragments: allFragments.map((f) => f.qid),
    expectedMissing,
    expectedCircular,
    expectedAmbiguous,
    expectedDuplicates,
    maxDirDepth: Math.max(...files.map((f) => f.rel.split(path.sep).length - 1)),
    maxIncludeDepth: Math.max(0, ...files.flatMap((f) => f.statements.map((s) => depthOf(s.refs)))),
    resultMapChains: resultMaps.map((rm) => {
      const chain = [];
      for (let x = rm; x; x = x.parent) chain.push(`${x.file.namespace}.${x.id}`);
      return chain;
    }),
  };
}
