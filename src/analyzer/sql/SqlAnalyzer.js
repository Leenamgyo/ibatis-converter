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
 * Oracle-only extensions (ROWNUM, DUAL, the `(+)` outer-join operator,
 * MERGE) are NOT supported by any available dialect and will fail to
 * parse — see docs/SPEC_MAPPING.md.
 */
const DIALECT_ALIASES = Object.freeze({ oracle: 'mysql' });

/**
 * Section 7-10 boundary — flattens a resolved statement to literal SQL
 * (`SqlFlattener`) and parses it with a real SQL parser. Deliberately
 * returns a diagnostic instead of throwing when the flattened SQL doesn't
 * parse (unsupported dialect feature, or a flattening edge case) so one
 * unparseable statement never aborts analysis of the rest of a project.
 */
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
      const ast = parser.astify(sql, { database });
      return { ast: Array.isArray(ast) ? ast : [ast], error: null };
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
