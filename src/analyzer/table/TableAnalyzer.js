import {
  TableOperation, ColumnUsedIn, ColumnResolution, JoinType, normalizeJoinType,
  TableUsage, ColumnUsage, JoinRelation, Operand, ComparisonNode, LogicalNode, ExpressionNode,
} from './model.js';
import { findImplicitJoins } from './implicitJoins.js';

/**
 * Sections 7-10 — Table / Column / Join / WHERE analysis over the AST
 * produced by `analyzer/sql/SqlAnalyzer`.
 *
 * Table/column resolution is a single flat scope for the whole statement,
 * including every subquery found in FROM or in a WHERE/HAVING expression
 * ("서브쿼리 안에 존재하는 테이블도 분석한다") — a subquery's tables, joins,
 * columns and its own WHERE tree are all folded into the same result
 * rather than nested, which is enough to answer "what tables/columns does
 * this statement touch" even though it doesn't preserve subquery scoping
 * for column resolution across subquery boundaries. UNION branches
 * (`_next`) are folded in the same way.
 */

function isSubqueryDescriptor(expr) {
  return !!expr && typeof expr === 'object' && 'ast' in expr && 'tableList' in expr;
}

function resolveTable(aliasOrTable, aliasMap) {
  return aliasMap.get(aliasOrTable) ?? aliasOrTable;
}

function operandFromExpr(expr, ctx) {
  if (!expr) return null;

  if (isSubqueryDescriptor(expr)) {
    analyzeNode(expr.ast, ctx);
    return new Operand({ kind: 'SUBQUERY' });
  }

  switch (expr.type) {
    case 'column_ref':
      if (expr.column === '*') return new Operand({ kind: 'STAR', table: expr.table ? resolveTable(expr.table, ctx.aliasMap) : null });
      return new Operand({
        kind: 'COLUMN',
        table: expr.table ? resolveTable(expr.table, ctx.aliasMap) : 'UNKNOWN',
        column: expr.column,
        resolution: expr.table ? ColumnResolution.RESOLVED : ColumnResolution.UNRESOLVED,
      });
    case 'origin':
      return expr.value === '?' ? new Operand({ kind: 'PARAMETER' }) : new Operand({ kind: 'LITERAL', value: expr.value });
    case 'number':
      return new Operand({ kind: 'LITERAL', value: expr.value, dataType: 'NUMBER' });
    case 'single_quote_string':
    case 'double_quote_string':
    case 'string':
      return new Operand({ kind: 'LITERAL', value: expr.value, dataType: 'STRING' });
    case 'null':
      return new Operand({ kind: 'LITERAL', value: null, dataType: 'NULL' });
    case 'bool':
      return new Operand({ kind: 'LITERAL', value: expr.value, dataType: 'BOOLEAN' });
    case 'expr_list':
      return new Operand({ kind: 'LIST', raw: expr.value.map((v) => operandFromExpr(v, ctx)) });
    case 'aggr_func':
      return operandFromExpr(expr.args?.expr, ctx) ?? new Operand({ kind: 'EXPRESSION', raw: 'aggr_func' });
    case 'binary_expr':
      return new ComparisonNode({ operator: expr.operator, left: operandFromExpr(expr.left, ctx), right: operandFromExpr(expr.right, ctx) });
    default:
      return new Operand({ kind: 'EXPRESSION', raw: expr.type });
  }
}

function buildConditionTree(expr, ctx) {
  if (!expr) return null;
  if (isSubqueryDescriptor(expr)) return operandFromExpr(expr, ctx);
  if (expr.type === 'binary_expr' && (expr.operator === 'AND' || expr.operator === 'OR')) {
    return new LogicalNode({ op: expr.operator, children: [buildConditionTree(expr.left, ctx), buildConditionTree(expr.right, ctx)] });
  }
  if (expr.type === 'binary_expr') {
    return new ComparisonNode({ operator: expr.operator, left: operandFromExpr(expr.left, ctx), right: operandFromExpr(expr.right, ctx) });
  }
  return new ExpressionNode({ raw: expr.type });
}

