'use strict';

/* ------------------------------------------------------------------ *
 * 변환 view                                                            *
 *                                                                      *
 * The second view of the selected statement. Its subject is the        *
 * old -> new SCHEMA migration (table / column renames, `converter/     *
 * schema`), with the dataset chosen in its toolbar. The iBATIS ->      *
 * MyBatis SYNTAX conversion is a toggle on top of it:                  *
 *                                                                      *
 *   off  original iBATIS  ->  iBATIS with the renames applied           *
 *   on   original iBATIS  ->  MyBatis with the renames applied          *
 *                                                                      *
 * Every change is marked, and the two kinds never share a colour:      *
 * renames are red (removed) / green (added), syntax conversion is      *
 * violet. Both sides are rendered by the server from ASTs in the same  *
 * layout, so the panes pair up line by line; the markings come from    *
 * token diffs between those four texts (iBATIS/MyBatis x before/after  *
 * the renames), so a rename is only ever marked where the converter    *
 * actually renamed something. The browser never rewrites SQL.          *
 *                                                                      *
 * Also here: the rename list, "검토 필요" (WARNING / MANUAL from both   *
 * conversions), the MyBatis conversion's own graded decisions when the *
 * toggle is on, and Δ badges on the tree while this view is open (the  *
 * lineage view shows no conversion output).                            *
 * ------------------------------------------------------------------ */

const schemaState = {
  result: null, // POST /schema-migration?file= response for the selected statement's file
  results: new Map(), // `${key}|${file}` -> that response; the last few files only
  summary: null, // POST /schema-summary: per-statement counts (tree badges) + project total
  summaryKey: null,
  datasets: [], // GET /datasets summaries
  datasetsLoaded: false,
  datasetId: readStored('schema.datasetId'),
  preserveResultColumnNames: readStored('schema.preserve') === 'true',
  formatSql: readStored('schema.formatSql') === 'true',
  // refid: below the query (default) or spliced into it under each <include> line
  inlineRefid: readStored('schema.inlineRefid') === 'true', // "쿼리 정렬": pretty-print each SQL block (server-side, MyBatis-aware)
  mybatis: readStored('schema.mybatis') === 'true', // the syntax-conversion toggle
  scope: 'statement', // 'statement' | 'file'
  onlyChanged: false,
};

function readStored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeStored(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch { /* storage unavailable: the choice just isn't remembered */ }
}

const SCHEMA_CODE_LABEL = {
  TABLE_RENAMED: '테이블 변경',
  COLUMN_RENAMED: '컬럼 변경',
  COLUMN_ASSUMED: '컬럼 변경 (추정)',
  COLUMN_AMBIGUOUS: '모호한 컬럼',
  UNRESOLVED_QUALIFIER: '알 수 없는 별칭',
  NO_TABLE_CONTEXT: '테이블 문맥 없음',
  RESULT_COLUMN_RENAMED: '결과 컬럼명 변경',
  RESULT_COLUMN_ALIASED: '결과 컬럼명 유지',
  RUNTIME_SUBSTITUTION: '${} 런타임 치환',
  DYNAMIC_IDENTIFIER: '런타임 생성 테이블명',
  HINT_NOT_MIGRATED: '힌트 미변환',
  FRAGMENT_CONTEXT_INFERRED: 'fragment 문맥 추론',
  FRAGMENT_CONTEXT_CONFLICT: 'fragment 문맥 충돌',
  // iBATIS -> MyBatis syntax conversion (converter/mybatis)
  HASH_PARAMETER: '#x# → #{x}',
  RAW_SQL_SUBSTITUTION: '$x$ → ${x}',
  CONDITIONAL_TO_IF: 'isXxx → <if>',
  DYNAMIC_TO_WHERE: '<dynamic> → <where>',
  DYNAMIC_TO_SET: '<dynamic> → <set>',
  DYNAMIC_TRIM_INFERENCE: '<dynamic> → <trim>',
  DYNAMIC_OPEN_CLOSE_TO_TRIM: 'open/close → <trim>',
  REMOVE_FIRST_PREPEND: 'removeFirstPrepend',
  ITERATE_TO_FOREACH: '<iterate> → <foreach>',
  INCLUDE_KEPT: '<include> 유지',
  SELECT_KEY_CONVERTED: '<selectKey> 변환',
  PROCEDURE_TO_CALLABLE: '프로시저 → CALLABLE',
  PROPERTY_AVAILABLE_APPROXIMATED: 'isPropertyAvailable 근사',
  UNSUPPORTED_NULL_VALUE: 'nullValue 미지원',
  PARAMETER_MAP_STATEMENT: 'parameterMap(?) 수동 변환',
  CACHE_MODEL_DROPPED: 'cacheModel 미지원',
  UNKNOWN_CONDITION: '알 수 없는 조건',
  RESULT_MAP_CONVERTED: 'resultMap 변환',
  GROUP_BY_TO_ID: 'groupBy → <id>',
  NESTED_RESULT_MAP: '중첩 resultMap',
  NESTED_SELECT: '중첩 select',
};
const RENAME_CODES = new Set(['TABLE_RENAMED', 'COLUMN_RENAMED', 'COLUMN_ASSUMED', 'RESULT_COLUMN_ALIASED']);

/* ------------------------------------------------------------------ *
 * Data                                                                 *
 * ------------------------------------------------------------------ */
async function loadDatasetList() {
  schemaState.datasets = await api('/api/v1/datasets');
  schemaState.datasetsLoaded = true;
  if (schemaState.datasetId && !schemaState.datasets.some((d) => d.id === schemaState.datasetId)) {
    schemaState.datasetId = null;
  }
  if (!schemaState.datasetId && schemaState.datasets.length) schemaState.datasetId = schemaState.datasets[0].id;
  writeStored('schema.datasetId', schemaState.datasetId);
  const count = document.getElementById('datasetCount');
  if (count) count.textContent = schemaState.datasets.length ? String(schemaState.datasets.length) : '';
  return schemaState.datasets;
}

/** Called after a dataset is saved/deleted on the 데이터셋 screen. */
function invalidateSchemaResult() {
  schemaState.result = null;
  schemaState.results = new Map();
  schemaState.summary = null;
  schemaState.summaryKey = null;
  schemaState.datasetsLoaded = false;
}

const SCHEMA_RESULT_CACHE = 6;

function schemaKey() {
  return `${state.projectId}|${schemaState.datasetId ?? '-'}|${schemaState.preserveResultColumnNames}|${schemaState.formatSql}|${schemaState.inlineRefid}`;
}

