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
 * join reference the statement could ever produce. The rule (matching
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

function flattenChildrenList(nodes, isTopLevel, state = { hasEmittedAnyContent: false }) {
  let out = '';

  for (const node of nodes) {
    // A conditional with no prepend is transparent: its children take part in
    // this container's own "first content" accounting (iBATIS 2.3 looks to the parent).
    if (isTransparentConditional(node)) {
      out += flattenChildrenList(node.children, isTopLevel, state);
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
      const inner = flattenChildrenList(node.children, true);
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
        innerText = flattenChildrenList(branch.children, true);
        if (innerText.trim()) break;
      }
    } else if (node.type === 'Dynamic' && node.trim) {
      innerText = applyTrim(flattenChildrenList(node.children, true), node.trim);
    } else if (node.type === 'Iterate') {
      const body = flattenChildrenList(node.children, true);
      innerText = body === '' ? '' : `${node.open ?? ''}${body}${node.close ?? ''}`;
    } else if (node.type === 'Dynamic' || node.type === 'Conditional') {
      innerText = flattenChildrenList(node.children, false);
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
  // MyBatis #{x} / ${x} first: their braces can hold a ':' or '#' that the iBATIS form would misread
  return sql.replace(/#\{[^}]*\}|\$\{[^}]*\}|#([^#]+)#|\$([^$]+)\$/g, '?');
}

/**
 * @param resolvedStatementTree a StatementNode, typically the `resolvedTree`
 *   from ReferenceResolver#resolve (so `<include>` is already flattened)
 * @returns {string} parseable literal SQL text
 */
export function flattenToSql(resolvedStatementTree) {
  const raw = flattenChildrenList(resolvedStatementTree.children, true);
  return replaceParameterTokens(raw).replace(/[ \t\r\n]+/g, ' ').trim();
}
