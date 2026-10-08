import { tokenize, TokenKind } from '../converter/schema/SqlLexer.js';

/**
 * "이 결과 컬럼을 없애려면 무엇을 고쳐야 하나" — a removal GUIDE for one output
 * column of a SELECT statement. Nothing is edited: the guide lists, with
 * file:line and the line's text, every place a human has to look at.
 *
 * 1. Trace. The column is followed down the statement's SELECT hierarchy
 *    (analyzer/lineage): from the final output item, through every derived
 *    table / CTE / inline view that feeds it, to the source table column. A
 *    UNION's branches contribute the item at the same position.
 * 2. Locate. The statement's resolved tree is walked in document order —
 *    INSIDE every `<include refid>` fragment, whatever file it is in — and
 *    each SQL text block is tokenized (the lossless SqlLexer). Every
 *    reference to a traced name (`Q.COL`, a bare `COL`, an alias) is
 *    recorded with its file, line, clause (SELECT / WHERE / JOIN ON /
 *    GROUP BY / ORDER BY …), enclosing dynamic tag and fragment.
 * 3. Classify into steps:
 *    REMOVE_SELECT_ITEM   a SELECT-list reference: the item to delete (mind the comma)
 *    REMOVE_FRAGMENT      the fragment holds nothing but this column: delete it…
 *    REMOVE_INCLUDE       …and every <include refid> of it (each includer listed)
 *    SHARED_FRAGMENT      the fragment is included by other statements too:
 *                         editing it changes them — split it first (they are listed)
 *    REMOVE_RESULT_MAPPING a resultMap <result column=…> mapping the column
 *    SHARED_RESULT_MAP    …a resultMap other statements use as well
 *    CHECK_REFERENCE      the column also feeds a WHERE / JOIN / GROUP / ORDER:
 *                         removing the output does not need these, dropping
 *                         the column from the table does
 *    REMOVE_DYNAMIC_TAG   a dynamic tag (<isNotEmpty>/<if>…) whose whole body is
 *                         this column's condition
 *    CHECK_JAVA           resultClass is a class: its field for the column
 */
