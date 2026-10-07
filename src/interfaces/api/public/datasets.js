'use strict';

/* ------------------------------------------------------------------ *
 * 데이터셋 screen                                                      *
 *                                                                      *
 * A dataset is a named old -> new schema mapping, stored server-side   *
 * as one JSON file (`/api/v1/datasets`). It is edited as plain JSON —  *
 * paste, type, or import a file — with live feedback: JSON syntax      *
 * errors with their line/column (checked here), then structural        *
 * errors and warnings with their path (checked by the server's         *
 * validator, the same one a save goes through), plus a preview of     *
 * what the mapping will do.                                            *
 * ------------------------------------------------------------------ */

const DATASET_EXAMPLE = {
  OLD_COUNTRY: {
    targetTable: 'COUNTRY',
    columns: { COUNTRY_CD: 'COUNTRY_CODE', COUNTRY_NM: 'COUNTRY_NAME', USE_YN: 'IS_ENABLED' },
  },
  'LEGACY.OLD_CODE_DETAIL': {
    targetTable: 'MASTER.CODE_DETAIL',
    columns: { GRP_ID: 'GROUP_ID', CD: 'CODE', CD_NM: 'CODE_NAME' },
  },
};

const dsState = {
  editing: null, // { id, isNew, name, description, text, savedText, savedName, savedDescription }
  parse: null, // { value } | { error, line, column }
  validation: null,
  validateSeq: 0,
  pendingSwitch: null,
  confirmDelete: false,
  message: null, // { kind: 'ok'|'error', text }
};

async function openDatasetScreen() {
  await loadDatasetList().catch(() => {});
  renderDatasetList();
  if (!dsState.editing) {
    if (schemaState.datasets.length) await selectDataset(schemaState.datasetId ?? schemaState.datasets[0].id);
    else renderDatasetEditor();
  }
}

function isDirty() {
  const e = dsState.editing;
  return !!e && (e.text !== e.savedText || e.name !== e.savedName || e.description !== e.savedDescription);
}

/* ---------------- list ---------------- */
function renderDatasetList() {
  const host = document.getElementById('dsItems');
  if (!schemaState.datasets.length && !dsState.editing?.isNew) {
    host.replaceChildren(el('div', { class: 'ds-empty' }, '등록된 데이터셋이 없습니다.', el('br'), '“＋ 새 데이터셋”으로 시작하거나 샘플을 불러오세요.'));
    return;
  }
  const items = schemaState.datasets.map((d) => el('button', {
    class: `ds-item${dsState.editing?.id === d.id && !dsState.editing.isNew ? ' selected' : ''}`,
    type: 'button',
    onclick: () => requestSwitch(() => selectDataset(d.id)),
  },
    el('div', { class: 'ds-item-name' }, d.name,
      schemaState.datasetId === d.id ? el('span', { class: 'ds-active', title: '변환 뷰에서 사용 중' }, '사용 중') : null),
    el('div', { class: 'ds-item-meta' },
      el('span', { class: 'mono' }, d.id), ' · ', `테이블 ${d.tables}`, ' · ', `컬럼 ${d.columns}`),
    el('div', { class: 'ds-item-date' }, formatDate(d.updatedAt)),
  ));
  if (dsState.editing?.isNew) {
    items.unshift(el('div', { class: 'ds-item selected draft' },
      el('div', { class: 'ds-item-name' }, dsState.editing.name || '새 데이터셋', el('span', { class: 'ds-active draft' }, '작성 중'))));
  }
  host.replaceChildren(...items);
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Leaving unsaved edits asks first — inline, not with a browser dialog. */
function requestSwitch(action) {
  if (!isDirty()) {
    action();
    return;
  }
  dsState.pendingSwitch = action;
  renderDatasetEditor();
}

async function selectDataset(id) {
  const dataset = await api(`/api/v1/datasets/${encodeURIComponent(id)}`);
  const text = JSON.stringify(dataset.mapping, null, 2);
  dsState.editing = {
    id: dataset.id, isNew: false, name: dataset.name, description: dataset.description ?? '',
    text, savedText: text, savedName: dataset.name, savedDescription: dataset.description ?? '',
  };
  dsState.confirmDelete = false;
  dsState.pendingSwitch = null;
  dsState.message = null;
  reparse();
  renderDatasetList();
  renderDatasetEditor();
}

function startNewDataset({ name = '', description = '', mapping = null } = {}) {
  const text = mapping ? JSON.stringify(mapping, null, 2) : '{\n  \n}';
  dsState.editing = { id: '', isNew: true, name, description, text, savedText: '', savedName: '', savedDescription: '' };
  dsState.confirmDelete = false;
  dsState.pendingSwitch = null;
  dsState.message = null;
  reparse();
  renderDatasetList();
  renderDatasetEditor();
}

/* ---------------- parsing + validation ---------------- */
function reparse() {
  const { text } = dsState.editing;
  try {
    let value = JSON.parse(text);
    // a whole exported dataset ({ name, mapping, ... }) is accepted too
    if (value && typeof value === 'object' && !Array.isArray(value) && value.mapping && typeof value.mapping === 'object'
      && Object.keys(value).every((k) => ['id', 'name', 'description', 'mapping', 'createdAt', 'updatedAt', 'validation'].includes(k))) {
      if (!dsState.editing.name && value.name) dsState.editing.name = value.name;
      if (!dsState.editing.description && value.description) dsState.editing.description = value.description;
      value = value.mapping;
      dsState.editing.text = JSON.stringify(value, null, 2);
    }
    dsState.parse = { value };
  } catch (e) {
    dsState.parse = { error: e.message, ...errorPosition(text, e.message) };
  }
  dsState.validation = null;
  if (dsState.parse.value !== undefined) {
    const seq = ++dsState.validateSeq;
    api('/api/v1/datasets/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mapping: dsState.parse.value }),
    }).then((validation) => {
      if (seq !== dsState.validateSeq) return;
      dsState.validation = validation;
      renderValidation();
      renderPreview();
      renderEditorActions();
    }).catch(() => {});
  }
}