function schemaRequest() {
  // no dataset: an empty mapping still returns the iBATIS -> MyBatis conversion
  const body = schemaState.datasetId ? { datasetId: schemaState.datasetId } : { mapping: {} };
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, preserveResultColumnNames: schemaState.preserveResultColumnNames, formatSql: schemaState.formatSql, inlineRefid: schemaState.inlineRefid }),
  };
}

/**
 * The migration of the selected statement's file only (its statements, its
 * fragments, the fragments they include): the server loads just those files.
 * The last few files are kept, so going back and forth doesn't refetch.
 */
async function ensureSchemaResult() {
  if (!schemaState.datasetsLoaded) await loadDatasetList();
  const sourceFile = state.statementFile.get(lineageState.statementId);
  if (!state.projectId || !sourceFile) return null;
  const key = `${schemaKey()}|${sourceFile}`;
  let result = schemaState.results.get(key);
  if (result) {
    schemaState.results.delete(key);
  } else {
    result = await api(`/api/v1/schema-migration?file=${encodeURIComponent(sourceFile)}`, schemaRequest());
  }
  schemaState.results.set(key, result);
  while (schemaState.results.size > SCHEMA_RESULT_CACHE) schemaState.results.delete(schemaState.results.keys().next().value);
  schemaState.result = result;
  ensureSchemaSummary()
    .then((fresh) => {
      decorateSchemaTree();
      if (fresh) renderSchemaView(); // the strip's project total just arrived
    })
    .catch(() => {});
  return result;
}

/** Counts per statement for the tree badges and the project total: small, computed file by file on the server. */
async function ensureSchemaSummary() {
  const key = schemaKey();
  if (schemaState.summaryKey === key) return false;
  schemaState.summaryKey = key;
  schemaState.summary = null;
  const summary = await api('/api/v1/schema-summary', schemaRequest());
  if (schemaState.summaryKey !== key) return false; // the dataset changed meanwhile
  schemaState.summary = summary;
  return true;
}

/* ------------------------------------------------------------------ *
 * Render                                                               *
 * ------------------------------------------------------------------ */
let schemaRenderSeq = 0;

/** Called by showView('schema') and whenever the selected statement changes while that view is open. */
function renderSchemaView() {
  const pane = document.getElementById('schemaPane');
  if (state.activeView !== 'schema') return;
  const seq = ++schemaRenderSeq;
  if (!schemaState.result) pane.replaceChildren(el('div', { class: 'empty-state small' }, '변환 중…'));
  ensureSchemaResult()
    .then((result) => {
      if (seq !== schemaRenderSeq) return; // a newer render started meanwhile
      const scrollTop = pane.scrollTop;
      drawSchemaView(pane, result);
      pane.scrollTop = scrollTop;
      decorateSchemaTree();
    })
    .catch((e) => {
      if (seq !== schemaRenderSeq) return;
      pane.replaceChildren(...[schemaToolbar(), el('div', { class: 'sm-callout error' }, `변환 실패: ${e.message}`)]);
    });
}

function drawSchemaView(pane, result) {
  const qualifiedId = lineageState.statementId;
  if (!qualifiedId || !result) {
    pane.replaceChildren(...[schemaToolbar(), el('div', { class: 'empty-state small' }, '왼쪽 트리에서 statement를 선택하세요.')]);
    return;
  }
  const sourceFile = state.statementFile.get(qualifiedId);
  if (schemaState.scope === 'file') {
    drawFile(pane, result, sourceFile);
    return;
  }
  const statement = result.statements[qualifiedId];
  if (!statement) {
    pane.replaceChildren(...[schemaToolbar(), el('div', { class: 'empty-state small' }, `${qualifiedId}: 변환 결과가 없습니다.`)]);
    return;
  }

  // the fragments this statement includes, with their own changes
  const included = statement.includes.map((id) => [id, result.fragments[id]]).filter(([, f]) => f);
  const shown = included.filter(([, f]) => entryChanged(f));
  const schemaEvents = [...statement.events, ...included.flatMap(([, f]) => f.events)];
  const conversionEvents = schemaState.mybatis
    ? [...located(statement.conversion?.events, qualifiedId), ...included.flatMap(([id, f]) => located(f.conversion?.events, id))]
    : [];

  pane.replaceChildren(...[
    schemaToolbar(),
    noDatasetCallout(),
    summaryStrip(qualifiedId, schemaEvents, conversionEvents, schemaState.summary?.total),
    reviewSection(schemaEvents, conversionEvents),
    legend(statement.syntax),
    // 통합 on: the server already spliced every fragment's text into the query (copy-ready)
    schemaState.inlineRefid && statement.includeTree?.length
      ? el('div', { class: 'sm-callout sm-inline-note' }, `refid ${countIncludes(statement.includeTree)}개를 fragment 내용으로 바꿔 넣은 쿼리입니다 — 그대로 복사해 쓸 수 있습니다.`)
      : null,
    pairView(statement),
    // refid listed below the query (the default): the whole include tree, every depth
    !schemaState.inlineRefid && statement.includeTree?.length
      ? el('section', { class: 'sm-section' },
        el('h3', { class: 'sm-h' }, '포함된 <sql> (refid)', el('span', { class: 'sm-h-sub' }, `${countIncludes(statement.includeTree)}개 · 쿼리 안에 펼쳐 보려면 "refid 쿼리에 통합"`)),
        ...statement.includeTree.map((node) => includeBlock(node, { fragments: result.fragments, depth: 0, seen: new Set([qualifiedId]), openNested: true, inline: false })))
      : null,
    // the server sent no include tree (whole-project API): the fragments as a flat list
    !statement.includeTree && shown.length
      ? el('section', { class: 'sm-section' },
        el('h3', { class: 'sm-h' }, '포함된 <sql> fragment', el('span', { class: 'sm-h-sub' }, `${shown.length}개 변경`)),
        ...shown.map(([id, f]) => el('details', { class: 'sm-fragment', open: '' },
          el('summary', {}, el('span', { class: 'mono' }, `<include refid="${id}">`), gradeDots(tallyEvents(f.events))),
          pairView(f, { compact: true }),
        )))
      : null,
    changeTable(schemaEvents, included.length > 0),
    schemaState.mybatis ? conversionList(conversionEvents) : null,
  ].filter(Boolean));
}

