/**
 * Where a nested SELECT hangs off its parent. This is the parent-child
 * relationship the lineage dashboard draws as a containment box, so it
 * has to say *why* the subquery exists, not just that one is there.
 */
export const SelectOrigin = Object.freeze({
  /** The statement's own top-level SELECT. */
  ROOT: 'ROOT',
  /** A derived table / inline view: `FROM (SELECT ...) S1`. */
  FROM: 'FROM',
  /** A derived table pulled in by a JOIN: `LEFT JOIN (SELECT ...) S1 ON ...`. */
  JOIN: 'JOIN',
  /** A scalar subquery in the SELECT list: `(SELECT MAX(..) ..) AS lastOrderDate`. */
  SELECT_LIST: 'SELECT_LIST',
  /** `WHERE x IN (SELECT ...)` / `EXISTS (SELECT ...)`. */
  WHERE: 'WHERE',
  /** The same, inside HAVING. */
  HAVING: 'HAVING',
  /** A `UNION` / `UNION ALL` branch - a sibling SELECT, not a nested one. */
  UNION: 'UNION',
  /** A named `WITH` CTE. */
  CTE: 'CTE',
  /** The SELECT that feeds an `INSERT INTO t (...) SELECT ...`. */
  INSERT_SELECT: 'INSERT_SELECT',
});

export const SelectRole = Object.freeze({
  MAIN: 'MAIN',
  SUBQUERY: 'SUBQUERY',
  UNION_BRANCH: 'UNION_BRANCH',
  CTE: 'CTE',
  /**
   * An INSERT/UPDATE/DELETE root. It isn't a SELECT, but it is the node
   * the same graph hangs off: its target table, the columns it writes,
   * and whatever SELECTs feed or filter it.
   */
  WRITE: 'WRITE',
});