function errorPosition(text, message) {
  const lineCol = /line (\d+) column (\d+)/.exec(message);
  if (lineCol) return { line: Number(lineCol[1]), column: Number(lineCol[2]) };
  const pos = /position (\d+)/.exec(message);
  if (!pos) return {};
  const before = text.slice(0, Number(pos[1]));
  const lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/* ---------------- editor ---------------- */
let validateTimer = null;

function renderDatasetEditor() {
  const host = document.getElementById('dsMain');
  const e = dsState.editing;
  if (!e) {
    host.replaceChildren(el('div', { class: 'ds-welcome' },
      el('h2', {}, '매핑 데이터셋'),
      el('p', {}, '레거시 테이블/컬럼을 신규 스키마 이름으로 바꾸는 규칙입니다. 테이블별로 컬럼을 매핑하므로, 같은 컬럼명도 테이블마다 다르게 바꿀 수 있습니다.'),
      el('pre', { class: 'ds-sample-json' }, JSON.stringify(DATASET_EXAMPLE, null, 2)),
      el('div', { class: 'ds-welcome-actions' },
        el('button', { class: 'btn primary', type: 'button', onclick: () => startNewDataset() }, '＋ 새 데이터셋'),
        el('button', { class: 'btn', type: 'button', onclick: () => startNewDataset({ name: '예시 매핑', mapping: DATASET_EXAMPLE }) }, '이 예시로 시작'),
      ),
    ));
    return;
  }

  const textarea = el('textarea', {
    class: 'ds-json', id: 'dsJson', spellcheck: 'false', autocomplete: 'off', 'aria-label': '매핑 JSON',
    oninput: (ev) => {
      e.text = ev.target.value;
      updateGutter();
      clearTimeout(validateTimer);
      validateTimer = setTimeout(() => {
        const prevText = e.text;
        reparse();
        if (e.text !== prevText) ev.target.value = e.text; // a pasted whole dataset was unwrapped
        renderValidation();
        renderPreview();
        renderEditorActions();
        renderHeaderFields();
      }, 250);
      renderEditorActions();
    },
    onscroll: (ev) => { document.getElementById('dsGutter').scrollTop = ev.target.scrollTop; },
    onkeydown: (ev) => {
      if (ev.key === 'Tab') { // indent instead of leaving the editor
        ev.preventDefault();
        const t = ev.target;
        const { selectionStart: s, selectionEnd: en } = t;
        t.setRangeText('  ', s, en, 'end');
        t.dispatchEvent(new Event('input'));
      }
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 's') { ev.preventDefault(); saveDataset(); }
    },
  });
  textarea.value = e.text;

  host.replaceChildren(...[
    dsState.pendingSwitch ? el('div', { class: 'ds-banner warn' },
      '저장하지 않은 변경이 있습니다.',
      el('button', { class: 'btn small', type: 'button', onclick: () => { const go = dsState.pendingSwitch; dsState.pendingSwitch = null; e.text = e.savedText; e.name = e.savedName; e.description = e.savedDescription; go(); } }, '버리고 이동'),
      el('button', { class: 'btn small', type: 'button', onclick: () => { dsState.pendingSwitch = null; renderDatasetEditor(); } }, '계속 편집'),
    ) : null,
    dsState.message ? el('div', { class: `ds-banner ${dsState.message.kind}` }, dsState.message.text) : null,
    el('div', { class: 'ds-fields', id: 'dsFields' }),
    el('div', { class: 'ds-work' },
      el('div', { class: 'ds-editor-col' },
        el('div', { class: 'ds-editor-bar' },
          el('span', { class: 'ds-editor-title' }, '매핑 JSON'),
          el('span', { class: 'ds-hint' }, '{ "레거시테이블": { "targetTable": "신규", "columns": { "레거시컬럼": "신규" } } }'),
          el('div', { class: 'ds-editor-tools' },
            el('button', { class: 'tool-btn', type: 'button', onclick: formatJson }, '포맷 정리'),
            el('button', { class: 'tool-btn', type: 'button', onclick: insertExample }, '예시 넣기'),
            el('button', { class: 'tool-btn', type: 'button', onclick: downloadJson }, 'JSON 다운로드'),
          ),
        ),
        el('div', { class: 'ds-editor-wrap' }, el('pre', { class: 'ds-gutter', id: 'dsGutter', 'aria-hidden': 'true' }), textarea),
        el('div', { class: 'ds-validation', id: 'dsValidation', 'aria-live': 'polite' }),
      ),
      el('div', { class: 'ds-preview-col' },
        el('div', { class: 'ds-editor-bar' }, el('span', { class: 'ds-editor-title' }, '미리보기'), el('span', { class: 'ds-hint' }, '저장 시 이렇게 변환됩니다')),
        el('div', { class: 'ds-preview', id: 'dsPreview' }),
      ),
    ),
    el('div', { class: 'ds-actions', id: 'dsActions' })
  ].filter(Boolean));
  renderHeaderFields();
  updateGutter();
  renderValidation();
  renderPreview();
  renderEditorActions();
}