/** 파일 전체: every fragment and statement of the file, each its own collapsible pair view. */
function drawFile(pane, result, sourceFile) {
  const file = result.files[sourceFile];
  if (!file) {
    pane.replaceChildren(...[schemaToolbar(), el('div', { class: 'empty-state small' }, `${sourceFile}: 변환 결과가 없습니다.`)]);
    return;
  }
  const entries = [
    ...file.fragments.map((id) => [id, result.fragments[id], 'sql']),
    ...file.statements.map((id) => [id, result.statements[id], 'stmt']),
  ].filter(([, e]) => e);
  const schemaEvents = entries.flatMap(([, e]) => e.events);
  const conversionEvents = schemaState.mybatis ? entries.flatMap(([id, e]) => located(e.conversion?.events, id)) : [];
  const visible = schemaState.onlyChanged ? entries.filter(([, e]) => entryChanged(e)) : entries;
  pane.replaceChildren(...[
    schemaToolbar(),
    noDatasetCallout(),
    summaryStrip(`${sourceFile} 전체`, schemaEvents, conversionEvents, schemaState.summary?.total),
    reviewSection(schemaEvents, conversionEvents),
    legend(),
    el('section', { class: 'sm-section' },
      el('h3', { class: 'sm-h' }, `${sourceFile}`, el('span', { class: 'sm-h-sub' }, `${entries.length}개 중 ${entries.filter(([, e]) => entryChanged(e)).length}개 변경${schemaState.onlyChanged ? ' · 변경된 것만 표시' : ''}`)),
      ...visible.map(([id, e, kind]) => el('details', { class: 'sm-fragment', ...(entryChanged(e) ? { open: '' } : {}) },
        el('summary', {},
          el('span', { class: `sm-node-kind ${kind}` }, kind === 'sql' ? 'SQL' : 'STMT'),
          el('span', { class: 'mono' }, id),
          gradeDots(tallyEvents([...e.events, ...(schemaState.mybatis ? e.conversion?.events ?? [] : [])]))),
        schemaState.inlineRefid
          ? pairView(e, { compact: true }) // already spliced on the server
          : [pairView(e, { compact: true }), ...(e.includeTree ?? []).map((node) => includeBlock(node, { fragments: result.fragments, depth: 0, seen: new Set([id]), openNested: false, inline: false }))],
      )),
    ),
    changeTable(schemaEvents, true),
    schemaState.mybatis ? conversionList(conversionEvents) : null,
  ].filter(Boolean));
}

/** MyBatis conversion events don't name their statement; tag them with the local id like the schema events. */
function located(events, qualifiedId) {
  const statementId = qualifiedId.split('.').pop();
  return (events ?? []).map((e) => ({ ...e, statementId }));
}

/** Does this statement/fragment change in the current mode (renames, or syntax when the toggle is on)? */
function entryChanged(entry) {
  if (entry.ibatisAfter !== undefined && entry.ibatisBefore !== entry.ibatisAfter) return true;
  if (entry.events.some((e) => e.grade !== 'SAFE')) return true;
  return schemaState.mybatis && (entry.conversion?.events ?? []).some((e) => e.grade !== 'SAFE');
}

function noDatasetCallout() {
  if (schemaState.datasets.length && schemaState.datasetId) return null;
  return el('div', { class: 'sm-callout sm-onboard-inline' },
    el('span', { class: 'sm-onboard-icon small', 'aria-hidden': 'true' }, '⇄'),
    el('span', {}, '매핑 데이터셋이 없어 컬럼명은 바뀌지 않습니다. 레거시 → 신규 매핑을 JSON으로 등록하세요.'),
    el('button', { class: 'btn primary small', type: 'button', onclick: () => createSampleDataset().catch((e) => alert(e.message)) }, '샘플 데이터셋 적용'),
    el('button', { class: 'btn small', type: 'button', onclick: () => { showScreen('datasets'); startNewDataset(); } }, '데이터셋 만들기'),
  );
}