const CLAUSES = ['SELECT', 'FROM', 'WHERE', 'ON', 'HAVING', 'SET', 'VALUES', 'INTO', 'UNION'];
const NOT_IDENTIFIERS = new Set(['AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'BETWEEN', 'EXISTS', 'TRUE', 'FALSE']);

const norm = (s) => (s ?? '').replace(/^["`[]|["`\]]$/g, '').toUpperCase();
const lastPart = (expr) => norm(String(expr ?? '').split('.').pop());
const outputName = (o) => norm(o.alias ?? o.sourceColumn ?? lastPart(o.expression));
const camel = (s) => s.toLowerCase().replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/** the output item of `select` named `name`, and its position */
function findOutput(select, name) {
  const index = select.outputs.findIndex((o) => outputName(o) === norm(name));
  return index === -1 ? null : { index, item: select.outputs[index] };
}

/** follows one output item down its derived tables; returns the trace tree */
function traceItem(selectsById, select, item, seen = new Set()) {
  const node = { selectId: select.id, origin: select.origin, scopeAlias: select.alias, expression: item.expression, alias: item.alias, aggregate: item.aggregate, sources: [] };
  if (seen.has(select.id)) return node;
  for (const ref of item.sourceRefs ?? []) {
    const table = (select.tables ?? []).find((t) => norm(t.alias ?? t.name) === norm(ref.table)) ?? (select.tables?.length === 1 && !ref.table ? select.tables[0] : null);
    if (table?.derived && table.selectId && selectsById.has(table.selectId)) {
      const inner = selectsById.get(table.selectId);
      const found = findOutput(inner, ref.column);
      if (found) {
        node.sources.push(traceItem(selectsById, inner, found.item, new Set([...seen, select.id])));
        continue;
      }
    }
    node.sources.push({ table: table ? table.name : ref.table ?? null, column: ref.column, base: true });
  }
  return node;
}

/** every name that refers to the traced column somewhere along the chain */
function namesOf(trace, out = { columns: new Set(), aliases: new Set(), qualifiers: new Set() }) {
  if (trace.base) {
    out.columns.add(norm(trace.column));
    return out;
  }
  if (trace.alias) out.aliases.add(norm(trace.alias));
  const ref = /([\w$#]+)\.([\w$#]+)\s*$/.exec(trace.expression ?? '');
  if (ref) {
    out.qualifiers.add(norm(ref[1]));
    out.columns.add(norm(ref[2]));
  } else if (/^[\w$#]+$/.test(trace.expression ?? '')) out.columns.add(norm(trace.expression));
  if (trace.scopeAlias) out.qualifiers.add(norm(trace.scopeAlias));
  for (const s of trace.sources) namesOf(s, out);
  return out;
}

/**
 * @param {import('./ProjectSession.js').ProjectSession} session
 * @param {string} qualifiedId a SELECT statement
 * @param {string} column an output column name (alias or column) of it
 */
export function buildColumnRemovalGuide(session, qualifiedId, column) {
  const analysis = session.analyze(qualifiedId);
  if (!analysis) return null;
  const selects = analysis.lineage?.selects ?? [];
  const selectsById = new Map(selects.map((s) => [s.id, s]));
  const root = selects.find((s) => s.role === 'MAIN' || s.role === 'WRITE');
  const guide = { statement: qualifiedId, column, found: false, trace: [], steps: [], notes: [] };
  if (!root) {
    guide.notes.push('SELECT 구조를 분석하지 못했습니다 (SQL_PARSE_FAILED 등) — 아래 위치는 이름으로만 찾았습니다.');
  }

  // 1. trace: the main SELECT's item, plus the same position of every UNION branch
  const hit = root && findOutput(root, column);
  if (hit) {
    guide.found = true;
    guide.trace.push(traceItem(selectsById, root, hit.item));
    for (const branch of selects.filter((s) => s.role === 'UNION_BRANCH')) {
      const item = branch.outputs[hit.index];
      if (item) guide.trace.push(traceItem(selectsById, branch, item));
    }
  } else if (root) {
    const star = root.outputs.find((o) => /(^|\.)\*$/.test(o.expression ?? ''));
    guide.notes.push(star
      ? `결과 컬럼이 "${star.expression}"로 나옵니다: 이 컬럼만 빼려면 *를 필요한 컬럼 목록으로 바꿔야 합니다.`
      : `"${column}"은 이 statement의 SELECT 결과 컬럼이 아닙니다 — 아래는 이름이 같은 참조입니다.`);
  }
  const names = guide.trace.length ? guide.trace.reduce((acc, t) => namesOf(t, acc), undefined) : { columns: new Set([norm(column)]), aliases: new Set([norm(column)]), qualifiers: new Set() };

  const literals = new Set(guide.trace.map((t) => String(t.expression ?? '').trim()).filter((e) => /^(\d+(\.\d+)?|'[^']*')$/.test(e)));

  // 2. locate every reference in the resolved tree (includes followed, in document order)
  const resolved = session.resolve(qualifiedId);
  const at = session.statementXml(qualifiedId);
  const occurrences = [];
  const fragmentText = new Map(); // fid -> identifier tokens of its whole body
  let clause = null;
  const walk = (nodes, ctx) => {
    for (const node of nodes ?? []) {
      if (node.type === 'TextSql') scanText(node, ctx);
      else if (node.type === 'ResolvedInclude') {
        walk(node.children, { ...ctx, fragment: node.qualifiedId, refid: node.refid, includeLine: node.sourceLine, includeFile: node.sourceFile });
      } else if (node.type === 'Conditional' || node.type === 'Iterate' || node.type === 'Dynamic') {
        const tag = node.type === 'Conditional' ? { node, line: node.sourceLine, file: node.sourceFile, label: conditionalLabel(node) } : ctx.tag;
        walk(node.children, { ...ctx, tag });
      } else if (node.children) walk(node.children, ctx);
    }
  };
  const scanText = (node, ctx) => {
    const tokens = tokenize(node.text);
    let line = node.sourceLine;
    const lines = node.text.split('\n');
    const lineOf = (k) => lines[k - node.sourceLine] ?? '';
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.kind === TokenKind.WHITESPACE || t.kind === TokenKind.COMMENT || t.kind === TokenKind.STRING) {
        line += (t.text.match(/\n/g) ?? []).length;
        continue;
      }
      const kw = t.kind === TokenKind.WORD ? t.text.toUpperCase() : null;
      if (kw && CLAUSES.includes(kw)) clause = kw === 'ON' ? 'JOIN ON' : kw;
      if (kw === 'BY') {
        const prev = tokens.slice(0, i).reverse().find((x) => x.kind === TokenKind.WORD);
        if (prev && ['GROUP', 'ORDER'].includes(prev.text.toUpperCase())) clause = `${prev.text.toUpperCase()} BY`;
      }
      if (ctx.fragment) {
        if (!fragmentText.has(ctx.fragment)) fragmentText.set(ctx.fragment, []);
        if (t.isIdentifier && !NOT_IDENTIFIERS.has(kw)) fragmentText.get(ctx.fragment).push(norm(t.value));
      }
      // an output that is a literal (`SELECT 1`, `'Y' AS FLAG`): its token in the SELECT list
      if ((t.kind === TokenKind.NUMBER || t.kind === TokenKind.STRING) && clause === 'SELECT' && literals.has(t.text)) {
        occurrences.push({ file: ctx.fragment ? node.sourceFile : at.sourceFile, line, clause, text: lineOf(line).trim(), fragment: ctx.fragment ?? null, refid: ctx.refid ?? null, includeLine: ctx.includeLine ?? null, tag: ctx.tag ?? null });
        continue;
      }
      if (!t.isIdentifier) continue;
      const prev = tokens[i - 1];
      const next = tokens[i + 1];
      const qualifiedRef = prev?.is('.') ? tokens[i - 2] : null;
      const name = norm(t.value);
      const isColumnRef = names.columns.has(name) && !next?.is('.') && (!qualifiedRef || names.qualifiers.has(norm(qualifiedRef.value)) || names.qualifiers.size === 0);
      const isAlias = names.aliases.has(name) && !prev?.is('.') && !next?.is('.');
      if (!isColumnRef && !isAlias) continue;
      // one occurrence per (place, line): `C.EMAIL AS EMAIL` is one reference
      const file = ctx.fragment ? node.sourceFile : at.sourceFile;
      const last = occurrences[occurrences.length - 1];
      if (last && last.file === file && last.line === line && last.clause === clause) continue;
      occurrences.push({ file, line, clause, text: lineOf(line).trim(), fragment: ctx.fragment ?? null, refid: ctx.refid ?? null, includeLine: ctx.includeLine ?? null, tag: ctx.tag ?? null });
    }
  };
  if (resolved) walk(resolved.resolvedTree.children, {});

  // 3. steps
  const fragmentsSeen = new Set();
  const tagsSeen = new Set();
  for (const o of occurrences) {
    const where = { file: o.file, line: o.line, text: o.text };
    const inFragment = o.fragment ? { fragment: o.fragment, refid: o.refid } : {};
    if (o.fragment && !fragmentsSeen.has(o.fragment)) {
      fragmentsSeen.add(o.fragment);
      const others = session.includerStatements(o.fragment).filter((id) => id !== qualifiedId);
      const body = fragmentText.get(o.fragment) ?? [];
      const onlyThis = body.length > 0 && body.every((n) => names.columns.has(n) || names.aliases.has(n) || names.qualifiers.has(n));
      if (others.length) {
        guide.steps.push({ action: 'SHARED_FRAGMENT', ...where, ...inFragment, sharedBy: others, reason: `<sql id> ${o.fragment}은(는) 다른 statement ${others.length}개도 포함합니다. 여기서 지우면 그쪽 결과도 바뀝니다 — 이 statement용으로 분리하거나 함께 지워도 되는지 확인하세요.` });
      } else if (onlyThis) {
        guide.steps.push({ action: 'REMOVE_FRAGMENT', ...where, ...inFragment, reason: `<sql id> ${o.fragment}에는 이 컬럼만 있습니다: fragment를 통째로 삭제할 수 있습니다.` });
        for (const site of session.includeSites(o.fragment)) {
          guide.steps.push({ action: 'REMOVE_INCLUDE', file: site.file, line: site.line, text: site.text, fragment: o.fragment, reason: `${site.statement}의 <include refid="${site.refid}"> 삭제 (앞뒤 쉼표/연결어 정리)` });
        }
      }
    }
    if (o.clause === 'SELECT') {
      guide.steps.push({ action: 'REMOVE_SELECT_ITEM', ...where, ...inFragment, reason: o.fragment ? `fragment ${o.fragment} 안의 SELECT 항목 (앞뒤 쉼표 정리)` : 'SELECT 항목 삭제 (앞뒤 쉼표 정리)' });
    } else {
      guide.steps.push({ action: 'CHECK_REFERENCE', ...where, ...inFragment, clause: o.clause, reason: `${o.clause ?? '다른 절'}에서도 쓰입니다: 결과 컬럼만 빼는 데는 필요 없지만, 테이블에서 컬럼을 없앤다면 이것도 고쳐야 합니다.` });
    }
    if (o.tag && !tagsSeen.has(o.tag.node) && o.clause !== 'SELECT' && tagOnlyThis(o.tag.node, names)) {
      tagsSeen.add(o.tag.node);
      guide.steps.push({ action: 'REMOVE_DYNAMIC_TAG', file: o.tag.file, line: o.tag.line, text: o.tag.label, reason: `${o.tag.label} 안에는 이 컬럼의 조건뿐입니다: 컬럼을 없애면 태그째 삭제 (파라미터도 더 안 쓰는지 확인)` });
    }
  }

  // resultMap mappings / Java fields
  const meta = session.statementMeta(qualifiedId);
  if (meta?.resultMap) {
    for (const rm of session.resultMapNodes(meta.resultMap, at.namespace)) {
      for (const r of rm.node.results ?? []) {
        if (!names.aliases.has(norm(r.column)) && norm(r.column) !== norm(column)) continue;
        guide.steps.push({ action: 'REMOVE_RESULT_MAPPING', file: rm.sourceFile, line: r.sourceLine ?? rm.node.sourceLine, text: `<result property="${r.property}" column="${r.column}"/>`, reason: `resultMap ${rm.qualifiedId}의 매핑 삭제 (Java 필드 ${r.property}도 확인)` });
        const users = session.statementsUsingResultMap(rm.qualifiedId).filter((id) => id !== qualifiedId);
        if (users.length) guide.steps.push({ action: 'SHARED_RESULT_MAP', file: rm.sourceFile, line: rm.node.sourceLine, text: `<resultMap id="${rm.node.id}">`, sharedBy: users, reason: `이 resultMap은 다른 statement ${users.length}개도 씁니다 — 그쪽이 이 컬럼을 계속 돌려주면 매핑을 남겨야 합니다.` });
      }
    }
  } else if (meta?.resultClass && !/map$/i.test(meta.resultClass) && !/^(int|long|string|java\.lang\.\w+)$/i.test(meta.resultClass)) {
    guide.steps.push({ action: 'CHECK_JAVA', file: at.sourceFile, line: meta.line, text: `resultClass="${meta.resultClass}"`, reason: `결과를 ${meta.resultClass}에 자동 매핑합니다: 필드 ${camel(column)} (또는 ${column})가 더 쓰이는지 확인하세요.` });
  }

  // An inner level's item (a derived table's / CTE's output) also feeds whatever the outer
  // query does with it: while a WHERE / JOIN / ORDER still uses the value, it must stay.
  const squash = (s) => String(s ?? '').replace(/\s+/g, '').toUpperCase();
  const rootExpressions = guide.trace.map((t) => squash(t.expression));
  const otherUses = guide.steps.filter((s) => s.action === 'CHECK_REFERENCE');
  for (const step of guide.steps) {
    if (step.action !== 'REMOVE_SELECT_ITEM' || !rootExpressions.length) continue;
    step.level = rootExpressions.some((e) => e && squash(step.text).includes(e)) ? 'result' : 'inner';
    if (step.level === 'inner' && otherUses.length) {
      step.reason += ` — 단, 바깥 쿼리가 이 값을 아래 '함께 확인' 위치(${otherUses.map((u) => `${u.file}:${u.line}`).join(', ')})에서 쓰는 동안은 남겨야 합니다`;
    }
  }

  const order = { REMOVE_SELECT_ITEM: 0, REMOVE_FRAGMENT: 1, REMOVE_INCLUDE: 2, SHARED_FRAGMENT: 3, REMOVE_RESULT_MAPPING: 4, SHARED_RESULT_MAP: 5, CHECK_JAVA: 6, REMOVE_DYNAMIC_TAG: 7, CHECK_REFERENCE: 8 };
  guide.steps.sort((a, b) => (order[a.action] - order[b.action]) || String(a.file).localeCompare(String(b.file)) || a.line - b.line);
  if (!guide.steps.length) guide.notes.push('XML에서 이 컬럼을 가리키는 곳을 찾지 못했습니다.');
  return guide;
}

function conditionalLabel(node) {
  const attrs = [node.property && `property="${node.property}"`, node.test && `test="${node.test}"`, node.compareValue && `compareValue="${node.compareValue}"`].filter(Boolean).join(' ');
  return `<${node.conditionType}${attrs ? ` ${attrs}` : ''}>`;
}

/** every identifier in the tag's SQL is one of the traced names */
function tagOnlyThis(tag, names) {
  const ids = [];
  const collect = (nodes) => {
    for (const n of nodes ?? []) {
      if (n.type === 'TextSql') {
        for (const t of tokenize(n.text)) if (t.isIdentifier && !NOT_IDENTIFIERS.has(t.text.toUpperCase())) ids.push(norm(t.value));
      } else collect(n.children);
    }
  };
  collect(tag.children);
  return ids.length > 0 && ids.every((n) => names.columns.has(n) || names.aliases.has(n) || names.qualifiers.has(n));
}

