import { SelectOrigin, SelectRole } from './model.js';
import { normalizeJoinType, JoinType } from '../table/model.js';
import { findImplicitJoins } from '../table/implicitJoins.js';

/**
 * Renders one node-sql-parser expression node back to a short SQL string.
 *
 * This is a *label* renderer for the lineage UI, not a SQL generator: it
 * maps the parsed expression AST node-kind by node-kind (the same
 * AST-to-AST discipline the converter uses), and a node kind it doesn't
 * know about degrades to its `column`/`value`/`name` rather than throwing
 * - an unrecognised expression must never abort a whole statement's
 * lineage.
 */
export function renderExpr(node) {
  if (node === null || node === undefined) return '';
  if (Array.isArray(node)) return node.map(renderExpr).filter(Boolean).join(', ');

  switch (node.type) {
    case 'column_ref': {
      const column = node.column?.expr?.value ?? node.column;
      return node.table ? `${node.table}.${column}` : String(column);
    }
    case 'star':
      return '*';
    case 'aggr_func': {
      const args = node.args?.expr !== undefined ? renderExpr(node.args.expr) : renderExpr(node.args);
      return `${node.name}(${node.args?.distinct ? 'DISTINCT ' : ''}${args || '*'})`;
    }
    case 'function': {
      const name = typeof node.name === 'string' ? node.name : (node.name?.name?.[0]?.value ?? '');
      return `${name}(${renderExpr(node.args)})`;
    }
    case 'binary_expr': {
      const operator = node.operator === 'AND' || node.operator === 'OR' ? ` ${node.operator} ` : ` ${node.operator} `;
      const text = `${renderExpr(node.left)}${operator}${renderExpr(node.right)}`;
      return node.parentheses ? `(${text})` : text;
    }
    case 'unary_expr':
      return `${node.operator} ${renderExpr(node.expr)}`;
    case 'expr_list': {
      const text = renderExpr(node.value);
      return node.parentheses ? `(${text})` : text;
    }
    case 'case': {
      const branches = (node.args ?? []).map((arg) => (arg.type === 'else'
        ? `ELSE ${renderExpr(arg.result)}`
        : `WHEN ${renderExpr(arg.cond)} THEN ${renderExpr(arg.result)}`));
      return `CASE ${branches.join(' ')} END`;
    }
    case 'cast':
      return `CAST(${renderExpr(node.expr)} AS ${node.target?.[0]?.dataType ?? node.target?.dataType ?? ''})`;
    case 'interval':
      return `INTERVAL ${renderExpr(node.expr)} ${node.unit ?? ''}`.trim();
    case 'single_quote_string':
    case 'string':
      return `'${node.value}'`;
    case 'number':
    case 'bool':
      return String(node.value);
    case 'null':
      return 'NULL';
    case 'param':
      return '?';
    case 'select':
      return '(SELECT …)';
    default:
      break;
  }

  // A parenthesised subquery arrives as { ast: <select>, parentheses: true }
  // rather than as a typed node.
  if (node.ast) return '(SELECT …)';
  if (node.expr) return renderExpr(node.expr);
  if (node.value !== undefined && node.value !== null && typeof node.value !== 'object') return String(node.value);
  return node.column ?? node.name ?? '';
}

/**
 * Every `column_ref` an expression reads, so an output column that isn't
 * a bare column - `SUM(PM.PAYMENT_AMOUNT)`, `A.X || B.Y` - still says
 * which column(s) it came from. Subqueries are skipped: their columns
 * belong to that subquery's own LineageSelect, not to this expression.
 */
function collectColumnRefs(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectColumnRefs(item, out);
    return out;
  }
  if (node.ast) return out;
  if (node.type === 'column_ref') {
    out.push({ table: node.table ?? null, column: node.column?.expr?.value ?? node.column ?? null });
    return out;
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') collectColumnRefs(value, out);
  }
  return out;
}

/** The parenthesised `{ ast, parentheses }` wrapper node-sql-parser puts around every subquery, if this is one. */
function subquerySelectOf(node) {
  const ast = node?.ast ?? (node?.expr?.ast ?? null);
  return ast && ast.type === 'select' ? ast : null;
}