/** Flattens chained same-operator AND/OR nodes into one n-ary LogicalNode, matching the spec's tree shape. */
function flattenLogical(node) {
  if (!node) return null;
  if (node.kind === 'AND' || node.kind === 'OR') {
    const children = [];
    const collect = (n) => {
      if (n && n.kind === node.kind) { for (const child of n.children) collect(child); } else children.push(flattenLogical(n));
    };
    collect(node);
    return new LogicalNode({ op: node.kind, children });
  }
  return node;
}

function collectColumns(node, usedIn, out) {
  if (!node) return;
  if (node.kind === 'COLUMN') { out.push(new ColumnUsage({ table: node.table, column: node.column, usedIn, resolution: node.resolution })); return; }
  if (node.kind === 'LIST') { node.raw.forEach((n) => collectColumns(n, usedIn, out)); return; }
  if (node.kind === 'AND' || node.kind === 'OR') { node.children.forEach((c) => collectColumns(c, usedIn, out)); return; }
  if (node.kind === 'COMPARISON') { collectColumns(node.left, usedIn, out); collectColumns(node.right, usedIn, out); return; }
}

function extractJoinConditions(onExpr, ctx) {
  const tree = flattenLogical(buildConditionTree(onExpr, ctx));
  const list = [];
  const collect = (n) => {
    if (!n) return;
    if (n.kind === 'AND') { n.children.forEach(collect); return; }
    list.push(n);
  };
  collect(tree);
  return list;
}

function walkFrom(fromArray, ctx) {
  let prevTable = null;
  for (const [idx, entry] of fromArray.entries()) {
    if (entry.expr) {
      // Derived table: `FROM (SELECT ...) alias`
      analyzeNode(entry.expr.ast, ctx);
      const alias = entry.as ?? null;
      if (alias) ctx.aliasMap.set(alias, alias);
      ctx.tables.push(new TableUsage({ name: alias ?? '(subquery)', alias, operation: TableOperation.READ, derived: true }));
      prevTable = alias ?? null;
      continue;
    }

    const tableName = entry.table;
    const alias = entry.as ?? null;
    ctx.tables.push(new TableUsage({ name: tableName, alias, operation: TableOperation.READ }));
    if (alias) ctx.aliasMap.set(alias, tableName);
    ctx.aliasMap.set(tableName, tableName);

    if (entry.join && idx > 0 && prevTable) {
      const conditions = entry.on ? extractJoinConditions(entry.on, ctx) : [];
      ctx.joins.push(new JoinRelation({ leftTable: prevTable, rightTable: tableName, type: normalizeJoinType(entry.join), conditions }));
      if (entry.on) collectColumns(flattenLogical(buildConditionTree(entry.on, ctx)), ColumnUsedIn.JOIN, ctx.columns);
    }
    prevTable = tableName;
  }
}

function analyzeSelect(node, ctx) {
  if (node.from) walkFrom(node.from, ctx);

  for (const col of node.columns ?? []) {
    if (col === '*' || !col.expr) continue;
    collectColumns(operandFromExpr(col.expr, ctx), ColumnUsedIn.SELECT, ctx.columns);
  }
  if (node.where) {
    const tree = flattenLogical(buildConditionTree(node.where, ctx));
    ctx.whereTrees.push(tree);
    collectColumns(tree, ColumnUsedIn.WHERE, ctx.columns);

    // `FROM A, B WHERE A.X = B.X` is a join too, just written without the
    // keyword - the form most legacy mappers use.
    for (const implicit of findImplicitJoins(node.from, node.where, (a) => resolveTable(a, ctx.aliasMap))) {
      ctx.joins.push(new JoinRelation({
        leftTable: implicit.leftTable,
        rightTable: implicit.rightTable,
        type: JoinType.IMPLICIT_JOIN,
        conditions: extractJoinConditions(implicit.condition, ctx),
      }));
    }
  }
  for (const g of node.groupby ?? []) collectColumns(operandFromExpr(g, ctx), ColumnUsedIn.GROUP_BY, ctx.columns);
  if (node.having) collectColumns(flattenLogical(buildConditionTree(node.having, ctx)), ColumnUsedIn.HAVING, ctx.columns);
  for (const o of node.orderby ?? []) collectColumns(operandFromExpr(o.expr, ctx), ColumnUsedIn.ORDER_BY, ctx.columns);

  if (node._next) analyzeNode(node._next, ctx);
}

