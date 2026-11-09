/**
 * Flattens a resolved iBATIS statement tree into literal SQL text that a
 * real SQL parser can consume — the boundary between "iBATIS structural
 * analysis" (parser/ast/resolver/analyzer-dynamic) and "SQL semantic
 * analysis" (this package). See docs/ARCHITECTURE.md for why the two are
 * kept apart.
 *
 * This does not execute or simulate the statement; it reproduces iBATIS's
 * own dynamic-tag rendering algorithm assuming every optional branch is
 * present, so the flattened SQL is a superset covering every table/column/
 * join reference the statement could ever produce — except where a
 * condition decides WHICH table is read (a dynamic table name): there,
 * `tableChoices` / `tableVariants` give one flattening per choice, see
 * below. The rule (matching
 * iBATIS's actual SqlTagContext bookkeeping) is:
 *
 *  - A conditional tag with no `prepend` (nor removeFirstPrepend / open /
 *    close) is transparent: its children count as children of the
 *    enclosing tag for the rule below (iBATIS 2.3's SqlTagContext makes
 *    such a tag "look to the parent"). Without this, the common
 *    `<isPropertyAvailable><isEqual prepend="AND">` wrapper would lose its
 *    AND whenever it is not first, and produce broken SQL.
 *  - A `<dynamic>`/`isXxx`/`<iterate>` tag's own `prepend` is emitted
 *    right before its content, UNLESS it is the first non-empty piece of
 *    content within an ENCLOSING conditional tag's children — in that one
 *    case its prepend is simply dropped (not substituted with anything),
 *    because the enclosing tag's own prepend already served as the
 *    connector when the enclosing tag itself was placed among its
 *    siblings. This is exactly how "WHERE" + "AND x" collapses to just
 *    "WHERE x", and how a leading "," before the first SET column vanishes.
 *  - At the STATEMENT root (or a `<sql>` fragment's own root, or the
 *    content spliced in by a resolved `<include>`) there is no enclosing
 *    conditional tag, so nothing is ever suppressed there — every
 *    top-level `<dynamic prepend="WHERE">` keeps its "WHERE" regardless of
 *    what text precedes it.
 *  - `<iterate>` is flattened as exactly one representative iteration
 *    (open + body + close, itself its own unsuppressed scope), which is
 *    sufficient for table/column discovery even though it under-represents
 *    the real repeated-item SQL.
 *  - `#prop#` / `$prop$` become a bare `?` placeholder.
 *  - `<selectKey>` and any `UnresolvedIncludeNode` are dropped — the
 *    former is its own embedded statement, the latter has no known
 *    content to include.
 *
 * MyBatis 3 input (parser/mybatis) uses the same tree: `<where>` / `<set>` /
 * `<trim>` are a Dynamic with `trim` (the body's leading / trailing override
 * is removed, then prefix / suffix added), `<if>` a prepend-less — so
 * transparent — Conditional, and `<choose>` a CHOOSE Conditional of which
 * only the FIRST non-empty branch is flattened: its branches are
 * alternatives, so all of them at once would not be SQL. `#{x}` / `${x}`
 * become `?` like `#x#` / `$x$`.
 *
 * Known simplification: a resolved `<include>`'s spliced-in content is
 * flattened as its own unsuppressed scope rather than being spliced into
 * the *surrounding* scope's suppression accounting, so a `<sql>` fragment
 * whose very first child is itself a prepend-bearing conditional will keep
 * that prepend even when the `<include>` is the first thing in its own
 * enclosing conditional. None of this project's fixtures hit that case;
 * fixing it would require flattening to a list of atoms instead of a
 * joined string so suppression can see through include boundaries.
 */

const isTransparentConditional = (node) =>
  node.type === 'Conditional' && node.conditionType !== 'CHOOSE'
  && !node.prepend?.trim() && !node.removeFirstPrepend && !node.open && !node.close;