/** Every `{ ast: <select> }` reachable from an expression tree (a WHERE can hold several: `A IN (SELECT ..) AND EXISTS (SELECT ..)`). */
function collectExpressionSubqueries(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectExpressionSubqueries(item, out);
    return out;
  }
  const select = subquerySelectOf(node);
  if (select) {
    out.push(select);
    return out;
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') collectExpressionSubqueries(value, out);
  }
  return out;
}

/**
 * Section 26 (lineage dashboard) — turns the parsed SQL AST of one
 * statement into the *hierarchy* the UI draws: which SELECT contains
 * which subquery, what each of those reads, and which source column ends
 * up behind each final SELECT alias.
 *
 * `analyzer/table` already answers "which tables/columns/joins does this
 * statement touch" as one flat set, which is the right shape for the
 * table explorer and deliberately loses nesting. The dashboard needs the
 * opposite: `ORDERS.ORDER_DATE -> S1.LAST_ORDER_DATE -> MAIN.lastOrderDate`,
 * with S1 drawn inside the SELECT that owns it. So this analyzer keeps
 * one `LineageSelect` per SELECT node - main, subquery, UNION branch or
 * CTE - each with its own tables/joins/outputs, linked by `parentId`.
 *
 * Like every other analyzer here it consumes the AST only (never the SQL
 * text) and never throws: an AST shape it doesn't recognise yields fewer
 * nodes, not an exception.
 */
export class LineageAnalyzer {
  /**
   * @param {object[]|object|null} ast node-sql-parser AST (`SqlAnalyzer#parse`)
   * @returns {{ selects: object[], columnLineage: object[], counts: object }}
   */
  analyze(ast) {
    const statements = Array.isArray(ast) ? ast : (ast ? [ast] : []);
    /** @type {object[]} */
    const selects = [];
    const counter = { subquery: 0, union: 0, main: 0 };

    for (const statement of statements) {
      if (!statement) continue;
      const context = {
        parentId: null,
        origin: SelectOrigin.ROOT,
        role: SelectRole.MAIN,
        alias: null,
        depth: 0,
      };
      if (statement.type === 'select') this.#walkSelect(statement, context, selects, counter);
      else if (statement.type === 'insert' || statement.type === 'update' || statement.type === 'delete') {
        this.#walkWrite(statement, context, selects, counter);
      }
    }

    const main = selects.find((s) => s.role === SelectRole.MAIN || s.role === SelectRole.WRITE) ?? null;
    const columnLineage = main ? this.#buildColumnLineage(main, selects) : [];

    return {
      selects,
      columnLineage,
      counts: {
        selects: selects.filter((s) => s.role !== SelectRole.WRITE).length,
        subqueries: selects.filter((s) => s.role === SelectRole.SUBQUERY).length,
        unions: selects.filter((s) => s.role === SelectRole.UNION_BRANCH).length,
        ctes: selects.filter((s) => s.role === SelectRole.CTE).length,
        joins: selects.reduce((sum, s) => sum + s.joins.length, 0),
      },
    };
  }

  /* ---------------------------------------------------------------- *
   * One SELECT node -> one LineageSelect (+ its children, recursively) *
   * ---------------------------------------------------------------- */
  #walkSelect(node, context, selects, counter) {
    const id = context.role === SelectRole.MAIN
      ? (counter.main++ === 0 ? 'MAIN' : `MAIN${counter.main}`)
      : context.role === SelectRole.UNION_BRANCH
        ? `U${++counter.union}`
        : `S${++counter.subquery}`;

    const select = {
      id,
      role: context.role,
      origin: context.origin,
      parentId: context.parentId,
      alias: context.alias ?? null,
      depth: context.depth,
      distinct: Boolean(node.distinct),
      tables: [],
      joins: [],
      outputs: [],
      groupBy: (node.groupby?.columns ?? node.groupby ?? []).map(renderExpr).filter(Boolean),
      orderBy: (node.orderby ?? []).map((o) => `${renderExpr(o.expr)}${o.type ? ` ${o.type.toUpperCase()}` : ''}`).filter(Boolean),
      where: node.where ? renderExpr(node.where) : null,
      having: node.having ? renderExpr(node.having) : null,
      limit: node.limit?.value?.length ? node.limit.value.map(renderExpr).join(', ') : null,
      // The set operator belongs to the branch it introduces, not to the
      // SELECT that happens to precede it, so only UNION_BRANCH nodes
      // carry one (assigned below, from the parent's `set_op`).
      setOperator: context.role === SelectRole.UNION_BRANCH ? (context.setOperator ?? null) : null,
      children: [],
    };
    selects.push(select);

