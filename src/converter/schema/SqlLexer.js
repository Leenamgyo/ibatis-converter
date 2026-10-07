/**
 * Lossless SQL tokenizer for schema migration.
 *
 * Every character of the input lands in exactly one token, so joining the
 * token texts back together reproduces the input byte-for-byte. That is
 * what lets the schema converter change *only* the identifier tokens it
 * has decided to rename, and leave keywords, whitespace, comments, string
 * literals and MyBatis parameters exactly as written — without ever
 * running a `.replace()` over SQL text.
 *
 * MyBatis `#{...}` / `${...}`, iBATIS `#x#` / `$x$`, JDBC `?` and `:name`
 * binds are single PARAM tokens: nothing inside them is ever seen as an
 * identifier. Unterminated strings/comments/params run to end of input
 * (a TextSql node can legitimately end mid-construct when a dynamic tag
 * splits it); they are never an error here.
 */

export const TokenKind = Object.freeze({
  WHITESPACE: 'Whitespace',
  COMMENT: 'Comment',
  STRING: 'String',
  QUOTED_IDENTIFIER: 'QuotedIdentifier',
  WORD: 'Word',
  NUMBER: 'Number',
  PARAM: 'Param',
  PUNCT: 'Punct',
  /** zero-width, inserted by the converter (e.g. an `<include>` site) — never produced by tokenize() */
  MARKER: 'Marker',
});

export const ParamStyle = Object.freeze({
  MYBATIS_BIND: 'MYBATIS_BIND', // #{x}
  MYBATIS_SUBSTITUTION: 'MYBATIS_SUBSTITUTION', // ${x}
  IBATIS_BIND: 'IBATIS_BIND', // #x#
  IBATIS_SUBSTITUTION: 'IBATIS_SUBSTITUTION', // $x$
  JDBC: 'JDBC', // ?
  NAMED: 'NAMED', // :x
});

export class SqlToken {
  constructor({ kind, text, value = text, quote = null, style = null }) {
    this.kind = kind;
    /** exact source text */
    this.text = text;
    /** identifier value without quotes (QUOTED_IDENTIFIER), otherwise === text */
    this.value = value;
    /** opening quote char of a QUOTED_IDENTIFIER: `"`, `` ` `` or `[` */
    this.quote = quote;
    /** ParamStyle of a PARAM token */
    this.style = style;
  }

  get significant() {
    return this.kind !== TokenKind.WHITESPACE && this.kind !== TokenKind.COMMENT && this.kind !== TokenKind.MARKER;
  }

  get isIdentifier() {
    return this.kind === TokenKind.WORD || this.kind === TokenKind.QUOTED_IDENTIFIER;
  }

  /** upper-cased WORD text, for keyword checks (never matches a quoted identifier) */
  get keyword() {
    return this.kind === TokenKind.WORD ? this.text.toUpperCase() : null;
  }

  is(punct) {
    return this.kind === TokenKind.PUNCT && this.text === punct;
  }
}

const MULTI_CHAR_OPERATORS = ['<>', '<=', '>=', '!=', '^=', '||', '::', ':=', '=>'];
const CLOSING_QUOTE = { '"': '"', '`': '`', '[': ']' };

const isWordStart = (ch) => /[A-Za-z_À-￿]/.test(ch);
const isWordPart = (ch) => /[A-Za-z0-9_$À-￿]/.test(ch);
const isDigit = (ch) => ch >= '0' && ch <= '9';

/**
 * @param {string} sql
 * @returns {SqlToken[]}
 */
