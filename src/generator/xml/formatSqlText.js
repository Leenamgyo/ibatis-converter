import { tokenize, TokenKind } from '../../converter/schema/SqlLexer.js';

/**
 * "쿼리 정렬": pretty-prints the SQL of ONE text node of a mapper.
 *
 * Neither an XML formatter (it never touches tags) nor a generic SQL
 * formatter (those choke on `#{x}`, `<if>` halves of a WHERE, a text node
 * that starts with `AND`): it formats the SQL between two tags, inside the
 * structure MyBatis / iBATIS give it, from the lossless SqlLexer tokens.
 *
 *  - A clause keyword (SELECT, FROM, WHERE, GROUP BY, ORDER BY, HAVING,
 *    VALUES, SET, UNION…, a JOIN phrase, INSERT, UPDATE, DELETE) starts a
 *    line at its level; `AND` / `OR` start an indented line; a SELECT list
 *    puts one item per line, aligned under the first.
 *  - `(SELECT …)` / `(WITH …)` is a nested level, indented; any other paren
 *    (a function call, an IN list, `EXTRACT(YEAR FROM d)`) is never broken.
 *    Nothing inside `CASE … END` breaks, nor `BETWEEN x AND y`'s AND.
 *  - The first token stays on the first line: a node like `AND x = #{x}`
 *    inside an `<if>` is not pushed down.
 *  - Tokens are never changed or merged: `#{x}`, `${x}`, `#x#`, string
 *    literals and comments (hints included) are single tokens; where the
 *    source had no whitespace between two tokens (`TB_${yyyymm}`, `a.b`,
 *    `f(x)`) none is added; elsewhere whitespace becomes one space or a
 *    line break. A `--` comment always ends its line.
 *
 * @param {string} text
 * @returns {string} the formatted SQL, first line unindented; nested lines
 *   carry their relative indentation (layoutSqlText adds the tag's depth)
 */
export function formatSqlText(text) {
  const tokens = tokenize(text);
  const significant = (i, step) => {
    for (let j = i + step; j >= 0 && j < tokens.length; j += step) {
      if (tokens[j].kind !== TokenKind.WHITESPACE && tokens[j].kind !== TokenKind.COMMENT) return tokens[j];
    }
    return null;
  };
  const word = (t) => (t && t.kind === TokenKind.WORD ? t.text.toUpperCase() : null);

  const levels = [{ depth: 0, indent: 0, clause: null }]; // one per (sub)query nesting
  const level = () => levels[levels.length - 1];
  let depth = 0; // paren depth
  let caseDepth = 0;
  let betweenPending = false;

  let out = '';
  let lineIndent = 0;
  let pendingSpace = false;
  let forceBreak = false;
  let subqueryStarting = false;
  const breakAt = (indent) => {
    if (out === '') return;
    out = out.replace(/[ \t]+$/, '');
    out += `\n${' '.repeat(indent)}`;
    lineIndent = indent;
    pendingSpace = false;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === TokenKind.WHITESPACE) {
      pendingSpace = true;
      continue;
    }
    const kw = word(t);
    const prev = significant(i, -1);
    const qualified = prev && prev.kind === TokenKind.PUNCT && prev.text === '.'; // a.from is a column
    const atBase = depth === level().depth && caseDepth === 0;
    let breakBefore = null;

    if (forceBreak) {
      breakBefore = lineIndent;
      forceBreak = false;
    }
    if (kw && !qualified && atBase) {
      const next = word(significant(i, 1));
      const prevWord = word(prev);
      const joinLead = ['LEFT', 'RIGHT', 'FULL', 'INNER', 'CROSS', 'NATURAL'];
      let clause = null;
      if (['SELECT', 'FROM', 'WHERE', 'HAVING', 'VALUES', 'SET', 'UNION', 'INTERSECT', 'EXCEPT', 'MINUS', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'LIMIT', 'OFFSET', 'FETCH', 'START', 'CONNECT'].includes(kw)) clause = kw;
      if ((kw === 'GROUP' || kw === 'ORDER') && next === 'BY') clause = kw;
      if (joinLead.includes(kw) && (next === 'JOIN' || next === 'OUTER' || (next === 'NATURAL'))) clause = 'JOIN';
      if (kw === 'JOIN' && !joinLead.includes(prevWord) && prevWord !== 'OUTER') clause = 'JOIN';
      // keywords that are not clauses here
      if (kw === 'SET' && prevWord === 'CHARACTER') clause = null;
      if (kw === 'START' && next !== 'WITH') clause = null;
      if (kw === 'CONNECT' && next !== 'BY') clause = null;
      if (kw === 'UPDATE' && prevWord === 'FOR') clause = null; // SELECT … FOR UPDATE
      if (clause && subqueryStarting) {
        level().clause = clause;
        subqueryStarting = false;
      } else if (clause) {
        level().clause = clause;
        breakBefore = level().indent;
        betweenPending = false;
      } else if ((kw === 'AND' || kw === 'OR') && !(kw === 'AND' && betweenPending)) {
        breakBefore = level().indent + 2;
      }
      if (kw === 'AND' && betweenPending) betweenPending = false;
      if (kw === 'BETWEEN') betweenPending = true;
    }
    if (kw === 'CASE') caseDepth++;
    if (kw === 'END' && caseDepth > 0) caseDepth--;

    // a subquery's closing paren goes back to the enclosing level's indent
    if (t.kind === TokenKind.PUNCT && t.text === ')') {
      if (levels.length > 1 && depth === level().depth) {
        breakBefore = levels.pop().closeIndent; // back to the line the "(" opened on
      }
      depth = Math.max(0, depth - 1);
    }

    if (breakBefore !== null && out !== '') breakAt(breakBefore);
    else if (pendingSpace && out !== '' && !/\n *$/.test(out)) out += ' '; // not right after a line break
    pendingSpace = false;
    out += t.text;
    if (t.text.includes('\n')) lineIndent = 0; // a multi-line literal / comment: the next line starts fresh

    if (t.kind === TokenKind.PUNCT && t.text === '(') {
      depth++;
      const next = word(significant(i, 1));
      if (next === 'SELECT' || next === 'WITH') {
        // nested under the line the "(" is on (a select item, a WHERE … IN line), closed back there
        levels.push({ depth, indent: lineIndent + 4, closeIndent: lineIndent, clause: null });
        breakAt(level().indent);
        // the nested level's first line has begun: its SELECT / WITH (after any comment) doesn't break again.
        // Every token is still emitted in order — nothing is skipped.
        subqueryStarting = true;
      }
    }
    // one SELECT item per line, aligned under the first ("SELECT " is 7 wide)
    if (t.kind === TokenKind.PUNCT && t.text === ',' && depth === level().depth && caseDepth === 0 && level().clause === 'SELECT') {
      forceBreak = true;
      lineIndent = level().indent + 7;
    }
    if (t.kind === TokenKind.COMMENT && t.text.startsWith('--')) {
      forceBreak = true;
      lineIndent = level().indent;
    }
  }
  return out;
}