function flattenChildrenList(nodes, isTopLevel, state = { hasEmittedAnyContent: false }, omit = null) {
  let out = '';

  for (const node of nodes) {
    if (omit?.has(node)) continue; // a table choice not taken in this variant (tableChoices)
    // A conditional with no prepend is transparent: its children take part in
    // this container's own "first content" accounting (iBATIS 2.3 looks to the parent).
    if (isTransparentConditional(node)) {
      out += flattenChildrenList(node.children, isTopLevel, state, omit);
      continue;
    }
    if (node.type === 'TextSql') {
      // Whitespace-only text (the indentation between sibling tags) must
      // not count as "real content" for suppression purposes, or the
      // first isXxx/nested-<dynamic> inside a container never gets its
      // prepend dropped.
      if (node.text.trim() === '') continue;
      // MyBatis joins the SQL of separate tags with a space (DynamicContext#appendSql); iBATIS doesn't
      out += node.spaced ? ` ${node.text} ` : node.text;
      state.hasEmittedAnyContent = true;
      continue;
    }
    if (node.type === 'ResolvedInclude') {
      const inner = flattenChildrenList(node.children, true, undefined, omit);
      if (inner === '') continue;
      out += inner;
      state.hasEmittedAnyContent = true;
      continue;
    }
    if (node.type === 'UnresolvedInclude' || node.type === 'SelectKey') continue;

    let innerText;
    if (node.type === 'Conditional' && node.conditionType === 'CHOOSE') {
      // one branch applies at runtime; the first non-empty one stands for the choose
      innerText = '';
      for (const branch of node.children) {
        if (branch.type !== 'Conditional') continue;
        innerText = flattenChildrenList(branch.children, true, undefined, omit);
        if (innerText.trim()) break;
      }
    } else if (node.type === 'Dynamic' && node.trim) {
      innerText = applyTrim(flattenChildrenList(node.children, true, undefined, omit), node.trim);
    } else if (node.type === 'Iterate') {
      const body = flattenChildrenList(node.children, true, undefined, omit);
      innerText = body === '' ? '' : `${node.open ?? ''}${body}${node.close ?? ''}`;
    } else if (node.type === 'Dynamic' || node.type === 'Conditional') {
      innerText = flattenChildrenList(node.children, false, undefined, omit);
    } else {
      continue;
    }
    if (innerText === '') continue;

    if (!isTopLevel && !state.hasEmittedAnyContent) {
      out += innerText; // first non-empty content inside an enclosing conditional: own prepend dropped
    } else {
      out += node.prepend ? ` ${node.prepend} ${innerText}` : ` ${innerText}`;
    }
    state.hasEmittedAnyContent = true;
  }

  return out;
}

/** MyBatis trim semantics over the flattened body (overrides compared case-insensitively) */
function applyTrim(body, { prefix = null, suffix = null, prefixOverrides = [], suffixOverrides = [] }) {
  let text = body.trim();
  if (!text) return '';
  const upper = () => text.toUpperCase();
  for (const o of prefixOverrides) {
    const word = o.trim().toUpperCase();
    if (word && upper().startsWith(word) && (/\W$/.test(word) || !/\w/.test(upper()[word.length] ?? ''))) {
      text = text.slice(word.length).trim();
      break;
    }
  }
  for (const o of suffixOverrides) {
    const word = o.trim().toUpperCase();
    if (word && upper().endsWith(word)) {
      text = text.slice(0, text.length - word.length).trim();
      break;
    }
  }
  return `${prefix ? ` ${prefix} ` : ' '}${text}${suffix ? ` ${suffix}` : ''}`;
}

function replaceParameterTokens(sql) {
  // MyBatis #{x} / ${x} first: their braces can hold a ':' or '#' that the iBATIS form would misread.
  // A `quoted` table name (variableTableNames) is kept as written.
  return sql.replace(/`[^`]*`|#\{[^}]*\}|\$\{[^}]*\}|#([^#]+)#|\$([^$]+)\$/g, (m) => (m.startsWith('`') ? m : '?'));
}

/**
 * `FROM $tableName$ T`, `JOIN TB_ORD_${yyyymm} M`: a table whose name the caller passes. As `?`
 * it would not parse (`FROM ?`), so at a table position the whole name is kept, quoted, as
 * written: the analysis then reports a table literally named `TB_ORD_$yyyymm$`.
 */
const SUBSTITUTION = String.raw`(?:\$\{[^}]*\}|\$[A-Za-z0-9_.]+\$)`;
const VARIABLE_TABLE = new RegExp(String.raw`(\b(?:FROM|JOIN|INTO|UPDATE)\s+)([A-Za-z0-9_]*${SUBSTITUTION}(?:[A-Za-z0-9_]|${SUBSTITUTION})*)`, 'gi');
function variableTableNames(sql) {
  return sql.replace(VARIABLE_TABLE, (_, keyword, name) => `${keyword}\`${name}\``);
}

/** the body of a tag that is one glued piece of text: only text children, one line, no whitespace at its edges */
function gluedBody(node) {
  const children = node.children ?? [];
  if (!children.length || !children.every((c) => c.type === 'TextSql')) return null;
  const text = children.map((c) => c.text).join('');
  return text && !/\s/.test(text) ? text : null;
}

