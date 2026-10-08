'use strict';

/* ------------------------------------------------------------------ *
 * Sample project                                                       *
 *                                                                      *
 * The "Load sample" project is real mapper files under `public/samples/`
 * (one per scenario: basic CRUD, dynamic SQL, joins, subqueries,        *
 * UNION/CTE, refid, resultMap, a legacy report query, and the           *
 * degrade-loudly edge cases), fetched at click time instead of being    *
 * inlined here - the same files the sample-project test analyzes, so a  *
 * scenario can't drift between what the UI demos and what CI checks.    *
 * ------------------------------------------------------------------ */

/** The two demo projects: each has a manifest of mapper files and a matching schema-mapping dataset. */
const SAMPLE_SETS = {
  basic: { dir: 'samples/', datasetId: 'sample-schema-v2', datasetName: '샘플 → 신규 스키마 v2', description: 'Load sample 프로젝트용 예시 매핑' },
  advanced: { dir: 'samples/advanced/', datasetId: 'advanced-schema', datasetName: 'advanced → 신규 스키마', description: 'Load advanced 프로젝트(2000줄 리포트 + 고급 문법)용 매핑' },
};

async function loadSampleProject(kind = 'basic') {
  const { dir } = SAMPLE_SETS[kind];
  const manifest = await fetch(`${dir}manifest.json`).then((r) => r.json());
  const entries = await Promise.all(manifest.files.map(async (name) => [
    name,
    await fetch(`${dir}${name}`).then((r) => r.text()),
  ]));
  state.sampleKind = kind;
  setFiles(new Map(entries));
}

/* ------------------------------------------------------------------ *
 * State                                                                *
 * ------------------------------------------------------------------ */
const state = {
  // picked files' text, only until they are uploaded (then dropped: the server reads them from disk)
  pendingFiles: new Map(),
  projectId: null,
  // the project index (GET /projects/:id): files, statement / fragment ids, include usage — no text
  index: null,
  statementFile: new Map(), // qualifiedId -> sourceFile
  statementMeta: new Map(), // qualifiedId -> index entry ({ type, line, parameterClass, ... })
  // a few recently opened statements (analysis + XML slices); older ones are dropped
  docs: new Map(),
  activeView: 'lineage',
  sampleKind: null, // 'basic' | 'advanced' when a demo project is loaded (picks its sample dataset)
  currentOriginal: null, // { text, localId } for the statement currently shown in the diff panes
};

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
};

async function api(path, opts) {
  const url = new URL(path, window.location.origin);
  if (state.projectId && !url.searchParams.has('projectId')) url.searchParams.set('projectId', state.projectId);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const error = new Error(`${res.status} ${res.statusText} for ${path}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

/* ------------------------------------------------------------------ *
 * File input / sample loading                                         *
 * ------------------------------------------------------------------ */
const fileInput = document.getElementById('fileInput');
const analyzeBtn = document.getElementById('analyzeBtn');
const fileCount = document.getElementById('fileCount');

const DOC_CACHE = 24;
const LARGE_TREE = 1500; // statements; above this the tree opens folded

/**
 * One statement's analysis and XML (its own element, its fragments', its
 * resultMap chain), fetched when it is opened. Kept in a small LRU so going
 * back and forth is instant, but a project is never held whole.
 */
async function loadStatement(qualifiedId) {
  const cached = state.docs.get(qualifiedId);
  if (cached) {
    state.docs.delete(qualifiedId);
    state.docs.set(qualifiedId, cached);
    return cached;
  }
  const projectId = state.projectId;
  const id = encodeURIComponent(qualifiedId);
  const [analysis, xml] = await Promise.all([api(`/api/v1/statements/${id}`), api(`/api/v1/statements/${id}/xml`)]);
  const doc = { analysis, ...xml };
  if (projectId !== state.projectId) return doc; // another project was opened meanwhile
  state.docs.set(qualifiedId, doc);
  while (state.docs.size > DOC_CACHE) state.docs.delete(state.docs.keys().next().value);
  return doc;
}

/** an XML slice from the server, parsed as the child of a <sqlMap> of its namespace */
function parseSlice(xml, namespace) {
  const attr = namespace ? ` namespace="${namespace.replace(/[&"<]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;' })[c])}"` : '';
  return parseMapperSource(`<sqlMap${attr}>${xml}</sqlMap>`)?.sqlMapEl.firstElementChild ?? null;
}

/** the fragments a loaded statement includes, as elements keyed by qualified id */
function fragmentElements(doc) {
  const map = new Map();
  for (const [qualifiedId, fragment] of Object.entries(doc?.fragments ?? {})) {
    const element = parseSlice(fragment.xml, fragment.namespace);
    if (element) map.set(qualifiedId, element);
  }
  return map;
}