function analyzeInsert(node, ctx) {
  const table = node.table?.[0];
  if (!table) return;
  ctx.tables.push(new TableUsage({ name: table.table, alias: table.as ?? null, operation: TableOperation.CREATE }));
  ctx.aliasMap.set(table.table, table.table);
  for (const colName of node.columns ?? []) {
    ctx.columns.push(new ColumnUsage({ table: table.table, column: colName, usedIn: ColumnUsedIn.INSERT }));
  }
  // `INSERT INTO t (...) SELECT ...` reads too: without this the source
  // tables of an archive/copy statement are invisible to the table report
  // and to the table dependency graph.
  const source = node.values?.ast ?? node.values;
  if (source && source.type === 'select') analyzeNode(source, ctx);
}

function analyzeUpdate(node, ctx) {
  const table = node.table?.[0];
  if (!table) return;
  ctx.tables.push(new TableUsage({ name: table.table, alias: table.as ?? null, operation: TableOperation.UPDATE }));
  if (table.as) ctx.aliasMap.set(table.as, table.table);
  ctx.aliasMap.set(table.table, table.table);

  if (node.from) walkFrom(node.from, ctx);

  for (const s of node.set ?? []) {
    ctx.columns.push(new ColumnUsage({ table: s.table ? resolveTable(s.table, ctx.aliasMap) : table.table, column: s.column, usedIn: ColumnUsedIn.UPDATE_SET }));
  }
  if (node.where) {
    const tree = flattenLogical(buildConditionTree(node.where, ctx));
    ctx.whereTrees.push(tree);
    collectColumns(tree, ColumnUsedIn.WHERE, ctx.columns);
  }
}

function analyzeDelete(node, ctx) {
  const deleteTargets = new Set((node.table ?? []).map((t) => t.table));
  if (node.from) walkFrom(node.from, ctx);
  for (const t of ctx.tables) {
    if (deleteTargets.has(t.name) && t.operation === TableOperation.READ) t.operation = TableOperation.DELETE;
  }
  if (node.where) {
    const tree = flattenLogical(buildConditionTree(node.where, ctx));
    ctx.whereTrees.push(tree);
    collectColumns(tree, ColumnUsedIn.WHERE, ctx.columns);
  }
}

function analyzeNode(node, ctx) {
  if (!node) return;
  switch (node.type) {
    case 'select': analyzeSelect(node, ctx); break;
    case 'insert': analyzeInsert(node, ctx); break;
    case 'update': analyzeUpdate(node, ctx); break;
    case 'delete': analyzeDelete(node, ctx); break;
    default: break;
  }
}

function dedupeTables(tables) {
  const seen = new Map();
  for (const t of tables) {
    const key = `${t.name} ${t.alias ?? ''} ${t.operation}`;
    if (!seen.has(key)) seen.set(key, t);
  }
  return [...seen.values()];
}

export class TableAnalyzer {
  /**
   * @param {object[]|object} sqlAst from `SqlAnalyzer#parse` (`.ast`)
   * @returns {{ tables: TableUsage[], columns: ColumnUsage[], joins: JoinRelation[], where: object|null, whereTrees: object[] }}
   */
  analyze(sqlAst) {
    const ctx = { tables: [], joins: [], columns: [], whereTrees: [], aliasMap: new Map() };
    const nodes = Array.isArray(sqlAst) ? sqlAst : [sqlAst];
    for (const node of nodes) analyzeNode(node, ctx);
    return {
      tables: dedupeTables(ctx.tables),
      columns: ctx.columns,
      joins: ctx.joins,
      where: ctx.whereTrees[0] ?? null,
      whereTrees: ctx.whereTrees,
    };
  }
}