function renderHeaderFields() {
  const host = document.getElementById('dsFields');
  if (!host) return;
  const e = dsState.editing;
  const field = (label, input, hint) => el('label', { class: 'ds-field' }, el('span', { class: 'ds-field-label' }, label), input, hint ? el('span', { class: 'ds-field-hint' }, hint) : null);
  const nameInput = el('input', {
    type: 'text', value: e.name, placeholder: '예: 주문 시스템 v2 스키마',
    oninput: (ev) => {
      e.name = ev.target.value;
      if (e.isNew && !e.idTouched) {
        e.id = slugify(e.name);
        const idInput = document.getElementById('dsIdInput');
        if (idInput) idInput.value = e.id;
      }
      renderEditorActions();
    },
  });
  const idInput = el('input', {
    type: 'text', id: 'dsIdInput', value: e.id, placeholder: 'order-v2', class: 'mono',
    ...(e.isNew ? {} : { readonly: '', title: '저장된 데이터셋의 ID는 바꿀 수 없습니다' }),
    oninput: (ev) => { e.id = ev.target.value; e.idTouched = true; renderEditorActions(); },
  });
  const descInput = el('input', {
    type: 'text', value: e.description, placeholder: '선택 사항',
    oninput: (ev) => { e.description = ev.target.value; renderEditorActions(); },
  });
  host.replaceChildren(...[
    field('이름', nameInput),
    field('ID', idInput, e.isNew ? '파일 이름 · 영문/숫자/-/_' : '변경 불가'),
    field('설명', descInput)
  ].filter(Boolean));
}

function slugify(name) {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return slug || `dataset-${Date.now().toString(36)}`;
}

function updateGutter() {
  const gutter = document.getElementById('dsGutter');
  if (!gutter) return;
  const lines = dsState.editing.text.split('\n').length;
  const errLine = dsState.parse?.error ? dsState.parse.line : null;
  gutter.replaceChildren(...Array.from({ length: lines }, (_, i) =>
    el('span', { class: i + 1 === errLine ? 'err' : '' }, `${i + 1}\n`)));
  const ta = document.getElementById('dsJson');
  if (ta) gutter.scrollTop = ta.scrollTop;
}

