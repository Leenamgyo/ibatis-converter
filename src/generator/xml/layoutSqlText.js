import { formatSqlText } from './formatSqlText.js';

/**
 * Lays out one SQL text node at the depth of the tag it sits in.
 *
 * A converted statement is re-nested (`<dynamic>` -> `<where>`, an `isXxx`
 * -> `<if>` …), so text copied with the source file's own indentation lands
 * at the wrong depth, and the whitespace-only text between tags turns into
 * runs of empty lines. Here, per text node:
 *
 *  - whitespace-only text produces no line at all;
 *  - leading / trailing blank lines are dropped;
 *  - the block is dedented by its common indentation and indented to `pad`,
 *    so lines keep their indentation RELATIVE to each other
 *    (`SELECT A,` / `       B` stays aligned);
 *  - the first line, when the text did not start on a new line (`<if>AND
 *    x = 1`), is not counted for the common indentation;
 *  - a line that starts INSIDE a quoted literal ('…' or "…" spanning lines)
 *    is kept byte for byte, and so is the trailing whitespace of a line
 *    that ends inside one: there, whitespace is data.
 *
 * Only whitespace at line starts / ends outside literals changes, and SQL
 * ignores it, so this never changes what the SQL means. Tabs in the
 * indentation count as 4 columns.
 *
 * @param {string} text the node's text (unescaped)
 * @param {string} pad the indentation of the enclosing depth
 * @param {{ format?: boolean }} [options] format: pretty-print the SQL first ("쿼리 정렬")
 * @returns {string[]} lines, unescaped
 */
export function layoutSqlText(text, pad, { format = false } = {}) {
  if (text.trim() === '') return [];
  // 쿼리 정렬 on: the SQL is first pretty-printed (formatSqlText); its first line is the block's base
  const source = format ? `\n${formatSqlText(text)}` : text;
  const raw = source.replace(/\r\n?/g, '\n').split('\n');

  // which lines start / end inside a quoted literal (a block comment is not a literal)
  const startsInLiteral = [];
  const endsInLiteral = [];
  let quote = null;
  let inBlockComment = false;
  for (const line of raw) {
    startsInLiteral.push(quote !== null);
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inBlockComment) {
        if (ch === '*' && line[i + 1] === '/') { inBlockComment = false; i++; }
      } else if (quote) {
        if (ch === quote) quote = null; // '' (an escaped quote) closes and reopens
      } else if (ch === "'" || ch === '"') {
        quote = ch;
      } else if (ch === '/' && line[i + 1] === '*') {
        inBlockComment = true;
        i++;
      } else if (ch === '-' && line[i + 1] === '-') {
        break; // a line comment: nothing after it opens a literal
      }
    }
    endsInLiteral.push(quote !== null);
  }

  const isBlank = (i) => !startsInLiteral[i] && !endsInLiteral[i] && raw[i].trim() === '';
  let first = 0;
  let last = raw.length - 1;
  while (first <= last && isBlank(first)) first++;
  while (last >= first && isBlank(last)) last--;

  const indentOf = (line) => {
    let columns = 0;
    for (const ch of line) {
      if (ch === ' ') columns++;
      else if (ch === '\t') columns += 4;
      else break;
    }
    return columns;
  };
  // the first raw line continues the tag's own line (`<if>AND …`): its indentation means nothing
  const counts = (i) => !(i === 0) && !startsInLiteral[i] && !isBlank(i);
  let common = Infinity;
  for (let i = first; i <= last; i++) if (counts(i)) common = Math.min(common, indentOf(raw[i]));
  if (common === Infinity) common = 0;

  const out = [];
  for (let i = first; i <= last; i++) {
    const line = raw[i];
    if (startsInLiteral[i]) {
      out.push(line); // inside a literal: every character is data
      continue;
    }
    if (isBlank(i)) {
      out.push('');
      continue;
    }
    const body = endsInLiteral[i] ? line.trimStart() : line.trim();
    const relative = i === 0 ? 0 : Math.max(0, indentOf(line) - common);
    out.push(`${pad}${' '.repeat(relative)}${body}`);
  }
  return out;
}
