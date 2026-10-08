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

/* ------------------------------------------------------------------ *
 * Stale tab check: a tab opened before an update runs the old script  *
 * (e.g. the old folder picker) until reloaded — say so.               *
 * ------------------------------------------------------------------ */
let loadedUiVersion = null;
async function checkUiVersion() {
  try {
    const { ui } = await fetch('/api/v1/version', { cache: 'no-store' }).then((r) => r.json());
    if (loadedUiVersion === null) loadedUiVersion = ui;
    else if (ui !== loadedUiVersion) document.getElementById('updateBar').hidden = false;
  } catch { /* server down: nothing to compare */ }
}
checkUiVersion();
window.addEventListener('focus', checkUiVersion);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkUiVersion(); });

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

/* ------------------------------------------------------------------ *
 * Uploading a project without holding it                              *
 *                                                                      *
 * A real project is thousands of files, most of them not mappers. Only *
 * paths are looked at first; each remaining .xml is classified from    *
 * its first 8 KB (classifyHead); a mapper is read whole only just      *
 * before its batch is sent, and the batch's text is dropped once the   *
 * server has written it to disk (POST /uploads/:id/files).             *
 * ------------------------------------------------------------------ */
const UPLOAD_BATCH_BYTES = 4 * 1024 * 1024;
const READ_CONCURRENCY = 16;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/**
 * Picks the iBATIS mappers out of `entries` ({ sourceFile, file }) without
 * reading anything else whole. @returns {{ mappers, skipped }}
 */
async function selectMappers(entries, progress) {
  const { decodeXml, classifyHead, classifyXml, HEAD_BYTES, SKIP_REASONS } = await import('/shared/mapperDetection.js');
  let done = 0;
  const kinds = await mapLimit(entries, READ_CONCURRENCY, async ({ file }) => {
    let kind;
    try {
      const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
      kind = classifyHead(head, file.size <= HEAD_BYTES)
        // the root element is past the head (a long license comment): read it whole, once
        ?? classifyXml(decodeXml(new Uint8Array(await file.arrayBuffer())).text);
    } catch {
      kind = 'UNREADABLE';
    }
    if (++done % 50 === 0 || done === entries.length) progress(`XML 확인 ${done.toLocaleString()} / ${entries.length.toLocaleString()}`);
    return kind;
  });
  const mappers = [];
  const skipped = [];
  entries.forEach((entry, i) => {
    // any mapper with SQL in it: iBATIS <sqlMap> or MyBatis <mapper>
    if (kinds[i] === 'IBATIS_MAPPER' || kinds[i] === 'MYBATIS_MAPPER') mappers.push(entry);
    else skipped.push(`${entry.sourceFile} — ${SKIP_REASONS[kinds[i]] ?? kinds[i]}`);
  });
  return { mappers, skipped };
}

/**
 * Sends mappers to the server in batches and opens the project.
 * @param {{ sourceFile: string, size: number, read: () => Promise<string> }[]} items
 */
async function uploadProject(items, progress = () => {}) {
  const post = async (url, body) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `${res.status} ${url}`);
    return json;
  };
  const { uploadId } = await post('/api/v1/uploads');
  let batch = [];
  let batchBytes = 0;
  let sent = 0;
  const flush = async () => {
    if (!batch.length) return;
    const files = await Promise.all(batch.map(async (item) => ({ sourceFile: item.sourceFile, source: await item.read() })));
    await post(`/api/v1/uploads/${uploadId}/files`, { files });
    sent += batch.length;
    progress(`업로드 ${sent.toLocaleString()} / ${items.length.toLocaleString()}`);
    batch = [];
    batchBytes = 0;
  };
  for (const item of items) {
    batch.push(item);
    batchBytes += item.size;
    if (batchBytes >= UPLOAD_BATCH_BYTES) await flush();
  }
  await flush();
  progress('색인 만드는 중…');
  await openProject(await post(`/api/v1/uploads/${uploadId}/open`));
}

/** a picked File as an upload item: its text is read (and decoded) only when its batch goes */
function fileItem(sourceFile, file, decodeXml) {
  return { sourceFile, size: file.size, read: async () => decodeXml(new Uint8Array(await file.arrayBuffer())).text };
}