function renderValidation() {
  const host = document.getElementById('dsValidation');
  if (!host) return;
  updateGutter();
  const p = dsState.parse;
  if (p?.error) {
    host.replaceChildren(el('div', { class: 'ds-v error' },
      el('span', { class: 'badge ERROR' }, 'JSON'),
      el('span', {}, p.line ? `${p.line}행 ${p.column}열: ` : '', p.error),
      p.line ? el('button', { class: 'tool-btn', type: 'button', onclick: () => jumpTo(p.line, p.column) }, '위치로 이동') : null,
    ));
    return;
  }
  const v = dsState.validation;
  if (!v) {
    host.replaceChildren(el('div', { class: 'ds-v pending' }, '검사 중…'));
    return;
  }
  const items = [
    ...v.errors.map((x) => el('div', { class: 'ds-v error' }, el('span', { class: 'badge ERROR' }, '오류'), el('span', { class: 'mono path' }, x.path), el('span', {}, x.message))),
    ...v.warnings.map((x) => el('div', { class: 'ds-v warn' }, el('span', { class: 'badge WARNING' }, '주의'), el('span', { class: 'mono path' }, x.path), el('span', {}, x.message))),
  ];
  host.replaceChildren(...[
    el('div', { class: `ds-v ${v.valid ? 'ok' : 'error'} head` },
      el('span', { class: `badge ${v.valid ? 'SAFE' : 'ERROR'}` }, v.valid ? '유효' : `오류 ${v.errors.length}`),
      el('span', {}, `테이블 ${v.summary.tables}개 (이름 변경 ${v.summary.renamedTables}) · 컬럼 매핑 ${v.summary.columns}개`),
      v.warnings.length ? el('span', { class: 'warn-text' }, ` · 주의 ${v.warnings.length}`) : null,
    ),
    ...items
  ].filter(Boolean));
}

function jumpTo(line, column) {
  const ta = document.getElementById('dsJson');
  const lines = ta.value.split('\n');
  const offset = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + Math.max(0, column - 1);
  ta.focus();
  ta.setSelectionRange(offset, Math.min(offset + 1, ta.value.length));
  ta.scrollTop = Math.max(0, (line - 4) * parseFloat(getComputedStyle(ta).lineHeight));
}

function renderPreview() {
  const host = document.getElementById('dsPreview');
  if (!host) return;
  const value = dsState.parse?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    host.replaceChildren(el('div', { class: 'ds-empty' }, '유효한 JSON 객체를 입력하면 매핑 미리보기가 나타납니다.'));
    return;
  }
  const entries = Object.entries(value);
  if (!entries.length) {
    host.replaceChildren(el('div', { class: 'ds-empty' }, '아직 테이블이 없습니다. “예시 넣기”로 형식을 확인해 보세요.'));
    return;
  }
  host.replaceChildren(...entries.map(([table, entry]) => {
    const target = entry && typeof entry === 'object' ? entry.targetTable : null;
    const columns = entry && typeof entry === 'object' && entry.columns && typeof entry.columns === 'object' ? Object.entries(entry.columns) : [];
    const renamed = target && String(target).toUpperCase() !== table.toUpperCase();
    return el('div', { class: 'ds-card' },
      el('div', { class: 'ds-card-head' },
        el('span', { class: 'mono old' }, table),
        el('span', { class: 'arrow' }, '→'),
        el('span', { class: `mono ${renamed ? 'new' : 'same'}` }, renamed ? String(target) : '(이름 유지)'),
        el('span', { class: 'ds-card-count' }, `컬럼 ${columns.length}`),
      ),
      columns.length
        ? el('div', { class: 'ds-cols' }, ...columns.map(([from, to]) => el('span', { class: 'ds-col' },
          el('span', { class: 'mono old' }, from), el('span', { class: 'arrow' }, '→'), el('span', { class: 'mono new' }, String(to)))))
        : el('div', { class: 'ds-cols none' }, renamed ? '컬럼 매핑 없음 — 테이블명만 변경' : '변경 없음'),
    );
  }));
}

