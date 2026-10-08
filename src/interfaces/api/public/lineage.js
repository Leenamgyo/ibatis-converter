'use strict';

/* ------------------------------------------------------------------ *
 * SQL Lineage Dashboard (spec section 26)                              *
 *                                                                      *
 * One screen per statement, in four fixed areas: a stat strip, the XML *
 * structure tree, the lineage graph, and the mapping/summary panels.   *
 *                                                                      *
 * The graph is NOT drawn by a diagram library. Containment (a subquery *
 * inside the SELECT that owns it) is expressed as nested DOM - which   *
 * is what makes a 3-level-deep subquery still readable - so the        *
 * browser does the layout, and the only thing this file computes is    *
 * the edge geometry, measured from the laid-out boxes afterwards.      *
 *                                                                      *
 * Everything drawn comes from the ORIGINAL iBATIS mapper with its      *
 * refids spliced in (the statement as it runs, no <include> left): the *
 * SELECT hierarchy from `analysis.lineage` (analyzer/lineage), the     *
 * dynamic blocks from the server's `inlinedXml`. The MyBatis side      *
 * lives in the 변환 view (schema.js) and never feeds this screen.       *
 * ------------------------------------------------------------------ */

const lineageState = {
  statementId: null,
  analysis: null,
  stmtEl: null,
  namespace: null,
  sourceFile: null,
  scale: 1,
  tx: 0,
  ty: 0,
  collapsedTree: new Set(),
  selectedNodeId: null,
  selectedColumn: null,
  fitted: false,
  search: '',
  edges: [],
  nodeById: new Map(),
  clusterById: new Map(),
  scopeQueue: [],
  // dragged boxes / lanes: { [layoutKey]: [dx, dy] } in graph units, plus the saved zoom/pan
  layout: { offsets: {}, view: null },
  layoutSaved: null, // JSON of what the server has for this statement (null: nothing saved)
};

const ORIGIN_LABEL = {
  ROOT: 'Main SELECT',
  INSERT_SELECT: 'Source SELECT (INSERT ... SELECT)',
  FROM: 'Inline View · FROM',
  JOIN: 'Inline View · JOIN',
  SELECT_LIST: 'Scalar Subquery · SELECT list',
  WHERE: 'Subquery · WHERE',
  HAVING: 'Subquery · HAVING',
  UNION: 'UNION branch',
  CTE: 'CTE · WITH',
};

/* ------------------------------------------------------------------ *
 * Entry points                                                         *
 * ------------------------------------------------------------------ */

/** Called by `runAnalysis` once a project has been analyzed. */
function renderLineageDashboard() {
  renderXmlTree();
  renderIncludeUsage();
  renderLegend();

  const stillThere = lineageState.statementId && state.statementMeta.has(lineageState.statementId);
  const first = stillThere
    ? lineageState.statementId
    : [...state.statementMeta.values()].find((s) => s.type === 'SELECT')?.qualifiedId ?? [...state.statementMeta.keys()][0];
  lineageState.statementId = null;
  if (first) selectLineageStatement(first);
}

let lineageLoadSeq = 0;

/** Opens one statement: its analysis and XML are fetched now (see loadStatement), not at project load. */
async function selectLineageStatement(qualifiedId) {
  if (!state.statementMeta.has(qualifiedId)) return;
  const seq = ++lineageLoadSeq;
  for (const node of document.querySelectorAll('#lineageTree .node')) {
    node.classList.toggle('loading', node.dataset.statementId === qualifiedId);
  }
  let doc;
  try {
    try {
      doc = await loadStatement(qualifiedId);
    } catch (e) {
      if (e.status !== 404 || !(await reopenProject())) throw e;
      doc = await loadStatement(qualifiedId); // the session had expired: reopened, retried once
    }
  } catch (e) {
    if (seq !== lineageLoadSeq) return;
    const message = e.status === 404
      ? '프로젝트가 서버에서 닫혔습니다 (30분 미사용 또는 서버 재시작). 프로젝트를 다시 열어 주세요.'
      : `${qualifiedId}: ${e.message}`;
    document.getElementById('dashStats').replaceChildren(el('div', { class: 'sm-callout error' }, message));
    return;
  } finally {
    if (seq === lineageLoadSeq) for (const node of document.querySelectorAll('#lineageTree .node.loading')) node.classList.remove('loading');
  }
  if (seq !== lineageLoadSeq) return; // a later click won

  keepLayoutDraft(); // the statement being left keeps its unsaved moves
  lineageState.statementId = qualifiedId;
  lineageState.doc = doc;
  lineageState.analysis = doc.analysis;
  lineageState.sourceFile = doc.sourceFile;
  lineageState.selectedNodeId = null;
  lineageState.selectedColumn = null;
  lineageState.selectedEdge = null;
  lineageState.namespace = doc.namespace ?? null;
  // the statement as it runs: every refid replaced by its fragment, so a dynamic tag written
  // inside a fragment guards its own SQL here (no <include> boxes in this view)
  lineageState.stmtEl = parseSlice(doc.inlinedXml ?? doc.xml, doc.namespace);
  await loadLayout(qualifiedId, doc.sourceFile);
  if (seq !== lineageLoadSeq) return;
  if (lineageState.collapsedTree.delete(`file:${doc.sourceFile}`)) renderXmlTree(); // reveal it in a folded tree

  for (const node of document.querySelectorAll('#lineageTree .node')) {
    const selected = node.dataset.statementId === qualifiedId;
    node.classList.toggle('selected', selected);
    if (node.dataset.statementId) node.setAttribute('aria-current', String(selected));
  }

  renderDashStats();
  renderGraph();
  renderRightPanel();
  renderBreadcrumb([]);
  // The MyBatis view is a view of *this* statement, so it follows the
  // tree selection instead of keeping a selection of its own.
  if (state.activeView === 'schema') renderSchemaView();
  // Start on the saved view, else on "fit": a wide statement is otherwise
  // cropped at 100% and looks broken until you find the zoom control.
  const view = lineageState.layout.view;
  if (view) {
    Object.assign(lineageState, { scale: view.scale, tx: view.tx, ty: view.ty, fitted: true });
    applyTransform();
    redrawEdgesWhenVisible();
  } else {
    lineageState.fitted = false;
    fitGraphWhenVisible();
  }
  renderLayoutStatus();
}

/* ------------------------------------------------------------------ *
 * Moving boxes with the mouse, and saving the arrangement             *
 *                                                                      *
 * The browser still lays the graph out; a drag only adds an offset     *
 * (CSS `translate`) to one table object or one lane, so containment,   *
 * edges (measured from the boxes) and the minimap all keep working.    *
 * Saved per statement on the server (data/layouts), with the zoom/pan. *
 * ------------------------------------------------------------------ */

/** The element a layout key names: `cluster:<id>` is a lane / group, `node:<id>` a box. */
function layoutElement(key) {
  if (key.startsWith('node:')) return lineageState.nodeById.get(key.slice(5)) ?? null;
  return document.querySelector(`#lineageNodes [data-layout-key="${CSS.escape(key)}"]`);
}

function layoutKeyOf(element) {
  return element.dataset.layoutKey ?? `node:${element.dataset.nodeId}`;
}

function applyLayoutOffsets() {
  for (const [key, [dx, dy]] of Object.entries(lineageState.layout.offsets)) {
    const element = layoutElement(key);
    if (element) element.style.translate = `${dx}px ${dy}px`;
  }
}

async function loadLayout(qualifiedId, sourceFile) {
  lineageState.layout = { offsets: {}, view: null };
  lineageState.layoutSaved = null;
  try {
    const res = await fetch(`/api/v1/layouts/${encodeURIComponent(qualifiedId)}`);
    if (!res.ok) return;
    const saved = await res.json();
    // a layout saved for a statement of the same id in another project's file is not this one's
    if (saved.sourceFile && sourceFile && saved.sourceFile !== sourceFile) return;
    lineageState.layout = { offsets: saved.offsets ?? {}, view: saved.view ?? null };
    lineageState.layoutSaved = JSON.stringify(lineageState.layout);
  } catch { /* no saved layout: the default one */ } finally {
    // unsaved moves made earlier in this page come back (still marked unsaved)
    const draft = layoutDrafts.get(qualifiedId);
    if (draft) lineageState.layout = { offsets: draft, view: lineageState.layout.view };
  }
}

/** unsaved moves per statement, so switching statements never silently drops them */
const layoutDrafts = new Map();

function keepLayoutDraft() {
  if (!lineageState.statementId) return;
  if (layoutDirty()) layoutDrafts.set(lineageState.statementId, { ...lineageState.layout.offsets });
  else layoutDrafts.delete(lineageState.statementId);
}

const EMPTY_LAYOUT = JSON.stringify({ offsets: {}, view: null });

/** moved since the last save (or, with nothing saved, moved at all) */
function layoutDirty() {
  const current = JSON.stringify({ offsets: lineageState.layout.offsets, view: lineageState.layoutSaved === null ? null : lineageState.layout.view });
  return current !== (lineageState.layoutSaved ?? EMPTY_LAYOUT);
}

function renderLayoutStatus() {
  const status = document.getElementById('layoutStatus');
  const save = document.querySelector('[data-graph-action="save-layout"]');
  const reset = document.querySelector('[data-graph-action="reset-layout"]');
  if (!status || !save) return;
  const moved = Object.keys(lineageState.layout.offsets).length;
  const dirty = layoutDirty();
  save.disabled = !lineageState.statementId || !dirty;
  reset.disabled = !moved && lineageState.layoutSaved === null;
  status.textContent = dirty ? `이동 ${moved}개 · 저장 안 됨` : lineageState.layoutSaved !== null ? '배치 저장됨' : '';
  status.classList.toggle('dirty', dirty);
}

