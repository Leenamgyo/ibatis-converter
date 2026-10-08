import pkg from 'node-sql-parser';
import { flattenToSql } from './SqlFlattener.js';

const { Parser } = pkg;

const parser = new Parser();

/**
 * node-sql-parser has no dedicated Oracle grammar, and its more
 * ANSI-leaning dialects (transactsql, db2, postgresql, ...) reject the
 * bare `?` placeholder that `SqlFlattener` always produces for `#x#`/`$x$`.
 * `mysql` is both permissive enough to accept `?` and permissive enough to
 * parse portable ANSI JOIN/subquery/UNION SQL that also happens to be
 * valid Oracle SQL, so it's used as the closest available stand-in.
 * Oracle-only extensions (CONNECT BY, MERGE ...) are NOT supported by any
 * available dialect and fail to parse — see docs/SPEC_MAPPING.md. The one
 * exception is the `(+)` outer-join marker, which legacy comma joins are
 * full of: see `stripOracleOuterJoins`.
 */
const DIALECT_ALIASES = Object.freeze({ oracle: 'mysql' });

/**
 * Section 7-10 boundary — flattens a resolved statement to literal SQL
 * (`SqlFlattener`) and parses it with a real SQL parser. Deliberately
 * returns a diagnostic instead of throwing when the flattened SQL doesn't
 * parse (unsupported dialect feature, or a flattening edge case) so one
 * unparseable statement never aborts analysis of the rest of a project.
 */
/**
 * Oracle's `(+)` marks the optional side of an outer join written as a comma
 * join: `FROM A, B WHERE A.X = B.X(+)` is `A LEFT JOIN B ON A.X = B.X`. No
 * parser dialect accepts it, so for ANALYSIS (never for conversion output)
 * the marker is taken out of the flattened SQL, outside string literals and
 * comments, and the column it was attached to is remembered. After parsing,
 * those column references are tagged `oracleOuter: true`, which is how
 * `implicitJoins` reports the join as a LEFT JOIN instead of an inner one.
 *
 * @returns {{ sql: string, outerColumns: Set<string> }} columns as upper-case `TABLE.COLUMN` / `COLUMN`
 */
export function stripOracleOuterJoins(sql) {
  const outerColumns = new Set();
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop;
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop;
    } else {
      const marker = /^\(\s*\+\s*\)/.exec(sql.slice(i, i + 12));
      if (marker) {
        const column = /([A-Za-z0-9_$#".]+)\s*$/.exec(out)?.[1];
        if (column) outerColumns.add(column.replace(/"/g, '').toUpperCase());
        i += marker[0].length;
      } else {
        out += ch;
        i++;
      }
    }
  }
  return { sql: out, outerColumns };
}

/** Tags the column references a `(+)` was attached to (see stripOracleOuterJoins). */
function tagOuterColumns(node, outerColumns, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (node.type === 'column_ref') {
    const column = typeof node.column === 'string' ? node.column : node.column?.expr?.value;
    const qualified = `${node.table ? `${node.table}.` : ''}${column}`.toUpperCase();
    if (outerColumns.has(qualified) || (!node.table && outerColumns.has(String(column).toUpperCase()))) node.oracleOuter = true;
  }
  for (const value of Object.values(node)) tagOuterColumns(value, outerColumns, seen);
}

/**
 * node-sql-parser nests `a AND b AND c …` left-deep, one level per operand. A WHERE built from
 * many included fragments (20 refids, each including more) has thousands of operands, and
 * every recursive walk over the AST (table / lineage analyzers) overflows the stack on it.
 * Rebuilds each unparenthesised same-operator AND / OR chain as a balanced tree — the same
 * operands in the same order (AND / OR are associative), depth log n. Iterative itself.
 */
export function balanceLogicalChains(root) {
  const isChain = (node, op) => node?.type === 'binary_expr' && node.operator === op && !node.parentheses;
  const balanced = (operands, lo, hi, template) => {
    if (hi - lo === 1) return operands[lo];
    const mid = (lo + hi) >>> 1;
    return { ...template, parentheses: undefined, left: balanced(operands, lo, mid, template), right: balanced(operands, mid, hi, template) };
  };
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    for (const key of Object.keys(node)) {
      let value = node[key];
      if (value?.type === 'binary_expr' && (value.operator === 'AND' || value.operator === 'OR') && (isChain(value.left, value.operator) || isChain(value.right, value.operator))) {
        const operands = [];
        const chain = [value.right, value.left];
        while (chain.length) {
          const e = chain.pop();
          if (isChain(e, value.operator)) chain.push(e.right, e.left);
          else operands.push(e);
        }
        const { left, right, ...template } = value;
        value = { ...balanced(operands, 0, operands.length, template), parentheses: value.parentheses };
        if (value.parentheses === undefined) delete value.parentheses;
        node[key] = value;
      }
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  return root;
}

export class SqlAnalyzer {
  /**
   * @param {string} sql
   * @param {string} [dialect] any of node-sql-parser's supported `database`
   *   values (mysql, postgresql, sqlite, mariadb, transactsql, ...), or 'oracle'
   * @returns {{ ast: object[]|null, error: string|null }}
   */
  parse(sql, dialect = 'mysql') {
    const database = DIALECT_ALIASES[dialect] ?? dialect;
    try {
      const { sql: parseable, outerColumns } = stripOracleOuterJoins(sql);
      const ast = parser.astify(parseable, { database });
      const list = Array.isArray(ast) ? ast : [ast];
      balanceLogicalChains(list);
      if (outerColumns.size) tagOuterColumns(list, outerColumns);
      return { ast: list, error: null };
    } catch (e) {
      return { ast: null, error: e.message };
    }
  }

  /**
   * @param {object} resolvedStatementTree a StatementNode (resolvedTree)
   * @param {string} [dialect]
   * @returns {{ sql: string, ast: object[]|null, error: string|null }}
   */
  analyzeStatement(resolvedStatementTree, dialect = 'mysql') {
    const sql = flattenToSql(resolvedStatementTree);
    const { ast, error } = this.parse(sql, dialect);
    return { sql, ast, error };
  }
}
