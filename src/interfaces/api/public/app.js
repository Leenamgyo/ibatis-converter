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
  files: new Map(), // sourceFile -> raw text
  projectId: null,
  mappers: [], // MapperReport[]
  statementFile: new Map(), // qualifiedId -> sourceFile
  tableUsageReport: {},
  tableDependencyGraph: {},
  analysisById: new Map(), // qualifiedId -> StatementAnalysis (incl. its lineage)
  generatedMapperXml: {}, // sourceFile -> converted MyBatis 3.x XML (MyBatis tab)
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
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return res.json();
}

/* ------------------------------------------------------------------ *
 * File input / sample loading                                         *
 * ------------------------------------------------------------------ */
const fileInput = document.getElementById('fileInput');
const analyzeBtn = document.getElementById('analyzeBtn');
const fileCount = document.getElementById('fileCount');

function setFiles(map) {
  state.files = map;
  fileCount.textContent = map.size ? `${map.size} file${map.size === 1 ? '' : 's'} ready` : '';
  analyzeBtn.disabled = map.size === 0;
}

fileInput.addEventListener('change', async () => {
  const map = new Map();
  for (const file of fileInput.files) {
    map.set(file.name, await file.text());
  }
  state.sampleKind = null;
  setFiles(map);
});

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
 * Every `<sql id="...">` fragment in every currently loaded file, keyed by
 * namespace-qualified id (`ProjectScanner#qualify`'s rule), so an
 * `<include refid>` can be expanded inline in the flow diagram instead of
 * being a dead-end node naming a fragment you'd have to go look up.
 */
function collectSqlFragmentElements() {
  const byQualifiedId = new Map();
  for (const source of state.files.values()) {
    let doc;
    try {
      doc = new DOMParser().parseFromString(source, 'application/xml');
    } catch {
      continue;
    }
    if (doc.querySelector('parsererror')) continue;
    const sqlMapEl = doc.querySelector('sqlMap');
    if (!sqlMapEl) continue;
    const namespace = sqlMapEl.getAttribute('namespace');
    for (const child of sqlMapEl.children) {
      if (child.tagName !== 'sql') continue;
      const id = child.getAttribute('id');
      if (!id) continue;
      byQualifiedId.set(namespace ? `${namespace}.${id}` : id, child);
    }
  }
  return byQualifiedId;
}

/** Resolves an `<include refid>` the way `ProjectScanner#qualify` does: an already-qualified id first, then the including mapper's own namespace. */
function resolveFragmentElement(refid, fragments, namespace) {
  return fragments.get(refid) ?? (namespace ? fragments.get(`${namespace}.${refid}`) : undefined);
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
  const files = [...state.files.entries()].map(([sourceFile, source]) => ({ sourceFile, source }));
  const res = await fetch('/api/v1/projects/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files }),
  });
  if (!res.ok) throw new Error(`analyze failed: ${res.status}`);
  const body = await res.json();

  state.projectId = body.projectId;
  state.mappers = body.mappers;
  state.tableUsageReport = body.tables;
  state.tableDependencyGraph = body.tableDependencyGraph;
  state.generatedMapperXml = body.generatedMapperXml ?? {};
  schemaState.result = null; // a new project invalidates the last migration run
  state.statementFile = new Map();
  state.analysisById = new Map();
  for (const mapper of body.mappers) {
    for (const stmt of mapper.statements) {
      state.statementFile.set(stmt.id, mapper.sourceFile);
      state.analysisById.set(stmt.id, stmt);
    }
  }

  showScreen('analysis');
  document.getElementById('emptyState').hidden = true;
  document.getElementById('lineageScreen').hidden = false;
  renderLineageDashboard();
  showView(state.activeView);
}