    // `WITH` CTEs first: they're named SELECTs the rest of this one reads from.
    for (const cte of node.with ?? []) {
      const cteSelect = cte.stmt?.ast ?? cte.stmt;
      if (!cteSelect || cteSelect.type !== 'select') continue;
      const child = this.#walkSelect(cteSelect, {
        parentId: id,
        origin: SelectOrigin.CTE,
        role: SelectRole.CTE,
        alias: cte.name?.value ?? cte.name ?? null,
        depth: context.depth + 1,
      }, selects, counter);
      select.children.push(child.id);
    }

    /* FROM / JOIN ---------------------------------------------------- */
    for (const entry of node.from ?? []) {
      const joinType = entry.join ? normalizeJoinType(entry.join) : null;
      const derived = subquerySelectOf(entry);

      if (derived) {
        const child = this.#walkSelect(derived, {
          parentId: id,
          origin: entry.join ? SelectOrigin.JOIN : SelectOrigin.FROM,
          role: SelectRole.SUBQUERY,
          alias: entry.as ?? null,
          depth: context.depth + 1,
        }, selects, counter);
        select.children.push(child.id);
        select.tables.push({ name: entry.as ?? child.id, alias: entry.as ?? null, derived: true, selectId: child.id });
        if (joinType) select.joins.push({ type: joinType, table: entry.as ?? child.id, alias: entry.as ?? null, derived: true, selectId: child.id, on: entry.on ? renderExpr(entry.on) : null });
        continue;
      }

      if (!entry.table) continue;
      select.tables.push({ name: entry.table, alias: entry.as ?? null, derived: false, selectId: null });
      if (joinType) select.joins.push({ type: joinType, table: entry.table, alias: entry.as ?? null, derived: false, selectId: null, on: entry.on ? renderExpr(entry.on) : null });
    }

    // Comma joins carry no JOIN keyword, so they have to be recovered
    // from the WHERE clause (see `analyzer/table/implicitJoins.js`).
    for (const implicit of findImplicitJoins(node.from, node.where, (alias) => this.#resolveAlias(select, alias))) {
      select.joins.push({
        type: JoinType.IMPLICIT_JOIN,
        table: implicit.rightTable,
        alias: null,
        derived: false,
        selectId: null,
        on: renderExpr(implicit.condition),
      });
    }

    /* SELECT list ---------------------------------------------------- */
    for (const column of node.columns ?? []) {
      if (column === '*' || column?.expr?.type === 'star') {
        select.outputs.push({ expression: '*', alias: null, sourceTable: null, sourceColumn: null, sourceRefs: [], aggregate: false, selectId: null });
        continue;
      }
      const scalarSubquery = subquerySelectOf(column.expr);
      if (scalarSubquery) {
        const child = this.#walkSelect(scalarSubquery, {
          parentId: id,
          origin: SelectOrigin.SELECT_LIST,
          role: SelectRole.SUBQUERY,
          alias: column.as ?? null,
          depth: context.depth + 1,
        }, selects, counter);
        select.children.push(child.id);
        select.outputs.push({
          expression: `(SELECT ${child.outputs.map((o) => o.expression).join(', ') || '…'})`,
          alias: column.as ?? null,
          sourceTable: child.id,
          sourceColumn: child.outputs[0]?.alias ?? child.outputs[0]?.sourceColumn ?? null,
          sourceRefs: [],
          aggregate: false,
          selectId: child.id,
        });
        continue;
      }

      // An expression column keeps its source only when it reads exactly
      // one column: `SUM(PM.PAYMENT_AMOUNT)` has an unambiguous origin,
      // `A.X + B.Y` does not, and guessing one of the two would be worse
      // than saying nothing (`sourceRefs` still lists both).
      const expr = column.expr ?? {};
      const refs = collectColumnRefs(expr);
      const distinct = [...new Map(refs.map((r) => [`${r.table}.${r.column}`, r])).values()];
      const single = distinct.length === 1 ? distinct[0] : null;
      select.outputs.push({
        expression: renderExpr(expr),
        alias: column.as ?? null,
        sourceTable: single?.table ?? null,
        sourceColumn: single?.column ?? null,
        sourceRefs: distinct,
        aggregate: expr.type === 'aggr_func',
        selectId: null,
      });
    }

    /* WHERE / HAVING subqueries -------------------------------------- */
    for (const [clause, origin] of [[node.where, SelectOrigin.WHERE], [node.having, SelectOrigin.HAVING]]) {
      for (const nested of collectExpressionSubqueries(clause)) {
        const child = this.#walkSelect(nested, {
          parentId: id,
          origin,
          role: SelectRole.SUBQUERY,
          alias: null,
          depth: context.depth + 1,
        }, selects, counter);
        select.children.push(child.id);
      }
    }

    /* UNION branches: siblings of this SELECT, not children of it ----- */
    if (node._next && node._next.type === 'select') {
      this.#walkSelect(node._next, {
        parentId: context.parentId ?? id,
        origin: SelectOrigin.UNION,
        role: SelectRole.UNION_BRANCH,
        alias: null,
        depth: context.depth,
        setOperator: (node.set_op ?? 'union').toUpperCase(),
      }, selects, counter);
    }

    return select;
  }


  /**
   * An INSERT/UPDATE/DELETE root, kept in the same `selects` list so the
   * dashboard can draw a write statement with the same containment
   * machinery as a SELECT: the target table on the source side, the
   * written columns as outputs, and any feeding/filtering SELECT as a
   * child.
   */
  #walkWrite(node, context, selects, counter) {
    const operation = node.type.toUpperCase();
    const id = counter.main++ === 0 ? 'MAIN' : `MAIN${counter.main}`;
    const target = node.table?.[0];

    const select = {
      id,
      role: SelectRole.WRITE,
      operation,
      origin: context.origin,
      parentId: null,
      alias: target?.as ?? null,
      depth: 0,
      distinct: false,
      tables: target?.table ? [{ name: target.table, alias: target.as ?? null, derived: false, selectId: null }] : [],
      joins: [],
      outputs: [],
      groupBy: [],
      orderBy: [],
      where: node.where ? renderExpr(node.where) : null,
      having: null,
      limit: null,
      setOperator: null,
      children: [],
    };
    selects.push(select);

    if (operation === 'INSERT') {
      for (const column of node.columns ?? []) {
        select.outputs.push({
          expression: column,
          alias: column,
          sourceTable: target?.table ?? null,
          sourceColumn: column,
          sourceRefs: [],
          aggregate: false,
          selectId: null,
        });
      }
      // `INSERT ... SELECT`: the feeding SELECT is a child, and its own
      // output list is what actually lands in those columns.
      const source = node.values?.ast ?? node.values;
      if (source && source.type === 'select') {
        const child = this.#walkSelect(source, {
          parentId: id,
          origin: SelectOrigin.INSERT_SELECT,
          role: SelectRole.SUBQUERY,
          alias: null,
          depth: 1,
        }, selects, counter);
        select.children.push(child.id);
      }
    } else if (operation === 'UPDATE') {
      for (const assignment of node.set ?? []) {
        select.outputs.push({
          expression: `${assignment.column} = ${renderExpr(assignment.value)}`,
          alias: assignment.column,
          sourceTable: assignment.table ?? target?.table ?? null,
          sourceColumn: assignment.column,
          sourceRefs: collectColumnRefs(assignment.value),
          aggregate: false,
          selectId: null,
        });
      }
    }

    // A subquery in WHERE (or in an UPDATE's SET) is a child of the write.
    const clauses = [node.where, ...(node.set ?? []).map((a) => a.value)];
    for (const nested of collectExpressionSubqueries(clauses)) {
      const child = this.#walkSelect(nested, {
        parentId: id,
        origin: SelectOrigin.WHERE,
        role: SelectRole.SUBQUERY,
        alias: null,
        depth: 1,
      }, selects, counter);
      select.children.push(child.id);
    }

    return select;
  }

  /* ---------------------------------------------------------------- *
   * alias -> source column, followed through derived tables            *
   * ---------------------------------------------------------------- */
  #buildColumnLineage(main, selects) {
    const byId = new Map(selects.map((s) => [s.id, s]));

    // `INSERT INTO t (a, b) SELECT x, y FROM s` pairs positionally, which
    // is the only place a write statement has real column lineage.
    if (main.role === SelectRole.WRITE && main.operation === 'INSERT') {
      const source = selects.find((s) => s.parentId === main.id && s.origin === SelectOrigin.INSERT_SELECT);
      return main.outputs.map((output, index) => {
        const from = source?.outputs[index];
        const sourceTable = from?.sourceTable ? this.#resolveAlias(source, from.sourceTable) : null;
        return {
          alias: output.alias,
          expression: from ? `${from.expression} -> ${output.alias}` : output.expression,
          aggregate: Boolean(from?.aggregate),
          sourceTable,
          sourceColumn: from?.sourceColumn ?? null,
          path: source ? [{ selectId: source.id, column: from?.alias ?? from?.sourceColumn ?? null }] : [],
        };
      });
    }
    const derivedByAlias = new Map();
    for (const table of main.tables) {
      if (table.derived && table.selectId) derivedByAlias.set(table.alias ?? table.selectId, table.selectId);
    }
    const realByAlias = new Map();
    for (const table of main.tables) {
      if (!table.derived) realByAlias.set(table.alias ?? table.name, table.name);
    }

    return main.outputs.map((output) => {
      const alias = output.alias ?? output.sourceColumn ?? output.expression;
      /** Each hop of `ORDERS.ORDER_DATE -> S1.LAST_ORDER_DATE -> MAIN.lastOrderDate`. */
      const path = [];
      let sourceTable = output.sourceTable;
      let sourceColumn = output.sourceColumn;

      // A scalar subquery in the SELECT list: the hop is the subquery itself.
      if (output.selectId) {
        path.push({ selectId: output.selectId, column: output.sourceColumn });
        const inner = byId.get(output.selectId);
        const innerOutput = inner?.outputs[0];
        sourceTable = innerOutput?.sourceTable ? this.#resolveAlias(inner, innerOutput.sourceTable) : (inner?.tables[0]?.name ?? null);
        sourceColumn = innerOutput?.sourceColumn ?? null;
      } else if (sourceTable && derivedByAlias.has(sourceTable)) {
        // A column read off a derived table: follow it into that SELECT's output list.
        const innerId = derivedByAlias.get(sourceTable);
        path.push({ selectId: innerId, column: sourceColumn });
        const inner = byId.get(innerId);
        const innerOutput = inner?.outputs.find((o) => (o.alias ?? o.sourceColumn) === sourceColumn);
        sourceTable = innerOutput?.sourceTable ? this.#resolveAlias(inner, innerOutput.sourceTable) : (inner?.tables.find((t) => !t.derived)?.name ?? null);
        // Once the hop is resolved, the source column is whatever the
        // inner SELECT read - `null` when it read no column at all
        // (`COUNT(*)`). Falling back to the outer alias here would name a
        // column of the derived table as if it were a real one.
        sourceColumn = innerOutput ? innerOutput.sourceColumn : sourceColumn;
      } else if (sourceTable) {
        sourceTable = realByAlias.get(sourceTable) ?? sourceTable;
      } else if (!sourceTable && main.tables.length === 1 && !main.tables[0].derived) {
        // Unqualified column in a single-table SELECT - unambiguous.
        sourceTable = main.tables[0].name;
      }

      return {
        alias,
        expression: output.expression,
        aggregate: output.aggregate,
        sourceTable: sourceTable ?? null,
        sourceColumn: sourceColumn ?? null,
        path,
      };
    });
  }

  /** Table alias -> real table name inside one SELECT's own FROM list. */
  #resolveAlias(select, aliasOrName) {
    if (!select) return aliasOrName;
    const match = select.tables.find((t) => (t.alias ?? t.name) === aliasOrName);
    return match ? match.name : aliasOrName;
  }
}