/**
 * The server closes idle projects (30 min) and forgets them on restart. A
 * folder opened by path is reopened in place; an upload has to be picked
 * again — the browser deliberately kept no copy of it.
 */
async function reopenProject() {
  if (!state.openedPath) return false;
  const res = await fetch('/api/v1/projects/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: state.openedPath }),
  });
  if (!res.ok) return false;
  const index = await res.json();
  state.projectId = index.projectId;
  state.index = index;
  state.docs = new Map();
  invalidateSchemaResult();
  return true;
}

/** Closes the open project on the server (its caches and any uploaded copy go with it). */
function closeProject() {
  if (!state.projectId) return;
  fetch(`/api/v1/projects/${state.projectId}`, { method: 'DELETE', keepalive: true }).catch(() => {});
  state.projectId = null;
}
window.addEventListener('pagehide', closeProject);

function setFiles(map) {
  state.pendingFiles = map;
  fileCount.textContent = map.size ? `${map.size} file${map.size === 1 ? '' : 's'} ready` : '';
  analyzeBtn.disabled = map.size === 0;
}

fileInput.addEventListener('change', async () => {
  const map = new Map();
  const { decodeXml } = await import('/shared/mapperDetection.js');
  for (const file of fileInput.files) {
    map.set(file.name, decodeXml(new Uint8Array(await file.arrayBuffer())).text);
  }
  state.sampleKind = null;
  setFiles(map);
});

/**
 * A whole project folder: keep only iBATIS mappers (root <sqlMap>), skip
 * build output (target/, build/, node_modules/ ...: Maven's target/classes
 * holds a copy of every mapper) and decode EUC-KR / MS949 when declared —
 * with the same code the CLI uses (src/application/mapperDetection.js).
 */
const folderInput = document.getElementById('folderInput');
folderInput.addEventListener('change', async () => {
  const { decodeXml, classifyXml, isInSkippedDirectory, SKIP_REASONS } = await import('/shared/mapperDetection.js');
  const map = new Map();
  const skipped = [];
  let buildCopies = 0;
  fileCount.textContent = '폴더 읽는 중…';
  for (const file of folderInput.files) {
    const relative = file.webkitRelativePath || file.name;
    if (!relative.toLowerCase().endsWith('.xml')) continue;
    // drop the picked folder's own name, keep the path inside it
    const inside = relative.split('/').slice(1).join('/') || relative;
    if (isInSkippedDirectory(inside)) {
      buildCopies++;
      continue;
    }
    const { text } = decodeXml(new Uint8Array(await file.arrayBuffer()));
    const kind = classifyXml(text);
    if (kind === 'IBATIS_MAPPER') map.set(inside, text);
    else skipped.push(`${inside} — ${SKIP_REASONS[kind]}`);
  }
  folderInput.value = '';
  state.sampleKind = null;
  setFiles(map);
  const total = map.size + skipped.length;
  fileCount.textContent = map.size
    ? `매퍼 ${map.size}개 (XML ${total}개 중${buildCopies ? ` · 빌드 폴더 ${buildCopies}개 제외` : ''})`
    : `iBATIS 매퍼를 찾지 못했습니다 (XML ${total}개)`;
  fileCount.title = skipped.length ? `건너뛴 XML:\n${skipped.join('\n')}` : '';
  if (map.size) runAnalysis().catch((e) => alert(`Analysis failed: ${e.message}`));
});

/**
 * A folder on this machine, by path: the server indexes it in place and reads
 * each file only when a statement in it is opened — nothing is uploaded, and
 * the browser never holds the files.
 */
document.getElementById('pathForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const dir = document.getElementById('pathInput').value.trim();
  if (!dir) return;
  fileCount.textContent = '여는 중…';
  try {
    const res = await fetch('/api/v1/projects/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: dir }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? res.status);
    state.sampleKind = null;
    await openProject(body);
    state.openedPath = dir; // a closed session (idle timeout, restart) can be reopened from it
    fileCount.textContent = `매퍼 ${body.totals.files}개 · statement ${body.totals.statements.toLocaleString()}개${body.skipped.length ? ` · XML ${body.skipped.length}개 제외` : ''}`;
    fileCount.title = body.skipped.length ? `건너뛴 XML:\n${body.skipped.map((x) => `${x.sourceFile} — ${x.reason}`).join('\n')}` : '';
    try { localStorage.setItem('project.path', dir); } catch { /* not remembered */ }
  } catch (err) {
    fileCount.textContent = `열기 실패: ${err.message}`;
  }
});
try { document.getElementById('pathInput').value = localStorage.getItem('project.path') ?? ''; } catch { /* storage unavailable */ }

document.getElementById('sampleBtn').addEventListener('click', () => {
  loadSampleProject('basic').catch((e) => alert(`Could not load the sample project: ${e.message}`));
});