/** Creates (or refreshes) the sample dataset that matches the loaded demo project. */
async function createSampleDataset(kind = state.sampleKind ?? 'basic') {
  const set = SAMPLE_SETS[kind];
  const mapping = await fetch(`${set.dir}schema-mapping.json`).then((r) => r.json());
  await api(`/api/v1/datasets/${set.datasetId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: set.datasetName, description: set.description, mapping }),
  });
  invalidateSchemaResult();
  schemaState.datasetId = set.datasetId;
  writeStored('schema.datasetId', schemaState.datasetId);
  renderSchemaView();
}

function schemaToolbar() {
  const select = el('select', {
    class: 'sm-select',
    'aria-label': '매핑 데이터셋',
    onchange: (e) => {
      schemaState.datasetId = e.target.value || null;
      writeStored('schema.datasetId', schemaState.datasetId);
      renderSchemaView();
    },
  },
  el('option', { value: '', ...(schemaState.datasetId ? {} : { selected: '' }) }, '(매핑 없음)'),
  ...schemaState.datasets.map((d) => el('option', { value: d.id, ...(d.id === schemaState.datasetId ? { selected: '' } : {}) },
    `${d.name} · 테이블 ${d.tables} · 컬럼 ${d.columns}`)));

  const toggle = (label, checked, onchange, title) => el('label', { class: 'sm-toggle', title },
    el('input', { type: 'checkbox', ...(checked ? { checked: '' } : {}), onchange }), label);

  const scopeButton = (scope, label) => el('button', {
    class: `tool-btn${schemaState.scope === scope ? ' active' : ''}`,
    type: 'button',
    'aria-pressed': String(schemaState.scope === scope),
    onclick: () => { schemaState.scope = scope; renderSchemaView(); },
  }, label);

  // the iBATIS -> MyBatis syntax conversion: a real switch, not a tab
  const mybatisSwitch = el('button', {
    class: `sm-switch${schemaState.mybatis ? ' on' : ''}`,
    type: 'button',
    role: 'switch',
    'aria-checked': String(schemaState.mybatis),
    title: '켜면 iBATIS 문법을 MyBatis 3로 변환한 결과에 컬럼명 변경을 함께 보여줍니다',
    onclick: () => {
      schemaState.mybatis = !schemaState.mybatis;
      writeStored('schema.mybatis', schemaState.mybatis);
      renderSchemaView();
    },
  }, el('span', { class: 'sm-switch-track', 'aria-hidden': 'true' }, el('span', { class: 'sm-switch-thumb' })), 'MyBatis 문법 변환');

  return el('div', { class: 'sm-toolbar' },
    el('div', { class: 'sm-toolbar-group' },
      el('span', { class: 'sm-label' }, '매핑'),
      select,
      el('button', { class: 'tool-btn', type: 'button', onclick: () => showScreen('datasets') }, '관리'),
      sampleDatasetHint(),
    ),
    el('div', { class: 'sm-toolbar-group' },
      mybatisSwitch,
      el('span', { class: 'sm-sep', 'aria-hidden': 'true' }),
      el('div', { class: 'mb-scope' }, scopeButton('statement', '이 statement'), scopeButton('file', '파일 전체')),
      toggle('변경 줄만', schemaState.onlyChanged, (e) => { schemaState.onlyChanged = e.target.checked; renderSchemaView(); }),
      toggle('refid 쿼리에 통합', schemaState.inlineRefid, (e) => {
        schemaState.inlineRefid = e.target.checked;
        writeStored('schema.inlineRefid', e.target.checked);
        renderSchemaView();
      }, '켜면 <include refid>를 fragment의 SQL로 바꿔 넣은 하나의 쿼리(복사해 바로 쓰는 텍스트)로, 끄면 쿼리 아래에 fragment를 따로 모아 보여줍니다'),
      toggle('쿼리 정렬', schemaState.formatSql, (e) => {
        schemaState.formatSql = e.target.checked;
        writeStored('schema.formatSql', e.target.checked);
        renderSchemaView();
      }, 'SQL을 절(SELECT/FROM/WHERE/JOIN…)마다 줄을 나누고 AND/OR·서브쿼리를 들여써 정렬합니다. MyBatis 태그(<if>, <where>…) 경계와 #{…}, 문자열, 주석은 건드리지 않습니다'),
      toggle('결과 컬럼명 유지 (AS)', schemaState.preserveResultColumnNames, (e) => {
        schemaState.preserveResultColumnNames = e.target.checked;
        writeStored('schema.preserve', e.target.checked);
        renderSchemaView();
      }, '이름이 바뀐 SELECT 항목에 "AS 기존이름"을 붙여 resultMap 매핑을 유지합니다'),
    ),
  );
}

/** A demo project is loaded but its own sample dataset isn't the one in use: offer it. */
function sampleDatasetHint() {
  const set = state.sampleKind && SAMPLE_SETS[state.sampleKind];
  if (!set || schemaState.datasetId === set.datasetId) return null;
  const exists = schemaState.datasets.some((d) => d.id === set.datasetId);
  return el('button', {
    class: 'tool-btn sm-hint-btn',
    type: 'button',
    title: `불러온 ${state.sampleKind === 'advanced' ? 'advanced' : '샘플'} 프로젝트의 테이블에 맞춘 매핑`,
    onclick: () => {
      if (exists) {
        schemaState.datasetId = set.datasetId;
        writeStored('schema.datasetId', set.datasetId);
        renderSchemaView();
      } else {
        createSampleDataset().catch((e) => alert(e.message));
      }
    },
  }, `↺ 이 프로젝트용 “${set.datasetName}” ${exists ? '선택' : '적용'}`);
}

function summaryStrip(title, schemaEvents, conversionEvents, projectSummary) {
  const s = tallyEvents(schemaEvents);
  const c = tallyEvents(conversionEvents);
  const stat = (label, value, cls) => el('div', { class: `sm-stat ${cls}${value ? '' : ' zero'}` },
    el('div', { class: 'v' }, String(value)), el('div', { class: 'k' }, label));
  return el('div', { class: 'sm-summary' },
    el('div', { class: 'sm-title' },
      el('h2', {}, title),
      projectSummary
        ? el('div', { class: 'sub' },
          `프로젝트 전체: 테이블 ${projectSummary.tables} · 컬럼 ${projectSummary.columns} · `,
          el('span', { class: 'warn-text' }, `WARNING ${projectSummary.WARNING}`), ' · ',
          el('span', { class: 'manual-text' }, `MANUAL ${projectSummary.MANUAL}`))
        : el('div', { class: 'sub' }, '프로젝트 전체: 집계 중…'),
    ),
    stat('테이블명 변경', s.tables, 'table'),
    stat('컬럼명 변경', s.columns, 'column'),
    schemaState.mybatis ? stat('문법 변환', conversionEvents.length, 'syntax') : null,
    stat('WARNING', s.WARNING + c.WARNING, 'WARNING'),
    stat('MANUAL', s.MANUAL + c.MANUAL + s.ERROR + c.ERROR, 'MANUAL'),
  );
}

function legend(syntax = 'ibatis') {
  return el('div', { class: 'sm-legend' },
    el('span', {}, el('del', { class: 'r' }, '레거시'), ' → ', el('ins', { class: 'r' }, '신규'), ' 컬럼·테이블명 변경'),
    syntax === 'mybatis'
      ? el('span', { class: 'muted' }, '이미 MyBatis 매퍼 — 문법 변환 없이 컬럼·테이블명만 바뀝니다')
      : schemaState.mybatis
        ? el('span', {}, el('del', { class: 's' }, '#x#'), ' → ', el('ins', { class: 's' }, '#{x}'), ' MyBatis 문법 변환')
        : el('span', { class: 'muted' }, 'iBATIS 문법은 그대로 — “MyBatis 문법 변환”을 켜면 문법 변환도 함께 표시'),
  );
}

function tallyEvents(events) {
  const t = { SAFE: 0, WARNING: 0, MANUAL: 0, ERROR: 0, tables: 0, columns: 0 };
  for (const e of events) {
    t[e.grade] = (t[e.grade] ?? 0) + 1;
    if (e.code === 'TABLE_RENAMED') t.tables++;
    if (e.code === 'COLUMN_RENAMED' || e.code === 'COLUMN_ASSUMED') t.columns++;
  }
  return t;
}

function gradeDots(summary) {
  return el('span', { class: 'sm-dots' },
    summary.tables ? el('span', { class: 'sm-dot table' }, `T ${summary.tables}`) : null,
    summary.columns ? el('span', { class: 'sm-dot column' }, `C ${summary.columns}`) : null,
    summary.WARNING ? el('span', { class: 'sm-dot WARNING' }, `W ${summary.WARNING}`) : null,
    summary.MANUAL ? el('span', { class: 'sm-dot MANUAL' }, `M ${summary.MANUAL}`) : null,
  );
}

function reviewSection(schemaEvents, conversionEvents) {
  const review = [
    ...schemaEvents.filter((e) => e.grade !== 'SAFE' && e.code !== 'FRAGMENT_CONTEXT_INFERRED').map((e) => ({ ...e, source: '컬럼명' })),
    ...conversionEvents.filter((e) => e.grade !== 'SAFE').map((e) => ({ ...e, source: '문법' })),
  ];
  if (!review.length) {
    const changed = schemaEvents.some((e) => RENAME_CODES.has(e.code));
    return el('div', { class: 'sm-callout ok' }, changed
      ? '✓ 검토가 필요한 항목이 없습니다. 모든 변경이 매핑에서 확정적으로 결정되었습니다.'
      : '✓ 바뀌는 것이 없고, 검토할 항목도 없습니다.');
  }
  const order = { MANUAL: 0, ERROR: 0, WARNING: 1 };
  review.sort((a, b) => (order[a.grade] ?? 2) - (order[b.grade] ?? 2));
  return el('section', { class: 'sm-review' },
    el('h3', { class: 'sm-h' }, '검토 필요', el('span', { class: 'sm-h-sub' }, `${review.length}건 — 사람이 확인해야 하는 결정`)),
    el('ul', { class: 'sm-review-list' }, ...review.map((e) => el('li', { class: `sm-review-item ${e.grade}` },
      el('span', { class: `badge ${e.grade}` }, e.grade),
      el('span', { class: `sm-src ${e.source === '문법' ? 's' : 'r'}` }, e.source),
      el('span', { class: 'code' }, SCHEMA_CODE_LABEL[e.code] ?? e.code),
      el('span', { class: 'msg' }, e.statementId ? el('span', { class: 'mono where' }, `${e.statementId} · `) : null, e.message),
    ))),
  );
}

/** The MyBatis conversion's own decisions (toggle on): what syntax became what, graded. */
function conversionList(events) {
  if (!events.length) return null;
  const counts = tallyEvents(events);
  return el('section', { class: 'sm-section' },
    el('h3', { class: 'sm-h' }, 'MyBatis 문법 변환 내역',
      el('span', { class: 'sm-h-sub' }, `${events.length}건 · SAFE ${counts.SAFE} · WARNING ${counts.WARNING} · MANUAL ${counts.MANUAL}`)),
    el('table', { class: 'data sm-changes sm-conv' },
      el('thead', {}, el('tr', {}, el('th', {}, '등급'), el('th', {}, '변환'), el('th', {}, '위치'), el('th', {}, '내용'))),
      el('tbody', {}, ...events.map((e) => el('tr', {},
        el('td', {}, el('span', { class: `badge ${e.grade}` }, e.grade)),
        el('td', { class: 'code' }, SCHEMA_CODE_LABEL[e.code] ?? e.code),
        el('td', { class: 'mono where' }, e.statementId ?? ''),
        el('td', { class: 'reason' }, e.message),
      ))),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * Change list                                                          *
 * ------------------------------------------------------------------ */
function changeTable(events, showLocation) {
  const groups = new Map();
  for (const e of events) {
    if (!RENAME_CODES.has(e.code)) continue;
    const kind = e.code === 'TABLE_RENAMED' ? 'TABLE' : 'COLUMN';
    const from = kind === 'TABLE' ? e.table : `${e.table}.${e.column}`;
    const key = `${kind}|${from}|${e.replacement}|${e.code}|${showLocation ? e.statementId : ''}`;
    const group = groups.get(key) ?? { kind, from, to: e.replacement, event: e, count: 0, where: new Set() };
    group.count++;
    if (e.statementId) group.where.add(e.statementId);
    groups.set(key, group);
  }
  const rows = [...groups.values()].sort((a, b) => (a.kind === b.kind ? a.from.localeCompare(b.from) : a.kind === 'TABLE' ? -1 : 1));
  if (!rows.length) {
    return el('section', { class: 'sm-section' },
      el('h3', { class: 'sm-h' }, '컬럼·테이블명 변경 목록'),
      el('div', { class: 'sm-callout' }, schemaState.datasetId ? '이 데이터셋에 해당하는 테이블/컬럼이 없어 변경되지 않았습니다.' : '매핑 데이터셋을 고르면 바뀌는 컬럼·테이블명이 여기에 나옵니다.'));
  }
  const reason = (e) => {
    if (e.code === 'RESULT_COLUMN_ALIASED') return '결과 label 유지';
    const via = /through (CTE|subquery) (\S+)/.exec(e.message);
    if (via) return `${via[1] === 'CTE' ? 'CTE' : '서브쿼리'} ${via[2]} 경유`;
    const assumed = /\(assumed: ([^)]*)\)/.exec(e.message);
    if (assumed) return `추정 — ${assumed[1].replace(' in the same scope is not in the mapping', ' 매핑 없음')}`;
    const alias = /\(alias (\S+) kept\)/.exec(e.message);
    if (alias) return `alias ${alias[1]} 유지`;
    return '매핑';
  };
  return el('section', { class: 'sm-section' },
    el('h3', { class: 'sm-h' }, '컬럼·테이블명 변경 목록', el('span', { class: 'sm-h-sub' }, `${rows.length}종 · 클릭하면 위에서 위치를 강조합니다`)),
    el('table', { class: 'data sm-changes' },
      el('thead', {}, el('tr', {},
        el('th', {}, '종류'), el('th', {}, '레거시'), el('th', {}), el('th', {}, '신규'), el('th', {}, '근거'),
        el('th', {}, '횟수'), showLocation ? el('th', {}, '위치') : null, el('th', {}, '등급'))),
      el('tbody', {}, ...rows.map((row) => el('tr', {
        class: 'clickable',
        tabindex: '0',
        onclick: (ev) => flashChange(row.to, ev.currentTarget),
        onkeydown: (ev) => { if (ev.key === 'Enter') flashChange(row.to, ev.currentTarget); },
      },
        el('td', {}, el('span', { class: `sm-kind ${row.kind}` }, row.kind === 'TABLE' ? '테이블' : '컬럼')),
        el('td', { class: 'mono old' }, row.from),
        el('td', { class: 'arrow' }, '→'),
        el('td', { class: 'mono new' }, row.to),
        el('td', { class: 'reason' }, reason(row.event)),
        el('td', { class: 'num' }, `×${row.count}`),
        showLocation ? el('td', { class: 'mono where' }, [...row.where].join(', ')) : null,
        el('td', {}, el('span', { class: `badge ${row.event.grade}` }, row.event.grade)),
      ))),
    ),
  );
}

/** Highlights every added token in the diffs that is part of `replacement`. */
function flashChange(replacement, rowEl) {
  for (const r of document.querySelectorAll('.sm-changes tr.selected')) r.classList.remove('selected');
  rowEl?.classList.add('selected');
  const parts = new Set(String(replacement).split(/[\s.]+/).filter(Boolean).map((p) => p.toUpperCase()));
  let first = null;
  for (const mark of document.querySelectorAll('#schemaPane ins.r')) {
    const hit = parts.has(mark.textContent.trim().toUpperCase());
    mark.classList.toggle('flash', hit);
    if (hit && !first) first = mark;
  }
  first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/* ------------------------------------------------------------------ *
 * Pair view: original iBATIS on the left, the result on the right      *
 * ------------------------------------------------------------------ */

const TOKEN_RE = /[A-Za-z0-9_$À-￿]+|\s+|[^A-Za-z0-9_$À-￿\s]/g;
const splitTokens = (s) => (s ?? '').match(TOKEN_RE) ?? [];
const isBlank = (s) => !s || !s.trim();

/** Token LCS between two lines: which tokens of `a` are gone, which of `b` are new. */
function tokenFlags(a, b) {
  const at = splitTokens(a);
  const bt = splitTokens(b);
  const removed = new Array(at.length).fill(false);
  const added = new Array(bt.length).fill(false);
  if (a === b) return { at, bt, removed, added };
  const t = lcsTable(at, bt);
  let i = 0;
  let j = 0;
  while (i < at.length || j < bt.length) {
    if (i < at.length && j < bt.length && at[i] === bt[j]) { i++; j++; }
    else if (j < bt.length && (i === at.length || t[i][j + 1] >= t[i + 1][j])) { added[j] = !/^\s+$/.test(bt[j]); j++; }
    else { removed[i] = !/^\s+$/.test(at[i]); i++; }
  }
  return { at, bt, removed, added };
}

/** Renders tokens, wrapping runs that share a mark in one <del>/<ins>. */
function markTokens(tokens, markOf, tag) {
  const out = [];
  let run = null;
  tokens.forEach((token, k) => {
    const mark = /^\s+$/.test(token) && run && k + 1 < tokens.length && markOf(k + 1) === run.mark ? run.mark : markOf(k);
    if (!mark) {
      run = null;
      out.push(document.createTextNode(token));
      return;
    }
    if (!run || run.mark !== mark) {
      run = { mark, node: el(tag, { class: mark }) };
      out.push(run.node);
    }
    run.node.appendChild(document.createTextNode(token));
  });
  return out.length ? out : [document.createTextNode(' ')];
}

/**
 * A structural key per line, the same for an iBATIS line and the MyBatis
 * line it became: tag kinds map across (isXxx -> if, dynamic -> where/set/
 * trim, iterate -> foreach ...), text keeps its SQL minus parameters and
 * leading/trailing connectors (`#x#` and `#{x}`, a written-in `AND`, a `,`).
 */
function lineKey(line) {
  const t = line.trim();
  if (!t) return '';
  const tag = /^<(\/?)([A-Za-z]+)/.exec(t);
  if (tag) {
    const close = tag[1];
    const name = tag[2];
    const kind = /^is[A-Z]/.test(name) || name === 'if' ? 'IF'
      : ['dynamic', 'where', 'set', 'trim'].includes(name) ? 'GROUP'
        : ['iterate', 'foreach'].includes(name) ? 'LOOP'
          : ['select', 'insert', 'update', 'delete', 'procedure', 'statement'].includes(name) ? 'STMT'
            : name.toUpperCase();
    return `${close}${kind}`;
  }
  return `T:${t
    .replace(/#\{[^}]*\}|\$\{[^}]*\}|#[^#\s]+#|\$[^$\s]+\$/g, '?')
    .replace(/^(AND|OR|XOR|WHERE|SET|,)\s+|^(AND|OR|XOR)$|,$/gi, '')
    .replace(/\s+/g, ' ')
    .trim()}`;
}

/**
 * Pairs the lines of two texts by lineKey (LCS). Returns [leftIndex|null,
 * rightIndex|null] pairs; a null side is a line only the other text has
 * (e.g. the <trim> MyBatis needs where iBATIS used an attribute).
 */
function alignLines(left, right) {
  const a = left.map(lineKey);
  const b = right.map(lineKey);
  if (a.length === b.length && a.every((k, i) => k === b[i])) return a.map((_, i) => [i, i]);
  if (a.length * b.length > 6e6) return null; // too big to align: caller falls back
  const t = lcsTable(a, b);
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) pairs.push([i++, j++]);
    else if (j < b.length && (i === a.length || t[i][j + 1] >= t[i + 1][j])) pairs.push([null, j++]);
    else pairs.push([i++, null]);
  }
  // a lone left line next to a lone right line is one changed line, not two
  const merged = [];
  for (let k = 0; k < pairs.length; k++) {
    const [l, r] = pairs[k];
    const next = pairs[k + 1];
    if (l !== null && r === null && next && next[0] === null && next[1] !== null) { merged.push([l, next[1]]); k++; } else merged.push([l, r]);
  }
  return merged;
}

