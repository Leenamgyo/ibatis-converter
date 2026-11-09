/**
 * Tags glued to the SQL around them — `FROM TB_ORDER<isEqual property="rbk">_RBK</isEqual> A`.
 * The generators put every tag on its own line, which inserts whitespace: at runtime that
 * would be `FROM TB_ORDER _RBK A` (`_RBK` an alias), a different query. So a tag whose body
 * is one piece of text with no whitespace at its edges, written with no whitespace between
 * it and the text before it, is kept inline on that text's line; text right after it with no
 * whitespace in between continues that line. Both generators apply the same rule, so the
 * iBATIS and MyBatis sides still line up line for line.
 */

/** the body text of a tag that can sit inline: only text children, one line, no whitespace at its edges */
export function inlineBody(node) {
  const children = node.children ?? [];
  if (!children.length || !children.every((c) => c.type === 'TextSql')) return null;
  const text = children.map((c) => c.text).join('');
  if (!text || /\n/.test(text) || text.trim() !== text) return null;
  return text;
}

/**
 * The tag on one line, nested tags included — `<isPropertyAvailable …><isEqual …>_RBK</isEqual>
 * </isPropertyAvailable>` — or null. `tagOf(node)` gives a node's [open, close] tag text, or
 * null if that kind of node can't sit inline.
 */
export function inlineTagText(node, tagOf, escapeText) {
  const tag = tagOf(node);
  if (!tag) return null;
  const children = node.children ?? [];
  if (children.length === 1 && children[0].type !== 'TextSql') {
    const inner = inlineTagText(children[0], tagOf, escapeText);
    return inner === null ? null : `${tag[0]}${inner}${tag[1]}`;
  }
  const body = inlineBody(node);
  return body === null ? null : `${tag[0]}${escapeText(body)}${tag[1]}`;
}

/** does text end / start with no whitespace (so a tag next to it is glued to it)? */
export const endsGlued = (text) => typeof text === 'string' && /\S$/.test(text);
export const startsGlued = (text) => typeof text === 'string' && /^\S/.test(text);

/**
 * Renders `nodes` like `renderOne` would, except glued tags (see above).
 * @param {object[]} nodes
 * @param {string[]} lines output
 * @param {(node: object) => string|null} inlineTag the tag rendered on one line (`<if test="x">_RBK</if>`), or null if this kind can't be inlined
 * @param {(node: object) => void} renderOne the generator's normal rendering
 * @param {string} pad the children's indentation
 */
export function renderGlued(nodes, lines, inlineTag, renderOne, pad) {
  let glued = false; // the last line ends with an inlined tag
  nodes.forEach((node, i) => {
    const prev = nodes[i - 1];
    if (node.type !== 'TextSql') {
      const inline = lines.length && (glued || (prev?.type === 'TextSql' && endsGlued(prev.text))) ? inlineTag(node) : null;
      if (inline !== null) {
        lines[lines.length - 1] += inline;
        glued = true;
        return;
      }
    } else if (glued && startsGlued(node.text)) {
      // `…_RBK</if>X`: the text's first line continues the tag's line
      const before = lines.length;
      renderOne(node);
      const added = lines.splice(before);
      if (added.length) lines[before - 1] += added[0].startsWith(pad) ? added[0].slice(pad.length) : added[0].trimStart();
      lines.push(...added.slice(1));
      glued = false;
      return;
    }
    glued = false;
    renderOne(node);
  });
}