async function saveLayout() {
  const qualifiedId = lineageState.statementId;
  if (!qualifiedId) return;
  // the view is saved with the boxes: reopening shows exactly what was saved
  const view = { scale: lineageState.scale, tx: lineageState.tx, ty: lineageState.ty };
  const offsets = lineageState.layout.offsets;
  const body = Object.keys(offsets).length ? { offsets, view, sourceFile: lineageState.sourceFile } : { offsets: {}, view: null };
  const res = await fetch(`/api/v1/layouts/${encodeURIComponent(qualifiedId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.status);
  layoutDrafts.delete(qualifiedId);
  if (lineageState.statementId !== qualifiedId) return;
  lineageState.layout = { offsets, view: body.view };
  lineageState.layoutSaved = res.status === 204 ? null : JSON.stringify(lineageState.layout);
  renderLayoutStatus();
}

/** Back to the browser's own layout (saved only when 저장 is pressed again). */
function resetLayout() {
  for (const key of Object.keys(lineageState.layout.offsets)) {
    const element = layoutElement(key);
    if (element) element.style.translate = '';
  }
  lineageState.layout = { offsets: {}, view: lineageState.layoutSaved === null ? null : lineageState.layout.view };
  fitGraph(); // redraws the edges, straight again
  renderLayoutStatus();
}

/* ------------------------------------------------------------------ *
 * Header stat strip                                                    *
 * ------------------------------------------------------------------ */
function statBox(label, value, className = '') {
  return el('div', { class: `stat ${className}`.trim() }, el('div', { class: 'k' }, label), el('div', { class: 'v' }, String(value)));
}

function renderDashStats() {
  const host = document.getElementById('dashStats');
  const { analysis, stmtEl, sourceFile } = lineageState;
  if (!analysis) {
    host.replaceChildren();
    return;
  }
  const lines = lineageState.doc?.lines ?? 0;
  const counts = analysis.lineage?.counts ?? { selects: 0, subqueries: 0, unions: 0, joins: 0 };

  host.replaceChildren(
    el('div', { class: 'dash-title' },
      el('h2', {}, analysis.id),
      el('div', { class: 'sub' },
        el('span', { class: 'mono' }, `parameterClass=${stmtEl?.getAttribute('parameterClass') ?? '—'}`),
        '  ·  ',
        el('span', { class: 'mono' }, `${stmtEl?.getAttribute('resultMap') ? 'resultMap' : 'resultClass'}=${stmtEl?.getAttribute('resultMap') ?? stmtEl?.getAttribute('resultClass') ?? '—'}`),
        '  ·  ',
        el('span', { class: 'mono' }, sourceFile ?? ''),
      ),
    ),
    statBox('XML 라인 수', lines.toLocaleString()),
    statBox('SELECT 구문', counts.selects),
    statBox('테이블', analysis.tables.filter((t) => !t.derived).length), // subqueries / CTEs aren't tables
    // Joins come from the lineage tree, which also sees the joins inside
    // subqueries and onto derived tables that the flat table analysis
    // reports against no named table.
    statBox('조인', Math.max(analysis.joins.length, counts.joins ?? 0)),
    statBox('서브쿼리', counts.subqueries),
    statBox('UNION', counts.unions),
    analysis.warnings.length
      ? statBox('경고', analysis.warnings.length)
      : statBox('분석', '완료', 'ok'),
  );
}

/* ------------------------------------------------------------------ *
 * Left: XML structure tree + include usage                             *
 * ------------------------------------------------------------------ */
function treeRow({ depth, kind, label, count, statementId, toggleKey, hint = null }) {
  const row = el('button', {
    class: `node depth-${depth}`,
    role: 'treeitem',
    'aria-level': String(depth + 1),
    ...(statementId ? { 'data-statement-id': statementId, 'aria-current': 'false' } : {}),
    ...(toggleKey ? { 'aria-expanded': String(!lineageState.collapsedTree.has(toggleKey)) } : {}),
    onclick: () => {
      if (statementId) selectLineageStatement(statementId);
      else if (toggleKey) {
        if (lineageState.collapsedTree.has(toggleKey)) lineageState.collapsedTree.delete(toggleKey);
        else lineageState.collapsedTree.add(toggleKey);
        renderXmlTree();
      }
    },
  },
    el('span', { class: 'twisty' }, toggleKey ? (lineageState.collapsedTree.has(toggleKey) ? '▶' : '▼') : ''),
    kind ? el('span', { class: `kind ${kind.toLowerCase()}` }, kind) : null,
    el('span', { class: 'label' }, label),
    hint ? el('span', { class: 'hit-why', title: hint.title }, hint.text) : null,
    count === undefined ? null : el('span', { class: 'count' }, String(count)),
  );
  if (statementId) row.classList.toggle('selected', statementId === lineageState.statementId);
  if (lineageState.search && label.toLowerCase().includes(lineageState.search)) row.classList.add('search-hit');
  return row;
}

/** why a statement matched the search: shown next to it in the filtered tree */
function hitHint(reasons) {
  if (!reasons?.length) return null;
  const refids = reasons.filter((r) => r.startsWith('refid:')).map((r) => r.slice(6));
  if (reasons.includes('sql')) return { text: 'SQL', title: '이 statement의 XML/SQL에 있음' };
  if (refids.length) return { text: 'refid', title: `포함한 <sql>에 있음: ${refids.join(', ')}` };
  return null; // matched by its id: the label itself shows it
}

function renderXmlTree() {
  const host = document.getElementById('lineageTree');
  const tree = el('div', { class: 'xml-tree' });
  // while searching, the tree is filtered to the hits (server-side search over ids, paths and the
  // mapper text), every file with a hit unfolded
  const search = lineageState.searchResult;
  const hitsByFile = search ? new Map(search.files.map((f) => [f.sourceFile, f])) : null;
  const summary = search ? el('div', { class: 'tree-search-summary', role: 'status' }) : null;
  if (summary) tree.appendChild(summary);

  // built from the index alone: no file is read or parsed to draw the tree.
  // Mapper files found OUTSIDE the opened folder (refid targets in a sibling module) come last, apart.
  const allFiles = state.index?.files ?? [];
  const ordered = [...allFiles.filter((f) => !f.external), ...allFiles.filter((f) => f.external)];
  let externalHeaderShown = false;
  for (const mapper of ordered) {
    const hit = hitsByFile?.get(mapper.sourceFile);
    if (mapper.external && !externalHeaderShown && (!hitsByFile || hit)) {
      externalHeaderShown = true;
      tree.appendChild(el('div', { class: 'tree-group', title: '열린 폴더 밖(같은 저장소의 다른 모듈)에서, 이 프로젝트의 refid가 가리키는 <sql>을 정의한 매퍼만 찾아 참조로 불러왔습니다' }, '프로젝트 밖 · refid 참조'));
    }
    if (hitsByFile && !hit) continue;
    const fileKey = `file:${mapper.sourceFile}`;
    const folded = !search && lineageState.collapsedTree.has(fileKey);
    tree.appendChild(treeRow({
      depth: 0,
      label: `${mapper.sourceFile} (${mapper.lines.toLocaleString()})`,
      toggleKey: search ? null : fileKey,
    }));
    if (folded) continue;
    // a file matched by its path / namespace shows everything in it
    const whole = !hit || hit.file;

    const fragments = whole ? mapper.fragments : mapper.fragments.filter((f) => hit.fragments[f.qualifiedId]);
    if (fragments.length) {
      const key = `${fileKey}:sql`;
      tree.appendChild(treeRow({ depth: 1, kind: 'sql', label: 'sql', count: fragments.length, toggleKey: search ? null : key }));
      if (search || !lineageState.collapsedTree.has(key)) {
        for (const fragment of fragments) {
          tree.appendChild(treeRow({ depth: 2, label: fragment.id, hint: hit ? hitHint(hit.fragments[fragment.qualifiedId]) : null }));
        }
      }
    }

    // a file too broken to parse: its statements are listed (from its text), not openable
    for (const s of !hitsByFile ? mapper.unparsedStatements ?? [] : []) {
      tree.appendChild(el('div', { class: 'node depth-2 unparsed', title: `${mapper.sourceFile}:${s.line} — XML 파싱 오류로 분석할 수 없습니다` }, el('span', { class: 'label' }, `${s.id}`), el('span', { class: 'hit-why' }, '파싱 오류')));
    }

    const byType = new Map();
    for (const stmt of mapper.statements) {
      if (!whole && !hit.statements[stmt.qualifiedId]) continue;
      if (!byType.has(stmt.type)) byType.set(stmt.type, []);
      byType.get(stmt.type).push(stmt);
    }
    for (const [type, statements] of byType) {
      const key = `${fileKey}:${type}`;
      tree.appendChild(treeRow({ depth: 1, kind: type, label: type.toLowerCase(), count: statements.length, toggleKey: search ? null : key }));
      if (!search && lineageState.collapsedTree.has(key)) continue;
      for (const stmt of statements) {
        tree.appendChild(treeRow({ depth: 2, label: stmt.id, statementId: stmt.qualifiedId, hint: hit ? hitHint(hit.statements[stmt.qualifiedId]) : null }));
      }
    }
  }

  if (summary) {
    // what the tree shows: a file matched by its name lists all of its statements
    const shown = tree.querySelectorAll('.node[data-statement-id]').length;
    summary.textContent = search.files.length
      ? `“${search.query}” · statement ${shown.toLocaleString()}개 · 파일 ${search.files.length.toLocaleString()}개${search.truncated ? ' (일부만 표시)' : ''}`
      : `“${search.query}”: 결과 없음 — 파일명, statement id, 테이블·컬럼·별칭, refid로 찾습니다`;
  }
  host.replaceChildren(tree);
  // Only the schema view adds its change badges; the lineage view stays free of conversion output.
  decorateSchemaTree();
}

function renderIncludeUsage() {
  const host = document.getElementById('lineageIncludeUsage');
  // statements that include each fragment (directly or through another fragment), from the index
  const counts = new Map(Object.entries(state.index?.includeUsage ?? {}));
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (!ranked.length) {
    host.replaceChildren(el('div', { class: 'side-empty' }, 'no <include refid> in this project'));
    return;
  }
  const max = ranked[0][1];
  host.replaceChildren(...ranked.map(([refid, count], i) => el('div', { class: 'usage-row' },
    el('span', { class: 'n' }, `${i + 1}.`),
    el('span', { class: 'name', title: refid }, refid),
    el('span', { class: 'bar', style: `width:${Math.max(6, Math.round((count / max) * 56))}px` }),
    el('span', { class: 'c' }, String(count)),
  )));
}

/* ------------------------------------------------------------------ *
 * Graph                                                                *
 * ------------------------------------------------------------------ */

/** One box in the graph. `id` doubles as the edge endpoint key. */
function gnode(id, className, ...children) {
  const node = el('div', { class: `gnode ${className}`, 'data-node-id': id }, ...children);
  node.addEventListener('mouseenter', () => highlightNeighbours(id));
  node.addEventListener('mouseleave', clearHighlight);
  node.addEventListener('click', (e) => { e.stopPropagation(); selectGraphNode(id); });
  lineageState.nodeById.set(id, node);
  return node;
}

function edge(from, to, kind = 'flow') {
  lineageState.edges.push({ from, to, kind });
}

/** Splits a predicate into its top-level AND/OR terms, so each condition can be its own box. */
/** WHERE terms drawn as their own objects, per SELECT (the rest are counted) */
const MAX_WHERE_OBJECTS = 200;

function splitConditions(where) {
  const text = String(where ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const upper = text.toUpperCase();
  const parts = [];
  let start = 0;
  let depth = 0;
  let token = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (token) { if (ch === token) token = null; continue; }
    if (ch === '#' || ch === '$' || ch === "'") { token = ch; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0) continue;
    for (const keyword of ['AND ', 'OR ']) {
      if (!upper.startsWith(keyword, i) || (i > 0 && text[i - 1] !== ' ')) continue;
      parts.push({ connector: parts.length ? null : null, text: text.slice(start, i).trim() });
      parts[parts.length - 1].next = keyword.trim();
      start = i + keyword.length;
      i += keyword.length - 1;
      break;
    }
  }
  parts.push({ text: text.slice(start).trim() });
  // Carry each term's leading connector (the keyword that preceded it).
  return parts
    .map((part, i) => ({ text: part.text, connector: i === 0 ? null : parts[i - 1].next ?? 'AND' }))
    .filter((part) => part.text);
}

function columnList(columns, limit = 8) {
  const shown = columns.slice(0, limit);
  return el('div', { class: 'sql' },
    shown.join(', ') + (columns.length > limit ? `, … (+${columns.length - limit})` : ''));
}

/** `<dynamic>` / `<isXxx>` / `<iterate>` blocks, read straight from the mapper XML. */
/** `#prop#` / `$prop$` bind to `?` once flattened - normalise so a tag's SQL can be matched to a WHERE term. */
function normalizeSql(text) {
  return String(text ?? '')
    .replace(/#[^#]*#|\$[^$]*\$/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/**
 * The dynamic tags that guard parts of the WHERE, with how deeply each is
 * nested. A condition is not a sibling of its `<isNotNull>` - it lives
 * *inside* it - so the graph shows containment rather than two parallel
 * runs of the same information.
 */
function collectGuards() {
  const stmtEl = lineageState.stmtEl;
  if (!stmtEl) return [];
  // iBATIS isXxx / iterate, and MyBatis if / when / otherwise / foreach (a MyBatis input mapper)
  const guardTags = new Set(['iterate', ...IBATIS_CONDITION_TAGS, ...MYBATIS_GUARD_TAGS]);
  const groupTags = new Set(['dynamic', 'where', 'set', 'trim', 'choose']);
  return [...stmtEl.querySelectorAll([...guardTags].join(', '))].map((element) => {
    let depth = 0;
    for (let parent = element.parentElement; parent && parent !== stmtEl; parent = parent.parentElement) {
      if (groupTags.has(parent.tagName) || guardTags.has(parent.tagName)) depth++;
    }
    const attrs = ['property', 'compareValue', 'prepend', 'conjunction', 'test', 'collection', 'separator']
      .map((name) => [name, element.getAttribute(name)])
      .filter(([, v]) => v !== null && v !== '')
      .map(([k, v]) => `${k}="${v}"`).join(' ');
    return {
      element,
      depth,
      label: `<${element.tagName}${attrs ? ` ${attrs}` : ''}>`,
      sql: normalizeSql(element.textContent),
      used: false,
    };
  });
}

function buildSelectCluster(select, byParent, analysis, isMain) {
  const id = `select:${select.id}`;

  const isWrite = select.role === 'WRITE';
  // The cluster is a *scope frame*, not an object: the objects are the
  // table boxes, the JOIN table, the conditions and the columns inside it.
  const head = el('div', { class: 'cluster-head' },
    el('span', { class: 'badge' }, isWrite ? select.operation : 'SELECT'),
    el('span', {}, isWrite
      ? `${select.operation} ${select.tables[0]?.name ?? ''}`.trim()
      : isMain ? 'MAIN 쿼리' : `${select.id} · ${ORIGIN_LABEL[select.origin] ?? select.origin}`),
    select.alias ? el('span', { class: 'origin' }, `AS ${select.alias}`) : null,
    select.setOperator ? el('span', { class: 'origin' }, select.setOperator) : null,
  );
  head.addEventListener('mouseenter', () => highlightNeighbours(id));
  head.addEventListener('mouseleave', clearHighlight);
  head.addEventListener('click', () => selectGraphNode(id));
  lineageState.nodeById.set(id, head);

  const cluster = el('div', {
    class: `cluster ${isWrite ? 'select-write' : isMain ? 'select-main' : select.role === 'UNION_BRANCH' ? 'select-union' : select.role === 'CTE' ? 'select-cte' : 'select-sub'}`,
    'data-select-id': select.id,
    'data-layout-key': `cluster:${select.id}`,
  }, head);
  lineageState.clusterById.set(select.id, cluster);

  const body = el('div', { class: 'cluster-body' });
  cluster.appendChild(body);

  /* The unit is the table. A cluster holds a SELECT's own clauses -
     tables, WHERE, GROUP BY/HAVING, output columns - and nothing about
     how tables attach to each other: joins are lines (below), and a
     subquery is a table of its own drawn alongside. */
  const labelOf = (t) => t.alias ?? t.name;
  const tableByLabel = new Map(select.tables.map((t) => [labelOf(t), t]));
  const tableNodeId = (name) => `tbl:${select.id}:${name}`;
  // A derived table is represented in here by its slot, not by the
  // subquery itself - the subquery lives outside this scope.
  const slotId = (childSelectId) => `subref:${select.id}:${childSelectId}`;
  const idFor = (label) => {
    const table = tableByLabel.get(label);
    if (!table) return null;
    return table.derived ? slotId(table.selectId) : tableNodeId(label);
  };

  const joinWiring = select.joins.map((join) => {
    // Resolve the joined side to the label the FROM column actually drew,
    // so an implicit (comma) join - which carries a table name where the
    // table is listed under its alias - lands on the real box instead of
    // adding a phantom one to the JOIN table.
    const named = join.alias ?? join.table;
    const right = tableByLabel.has(named)
      ? named
      : labelOf(select.tables.find((t) => t.name === join.table && !t.derived) ?? { name: named });
    const aliases = [...new Set((join.on ?? '').match(/[A-Za-z_][\w$]*(?=\s*\.)/g) ?? [])];
    const left = aliases.find((a) => a !== right && tableByLabel.has(a))
      ?? [...tableByLabel.keys()].find((l) => l !== right)
      ?? null;
    return { join, left, right };
  });

  // A subquery is never drawn inside the query that reads it: it is queued
  // as a scope of its own, drawn outside, and wired back in by a line to
  // the table slot / condition / column that reads it.
  const children = byParent.get(select.id) ?? [];
  for (const child of children) lineageState.scopeQueue.push(child);
  const inlineViews = children.filter((c) => c.origin === 'FROM' || c.origin === 'JOIN');
  const attached = children.filter((c) => !['FROM', 'JOIN'].includes(c.origin));

  const guards = isMain ? collectGuards() : [];
  // A guard whose body is a JOIN belongs to that join, not to the WHERE
  // column - otherwise join text ends up inside the table object.
  const guardByTable = new Map();
  for (const guard of guards) {
    if (!/\bJOIN\b/i.test(guard.sql)) continue;
    const target = joinWiring.find(({ join, right }) =>
      guard.sql.includes(normalizeSql(right)) || guard.sql.includes(normalizeSql(join.table)));
    if (!target) continue;
    guard.used = true;
    guardByTable.set(target.right, guard);
  }

  /* Every box on screen is a TABLE OBJECT: its inside is its own
     FROM / WHERE / SELECT, and nothing else. A table has no join among its
     properties - a join only ever makes *another* table (the JOIN 테이블),
     and the source tables point a line at it. */
  const section = (label, ...children) => {
    const kids = children.filter(Boolean);
    if (!kids.length) return null;
    return el('div', { class: 'tsec' },
      el('div', { class: 'tsec-head' }, label),
      el('div', { class: 'tsec-body' }, ...kids),
    );
  };
  const sqlLine = (text) => el('div', { class: 'sql' }, text);
  const tableObject = (nodeId, kind, name, alias, ...sections) => gnode(nodeId, `tobj ${kind}`,
    el('div', { class: 'tobj-head' },
      el('span', { class: 'badge' }, 'TABLE'),
      el('span', { class: 'tname' }, name),
      alias ? el('span', { class: 'alias' }, `(${alias})`) : null,
    ),
    ...sections.filter(Boolean),
  );

  const columnsByTable = new Map();
  for (const column of analysis.columns ?? []) {
    if (!columnsByTable.has(column.table)) columnsByTable.set(column.table, new Set());
    columnsByTable.get(column.table).add(column.column);
  }

  /* 3 - every WHERE condition is an object, with the dynamic tag that
     guards it as its own object one depth below. Built here, then placed
     inside the table object that these clauses actually belong to. */
  const conditionNodes = [];
  const conditionIds = [];
  if (select.where) {
    const conditions = splitConditions(select.where);
    // a WHERE spliced together from many fragments can have thousands of terms: one object
    // each would be thousands of boxes and edges — draw the first ones and say how many remain
    conditions.slice(0, MAX_WHERE_OBJECTS).forEach((condition, i) => {
      const condId = `where:${select.id}:${i}`;
      const normalized = normalizeSql(condition.text);
      const guard = guards.find((g) => !g.used && g.sql && (g.sql.includes(normalized) || normalized.includes(g.sql)));
      if (guard) guard.used = true;

      const stack = el('div', { class: 'cond-stack' },
        gnode(condId, 'cond',
          el('div', { class: 'title' }, el('span', { class: 'cond-kw' }, i === 0 ? 'WHERE' : condition.connector ?? 'AND')),
          el('div', { class: 'sql' }, condition.text),
        ),
      );
      if (guard) {
        const dynId = `dyn:${select.id}:${i}`;
        stack.appendChild(el('div', { class: 'cond-children' },
          gnode(dynId, 'dynamic', el('div', { class: 'title' }, guard.label)),
        ));
      }
      conditionNodes.push(stack);
      conditionIds.push({ id: condId, text: condition.text });
    });
    if (conditions.length > MAX_WHERE_OBJECTS) {
      conditionNodes.push(el('div', { class: 'cond-stack' },
        gnode(`where:${select.id}:more`, 'cond',
          el('div', { class: 'title' }, el('span', { class: 'cond-kw' }, '⋯')),
          el('div', { class: 'sql' }, `조건 ${(conditions.length - MAX_WHERE_OBJECTS).toLocaleString()}개 더 (모두 ${conditions.length.toLocaleString()}개) — 전체는 변환 탭의 쿼리에서 보세요`),
        )));
    }
  }
  // A tag that guards something other than a WHERE term - an <iterate>
  // feeding an IN list, say - is still a dynamic object of its own.
  guards.filter((g) => !g.used).forEach((g, i) => {
    const dynId = `dyn:${select.id}:extra:${i}`;
    conditionNodes.push(el('div', { class: 'cond-stack' },
      gnode(dynId, 'dynamic',
        el('div', { class: 'title' }, g.label),
        g.sql ? el('div', { class: 'sql' }, g.element.textContent.replace(/\s+/g, ' ').trim()) : null,
      ),
    ));
  });

  const aggregateNodes = [];
  let havingId = null;
  if (select.groupBy.length) {
    aggregateNodes.push(gnode(`group:${select.id}`, 'clause',
      el('div', { class: 'title' }, 'GROUP BY'),
      el('div', { class: 'sql' }, select.groupBy.join(', ')),
    ));
  }
  if (select.having) {
    havingId = `having:${select.id}`;
    aggregateNodes.push(gnode(havingId, 'clause',
      el('div', { class: 'title' }, 'HAVING'),
      el('div', { class: 'sql' }, select.having),
    ));
  }

  const outputNodes = select.outputs.map((output, i) => {
    const outId = `out:${select.id}:${i}`;
    const label = output.alias ?? output.sourceColumn ?? output.expression;
    // Only a *subquery* earns an arrow into a column; a column coming off
    // this object's own tables is said by the column being in the object.
    if (output.selectId) edge(`select:${output.selectId}`, outId, 'flow');
    return gnode(outId, 'column',
      el('div', { class: 'title' }, label),
      output.alias && output.expression !== output.alias ? el('div', { class: 'meta' }, output.expression) : null,
    );
  });

  // The clauses that describe the *result*, wherever that result lives.
  const resultSections = () => [
    section('WHERE', ...conditionNodes),
    section('GROUP BY / HAVING', ...aggregateNodes),
    section(isWrite ? select.operation : 'SELECT', ...outputNodes),
  ];

  /* 1 + 2 - one box per table, and the joins make one more table. */
  const physical = select.tables.filter((t) => !t.derived);
  const sourceCount = physical.length + inlineViews.length;
  const needsResultTable = joinWiring.length > 0 || sourceCount !== 1;

  const sourceObject = (table) => {
    const used = [...(columnsByTable.get(table.name) ?? [])];
    return tableObject(tableNodeId(labelOf(table)), 'table', table.name, table.alias,
      section('FROM', sqlLine(`${table.name}${table.alias ? ` ${table.alias}` : ''}`)),
      used.length ? section('SELECT', columnList(used, 6)) : null,
    );
  };
  // An inline view holds a table slot; the query that fills it is drawn
  // outside this scope and points at the slot.
  const slotObject = (view, ...sections) => {
    const node = tableObject(slotId(view.id), 'subref', view.alias ?? view.id, view.id,
      section('FROM', sqlLine(`(${ORIGIN_LABEL[view.origin] ?? view.origin})`)),
      ...sections,
    );
    edge(`select:${view.id}`, slotId(view.id), 'ref');
    return node;
  };

  if (!needsResultTable) {
    // One source, no join: the query *is* that table object.
    const only = physical[0];
    body.appendChild(el('div', { class: 'lane-col result' },
      only
        ? tableObject(tableNodeId(labelOf(only)), 'table', only.name, only.alias,
            section('FROM', sqlLine(`${only.name}${only.alias ? ` ${only.alias}` : ''}`)),
            ...resultSections())
        : slotObject(inlineViews[0], ...resultSections()),
    ));
  } else {
    const sourcesCol = el('div', { class: 'lane-col sources' });
    for (const table of physical) sourcesCol.appendChild(sourceObject(table));
    for (const view of inlineViews) sourcesCol.appendChild(slotObject(view));
    if (sourcesCol.children.length) body.appendChild(sourcesCol);

    const baseTable = physical[0];
    const firstDerived = select.tables.find((t) => t.derived);
    const startId = baseTable ? tableNodeId(labelOf(baseTable)) : firstDerived ? slotId(firstDerived.selectId) : null;

    const resultId = joinWiring.length ? `jointbl:${select.id}` : `result:${select.id}`;
    const feeders = new Set();
    if (startId) feeders.add(startId);
    const fromLines = [];
    if (baseTable) fromLines.push(sqlLine(`${baseTable.name}${baseTable.alias ? ` ${baseTable.alias}` : ''}`));
    for (const { join, left, right } of joinWiring) {
      const rightId = join.derived ? slotId(join.selectId) : tableNodeId(right);
      feeders.add(rightId);
      if (left) {
        const leftId = idFor(left);
        if (leftId) feeders.add(leftId);
      }
      const text = `${(join.type ?? 'JOIN').replace(/_/g, ' ')} ${join.table}${join.alias ? ` ${join.alias}` : ''}`;
      // Joined only when a dynamic tag says so: the tag is its own object,
      // one depth under the join that it guards.
      const guard = guardByTable.get(right);
      fromLines.push(guard
        ? el('div', { class: 'cond-stack' }, sqlLine(text), el('div', { class: 'cond-children' },
            gnode(`dynjoin:${select.id}:${right}`, 'dynamic', el('div', { class: 'title' }, guard.label))))
        : sqlLine(text));
    }
    for (const view of inlineViews) {
      if (feeders.has(slotId(view.id))) continue;
      feeders.add(slotId(view.id));
      fromLines.push(sqlLine(`${view.alias ?? view.id} (${ORIGIN_LABEL[view.origin] ?? view.origin})`));
    }

    body.appendChild(el('div', { class: 'lane-col result' },
      tableObject(resultId, 'jointbl', joinWiring.length ? 'JOIN 테이블' : '결과 테이블', null,
        section('FROM', ...fromLines.slice(0, 8)),
        ...resultSections()),
    ));
    for (const feeder of feeders) {
      if (feeder === resultId) continue;
      edge(feeder, resultId, joinWiring.length ? 'join' : 'flow');
    }
  }

  /* 4 - a subquery is drawn outside this scope; from out there a line runs
     into the condition, the HAVING or the column that reads it. */
  const withSelect = conditionIds.filter((c) => /\bSELECT\b/i.test(c.text));
  let nextCondition = 0;
  for (const child of attached) {
    const childId = `select:${child.id}`;
    if (child.origin === 'WHERE') {
      const target = withSelect[nextCondition++] ?? conditionIds[0];
      if (target) edge(childId, target.id, 'flow');
    } else if (child.origin === 'HAVING' && havingId) {
      edge(childId, havingId, 'flow');
    }
  }

  return cluster;
}

function renderGraph() {
  const host = document.getElementById('lineageNodes');
  lineageState.edges = [];
  lineageState.nodeById = new Map();
  lineageState.clusterById = new Map();
  host.replaceChildren();

  const analysis = lineageState.analysis;
  const lineage = analysis?.lineage;
  if (!lineage || !lineage.selects.length) {
    host.appendChild(el('div', { class: 'side-empty' },
      analysis?.warnings?.some((w) => w.code === 'SQL_PARSE_FAILED')
        ? '이 statement는 flatten된 SQL이 파싱되지 않아 (SQL_PARSE_FAILED) 리니지를 그릴 수 없습니다 — Statements 탭의 경고를 확인하세요.'
        : '그릴 리니지가 없습니다.'));
    drawEdges();
    return;
  }

  const byParent = new Map();
  for (const select of lineage.selects) {
    if (!select.parentId || select.role === 'UNION_BRANCH') continue;
    if (!byParent.has(select.parentId)) byParent.set(select.parentId, []);
    byParent.get(select.parentId).push(select);
  }

  // Subquery scopes are queued while their parent is built and drawn out
  // here, after it - never inside it.
  lineageState.scopeQueue = [];

  const roots = lineage.selects.filter((s) => s.role === 'MAIN' || s.role === 'WRITE');
  const branches = lineage.selects.filter((s) => s.role === 'UNION_BRANCH');

  if (branches.length) {
    // A UNION is one result built from several branches, so it gets one
    // box around them rather than sibling clusters tied together by
    // reference arrows.
    const operator = branches.find((b) => b.setOperator)?.setOperator ?? 'UNION';
    const group = el('div', { class: 'cluster union-group', 'data-layout-key': 'cluster:union' },
      el('div', { class: 'cluster-head' },
        el('span', { class: 'badge' }, operator),
        el('span', {}, `${roots.length + branches.length}개 브랜치가 하나의 결과로`),
      ),
      el('div', { class: 'cluster-body union-body' },
        ...roots.map((select) => buildSelectCluster(select, byParent, analysis, true)),
        ...branches.map((branch) => buildSelectCluster(branch, byParent, analysis, false)),
      ),
    );
    host.appendChild(group);
  } else {
    for (const select of roots) host.appendChild(buildSelectCluster(select, byParent, analysis, true));
  }

  const drawn = new Set([...roots, ...branches].map((s) => s.id));
  while (lineageState.scopeQueue.length) {
    const next = lineageState.scopeQueue.shift();
    if (drawn.has(next.id)) continue;
    drawn.add(next.id);
    host.appendChild(buildSelectCluster(next, byParent, analysis, false));
  }

  applyLayoutOffsets();
  applySearchHighlight();
  redrawEdgesWhenVisible();
}

/* ------------------------------------------------------------------ *
 * Edge layer - measured from the laid-out boxes                        *
 * ------------------------------------------------------------------ */

/**
 * Edges are geometry, so they can only be computed once the boxes have
 * been laid out - and a box on a `hidden` screen has no geometry at all
 * (`offsetParent === null`), which would silently produce an empty edge
 * layer. Retry across frames until the graph is really on screen.
 */
function redrawEdgesWhenVisible(attempts = 20) {
  const viewport = document.getElementById('lineageViewport');
  const content = document.getElementById('lineageNodes');
  if (!viewport || !content) return;
  if (!viewport.clientWidth || !content.scrollWidth) {
    if (attempts > 0) requestAnimationFrame(() => redrawEdgesWhenVisible(attempts - 1));
    return;
  }
  drawEdges();
  renderMinimap();
}

/** The box on screen for a node id (null when it isn't laid out). */
function visibleAnchor(nodeId) {
  const node = lineageState.nodeById.get(nodeId);
  return node && node.offsetParent !== null ? node : null;
}

/** One arrowhead per edge kind; markers don't inherit `stroke`, so each needs its own fill. */
function arrowDefs() {
  const NS = 'http://www.w3.org/2000/svg';
  const defs = document.createElementNS(NS, 'defs');
  for (const [kind, variable] of [['flow', '--edge'], ['join', '--edge-join'], ['ref', '--edge-ref']]) {
    const marker = document.createElementNS(NS, 'marker');
    marker.setAttribute('id', `arrow-${kind}`);
    marker.setAttribute('viewBox', '0 0 8 8');
    marker.setAttribute('refX', '7');
    marker.setAttribute('refY', '4');
    marker.setAttribute('markerWidth', '6');
    marker.setAttribute('markerHeight', '6');
    marker.setAttribute('orient', 'auto-start-reverse');
    const head = document.createElementNS(NS, 'path');
    head.setAttribute('d', 'M 0 1 L 8 4 L 0 7 z');
    head.setAttribute('fill', `var(${variable})`);
    marker.appendChild(head);
    defs.appendChild(marker);
  }
  return defs;
}

function drawEdges() {
  const svg = document.getElementById('lineageEdges');
  const content = document.getElementById('lineageNodes');
  if (!svg || !content) return;

  const scale = lineageState.scale;
  const base = content.getBoundingClientRect();
  const rect = (node) => {
    const r = node.getBoundingClientRect();
    return {
      left: (r.left - base.left) / scale,
      top: (r.top - base.top) / scale,
      width: r.width / scale,
      height: r.height / scale,
    };
  };

  svg.setAttribute('width', String(content.scrollWidth));
  svg.setAttribute('height', String(content.scrollHeight));
  svg.replaceChildren(arrowDefs());
  // wide invisible strokes over the edges, so a 1.5px line can be grabbed (own group:
  // the highlight code only touches `#lineageEdges > path`)
  const hits = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  hits.setAttribute('class', 'edge-hits');

  lineageState.edges.forEach((e, index) => {
    const fromEl = visibleAnchor(e.from);
    const toEl = visibleAnchor(e.to);
    if (!fromEl || !toEl || fromEl === toEl) return;
    const a = rect(fromEl);
    const b = rect(toEl);

    let x1;
    let y1;
    let x2;
    let y2;
    let path;
    // Sides are picked from where the boxes are, not assumed: a dragged box can be
    // anywhere relative to the other one.
    // a user's bend: both control points shifted by it (the curve's middle moves 3/4 of that)
    const [bx, by] = lineageState.layout.offsets[edgeKey(e)] ?? [0, 0];
    const curve = (c1x, c1y, c2x, c2y) => `M ${x1} ${y1} C ${c1x + bx} ${c1y + by}, ${c2x + bx} ${c2y + by}, ${x2} ${y2}`;
    const horizontal = (fromRight) => {
      x1 = fromRight ? a.left + a.width : a.left; y1 = a.top + a.height / 2;
      x2 = fromRight ? b.left : b.left + b.width; y2 = b.top + b.height / 2;
      const dx = Math.max(18, Math.abs(x2 - x1) / 2) * (fromRight ? 1 : -1);
      return curve(x1 + dx, y1, x2 - dx, y2);
    };
    const vertical = (fromBottom) => {
      x1 = a.left + a.width / 2; y1 = fromBottom ? a.top + a.height : a.top;
      x2 = b.left + b.width / 2; y2 = fromBottom ? b.top : b.top + b.height;
      const dy = Math.max(14, Math.abs(y2 - y1) / 2) * (fromBottom ? 1 : -1);
      return curve(x1, y1 + dy, x2, y2 - dy);
    };
    if (b.left >= a.left + a.width - 8) path = horizontal(true); // left -> right: source -> output
    else if (b.top >= a.top + a.height - 8) path = vertical(true); // stacked: bottom -> top
    else if (b.left + b.width <= a.left + 8) path = horizontal(false); // a reference pointing back left
    else if (b.top + b.height <= a.top + 8) path = vertical(false); // b above a
    else path = horizontal(b.left + b.width / 2 >= a.left + a.width / 2); // overlapping: by centres

    const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    el.setAttribute('d', path);
    const kind = e.kind === 'ref' ? 'ref' : e.kind === 'join' ? 'join' : 'flow';
    el.setAttribute('class', kind === 'flow' ? '' : kind);
    // Direction matters here - the whole point is reading which way the
    // relation flows - so every edge gets a head.
    el.setAttribute('marker-end', `url(#arrow-${kind})`);
    el.dataset.edgeIndex = String(index);
    el.dataset.from = e.from;
    el.dataset.to = e.to;
    if (lineageState.selectedEdge === edgeKey(e)) el.classList.add('selected');
    if (bx || by) el.classList.add('bent');
    svg.appendChild(el);

    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hit.setAttribute('d', path);
    hit.setAttribute('class', 'edge-hit');
    hit.dataset.edgeKey = edgeKey(e);
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `${e.from} → ${e.to}\n드래그: 휘기 · 더블클릭: 곧게 · 클릭: 양 끝 강조`;
    hit.appendChild(title);
    hits.appendChild(hit);
  });
  svg.appendChild(hits);
}

/** an edge's layout key: its two ends and kind (stable across redraws and reloads) */
function edgeKey(e) {
  return `edge:${e.kind ?? 'flow'}:${e.from}>${e.to}`;
}

/** Clicking an edge highlights it and its two boxes; clicking it again (or the background) clears it. */
function selectEdge(key) {
  lineageState.selectedEdge = lineageState.selectedEdge === key ? null : key;
  const edge = lineageState.edges.find((e) => edgeKey(e) === lineageState.selectedEdge);
  for (const [id, node] of lineageState.nodeById) node.classList.toggle('edge-end', Boolean(edge) && (id === edge.from || id === edge.to));
  drawEdges();
}

/* ------------------------------------------------------------------ *
 * Hover / selection / search highlighting                              *
 * ------------------------------------------------------------------ */
function highlightNeighbours(nodeId) {
  const related = new Set([nodeId]);
  for (const e of lineageState.edges) {
    if (e.from === nodeId) related.add(e.to);
    if (e.to === nodeId) related.add(e.from);
  }
  for (const [id, node] of lineageState.nodeById) {
    node.classList.toggle('dim', !related.has(id));
  }
  for (const path of document.querySelectorAll('#lineageEdges > path, #lineageEdges > text')) {
    const touches = path.dataset.from === nodeId || path.dataset.to === nodeId;
    path.classList.toggle('hi', touches);
    path.classList.toggle('dim', !touches);
  }
}

function clearHighlight() {
  for (const node of lineageState.nodeById.values()) node.classList.remove('dim');
  for (const path of document.querySelectorAll('#lineageEdges > path, #lineageEdges > text')) path.classList.remove('dim', 'hi');
  if (lineageState.selectedColumn !== null) highlightColumnPath(lineageState.selectedColumn);
}

function selectGraphNode(nodeId) {
  lineageState.selectedNodeId = nodeId;
  for (const [id, node] of lineageState.nodeById) node.classList.toggle('selected', id === nodeId);
  renderNodeDetail(nodeId);
  renderBreadcrumb(breadcrumbFor(nodeId));
}

function breadcrumbFor(nodeId) {
  const lineage = lineageState.analysis?.lineage;
  if (!lineage) return [];
  const [kind, selectId] = nodeId.split(':');
  const byId = new Map(lineage.selects.map((s) => [s.id, s]));
  const chain = [];
  let current = byId.get(selectId);
  while (current) {
    chain.unshift(current.role === 'MAIN' ? 'Main SELECT' : `${current.id} · ${ORIGIN_LABEL[current.origin] ?? current.origin}`);
    current = current.parentId ? byId.get(current.parentId) : null;
  }
  const tail = { tbl: 'TABLE', jointbl: 'JOIN 테이블', out: 'COLUMN', join: 'JOIN', dyn: 'DYNAMIC', dynjoin: 'DYNAMIC', where: 'WHERE', group: 'GROUP BY', having: 'HAVING' }[kind];
  const node = lineageState.nodeById.get(nodeId);
  if (tail && node) chain.push(`${tail} ${node.querySelector('.title')?.textContent ?? ''}`.trim());
  return chain;
}

function renderBreadcrumb(chain) {
  const host = document.getElementById('lineageBreadcrumb');
  const parts = [lineageState.statementId ?? '', ...chain].filter(Boolean);
  host.replaceChildren(...parts.flatMap((part, i) => [
    i ? el('span', { class: 'sep' }, '›') : null,
    el('span', { class: `crumb${i === parts.length - 1 ? ' current' : ''}` }, part),
  ].filter(Boolean)));
}

function applySearchHighlight() {
  const term = lineageState.search;
  for (const node of lineageState.nodeById.values()) {
    node.classList.toggle('search-hit', Boolean(term) && node.textContent.toLowerCase().includes(term));
  }
}

/** `ORDERS.ORDER_DATE -> S1.LAST_ORDER_DATE -> MAIN.lastOrderDate`, lit up across the graph. */
function highlightColumnPath(index) {
  const lineage = lineageState.analysis?.lineage;
  if (!lineage) return;
  const entry = lineage.columnLineage[index];
  if (!entry) return;

  const ids = new Set([`out:MAIN:${index}`]);
  for (const hop of entry.path) {
    ids.add(`select:${hop.selectId}`);
    const inner = lineage.selects.find((s) => s.id === hop.selectId);
    for (const table of inner?.tables ?? []) {
      if (!table.derived) ids.add(`tbl:${inner.id}:${table.alias ?? table.name}`);
    }
  }
  if (entry.sourceTable) {
    for (const select of lineage.selects) {
      for (const table of select.tables) {
        if (table.name === entry.sourceTable) ids.add(`tbl:${select.id}:${table.alias ?? table.name}`);
      }
    }
  }
  for (const [id, node] of lineageState.nodeById) node.classList.toggle('lineage-hi', ids.has(id));
  for (const path of document.querySelectorAll('#lineageEdges > path, #lineageEdges > text')) {
    path.classList.toggle('hi', ids.has(path.dataset.from) && ids.has(path.dataset.to));
  }
}

/* ------------------------------------------------------------------ *
 * 컬럼 삭제 가이드 (GET /statements/:id/column-guide)                    *
 * Where to edit to drop one output column — its trace down the SELECT *
 * hierarchy, then every place in the XML: the select items, the <sql>  *
 * fragments (shared or removable, with their <include> sites), the     *
 * resultMap mappings, and the other clauses that still use it. Only a  *
 * guide: nothing is edited.                                            *
 * ------------------------------------------------------------------ */
const GUIDE_ACTIONS = {
  REMOVE_SELECT_ITEM: ['삭제', 'SELECT 항목'],
  REMOVE_FRAGMENT: ['삭제', '<sql> fragment 통째로'],
  REMOVE_INCLUDE: ['삭제', '<include refid>'],
  REMOVE_RESULT_MAPPING: ['삭제', 'resultMap 매핑'],
  REMOVE_DYNAMIC_TAG: ['삭제', '동적 태그'],
  SHARED_FRAGMENT: ['먼저 확인', '공유 fragment'],
  SHARED_RESULT_MAP: ['먼저 확인', '공유 resultMap'],
  CHECK_JAVA: ['먼저 확인', 'Java 필드'],
  CHECK_REFERENCE: ['함께 확인', '다른 절에서 사용'],
};

function guideTrace(node, depth = 0) {
  if (node.base) {
    return el('li', { class: 'gt-base' }, el('span', { class: 'gt-tag' }, '테이블'), el('span', { class: 'mono' }, `${node.table ?? '?'}.${node.column}`));
  }
  const scope = node.selectId === 'MAIN' ? '결과' : `${node.selectId}${node.scopeAlias ? ` · ${node.origin} ${node.scopeAlias}` : ''}`;
  return el('li', {},
    el('span', { class: 'gt-tag' }, scope),
    el('span', { class: 'mono' }, `${node.expression}${node.alias ? ` AS ${node.alias}` : ''}`),
    node.aggregate ? el('span', { class: 'gt-agg' }, '집계') : null,
    node.sources.length ? el('ul', {}, ...node.sources.map((s) => guideTrace(s, depth + 1))) : null);
}

async function openColumnGuide(column) {
  const dialog = document.getElementById('guideDialog');
  const body = document.getElementById('guideBody');
  const id = lineageState.statementId;
  document.getElementById('guideTitle').textContent = `컬럼 삭제 가이드 · ${column}`;
  body.replaceChildren(el('div', { class: 'side-empty' }, '추적 중…'));
  if (!dialog.open) dialog.showModal();
  let guide;
  try {
    guide = await api(`/api/v1/statements/${encodeURIComponent(id)}/column-guide?column=${encodeURIComponent(column)}`);
  } catch (e) {
    body.replaceChildren(el('div', { class: 'sm-callout error' }, `가이드를 만들 수 없습니다: ${e.message}`));
    return;
  }
  // what is shared comes first: it decides whether the deletions below may be done as they are
  const groups = ['먼저 확인', '삭제', '함께 확인'].map((title) => [title, guide.steps.filter((s) => GUIDE_ACTIONS[s.action]?.[0] === title)]);
  let n = 0;
  body.replaceChildren(...[
    el('p', { class: 'gd-lead' }, el('span', { class: 'mono' }, id), ' — 직접 수정하지 않습니다. 아래 위치를 차례로 고치세요.'),
    ...guide.notes.map((note) => el('div', { class: 'sm-callout' }, note)),
    guide.trace.length
      ? el('section', { class: 'gd-section' }, el('h3', {}, '컬럼 추적 (결과 → 원본)'), el('ul', { class: 'gd-trace' }, ...guide.trace.map((t) => guideTrace(t))))
      : null,
    ...groups.filter(([, steps]) => steps.length).map(([title, steps]) => el('section', { class: `gd-section gd-${title === '삭제' ? 'remove' : title === '먼저 확인' ? 'first' : 'check'}` },
      el('h3', {}, title, el('span', { class: 'gd-count' }, String(steps.length))),
      el('ol', { class: 'gd-steps' }, ...steps.map((step) => el('li', { value: String(++n) },
        el('div', { class: 'gd-step-head' },
          el('span', { class: 'gd-kind' }, GUIDE_ACTIONS[step.action]?.[1] ?? step.action),
          step.level === 'inner' ? el('span', { class: 'gd-tag' }, '안쪽 쿼리') : null,
          step.fragment ? el('span', { class: 'gd-tag' }, `<sql> ${step.fragment}`) : null,
          el('span', { class: 'gd-loc mono' }, `${step.file}:${step.line}`)),
        step.text ? el('code', { class: 'gd-code' }, step.text) : null,
        el('div', { class: 'gd-why' }, step.reason),
        step.sharedBy?.length
          ? el('details', { class: 'gd-shared' }, el('summary', {}, `함께 쓰는 statement ${step.sharedBy.length}개`), el('ul', {}, ...step.sharedBy.map((s) => el('li', { class: 'mono' }, s))))
          : null,
      )))),
    ),
    guide.steps.length ? null : el('div', { class: 'side-empty' }, '고칠 곳을 찾지 못했습니다.'),
  ].filter(Boolean));
}

/* ------------------------------------------------------------------ *
 * Right panel                                                          *
 * ------------------------------------------------------------------ */
function sideCard(title, count, ...body) {
  return el('div', { class: 'side-card' },
    el('div', { class: 'side-head' }, title, count === undefined ? null : el('span', { class: 'n' }, String(count))),
    el('div', { class: 'side-body' }, ...body),
  );
}

/** resultMap (following `extends`) or resultClass — how the aliases land in Java. */
function resultMapChain(name) {
  // resolved by the server with the resolver's rules and sent with the statement, leaf first
  if (!name) return [];
  return (lineageState.doc?.resultMaps ?? []).map((entry) => {
    const dot = entry.qualifiedId.lastIndexOf('.');
    return parseSlice(entry.xml, dot === -1 ? null : entry.qualifiedId.slice(0, dot));
  }).filter(Boolean);
}

function renderRightPanel() {
  const host = document.getElementById('lineageRight');
  const analysis = lineageState.analysis;
  if (!analysis) {
    host.replaceChildren();
    return;
  }
  const lineage = analysis.lineage ?? { selects: [], columnLineage: [] };

  /* 1. alias -> source table.column */
  const columnRows = lineage.columnLineage.map((entry, i) => {
    const row = el('tr', {
      class: 'clickable',
      onclick: () => {
        lineageState.selectedColumn = lineageState.selectedColumn === i ? null : i;
        for (const tr of host.querySelectorAll('tr.clickable')) tr.classList.remove('selected');
        if (lineageState.selectedColumn === null) {
          for (const node of lineageState.nodeById.values()) node.classList.remove('lineage-hi');
          for (const path of document.querySelectorAll('#lineageEdges > path, #lineageEdges > text')) path.classList.remove('hi');
        } else {
          row.classList.add('selected');
          highlightColumnPath(i);
        }
      },
    },
      el('td', {}, String(i + 1)),
      el('td', { class: 'mono' }, entry.expression),
      el('td', { class: 'mono' }, entry.alias ?? '—'),
      // Table and column on their own lines: `PRODUCT.PRODUCT_ID` does
      // not fit the panel width, and wrapping it mid-word ("PRODUCT.PRO
      // DUCT_ID") is worse than eliding it.
      el('td', { class: 'mono src', title: entry.sourceTable ? `${entry.sourceTable}${entry.sourceColumn ? `.${entry.sourceColumn}` : ''}` : '' },
        entry.sourceTable
          ? [el('span', { class: 't' }, entry.sourceTable), entry.sourceColumn ? el('span', { class: 'c' }, entry.sourceColumn) : null]
          : '—'),
      el('td', {}, el('button', {
        class: 'tool-btn guide-btn',
        type: 'button',
        title: '이 결과 컬럼을 없애려면 고칠 곳 (refid·resultMap 포함)',
        onclick: (e) => {
          e.stopPropagation();
          openColumnGuide(entry.alias ?? entry.sourceColumn ?? String(entry.expression).split('.').pop());
        },
      }, '가이드')),
    );
    return row;
  });

  const columnCard = sideCard('SELECT 컬럼 매핑', lineage.columnLineage.length,
    columnRows.length
      ? el('table', { class: 'data lineage-cols' },
        el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'SQL Expression'), el('th', {}, 'Alias'), el('th', {}, 'Source'), el('th', { title: '컬럼 삭제 가이드' }, ''))),
        el('tbody', {}, ...columnRows))
      : el('div', { class: 'side-empty' }, 'no resolved output columns'),
  );

  /* 2. Java mapping */
  const resultMapName = lineageState.stmtEl?.getAttribute('resultMap');
  const resultClass = lineageState.stmtEl?.getAttribute('resultClass');
  const chain = resultMapName ? resultMapChain(resultMapName) : [];
  const javaRows = chain.flatMap((element) => [...element.children]
    .filter((c) => c.tagName === 'result' || c.tagName === 'id')
    .map((c) => el('tr', {},
      el('td', { class: 'mono' }, c.getAttribute('column') ?? '—'),
      el('td', {}, '→'),
      el('td', { class: 'mono' }, c.getAttribute('property') ?? '—'),
      el('td', {}, c.getAttribute('javaType') ?? ''),
    )));
  const javaCard = el('div', { class: 'side-card java' },
    el('div', { class: 'side-head' }, 'Java 매핑', el('span', { class: 'n' }, resultMapName ?? resultClass ?? '—')),
    el('div', { class: 'side-body' },
      javaRows.length
        ? el('table', { class: 'data' },
          el('thead', {}, el('tr', {}, el('th', {}, 'Column'), el('th', {}), el('th', {}, 'Property'), el('th', {}, 'Type'))),
          el('tbody', {}, ...javaRows))
        : el('div', { class: 'side-empty' }, resultClass
          ? `resultClass="${resultClass}" — 컬럼명이 그대로 필드에 매핑됩니다.`
          : 'resultMap / resultClass 없음'),
      chain.length > 1
        ? el('div', { class: 'side-empty' }, `extends: ${chain.map((c) => c.getAttribute('id')).join(' ← ')}`)
        : null,
    ),
  );

  /* 3. joins */
  const joinRows = lineage.selects.flatMap((select) => select.joins.map((join) => el('tr', {},
    el('td', { class: 'mono' }, select.id),
    el('td', {}, el('span', { class: `join-type ${join.type}` }, join.type.replace(/_/g, ' '))),
    el('td', { class: 'mono' }, join.table),
    el('td', { class: 'mono' }, join.on ?? '—'),
  )));
  const joinCard = sideCard('조인 관계', joinRows.length,
    joinRows.length
      ? el('table', { class: 'data compact-first' },
        el('thead', {}, el('tr', {}, el('th', {}, 'In'), el('th', {}, 'Type'), el('th', {}, 'Table'), el('th', {}, 'On'))),
        el('tbody', {}, ...joinRows))
      : el('div', { class: 'side-empty' }, 'no joins'),
  );

  /* 4. subqueries */
  const subqueries = lineage.selects.filter((s) => s.role !== 'MAIN');
  const subCard = sideCard('서브쿼리 / UNION 요약', subqueries.length,
    subqueries.length
      ? el('table', { class: 'data compact-first' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Id'), el('th', {}, 'Kind'), el('th', {}, 'Depth'), el('th', {}, 'Tables'))),
        el('tbody', {}, ...subqueries.map((s) => el('tr', {
          class: 'clickable',
          onclick: () => selectGraphNode(`select:${s.id}`),
        },
          el('td', { class: 'mono' }, s.id),
          el('td', {}, ORIGIN_LABEL[s.origin] ?? s.origin),
          el('td', {}, String(s.depth)),
          el('td', { class: 'mono' }, s.tables.map((t) => t.name).join(', ') || '—'),
        ))))
      : el('div', { class: 'side-empty' }, 'no subqueries'),
  );

  /* 5. selected node detail + minimap */
  const detailCard = sideCard('선택한 노드', undefined, el('div', { class: 'side-empty', id: 'lineageNodeDetail' }, '그래프에서 노드를 클릭하세요.'));
  const minimapCard = el('div', { class: 'side-card' },
    el('div', { class: 'side-head' }, '미니맵'),
    el('div', { class: 'minimap', id: 'lineageMinimap' }),
  );

  host.replaceChildren(columnCard, javaCard, joinCard, subCard, detailCard, minimapCard);
  renderMinimap();
}

function renderNodeDetail(nodeId) {
  const host = document.getElementById('lineageNodeDetail');
  if (!host) return;
  const node = lineageState.nodeById.get(nodeId);
  if (!node) return;
  const [kind] = nodeId.split(':');
  const lines = [...node.querySelectorAll('.title, .sql, .meta')].map((n) => n.textContent.trim()).filter(Boolean);
  host.replaceChildren(
    el('div', { class: 'mono', style: 'font-size:0.68rem;color:var(--text-faint)' }, `${kind} · ${nodeId}`),
    ...lines.map((line) => el('div', { class: 'mono', style: 'word-break:break-word' }, line)),
  );
}

/* ------------------------------------------------------------------ *
 * Legend                                                               *
 * ------------------------------------------------------------------ */
function renderLegend() {
  const host = document.getElementById('lineageLegend');
  const swatch = (varName) => el('span', { class: 'legend-swatch', style: `background:var(${varName})` });
  host.replaceChildren(
    el('span', { class: 'legend-item' }, swatch('--node-table-bg'), '테이블'),
    el('span', { class: 'legend-item' }, swatch('--node-sub-bg'), '서브쿼리 / inline view'),
    el('span', { class: 'legend-item' }, swatch('--node-union-bg'), 'UNION / CTE'),
    el('span', { class: 'legend-item' }, swatch('--node-col-bg'), '최종 SELECT 컬럼'),
    el('span', { class: 'legend-item' }, swatch('--node-join-bg'), 'JOIN 테이블 / WHERE 조건'),
    el('span', { class: 'legend-item' }, el('span', { class: 'legend-swatch', style: 'border-style:dashed;background:transparent' }), '동적 조건'),
    el('span', { class: 'legend-item' }, el('span', { class: 'legend-line' }), '데이터 흐름'),
    el('span', { class: 'legend-item' }, el('span', { class: 'legend-line ref' }), '참조 (dynamic)'),
    el('span', { class: 'legend-item' }, el('span', { class: 'legend-line join' }), '조인'),
  );
}

/* ------------------------------------------------------------------ *
 * Zoom / pan / minimap                                                 *
 * ------------------------------------------------------------------ */
function applyTransform() {
  const content = document.getElementById('lineageContent');
  content.style.transform = `translate(${lineageState.tx}px, ${lineageState.ty}px) scale(${lineageState.scale})`;
  document.getElementById('lineageZoomLevel').textContent = `${Math.round(lineageState.scale * 100)}%`;
  renderMinimap();
}

function setScale(next, originX, originY) {
  const viewport = document.getElementById('lineageViewport');
  const clamped = Math.min(2.5, Math.max(0.2, next));
  const rect = viewport.getBoundingClientRect();
  const cx = originX ?? rect.width / 2;
  const cy = originY ?? rect.height / 2;
  // Keep the point under the cursor fixed while zooming.
  lineageState.tx = cx - ((cx - lineageState.tx) * clamped) / lineageState.scale;
  lineageState.ty = cy - ((cy - lineageState.ty) * clamped) / lineageState.scale;
  lineageState.scale = clamped;
  applyTransform();
}

/**
 * Fitting needs real box sizes, and a hidden screen has none - selecting
 * a statement while another tab is open (or right after `analyze`, before
 * `showTab`) would otherwise fit to a 0-wide viewport. So retry across a
 * few frames until the screen is actually laid out.
 */
function fitGraphWhenVisible(attempts = 20) {
  const viewport = document.getElementById('lineageViewport');
  const content = document.getElementById('lineageNodes');
  if (!viewport || !content) return;
  if (!viewport.clientWidth || !content.scrollWidth) {
    if (attempts > 0) requestAnimationFrame(() => fitGraphWhenVisible(attempts - 1));
    return;
  }
  fitGraph();
}

function fitGraph() {
  const viewport = document.getElementById('lineageViewport');
  const content = document.getElementById('lineageNodes');
  if (!viewport || !content) return;
  const width = content.scrollWidth + 32;
  const height = content.scrollHeight + 32;
  if (!viewport.clientWidth || !content.scrollWidth) return;
  const scale = Math.min(1, Math.min(viewport.clientWidth / width, viewport.clientHeight / height));
  lineageState.scale = Math.max(0.2, scale);
  lineageState.tx = 8;
  lineageState.ty = 8;
  lineageState.fitted = true;
  applyTransform();
  drawEdges();
}

function renderMinimap() {
  const host = document.getElementById('lineageMinimap');
  const content = document.getElementById('lineageNodes');
  const viewport = document.getElementById('lineageViewport');
  if (!host || !content || !viewport) return;

  const width = Math.max(content.scrollWidth, 1);
  const height = Math.max(content.scrollHeight, 1);
  const base = content.getBoundingClientRect();
  const scale = lineageState.scale;

  const rects = [];
  for (const node of content.querySelectorAll('.gnode')) {
    if (node.offsetParent === null) continue;
    const r = node.getBoundingClientRect();
    rects.push({
      x: (r.left - base.left) / scale,
      y: (r.top - base.top) / scale,
      w: r.width / scale,
      h: r.height / scale,
    });
  }

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  for (const r of rects) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(r.x));
    rect.setAttribute('y', String(r.y));
    rect.setAttribute('width', String(Math.max(r.w, 4)));
    rect.setAttribute('height', String(Math.max(r.h, 4)));
    rect.setAttribute('class', 'mm-node');
    svg.appendChild(rect);
  }
  const view = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  view.setAttribute('x', String(-lineageState.tx / scale));
  view.setAttribute('y', String(-lineageState.ty / scale));
  view.setAttribute('width', String(viewport.clientWidth / scale));
  view.setAttribute('height', String(viewport.clientHeight / scale));
  view.setAttribute('class', 'mm-view');
  svg.appendChild(view);

  host.replaceChildren(svg);
  host.onclick = (e) => {
    const rect = host.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const py = ((e.clientY - rect.top) / rect.height) * height;
    lineageState.tx = viewport.clientWidth / 2 - px * lineageState.scale;
    lineageState.ty = viewport.clientHeight / 2 - py * lineageState.scale;
    applyTransform();
  };
}

