/**
 * Implicit (comma) joins: `FROM ORDERS O, CUSTOMER C WHERE C.CUSTOMER_ID
 * = O.CUSTOMER_ID`.
 *
 * Legacy iBATIS mappers - especially Oracle-era ones - write most of
 * their joins this way, with no JOIN keyword at all. node-sql-parser
 * reports those FROM entries with no `join` property, so a join analysis
 * that only looks at `entry.join` reports "0 joins" for a statement that
 * obviously joins two tables, and the table dependency graph loses the
 * edge entirely.
 *
 * The rule here is deliberately narrow, because a WHERE comparison
 * between two tables is only a join when nothing else already joined
 * them: both sides must be plain column references, they must resolve to
 * two *different* comma-joined tables of the same FROM clause, and the
 * operator must be `=`. Anything else (a range condition, a comparison
 * against a literal or a bind variable, a table that arrived via an
 * explicit JOIN) is left alone.
 *
 * @param {object[]} fromArray one SELECT's `from` array
 * @param {object} whereAst the same SELECT's raw `where` AST
 * @param {(aliasOrName: string) => string} resolveAlias alias -> table name
 * An Oracle `(+)` on one side (`A.X = B.X(+)`, tagged by SqlAnalyzer as
 * `oracleOuter`) makes it an outer join: `leftTable` is then the preserved
 * table, `rightTable` the optional one, and `outer` is true.
 *
 * @returns {{ leftTable: string, rightTable: string, condition: object, outer: boolean }[]}
 */
export function findImplicitJoins(fromArray, whereAst, resolveAlias) {
  const commaJoined = new Set(
    (fromArray ?? [])
      .filter((entry) => !entry.join && entry.table)
      .map((entry) => entry.table),
  );
  if (commaJoined.size < 2 || !whereAst) return [];

  const found = [];
  const seen = new Set();

  const walk = (node) => {
    if (!node || typeof node !== 'object' || node.type !== 'binary_expr') return;
    if (node.operator === 'AND' || node.operator === 'OR') {
      walk(node.left);
      walk(node.right);
      return;
    }
    if (node.operator !== '=') return;
    if (node.left?.type !== 'column_ref' || node.right?.type !== 'column_ref') return;

    const leftTable = node.left.table ? resolveAlias(node.left.table) : null;
    const rightTable = node.right.table ? resolveAlias(node.right.table) : null;
    if (!leftTable || !rightTable || leftTable === rightTable) return;
    if (!commaJoined.has(leftTable) || !commaJoined.has(rightTable)) return;

    const key = [leftTable, rightTable].sort().join(' = ');
    if (seen.has(key)) return;
    seen.add(key);
    // `(+)` marks the optional side; report it as the right side of a LEFT JOIN
    if (node.left.oracleOuter && !node.right.oracleOuter) found.push({ leftTable: rightTable, rightTable: leftTable, condition: node, outer: true });
    else found.push({ leftTable, rightTable, condition: node, outer: Boolean(node.right.oracleOuter && !node.left.oracleOuter) });
  };

  walk(whereAst);
  return found;
}