const TABLE_KEYWORD_END = /\b(FROM|JOIN|INTO|UPDATE)\s*$/i;

/**
 * Dynamic table names: the places where iBATIS's conditions decide WHICH table a statement
 * reads. Flattening keeps every branch (a superset), which for these is wrong — it either
 * glues a suffix on for good (`TB_ORDER<isEqual>_RBK</isEqual>` -> only TB_ORDER_RBK) or
 * writes two tables in one slot (`FROM <isEqual>A</isEqual><isNotEqual>B</isNotEqual>` ->
 * `FROM A B`, which doesn't parse). Each choice point lists its options:
 *
 *  - SUFFIX: a prepend-less conditional whose body is one glued piece (`_RBK`) right after
 *    a word with no whitespace in between: with it or without it — both tables exist.
 *  - ALTERNATIVES: two or more consecutive prepend-less conditionals right after FROM /
 *    JOIN / INTO / UPDATE (also through `<include refid>`): exactly one of them.
 *
 * @returns {{ kind: 'SUFFIX'|'ALTERNATIVES', nodes: object[], base?: string, suffix?: string }[]}
 */
export function tableChoices(tree) {
  const points = [];
  let before = ''; // the SQL text emitted so far (approximately: enough to see what a tag is glued to)
  const walk = (nodes) => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.type === 'TextSql') {
        before += node.text;
        continue;
      }
      if (node.type === 'UnresolvedInclude' || node.type === 'SelectKey') continue;
      if (isTransparentConditional(node)) {
        const body = gluedBody(node);
        // only the tail matters (and a statement with refids spliced in can be 100k lines long)
        const tail = before.slice(-256);
        const word = /([A-Za-z0-9_$}]+)$/.exec(tail);
        if (body && word) {
          points.push({ kind: 'SUFFIX', nodes: [node], base: word[1], suffix: body });
          before += body;
          continue;
        }
        if (TABLE_KEYWORD_END.test(tail.trimEnd())) {
          // the run of conditionals in this slot (whitespace-only text between them is fine)
          const run = [node];
          let j = i + 1;
          for (; j < nodes.length; j++) {
            const next = nodes[j];
            if (next.type === 'TextSql' && !next.text.trim()) continue;
            if (!isTransparentConditional(next)) break;
            run.push(next);
          }
          if (run.length > 1) {
            points.push({ kind: 'ALTERNATIVES', nodes: run });
            walk(node.children ?? []); // what follows reads as if the first one were taken
            i = nodes.indexOf(run[run.length - 1]);
            continue;
          }
        }
      }
      if (node.prepend) before += ` ${node.prepend} `;
      if (node.open) before += node.open;
      walk(node.children ?? []);
      if (node.close) before += node.close;
    }
  };
  walk(tree.children ?? []);
  return points;
}

/** at most this many variants are analyzed (choice points multiply) */
export const MAX_TABLE_VARIANTS = 16;

/**
 * Every combination of the statement's table choices, as the set of nodes each one leaves
 * out. No choice points: one variant that leaves nothing out (the plain flattening).
 * @returns {{ omit: Set<object>, picks: object[] }[]} picks[i]: what was taken at choice point i
 */
export function tableVariants(tree, points = tableChoices(tree)) {
  let variants = [{ omit: new Set(), picks: [] }];
  for (const point of points) {
    const options = point.kind === 'SUFFIX'
      ? [{ omit: point.nodes, pick: { kind: 'SUFFIX', with: false } }, { omit: [], pick: { kind: 'SUFFIX', with: true } }]
      : point.nodes.map((taken, k) => ({ omit: point.nodes.filter((n) => n !== taken), pick: { kind: 'ALTERNATIVES', index: k } }));
    const next = [];
    for (const variant of variants) {
      for (const option of options) {
        if (next.length >= MAX_TABLE_VARIANTS) break;
        next.push({ omit: new Set([...variant.omit, ...option.omit]), picks: [...variant.picks, option.pick] });
      }
    }
    variants = next;
  }
  return variants;
}

/**
 * @param resolvedStatementTree a StatementNode, typically the `resolvedTree`
 *   from ReferenceResolver#resolve (so `<include>` is already flattened)
 * @param {{ omit?: Set<object> }} [options] omit: table choices not taken (tableVariants)
 * @returns {string} parseable literal SQL text
 */
export function flattenToSql(resolvedStatementTree, { omit = null } = {}) {
  const raw = flattenChildrenList(resolvedStatementTree.children, true, undefined, omit);
  return replaceParameterTokens(variableTableNames(raw)).replace(/[ \t\r\n]+/g, ' ').trim();
}