/**
 * One statement / fragment as aligned rows. Left: original iBATIS. Right:
 * iBATIS + renames (toggle off) or MyBatis + renames (toggle on). Marks:
 *   left  <del class="r"> renamed away   <del class="s"> iBATIS-only syntax
 *   right <ins class="r"> new name       <ins class="s"> MyBatis syntax
 * Each mark is a token diff between two texts that differ ONLY in that
 * kind of change (renames: X vs X+renames, line for line; syntax: iBATIS
 * vs MyBatis, both before or both after the renames, paired by alignLines),
 * never between the iBATIS original and the final MyBatis text directly.
 */
function pairView(entry, { compact = false, includeTree = null, fragments = null, depth = 0, seen = new Set(), openNested = true } = {}) {
  const mybatis = schemaState.mybatis;
  // the server leaves out an "after" that didn't change
  const L = entry.ibatisBefore.split('\n');
  const LA = (entry.ibatisAfter ?? entry.ibatisBefore).split('\n');
  const MB = entry.mybatisBefore.split('\n');
  const MA = (entry.mybatisAfter ?? entry.mybatisBefore).split('\n');
  const renamesLineUp = L.length === LA.length && MB.length === MA.length;
  const pairs = !mybatis ? L.map((_, i) => [i, i]) : renamesLineUp ? alignLines(L, MB) : null;

  // which <include> lines of the original carry which include-tree nodes (both are in document order)
  const includeAt = new Map();
  if (includeTree?.length) {
    let k = 0;
    L.forEach((line, i) => {
      const n = (line.match(/<include\b/g) ?? []).length;
      if (n) includeAt.set(i, includeTree.slice(k, k += n));
    });
  }
  const nestedOpts = { fragments, depth, seen, openNested };
  const rows = [];
  // an <include> line is followed by the fragment it brings in, expanded to every depth
  const pushIncludes = (i) => {
    for (const node of includeAt.get(i) ?? []) rows.push({ kinds: [], keep: true, nested: node });
  };
  if (pairs) {
    for (const [i, j] of pairs) {
      const leftText = i === null ? '' : L[i];
      const rightText = j === null ? '' : (mybatis ? MA[j] : LA[j]);
      if (isBlank(leftText) && isBlank(rightText)) continue; // blank layout lines
      const renameL = i === null ? null : tokenFlags(L[i], LA[i]);
      const renameR = j === null ? null : mybatis ? tokenFlags(MB[j], MA[j]) : tokenFlags(L[j], LA[j]);
      // syntax: what MyBatis replaced (left) / introduced (right) on this pair of lines
      const syntaxL = mybatis && i !== null ? (j === null ? { removed: splitTokens(L[i]).map((x) => !/^\s+$/.test(x)) } : tokenFlags(L[i], MB[j])) : null;
      const syntaxR = mybatis && j !== null ? (i === null ? { added: splitTokens(MA[j]).map((x) => !/^\s+$/.test(x)) } : tokenFlags(LA[i], MA[j])) : null;
      const left = i === null ? [document.createTextNode(' ')]
        : markTokens(renameL.at, (k) => (renameL.removed[k] ? 'r' : syntaxL?.removed[k] ? 's' : null), 'del');
      const right = j === null ? [document.createTextNode(' ')]
        : markTokens(renameR.bt, (k) => (renameR.added[k] ? 'r' : syntaxR?.added[k] ? 's' : null), 'ins');
      const kinds = [
        renameL?.removed.some(Boolean) || renameR?.added.some(Boolean) ? 'r' : null,
        syntaxL?.removed.some(Boolean) || syntaxR?.added.some(Boolean) ? 's' : null,
      ].filter(Boolean);
      rows.push({ kinds, leftNo: i === null ? '' : i + 1, rightNo: j === null ? '' : j + 1, left, right });
      if (i !== null) pushIncludes(i);
    }
  } else {
    // too large to align (or renames changed the line count): side by side, renames only
    const R = mybatis ? MA : LA;
    const n = Math.max(L.length, R.length);
    for (let i = 0; i < n; i++) {
      if (isBlank(L[i]) && isBlank(R[i])) continue;
      const lf = i < L.length && L.length === LA.length ? tokenFlags(L[i], LA[i]) : { at: splitTokens(L[i]), removed: [] };
      const rf = i < R.length && (mybatis ? MB.length === MA.length : L.length === LA.length) ? tokenFlags(mybatis ? MB[i] : L[i], R[i]) : { bt: splitTokens(R[i]), added: [] };
      rows.push({
        kinds: lf.removed.some(Boolean) || rf.added.some(Boolean) ? ['r'] : [],
        leftNo: i < L.length ? i + 1 : '',
        rightNo: i < R.length ? i + 1 : '',
        left: i < L.length ? markTokens(lf.at, (k) => (lf.removed[k] ? 'r' : null), 'del') : [document.createTextNode(' ')],
        right: i < R.length ? markTokens(rf.bt, (k) => (rf.added[k] ? 'r' : null), 'ins') : [document.createTextNode(' ')],
      });
      if (i < L.length) pushIncludes(i);
    }
  }

  const changedRows = rows.filter((r) => r.kinds.length);
  const renameRows = rows.filter((r) => r.kinds.includes('r')).length;
  const syntaxRows = rows.filter((r) => r.kinds.includes('s')).length;
  const head = el('div', { class: 'sd-head' },
    el('div', {}, entry.syntax === 'mybatis' ? '원본 · MyBatis' : '원본 · iBATIS'),
    el('div', {}, mybatis || entry.syntax === 'mybatis' ? '결과 · MyBatis + 신규 스키마' : '결과 · iBATIS + 신규 스키마',
      el('span', { class: 'sd-count' },
        renameRows ? el('span', { class: 'r' }, `컬럼명 ${renameRows}줄`) : null,
        syntaxRows ? el('span', { class: 's' }, `문법 ${syntaxRows}줄`) : null,
        changedRows.length ? null : '변경 없음')),
  );
  const body = el('div', { class: `sd-body${compact ? ' compact' : ''}${depth ? ' nested' : ''}` });
  if (!pairs && mybatis) body.appendChild(el('div', { class: 'sd-gap' }, '이 항목은 너무 커서 iBATIS와 MyBatis 줄을 맞추지 않고, 컬럼명 변경만 표시합니다'));
  for (const item of collapseRows(rows, schemaState.onlyChanged ? 2 : Infinity)) {
    if (item.gap) {
      body.appendChild(el('div', { class: 'sd-gap' }, `⋯ 변경 없는 ${item.gap}줄`));
      continue;
    }
    if (item.nested) {
      body.appendChild(includeBlock(item.nested, nestedOpts));
      continue;
    }
    body.appendChild(el('div', { class: `sd-row ${item.kinds.map((k) => `k-${k}`).join(' ')}` },
      el('span', { class: 'ln' }, String(item.leftNo)),
      el('code', { class: 'sd-l' }, ...item.left),
      el('span', { class: 'ln' }, String(item.rightNo)),
      el('code', { class: 'sd-r' }, ...item.right),
    ));
  }
  return el('div', { class: 'sd-diff' }, head, body);
}