/* ------------------------------------------------------------------ *
 * Wiring                                                               *
 * ------------------------------------------------------------------ */
(function wireLineageDashboard() {
  const viewport = document.getElementById('lineageViewport');
  if (!viewport) return;

  // Dragging a box: a table object moves whole (a drag that starts on one of its
  // condition / column chips moves the table, never the chip out of it); a lane or
  // group moves by its header. Under 4px it stays a click.
  let dragging = null;
  let suppressClickUntil = 0;
  viewport.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button, input, a')) return;
    // an edge: dragging bends it
    const hit = e.target.closest('.edge-hit');
    if (hit) {
      const key = hit.dataset.edgeKey;
      const [dx, dy] = lineageState.layout.offsets[key] ?? [0, 0];
      // the curve's middle moves 3/4 of a control-point shift: scale so it follows the mouse
      dragging = { element: null, key, startX: e.clientX, startY: e.clientY, dx, dy, moved: false, factor: 4 / 3 };
      e.preventDefault();
      return;
    }
    const head = e.target.closest('.cluster-head');
    const element = head ? head.closest('[data-layout-key]') : e.target.closest('.gnode.tobj') ?? e.target.closest('.gnode');
    if (!element || !viewport.contains(element)) return;
    const key = layoutKeyOf(element);
    const [dx, dy] = lineageState.layout.offsets[key] ?? [0, 0];
    dragging = { element, key, startX: e.clientX, startY: e.clientY, dx, dy, moved: false };
    e.preventDefault(); // no text selection while dragging
  });
  let edgeFrame = 0;
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const mx = e.clientX - dragging.startX;
    const my = e.clientY - dragging.startY;
    if (!dragging.moved && Math.hypot(mx, my) < 4) return;
    if (!dragging.moved) {
      dragging.moved = true;
      dragging.element?.classList.add('dragging');
      viewport.classList.add('moving');
    }
    const f = dragging.factor ?? 1;
    const next = [Math.round(dragging.dx + (mx * f) / lineageState.scale), Math.round(dragging.dy + (my * f) / lineageState.scale)];
    if (dragging.element) dragging.element.style.translate = `${next[0]}px ${next[1]}px`;
    lineageState.layout.offsets[dragging.key] = next;
    if (!edgeFrame) edgeFrame = requestAnimationFrame(() => { edgeFrame = 0; drawEdges(); });
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    if (!dragging.moved && dragging.key.startsWith('edge:')) {
      selectEdge(dragging.key);
      suppressClickUntil = Date.now() + 80; // the background click would clear it again
    } else if (dragging.moved) {
      dragging.element?.classList.remove('dragging');
      viewport.classList.remove('moving');
      const [x, y] = lineageState.layout.offsets[dragging.key];
      if (!x && !y) delete lineageState.layout.offsets[dragging.key];
      suppressClickUntil = Date.now() + 80; // the click that ends a drag is not a selection
      drawEdges();
      renderMinimap();
      renderLayoutStatus();
    }
    dragging = null;
  });
  // double-click an edge: straight again
  viewport.addEventListener('dblclick', (e) => {
    const hit = e.target.closest('.edge-hit');
    if (!hit || !lineageState.layout.offsets[hit.dataset.edgeKey]) return;
    delete lineageState.layout.offsets[hit.dataset.edgeKey];
    drawEdges();
    renderLayoutStatus();
  });
  viewport.addEventListener('click', (e) => {
    if (Date.now() < suppressClickUntil) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
  // Ctrl/Cmd+S saves the arrangement while the lineage view is open
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's' || state.activeView !== 'lineage' || document.getElementById('app').hidden) return;
    e.preventDefault();
    if (layoutDirty()) saveLayout().catch((err) => { document.getElementById('layoutStatus').textContent = `저장 실패: ${err.message}`; });
  });

  let panning = null;
  viewport.addEventListener('mousedown', (e) => {
    if (e.target.closest('.gnode, .cluster-head, .edge-hit')) return;
    panning = { x: e.clientX - lineageState.tx, y: e.clientY - lineageState.ty };
    viewport.classList.add('panning');
  });
  window.addEventListener('mousemove', (e) => {
    if (!panning) return;
    lineageState.tx = e.clientX - panning.x;
    lineageState.ty = e.clientY - panning.y;
    applyTransform();
  });
  window.addEventListener('mouseup', () => {
    panning = null;
    viewport.classList.remove('panning');
  });
  viewport.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 2) return;
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    setScale(lineageState.scale * (e.deltaY < 0 ? 1.1 : 0.9), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });
  viewport.addEventListener('click', (e) => {
    if (e.target.closest('.gnode, .cluster-head')) return;
    lineageState.selectedNodeId = null;
    for (const node of lineageState.nodeById.values()) node.classList.remove('selected');
    if (lineageState.selectedEdge) selectEdge(lineageState.selectedEdge);
  });

  document.querySelector('.dash-toolbar').addEventListener('click', (e) => {
    const action = e.target.closest('[data-graph-action]')?.dataset.graphAction;
    if (!action) return;
    if (action === 'zoom-in') setScale(lineageState.scale * 1.2);
    else if (action === 'zoom-out') setScale(lineageState.scale / 1.2);
    else if (action === 'fit') fitGraph();
    else if (action === 'save-layout') saveLayout().catch((err) => { document.getElementById('layoutStatus').textContent = `저장 실패: ${err.message}`; });
    else if (action === 'reset-layout') resetLayout();
  });

  // typing filters the tree to the hits (debounced; the server searches ids, paths and mapper text)
  let searchTimer = 0;
  let searchSeq = 0;
  const searchBox = document.getElementById('lineageSearch');
  searchBox.addEventListener('input', (e) => {
    lineageState.search = e.target.value.trim().toLowerCase();
    applySearchHighlight(); // the open statement's graph, at once
    clearTimeout(searchTimer);
    if (!lineageState.search) {
      lineageState.searchResult = null;
      renderXmlTree();
      return;
    }
    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      const term = lineageState.search;
      try {
        const result = await api(`/api/v1/search?q=${encodeURIComponent(term)}`);
        if (seq !== searchSeq || term !== lineageState.search) return; // typed on meanwhile
        lineageState.searchResult = result;
        renderXmlTree();
      } catch (err) {
        if (seq === searchSeq) document.getElementById('lineageTree').prepend(el('div', { class: 'tree-search-summary error' }, `검색 실패: ${err.message}`));
      }
    }, 180);
  });
  // Enter opens the first statement found; Escape clears the search
  searchBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = document.querySelector('#lineageTree .node[data-statement-id]');
      if (first) selectLineageStatement(first.dataset.statementId);
    } else if (e.key === 'Escape' && searchBox.value) {
      searchBox.value = '';
      searchBox.dispatchEvent(new Event('input'));
    }
  });

  window.addEventListener('resize', () => {
    if (state.activeTab === 'lineage') {
      drawEdges();
      renderMinimap();
    }
  });
})();