document.getElementById('advancedBtn').addEventListener('click', () => {
  loadSampleProject('advanced').catch((e) => alert(`Could not load the advanced project: ${e.message}`));
});

document.getElementById('analyzeBtn').addEventListener('click', () => {
  runAnalysis().catch((e) => alert(`Analysis failed: ${e.message}`));
});

/* ------------------------------------------------------------------ *
 * View switch (left menu)                                              *
 *                                                                      *
 * One screen, one selected statement, two views of it. The switch      *
 * lives in the left menu next to the tree so that flipping between the *
 * lineage graph and the converted query never moves the tree, loses    *
 * the scroll position, or clears the selection - which is exactly what *
 * the old top-level tab bar did.                                       *
 * ------------------------------------------------------------------ */
const VIEW_PANES = { lineage: 'lineagePane', schema: 'schemaPane' };

const viewSwitch = document.getElementById('viewSwitch');

viewSwitch.addEventListener('click', (e) => {
  const btn = e.target.closest('.view-tab');
  if (btn) showView(btn.dataset.view);
});

// Roving tabindex + arrow keys: the standard tablist keyboard contract.
viewSwitch.addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const tabs = [...viewSwitch.querySelectorAll('.view-tab')];
  const current = tabs.indexOf(document.activeElement);
  if (current === -1) return;
  e.preventDefault();
  const next = e.key === 'Home' ? 0
    : e.key === 'End' ? tabs.length - 1
    : (current + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus();
  showView(tabs[next].dataset.view);
});

function showView(view) {
  state.activeView = view;
  for (const tab of viewSwitch.querySelectorAll('.view-tab')) {
    const active = tab.dataset.view === view;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  for (const [name, id] of Object.entries(VIEW_PANES)) document.getElementById(id).hidden = name !== view;
  // Toolbar controls belong to the graph; they'd be inert over the XML.
  document.querySelector('.dash-toolbar').hidden = view !== 'lineage';
  // The schema diff needs the width; the lineage side panel says nothing about it.
  document.getElementById('lineageRight').hidden = view === 'schema';
  document.querySelector('.dash-body').classList.toggle('no-right', view === 'schema');
  decorateSchemaTree();

  if (view === 'lineage') {
    // The graph's edges are measured from laid-out boxes, so they can
    // only be drawn once the pane is actually visible.
    redrawEdgesWhenVisible();
    if (!lineageState.fitted) fitGraphWhenVisible();
  } else {
    renderSchemaView();
  }
}

/* ------------------------------------------------------------------ *
 * Top-level screens: 분석 (the dashboard) / 데이터셋 (mapping editor)   *
 * ------------------------------------------------------------------ */
const screenTabs = document.getElementById('screenTabs');

screenTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn) showScreen(btn.dataset.screen);
});

screenTabs.addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const tabs = [...screenTabs.querySelectorAll('.tab')];
  const next = tabs[(tabs.indexOf(document.activeElement) + 1) % tabs.length];
  e.preventDefault();
  next.focus();
  showScreen(next.dataset.screen);
});

function showScreen(screen) {
  for (const tab of screenTabs.querySelectorAll('.tab')) {
    const active = tab.dataset.screen === screen;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  document.getElementById('app').hidden = screen !== 'analysis';
  document.getElementById('datasetScreen').hidden = screen !== 'datasets';
  document.querySelector('.top-actions').classList.toggle('dimmed', screen !== 'analysis');
  if (screen === 'datasets') openDatasetScreen();
  else if (state.activeView === 'schema' && state.projectId) renderSchemaView();
  else if (state.activeView === 'lineage' && state.projectId) redrawEdgesWhenVisible();
}

/** The 12 standardized iBATIS `isXxx` conditional tags (see docs/AST_REFERENCE.md's ConditionType). */
const IBATIS_CONDITION_TAGS = new Set([
  'isNull', 'isNotNull', 'isEmpty', 'isNotEmpty', 'isEqual', 'isNotEqual',
  'isGreaterThan', 'isGreaterEqual', 'isLessThan', 'isLessEqual',
  'isPropertyAvailable', 'isNotPropertyAvailable',
]);

const STATEMENT_TAGS = new Set(['select', 'insert', 'update', 'delete', 'procedure']);

/** Parses one mapper source into `{ sqlMapEl, namespace }`, or null if it isn't parseable/isn't a sqlMap. */
function parseMapperSource(source) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(source, 'application/xml');
  } catch {
    return null;
  }
  if (doc.querySelector('parsererror')) return null;
  const sqlMapEl = doc.querySelector('sqlMap');
  if (!sqlMapEl) return null;
  return { sqlMapEl, namespace: sqlMapEl.getAttribute('namespace') };
}