/** Does this fragment, or anything it includes at any depth, change? */
function includeChanged(node, fragments, seen = new Set()) {
  const entry = fragments?.[node.qualifiedId];
  if (!entry || seen.has(node.qualifiedId)) return false;
  if (entryChanged(entry)) return true;
  return (node.children ?? []).some((c) => includeChanged(c, fragments, new Set([...seen, node.qualifiedId])));
}

/**
 * The fragment an `<include refid>` brings in, as its own pair view right
 * under the include line, and that fragment's includes under it — to the
 * last depth. The tree comes from the resolver (statement-namespace rules,
 * cycles cut), so this follows exactly what runs. A collapsed block renders
 * its body only when first opened.
 */
/** how the resolver found the fragment (ProjectSession#includeTree rule) — shown with every refid */
const REFID_RULE = {
  QUALIFIED: ['namespace.id', 'refid가 namespace까지 적힌 id라 그대로 찾았습니다'],
  NAMESPACE: ['같은 namespace', '<include>가 있는 매퍼의 namespace에서 찾았습니다'],
  GLOBAL_UNIQUE: ['프로젝트에서 유일', '같은 namespace엔 없지만, 프로젝트 전체에서 이 id의 <sql>이 하나뿐이라 그것으로 찾았습니다 (iBATIS useStatementNamespaces=false)'],
  DUPLICATE_SAME: ['같은 SQL 사본', '여러 매퍼에 똑같은 <sql>이 복사돼 있어 그중 하나로 찾았습니다 (모두 같은 SQL)'],
  NEAREST_DUPLICATE: ['가장 가까운 사본', '여러 매퍼에 같은 id의 다른 <sql>이 있어, 이 파일과 가장 가까운 폴더의 것으로 찾았습니다 — 다른 것이 맞다면 namespace를 붙여 쓰세요'],
  RUNTIME_SHADOWED: ['statement namespace 우선', 'fragment 안의 refid는 실행 시 statement의 namespace로 먼저 찾습니다 — 그 namespace에 같은 id가 있어 그쪽입니다'],
  AUTHOR_NAMESPACE: ['fragment의 namespace', 'statement namespace에는 없어 fragment가 있는 매퍼의 것으로 찾았습니다 (MyBatis 결과에는 namespace를 붙여 씁니다)'],
  MISSING: ['못 찾음', '프로젝트 어디에도 이 id의 <sql>이 없거나, 둘 이상이라 정할 수 없습니다'],
  CIRCULAR: ['순환', '이미 펼친 fragment를 다시 포함합니다 — 여기서 멈춥니다'],
};