function renderEditorActions() {
  const host = document.getElementById('dsActions');
  if (!host) return;
  const e = dsState.editing;
  const valid = dsState.parse?.value !== undefined && dsState.validation?.valid;
  const idOk = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(e.id);
  const dirty = isDirty() || e.isNew;
  const canSave = valid && idOk && dirty;
  const why = !dsState.parse?.value ? 'JSON 오류를 먼저 고쳐 주세요'
    : !dsState.validation ? '검사 중'
    : !dsState.validation.valid ? '매핑 오류를 먼저 고쳐 주세요'
    : !idOk ? 'ID를 확인해 주세요 (영문/숫자/-/_)'
    : !dirty ? '변경 사항 없음' : '';

  host.replaceChildren(...[
    e.isNew ? el('button', { class: 'btn', type: 'button', onclick: () => { dsState.editing = null; openDatasetScreen(); } }, '취소')
      : el('button', {
        class: `btn danger${dsState.confirmDelete ? ' armed' : ''}`, type: 'button',
        onclick: () => {
          if (!dsState.confirmDelete) {
            dsState.confirmDelete = true;
            renderEditorActions();
            setTimeout(() => { dsState.confirmDelete = false; renderEditorActions(); }, 3000);
            return;
          }
          deleteDataset();
        },
      }, dsState.confirmDelete ? '한 번 더 누르면 삭제' : '삭제'),
    el('span', { class: 'ds-actions-status' }, isDirty() && !e.isNew ? '● 저장되지 않은 변경' : why),
    el('button', { class: 'btn', type: 'button', ...(canSave ? {} : { disabled: '' }), onclick: () => saveDataset() }, '저장'),
    el('button', {
      class: 'btn primary', type: 'button', ...(valid && idOk ? {} : { disabled: '' }),
      onclick: () => saveDataset({ thenShow: true }),
    }, dirty ? '저장하고 변환 보기 →' : '변환 보기 →')
  ].filter(Boolean));
}

/* ---------------- actions ---------------- */
async function saveDataset({ thenShow = false } = {}) {
  const e = dsState.editing;
  if (!dsState.validation?.valid) return;
  if (isDirty() || e.isNew) {
    const res = await fetch(`/api/v1/datasets/${encodeURIComponent(e.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: e.name || e.id, description: e.description, mapping: dsState.parse.value }),
    });
    const body = await res.json();
    if (!res.ok) {
      dsState.message = { kind: 'error', text: `저장 실패: ${body.error ?? res.status}` };
      renderDatasetEditor();
      return;
    }
    invalidateSchemaResult();
    await loadDatasetList();
    await selectDataset(body.id);
    dsState.message = { kind: 'ok', text: `“${body.name}” 저장됨` };
    renderDatasetEditor();
  }
  schemaState.datasetId = e.id;
  writeStored('schema.datasetId', e.id);
  schemaState.result = null;
  renderDatasetList();
  if (thenShow) {
    showScreen('analysis');
    if (state.projectId) showView('schema');
  }
}

async function deleteDataset() {
  const { id } = dsState.editing;
  await fetch(`/api/v1/datasets/${encodeURIComponent(id)}`, { method: 'DELETE' });
  invalidateSchemaResult();
  dsState.editing = null;
  if (schemaState.datasetId === id) schemaState.datasetId = null;
  await loadDatasetList();
  dsState.message = null;
  renderDatasetList();
  if (schemaState.datasets.length) await selectDataset(schemaState.datasets[0].id);
  else renderDatasetEditor();
}

function formatJson() {
  if (dsState.parse?.value === undefined) return;
  const ta = document.getElementById('dsJson');
  dsState.editing.text = JSON.stringify(dsState.parse.value, null, 2);
  ta.value = dsState.editing.text;
  updateGutter();
  renderEditorActions();
}

function insertExample() {
  const ta = document.getElementById('dsJson');
  const current = dsState.parse?.value;
  const merged = current && typeof current === 'object' && !Array.isArray(current) ? { ...current, ...DATASET_EXAMPLE } : DATASET_EXAMPLE;
  dsState.editing.text = JSON.stringify(merged, null, 2);
  ta.value = dsState.editing.text;
  reparse();
  renderDatasetEditor();
}

function downloadJson() {
  const e = dsState.editing;
  const blob = new Blob([`${e.text}\n`], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `${e.id || 'mapping'}.json` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

document.getElementById('dsNewBtn').addEventListener('click', () => requestSwitch(() => startNewDataset()));

function loadSampleIntoEditor(kind) {
  requestSwitch(async () => {
    const set = SAMPLE_SETS[kind];
    const mapping = await fetch(`${set.dir}schema-mapping.json`).then((r) => r.json());
    startNewDataset({ name: set.datasetName, description: set.description, mapping });
    dsState.editing.id = set.datasetId;
    renderHeaderFields();
    renderEditorActions();
  });
}

document.getElementById('dsSampleBtn').addEventListener('click', () => loadSampleIntoEditor('basic'));
document.getElementById('dsAdvancedBtn').addEventListener('click', () => loadSampleIntoEditor('advanced'));

document.getElementById('dsImportInput').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  const text = await file.text();
  requestSwitch(() => {
    startNewDataset({ name: file.name.replace(/\.json$/i, '') });
    dsState.editing.id = slugify(dsState.editing.name);
    dsState.editing.text = text;
    reparse();
    renderDatasetEditor();
  });
});

// The tab count is known before the screen is ever opened.
loadDatasetList().catch(() => {});