async function uploadPicked(entries, { buildCopies = 0, skippedDirs = 0 } = {}) {
  const { decodeXml } = await import('/shared/mapperDetection.js');
  const progress = (text) => { fileCount.textContent = text; };
  const xmlCount = entries.length;
  const { mappers, skipped } = await selectMappers(entries, progress);
  fileCount.title = skipped.length ? `건너뛴 XML:\n${skipped.slice(0, 500).join('\n')}${skipped.length > 500 ? `\n… +${skipped.length - 500}` : ''}` : '';
  if (!mappers.length) {
    fileCount.textContent = `SQL 매퍼(iBATIS <sqlMap> / MyBatis <mapper>)를 찾지 못했습니다 (XML ${xmlCount.toLocaleString()}개)`;
    return;
  }
  state.sampleKind = null;
  setFiles(new Map());
  await uploadProject(mappers.map(({ sourceFile, file }) => fileItem(sourceFile, file, decodeXml)), progress);
  const mybatisCount = state.index?.files.filter((f) => f.syntax === 'mybatis').length ?? 0;
  fileCount.textContent = `매퍼 ${mappers.length.toLocaleString()}개${mybatisCount ? ` (MyBatis ${mybatisCount.toLocaleString()})` : ''} · XML ${xmlCount.toLocaleString()}개 중${buildCopies ? ` · 빌드 폴더 XML ${buildCopies.toLocaleString()}개 제외` : ''}${skippedDirs ? ` · 빌드/도구 폴더 ${skippedDirs.toLocaleString()}개 건너뜀` : ''}`;
}

fileInput.addEventListener('change', () => {
  const entries = [...fileInput.files].map((file) => ({ sourceFile: file.name, file }));
  fileInput.value = '';
  uploadPicked(entries).catch((e) => { fileCount.textContent = `업로드 실패: ${e.message}`; });
});

/**
 * A whole project folder: keep only iBATIS mappers (root <sqlMap>), skip
 * build output (target/, build/, node_modules/ ...: Maven's target/classes
 * holds a copy of every mapper) and decode EUC-KR / MS949 when declared —
 * with the same code the CLI uses (src/application/mapperDetection.js).
 * Non-XML files are dropped by name: they are never read.
 */
const folderInput = document.getElementById('folderInput');

/**
 * Walks a picked directory (File System Access API) and returns only its
 * `.xml` files, never descending into build output / tool directories —
 * so a 3,800-file project is not handed to the page at all, and the
 * browser never asks to "upload" every file. Paths are relative to the
 * picked folder.
 */
async function collectXmlFromDirectory(dirHandle, isInSkippedDirectory, onProgress) {
  const out = [];
  let skippedDirs = 0;
  const walk = async (handle, prefix) => {
    for await (const [name, child] of handle.entries()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (child.kind === 'directory') {
        if (isInSkippedDirectory(`${relative}/x`)) skippedDirs++;
        else await walk(child, relative);
      } else if (name.toLowerCase().endsWith('.xml')) {
        out.push({ sourceFile: relative, file: await child.getFile() });
        if (out.length % 100 === 0) onProgress(out.length);
      }
    }
  };
  await walk(dirHandle, '');
  return { entries: out, skippedDirs };
}

/**
 * The browser's own folder access: the File System Access picker where there is one,
 * else the classic folder input. Used only when the page is not served from this
 * machine (the in-app browser below needs the local server). Chrome's picker
 * refuses folders it deems sensitive ("시스템 파일이 포함되어 있으므로 …"); that
 * refusal reaches the page as a plain cancel, so the hint says what to do.
 */
async function pickWithBrowser() {
  if (!window.showDirectoryPicker) {
    folderInput.click();
    return;
  }
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'read' });
  } catch (e) {
    // Chrome's "시스템 파일이 포함되어 있으므로 … 열 수 없습니다" refusal arrives here as a plain AbortError
    fileCount.textContent = e.name === 'AbortError'
      ? '폴더를 열지 않았습니다. 브라우저가 “시스템 파일” 때문에 막았다면: 이 컴퓨터에서 연 화면의 “프로젝트 폴더”(앱 안의 폴더 목록)나 “경로 열기”를 쓰세요'
      : `브라우저가 폴더를 열 수 없습니다: ${e.message}`;
    return;
  }
  try {
    const { isInSkippedDirectory } = await import('/shared/mapperDetection.js');
    fileCount.textContent = `${handle.name}: XML 찾는 중…`;
    const { entries, skippedDirs } = await collectXmlFromDirectory(handle, isInSkippedDirectory, (n) => {
      fileCount.textContent = `${handle.name}: XML ${n.toLocaleString()}개 찾는 중…`;
    });
    await uploadPicked(entries, { buildCopies: 0, skippedDirs });
  } catch (e) {
    fileCount.textContent = `업로드 실패: ${e.message}`;
  }
}

