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
  node.type === 'Conditional' && !node.prepend?.trim() && !node.removeFirstPrepend && !node.open && !node.close;

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
      out += node.text;
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
    if (node.type === 'Iterate') {
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

function replaceParameterTokens(sql) {
  return sql.replace(/#([^#]+)#|\$([^$]+)\$/g, '?');
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