export function tokenize(sql) {
  const tokens = [];
  const n = sql.length;
  let i = 0;

  const push = (kind, start, end, extra = {}) => {
    tokens.push(new SqlToken({ kind, text: sql.slice(start, end), ...extra }));
    i = end;
  };
  const indexOrEnd = (needle, from) => {
    const at = sql.indexOf(needle, from);
    return at === -1 ? n : at + needle.length;
  };

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < n && /\s/.test(sql[j])) j++;
      push(TokenKind.WHITESPACE, i, j);
    } else if (ch === '-' && next === '-') {
      const eol = sql.indexOf('\n', i);
      push(TokenKind.COMMENT, i, eol === -1 ? n : eol);
    } else if (ch === '/' && next === '*') {
      push(TokenKind.COMMENT, i, indexOrEnd('*/', i + 2));
    } else if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") { j++; break; } else j++;
      }
      push(TokenKind.STRING, i, Math.min(j, n));
    } else if ((ch === '#' || ch === '$') && next === '{') {
      push(TokenKind.PARAM, i, indexOrEnd('}', i + 2), {
        style: ch === '#' ? ParamStyle.MYBATIS_BIND : ParamStyle.MYBATIS_SUBSTITUTION,
      });
    } else if ((ch === '#' || ch === '$') && next !== undefined && /[A-Za-z_]/.test(next)) {
      // iBATIS #prop# / $prop$ (also #prop:VARCHAR#, #list[]#)
      const close = sql.indexOf(ch, i + 1);
      const body = close === -1 ? '' : sql.slice(i + 1, close);
      if (close !== -1 && /^[\w.[\]:,= ]+$/.test(body)) {
        push(TokenKind.PARAM, i, close + 1, {
          style: ch === '#' ? ParamStyle.IBATIS_BIND : ParamStyle.IBATIS_SUBSTITUTION,
        });
      } else {
        push(TokenKind.PUNCT, i, i + 1);
      }
    } else if (ch === '?') {
      push(TokenKind.PARAM, i, i + 1, { style: ParamStyle.JDBC });
    } else if (ch === ':' && next !== ':' && next !== '=' && next !== undefined && isWordStart(next) && sql[i - 1] !== ':') {
      let j = i + 1;
      while (j < n && isWordPart(sql[j])) j++;
      push(TokenKind.PARAM, i, j, { style: ParamStyle.NAMED });
    } else if (ch in CLOSING_QUOTE && (ch !== '[' || isWordStart(next ?? ''))) {
      const end = indexOrEnd(CLOSING_QUOTE[ch], i + 1);
      const closed = sql[end - 1] === CLOSING_QUOTE[ch] && end > i + 1;
      push(TokenKind.QUOTED_IDENTIFIER, i, end, {
        value: sql.slice(i + 1, closed ? end - 1 : end),
        quote: ch,
      });
    } else if (isDigit(ch) || (ch === '.' && isDigit(next ?? ''))) {
      let j = i + 1;
      while (j < n && /[0-9.]/.test(sql[j])) j++;
      if ((sql[j] === 'e' || sql[j] === 'E') && /[0-9+-]/.test(sql[j + 1] ?? '')) {
        j += 2;
        while (j < n && isDigit(sql[j])) j++;
      }
      push(TokenKind.NUMBER, i, j);
    } else if (isWordStart(ch)) {
      let j = i + 1;
      // a `$` is an identifier character (Oracle V$SESSION), but `${x}` and iBATIS `$x$` start a
      // parameter even when glued to a name: TB_ORD_H_${yyyymm}, TB_ORD_H_$yyyymm$
      const startsParam = (k) => sql[k] === '$' && (sql[k + 1] === '{' || /^\$[A-Za-z_][\w.[\]]*\$/.test(sql.slice(k, k + 64)));
      while (j < n && isWordPart(sql[j]) && !startsParam(j)) j++;
      push(TokenKind.WORD, i, j);
    } else {
      const op = MULTI_CHAR_OPERATORS.find((candidate) => sql.startsWith(candidate, i));
      push(TokenKind.PUNCT, i, i + (op ? op.length : 1));
    }
  }
  return tokens;
}

/** A token that was never in any source text (`<where>` -> WHERE, `<set>` -> SET, an include marker). */
export function syntheticToken(kind, text, extra = {}) {
  return new SqlToken({ kind, text, ...extra });
}