function ruleChip(rule) {
  const [text, title] = REFID_RULE[rule] ?? [rule, ''];
  return rule ? el('span', { class: `sd-inc-rule rule-${String(rule).toLowerCase()}`, title }, text) : null;
}

/**
 * The fragment an <include> brings in, and its own includes, to the last depth.
 * inline: inside the query, right under the include line (refid 쿼리에 통합 on);
 * otherwise listed below the query, each nested include as an indented block under its fragment.
 */
function includeBlock(node, { fragments, depth, seen, openNested, inline = schemaState.inlineRefid }) {
  const level = depth + 1;
  const label = el('span', { class: 'mono' }, `<include refid="${node.refid}">`);
  const note = (text) => el('div', { class: 'sd-include note', style: `--level:${level}` },
    el('span', { class: 'sd-inc-arrow' }, '↳'), label, el('span', { class: 'sd-inc-note' }, text));
  if (node.unresolved) return note(node.unresolved === 'CIRCULAR' ? '순환 참조 — 여기서 멈춤' : 'fragment를 찾을 수 없음 — refid 이름·namespace를 확인하세요');
  if (seen.has(node.qualifiedId)) return note('순환 참조 — 여기서 멈춤');
  const entry = fragments?.[node.qualifiedId];
  if (!entry) return note(`${node.qualifiedId}: 결과에 없음`);
  const changed = includeChanged(node, fragments);
  const open = openNested || changed;
  const details = el('details', { class: `sd-include${changed ? ' changed' : ''}`, style: `--level:${level}`, ...(open ? { open: '' } : {}) },
    el('summary', {},
      el('span', { class: 'sd-inc-arrow' }, '↳'),
      label,
      node.qualifiedId !== node.refid ? el('span', { class: 'sd-inc-target mono' }, `→ ${node.qualifiedId}`) : null,
      ruleChip(node.rule),
      node.unparsed ? el('span', { class: 'sd-inc-rule rule-missing', title: `${node.file}: XML을 파싱할 수 없어 SQL을 펼칠 수 없습니다 (위치는 찾았습니다) — 그 파일의 오류를 먼저 고치세요` }, '파일 파싱 오류') : null,
      el('span', { class: 'sd-inc-depth' }, `depth ${level}`),
      node.children?.length ? el('span', { class: 'sd-inc-sub' }, `하위 include ${countIncludes(node.children)}`) : null,
      gradeDots(tallyEvents(entry.events)),
    ));
  const innerSeen = new Set([...seen, node.qualifiedId]);
  const fill = () => {
    details.appendChild(pairView(entry, inline
      ? { compact: true, includeTree: node.children, fragments, depth: level, seen: innerSeen, openNested }
      : { compact: true, depth: level }));
    // listed below: the fragment's own includes follow it, one level deeper
    if (!inline) for (const child of node.children ?? []) details.appendChild(includeBlock(child, { fragments, depth: level, seen: innerSeen, openNested, inline }));
  };
  if (open) fill();
  else details.addEventListener('toggle', fill, { once: true });
  return details;
}

