export const TableOperation = Object.freeze({
  READ: 'READ',
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
});

export const ColumnUsedIn = Object.freeze({
  SELECT: 'SELECT',
  WHERE: 'WHERE',
  JOIN: 'JOIN',
  ORDER_BY: 'ORDER_BY',
  GROUP_BY: 'GROUP_BY',
  HAVING: 'HAVING',
  INSERT: 'INSERT',
  UPDATE_SET: 'UPDATE_SET',
});

export const ColumnResolution = Object.freeze({
  RESOLVED: 'RESOLVED',
  UNRESOLVED: 'UNRESOLVED',
});

export const JoinType = Object.freeze({
  JOIN: 'JOIN',
  INNER_JOIN: 'INNER_JOIN',
  LEFT_JOIN: 'LEFT_JOIN',
  RIGHT_JOIN: 'RIGHT_JOIN',
  FULL_JOIN: 'FULL_JOIN',
  CROSS_JOIN: 'CROSS_JOIN',
  /** `FROM A, B WHERE A.X = B.X` — a join with no JOIN keyword. */
  IMPLICIT_JOIN: 'IMPLICIT_JOIN',
  /** A bare `OUTER JOIN` with no side — rare, and not the same as FULL. */
  OUTER_JOIN: 'OUTER_JOIN',
});

/**
 * node-sql-parser's raw join text (`"LEFT OUTER JOIN"`, `"FULL JOIN"`, …)
 * -> one `JoinType`. Shared by `analyzer/table` and `analyzer/lineage` so
 * a join can never be called `FULL_JOIN` on one screen and
 * `FULL_OUTER_JOIN` on another. `FULL`/`CROSS` are checked before the
 * generic `OUTER`, since "FULL OUTER JOIN" contains both words.
 */
export function normalizeJoinType(join) {
  const text = (join ?? '').toUpperCase();
  if (text.includes('LEFT')) return JoinType.LEFT_JOIN;
  if (text.includes('RIGHT')) return JoinType.RIGHT_JOIN;
  if (text.includes('FULL')) return JoinType.FULL_JOIN;
  if (text.includes('CROSS')) return JoinType.CROSS_JOIN;
  if (text.includes('INNER')) return JoinType.INNER_JOIN;
  if (text.includes('OUTER')) return JoinType.OUTER_JOIN;
  return JoinType.JOIN;
}

/** One table reference found in a statement (a statement can list the same table more than once, e.g. once per operation). */
export class TableUsage {
  constructor({ name, alias = null, operation, derived = false }) {
    this.name = name;
    this.alias = alias;
    this.operation = operation;
    /** true for a FROM-clause subquery ("derived table") rather than a real table. */
    this.derived = derived;
  }
}

/** One column reference, alias already resolved back to its real table name where possible. */
export class ColumnUsage {
  constructor({ table, column, usedIn, resolution = ColumnResolution.RESOLVED }) {
    this.table = table;
    this.column = column;
    this.usedIn = usedIn;
    this.resolution = resolution;
  }
}

/** One JOIN edge between two tables, with its ON conditions kept as a structured WhereNode list (see WhereNode below). */
export class JoinRelation {
  constructor({ leftTable, rightTable, type, conditions }) {
    this.leftTable = leftTable;
    this.rightTable = rightTable;
    this.type = type;
    /** @type {(ComparisonNode|LogicalNode|ExpressionNode)[]} */
    this.conditions = conditions;
  }
}

/** `column`, `parameter`, `literal`, `subquery`, `star`, or a generic fallback — one side of a comparison. */
export class Operand {
  constructor({ kind, table = null, column = null, value = null, dataType = null, resolution = null, raw = null }) {
    this.kind = kind; // COLUMN | PARAMETER | LITERAL | SUBQUERY | STAR | LIST | BINARY | EXPRESSION
    this.table = table;
    this.column = column;
    this.value = value;
    this.dataType = dataType;
    this.resolution = resolution;
    this.raw = raw;
  }
}

/** A single `left OP right` comparison — a leaf of the WHERE/ON tree. */
export class ComparisonNode {
  constructor({ operator, left, right }) {
    this.kind = 'COMPARISON';
    this.operator = operator;
    this.left = left;
    this.right = right;
  }
}

/** An AND/OR node whose children have already been flattened (chained ANDs become one n-ary node, not a binary tree). */
export class LogicalNode {
  constructor({ op, children }) {
    this.kind = op; // 'AND' | 'OR'
    this.children = children;
  }
}

/** Anything the analyzer doesn't specially model yet (function calls, CASE, ...) — degrades gracefully instead of throwing. */
export class ExpressionNode {
  constructor({ raw }) {
    this.kind = 'EXPRESSION';
    this.raw = raw;
  }
}