/**
 * Resolves an `<include refid>` the way the ReferenceResolver does: an
 * already-qualified id, then the including mapper's own namespace, then — a
 * bare id under iBATIS's default useStatementNamespaces=false — the one
 * fragment of that id in any mapper (none if two mappers define it).
 */
function resolveFragmentElement(refid, fragments, namespace) {
  const direct = fragments.get(refid) ?? (namespace ? fragments.get(`${namespace}.${refid}`) : undefined);
  if (direct || refid.includes('.')) return direct;
  const matches = [...fragments].filter(([qualifiedId]) => qualifiedId.endsWith(`.${refid}`) || qualifiedId === refid);
  return matches.length === 1 ? matches[0][1] : undefined;
}

/**
 * The fragment's real SQL text, with any `<include refid>` *inside* the
 * fragment spliced in as well - a fragment built out of other fragments
 * would otherwise draw as an empty box. `seen` breaks refid cycles; the
 * resolver already reports those as diagnostics, the diagram just stops.
 */
function expandFragmentSql(element, fragments, namespace, seen) {
  let out = '';
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue;
    } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'include') {
      const refid = node.getAttribute('refid');
      const target = refid && !seen.has(refid) ? resolveFragmentElement(refid, fragments, namespace) : undefined;
      if (target) out += ` ${expandFragmentSql(target, fragments, namespace, new Set([...seen, refid]))} `;
      else if (refid && seen.has(refid)) out += ` ${refid} (circular) `;
      else out += ` ${refid ?? 'include'} (not loaded) `;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      out += ` ${node.textContent} `;
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Longest first, so `LEFT OUTER JOIN` wins over `JOIN` and `UNION ALL` over `UNION`. */
const SQL_CLAUSE_KEYWORDS = [
  'SELECT DISTINCT', 'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'FULL OUTER JOIN',
  'INNER JOIN', 'CROSS JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'UNION ALL',
  'GROUP BY', 'ORDER BY', 'SELECT', 'FROM', 'WHERE', 'HAVING', 'LIMIT', 'OFFSET',
  'UNION', 'JOIN', 'START WITH', 'CONNECT BY', 'FOR UPDATE',
];

/**
 * Splits SQL into one string per top-level clause, so a fragment holding
 * `FROM ... JOIN ... WHERE ...` draws as one box per clause instead of a
 * wall of text. A keyword only cuts when it sits at paren depth 0 and
 * outside a `#binding#` / `$substitution$` token, so a subquery's own
 * FROM stays with its parent clause and `LIMIT #offset#, #limit#` is
 * never split down the middle.
 */
function splitSqlClauses(sql) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const upper = text.toUpperCase();
  const cuts = [];
  let depth = 0;
  let token = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (token) {
      if (ch === token) token = null;
      continue;
    }
    if (ch === '#' || ch === '$') { token = ch; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0 || (i > 0 && text[i - 1] !== ' ')) continue;
    const keyword = SQL_CLAUSE_KEYWORDS.find((k) => upper.startsWith(k, i)
      && (i + k.length === upper.length || upper[i + k.length] === ' ' || upper[i + k.length] === '('));
    if (!keyword) continue;
    if (i > 0) cuts.push(i);
    i += keyword.length - 1;
  }
  const bounds = [0, ...cuts, text.length];
  return bounds.slice(0, -1)
    .map((start, n) => text.slice(start, bounds[n + 1]).trim())
    .filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * Analysis run                                                         *
 * ------------------------------------------------------------------ */
async function runAnalysis() {
  const files = [...state.pendingFiles.entries()].map(([sourceFile, source]) => ({ sourceFile, source }));
  const res = await fetch('/api/v1/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files }),
  });
  if (!res.ok) throw new Error(`open failed: ${res.status}`);
  await openProject(await res.json());
}

/** Shows a project from its index (POST /projects or /projects/open): nothing is analysed yet. */
async function openProject(index) {
  closeProject();
  state.openedPath = null;
  // the server has the files now; the browser keeps no copy of their text
  state.pendingFiles = new Map();
  state.projectId = index.projectId;
  state.index = index;
  state.docs = new Map();
  state.statementFile = new Map();
  state.statementMeta = new Map();
  for (const file of index.files) {
    for (const stmt of file.statements) {
      state.statementFile.set(stmt.qualifiedId, file.sourceFile);
      state.statementMeta.set(stmt.qualifiedId, stmt);
    }
  }
  invalidateSchemaResult(); // a new project invalidates the last migration run
  // a big project starts with its files folded: only the open statement's file is expanded
  lineageState.collapsedTree = new Set(index.totals.statements > LARGE_TREE ? index.files.map((f) => `file:${f.sourceFile}`) : []);

  showScreen('analysis');
  document.getElementById('emptyState').hidden = true;
  document.getElementById('lineageScreen').hidden = false;
  renderLineageDashboard();
  showView(state.activeView);
}