/* ---- in-app folder browser (local server) -------------------------- */
const folderDialog = document.getElementById('folderDialog');
const folderBrowser = { path: null, parent: null, home: null };

async function listFolder(dir) {
  const url = new URL('/api/v1/fs/dirs', window.location.origin);
  if (dir) url.searchParams.set('path', dir);
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function showFolder(dir) {
  const error = document.getElementById('folderError');
  const { ok, body } = await listFolder(dir);
  if (!ok) {
    error.textContent = body.error ?? '폴더를 읽을 수 없습니다';
    return false;
  }
  error.textContent = '';
  Object.assign(folderBrowser, { path: body.path, parent: body.parent, home: body.home });
  document.getElementById('folderPath').textContent = body.path;
  document.getElementById('folderUp').disabled = !body.parent;
  const list = document.getElementById('folderList');
  list.replaceChildren(...(body.dirs.length
    ? body.dirs.map((name) => el('li', {},
      el('button', { type: 'button', class: 'fd-dir', role: 'option', onclick: () => showFolder(`${body.path}/${name}`) }, el('span', { class: 'fd-icon', 'aria-hidden': 'true' }, '📁'), name)))
    : [el('li', { class: 'fd-empty' }, '하위 폴더 없음')]));
  document.getElementById('folderOpen').textContent = `이 폴더 열기${body.xmlHere ? ` (XML ${body.xmlHere})` : ''}`;
  list.scrollTop = 0;
  return true;
}

document.getElementById('folderBtn').addEventListener('click', async () => {
  // served from this machine: browse its folders in-app; otherwise the browser's picker
  const remembered = (() => { try { return localStorage.getItem('project.path'); } catch { return null; } })();
  const start = remembered ? remembered.replace(/\/[^/]+\/?$/, '') : null; // the remembered project's parent
  const probe = await listFolder(start).catch(() => ({ ok: false, status: 0 }));
  if (probe.status === 403 || probe.status === 0) {
    pickWithBrowser();
    return;
  }
  if (!(await showFolder(probe.ok ? start : null))) await showFolder(null);
  folderDialog.showModal();
});
document.getElementById('folderUp').addEventListener('click', () => folderBrowser.parent && showFolder(folderBrowser.parent));
document.getElementById('folderHome').addEventListener('click', () => folderBrowser.home && showFolder(folderBrowser.home));
document.getElementById('folderBrowserPicker').addEventListener('click', () => {
  folderDialog.close();
  pickWithBrowser();
});
document.getElementById('folderOpen').addEventListener('click', () => {
  const dir = folderBrowser.path;
  folderDialog.close();
  openByPath(dir).catch((err) => { fileCount.textContent = `열기 실패: ${err.message}`; });
});

folderInput.addEventListener('change', () => {
  const files = [...folderInput.files];
  folderInput.value = '';
  uploadFolder(files).catch((e) => { fileCount.textContent = `업로드 실패: ${e.message}`; });
});

/** @param {File[]} files everything the folder picker returned (webkitRelativePath set) */
async function uploadFolder(files) {
  const { isInSkippedDirectory } = await import('/shared/mapperDetection.js');
  const entries = [];
  let buildCopies = 0;
  for (const file of files) {
    const relative = file.webkitRelativePath || file.name;
    if (!relative.toLowerCase().endsWith('.xml')) continue;
    // drop the picked folder's own name, keep the path inside it
    const inside = relative.split('/').slice(1).join('/') || relative;
    if (isInSkippedDirectory(inside)) buildCopies++;
    else entries.push({ sourceFile: inside, file });
  }
  fileCount.textContent = `파일 ${files.length.toLocaleString()}개 중 XML ${entries.length.toLocaleString()}개 확인 중…`;
  await uploadPicked(entries, { buildCopies });
}

/**
 * A folder on this machine, by path: the server indexes it in place and reads
 * each file only when a statement in it is opened — nothing is uploaded, and
 * the browser never holds the files.
 */
/** Opens a folder on this machine in place (the server reads it; nothing is uploaded). */
async function openByPath(dir) {
  fileCount.textContent = '여는 중…';
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
  const mybatis = body.files.filter((f) => f.syntax === 'mybatis').length;
  fileCount.textContent = body.totals.files
    ? `매퍼 ${body.totals.files}개${mybatis ? ` (MyBatis ${mybatis})` : ''} · statement ${body.totals.statements.toLocaleString()}개${body.skipped.length ? ` · XML ${body.skipped.length}개 제외` : ''}`
    : `SQL 매퍼(iBATIS <sqlMap> / MyBatis <mapper>)를 찾지 못했습니다${body.skipped.length ? ` (XML ${body.skipped.length}개는 매퍼가 아님)` : ''}`;
  fileCount.title = body.skipped.length ? `건너뛴 XML:\n${body.skipped.map((x) => `${x.sourceFile} — ${x.reason}`).join('\n')}` : '';
  document.getElementById('pathInput').value = dir;
  try { localStorage.setItem('project.path', dir); } catch { /* not remembered */ }
}

document.getElementById('pathForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const dir = document.getElementById('pathInput').value.trim();
  if (dir) openByPath(dir).catch((err) => { fileCount.textContent = `열기 실패: ${err.message}`; });
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
/** MyBatis 3 tags that guard SQL (a MyBatis input mapper; see parser/mybatis). */
const MYBATIS_GUARD_TAGS = new Set(['if', 'when', 'otherwise', 'foreach']);

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
 * The fragment's real SQL text, with every `<include refid>` inside it — at
 * any depth, also inside its dynamic tags — spliced in. Which fragment an
 * include means is NOT guessed by name here: it comes from the server's
 * resolved include tree (`GET /statements/:id/xml` -> includeTree, the
 * ReferenceResolver's own answer, nested bare refids included). `treeNode`
 * is this fragment's node in that tree; its children are the fragment's
 * includes in document order.
 */
function expandFragmentSql(element, fragments, treeNode) {
  const includes = treeNode?.children ?? [];
  let k = 0;
  const walk = (parent) => {
    let out = '';
    for (const node of parent.childNodes) {
      if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
        out += node.nodeValue;
      } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'include') {
        const refid = node.getAttribute('refid') ?? 'include';
        const resolved = includes[k++];
        const target = resolved?.qualifiedId ? fragments.get(resolved.qualifiedId) : undefined;
        if (target) out += ` ${expandFragmentSql(target, fragments, resolved)} `;
        else if (resolved?.unresolved === 'CIRCULAR') out += ` ${refid} (circular) `;
        else if (resolved?.unresolved === 'MISSING') out += ` ${refid} (not found) `;
        else out += ` ${refid} (not loaded) `;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        out += ` ${walk(node)} `; // a dynamic tag: its text, and the includes inside it
      }
    }
    return out;
  };
  return walk(element).replace(/\s+/g, ' ').trim();
}

/** the include-tree node of `qualifiedId` (first in document order), for expanding it */
function findIncludeNode(tree, qualifiedId) {
  for (const node of tree ?? []) {
    if (node.qualifiedId === qualifiedId) return node;
    const inner = findIncludeNode(node.children, qualifiedId);
    if (inner) return inner;
  }
  return null;
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
/** The loaded sample project (its files are small and already in memory). */
async function runAnalysis() {
  const items = [...state.pendingFiles.entries()].map(([sourceFile, source]) => ({ sourceFile, size: source.length, read: async () => source }));
  await uploadProject(items);
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
  // and its search: results name the old project's statements
  lineageState.search = '';
  lineageState.searchResult = null;
  document.getElementById('lineageSearch').value = '';
  // a big project starts with its files folded: only the open statement's file is expanded
  lineageState.collapsedTree = new Set(index.totals.statements > LARGE_TREE ? index.files.map((f) => `file:${f.sourceFile}`) : []);

  showScreen('analysis');
  document.getElementById('emptyState').hidden = true;
  document.getElementById('lineageScreen').hidden = false;
  renderLineageDashboard();
  showView(state.activeView);
}