function countIncludes(tree) {
  return tree.reduce((n, node) => n + 1 + countIncludes(node.children ?? []), 0);
}

/** Every row, or only changed rows with `context` rows around them and gap markers. */
function collapseRows(rows, context) {
  if (context === Infinity) return rows;
  const keep = rows.map(() => false);
  rows.forEach((r, i) => {
    if (r.keep) keep[i] = true; // an expanded <include>: always shown
    if (!r.kinds.length) return;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep[j] = true;
  });
  const out = [];
  let gap = 0;
  rows.forEach((r, i) => {
    if (keep[i]) {
      if (gap) out.push({ gap });
      gap = 0;
      out.push(r);
    } else gap++;
  });
  if (gap) out.push({ gap });
  return out;
}

function lcsTable(a, b) {
  const t = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  }
  return t;
}

/* ------------------------------------------------------------------ *
 * Tree badges (this view only)                                         *
 * ------------------------------------------------------------------ */
function decorateSchemaTree() {
  const show = state.activeView === 'schema' && schemaState.summary && schemaState.summaryKey === schemaKey();
  for (const node of document.querySelectorAll('#lineageTree .node[data-statement-id]')) {
    node.querySelector('.schema-badge')?.remove();
    if (!show) continue;
    const counts = schemaState.summary.statements[node.dataset.statementId];
    if (!counts) continue;
    const s = counts.schema;
    const c = schemaState.mybatis ? counts.conversion : { WARNING: 0, MANUAL: 0, ERROR: 0 };
    const changes = s.tables + s.columns;
    const manual = s.MANUAL + s.ERROR + c.MANUAL + c.ERROR;
    const warning = s.WARNING + c.WARNING;
    const level = manual ? 'MANUAL' : warning ? 'WARNING' : changes ? 'changed' : 'none';
    node.appendChild(el('span', {
      class: `schema-badge ${level}`,
      title: `테이블 ${s.tables} · 컬럼 ${s.columns} · WARNING ${warning} · MANUAL ${manual}`,
    }, changes ? `Δ${changes}` : manual || warning ? '!' : '—'));
  }
}
