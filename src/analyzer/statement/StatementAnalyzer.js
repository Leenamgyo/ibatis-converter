import { DynamicSqlAnalyzer } from '../dynamic/DynamicSqlAnalyzer.js';
import { LineageAnalyzer } from '../lineage/LineageAnalyzer.js';
import { ParameterAnalyzer } from '../parameter/ParameterAnalyzer.js';
import { SqlAnalyzer } from '../sql/SqlAnalyzer.js';
import { TableAnalyzer } from '../table/TableAnalyzer.js';

function collectResolvedIncludeIds(node, seen = new Set(), out = []) {
  if (!node) return out;
  if (node.type === 'ResolvedInclude' && !seen.has(node.qualifiedId)) {
    seen.add(node.qualifiedId);
    out.push(node.qualifiedId);
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectResolvedIncludeIds(child, seen, out);
  }
  return out;
}

const dedupe = (items) => {
  const seen = new Set();
  return items.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * Dynamic table names (SqlFlattener#tableChoices): the statement was analyzed once per
 * combination of table choices. Merged: tables / columns / joins of every variant; WHERE
 * and lineage structure of the first, with each SELECT's tables completed from the others
 * (same SELECT ids — the variants differ only in table names). A table that not every
 * variant reads carries `choice`: `{ group, kind, label }`, the same `group` for the tables
 * that fill one slot (`ORDERS` / `ORDERS_RBK`, or each alternative), so the UI can draw them
 * as one dynamic table. A name with `$` in it is a variable table (`variable: true`).
 */
function mergeVariants(results, points) {
  const [first] = results;
  const upper = (name) => String(name).toUpperCase();
  const inAll = (name) => results.every((r) => r.tables.some((t) => upper(t.name) === upper(name)));

  // which choice point decides a table, and how to say it
  const choiceOf = (name) => {
    if (inAll(name)) return null;
    for (const [i, point] of points.entries()) {
      const group = `choice${i}`;
      if (point.kind === 'SUFFIX') {
        if (upper(name) === upper(`${point.base}${point.suffix}`)) return { group, kind: 'SUFFIX', suffix: point.suffix, label: `조건부 ${point.suffix}` };
        if (upper(name) === upper(point.base)) return { group, kind: 'SUFFIX', suffix: point.suffix, label: `${point.suffix} 없을 때` };
      } else {
        const takers = results.filter((r) => r.tables.some((t) => upper(t.name) === upper(name))).map((r) => r.picks[i]?.index);
        if (takers.length && takers.every((k) => k === takers[0]) && takers[0] !== undefined) {
          return { group, kind: 'ALTERNATIVES', label: `분기 ${takers[0] + 1}/${point.nodes.length}` };
        }
      }
    }
    return { group: 'choice', kind: 'CONDITIONAL', label: '조건부' };
  };
  const tag = (table) => {
    if (table.derived) return table;
    const choice = choiceOf(table.name);
    return { ...table, ...(choice ? { choice } : {}), ...(String(table.name).includes('$') ? { variable: true } : {}) };
  };

  const tables = [];
  for (const r of results) {
    for (const t of r.tables) if (!tables.some((x) => upper(x.name) === upper(t.name) && x.alias === t.alias)) tables.push(t);
  }

  const lineage = structuredClone(first.lineage);
  for (const select of lineage.selects) {
    for (const r of results.slice(1)) {
      const twin = r.lineage.selects.find((s) => s.id === select.id && s.role === select.role);
      for (const t of twin?.tables ?? []) {
        if (!select.tables.some((x) => upper(x.name) === upper(t.name) && x.alias === t.alias)) select.tables.push(t);
      }
    }
    select.tables = select.tables.map(tag);
  }

  return {
    tables: tables.map(tag),
    columns: dedupe(results.flatMap((r) => r.columns)),
    joins: dedupe(results.flatMap((r) => r.joins)),
    where: first.where,
    lineage,
  };
}

/**
 * Section 11 — combines every per-statement analyzer into one immutable
 * `StatementAnalysis` object:
 *
 *   { id, type, tables, parameters, includes, columns, joins,
 *     dynamicConditions, where, lineage, warnings, sql }
 *
 * This is the object the JSON API (`interfaces/api`) and report layer
 * (`report/migration`) consume directly. If the flattened SQL fails to
 * parse (an iBATIS structure `SqlFlattener` can't safely handle, or a
 * genuine syntax issue in the source mapper), `tables`/`columns`/`joins`/
 * `where` degrade to empty/`null` and a `SQL_PARSE_FAILED` warning is
 * added — the rest of the analysis (dynamic SQL, parameters, includes)
 * still succeeds independently, per the project's diagnostics-not-
 * exceptions principle.
 */
export class StatementAnalyzer {
  constructor({
    dynamicSqlAnalyzer = new DynamicSqlAnalyzer(),
    parameterAnalyzer = new ParameterAnalyzer(),
    sqlAnalyzer = new SqlAnalyzer(),
    tableAnalyzer = new TableAnalyzer(),
    lineageAnalyzer = new LineageAnalyzer(),
  } = {}) {
    this.dynamicSqlAnalyzer = dynamicSqlAnalyzer;
    this.parameterAnalyzer = parameterAnalyzer;
    this.sqlAnalyzer = sqlAnalyzer;
    this.tableAnalyzer = tableAnalyzer;
    this.lineageAnalyzer = lineageAnalyzer;
  }

  /**
   * @param {object} statementNode original StatementNode
   * @param {object} resolvedTree resolved StatementNode (includes flattened)
   * @param {string} qualifiedId e.g. "user.getUserList"
   * @param {string} [dialect] passed through to SqlAnalyzer
   * @returns {object} StatementAnalysis
   */
  analyze(statementNode, resolvedTree, qualifiedId, dialect = 'mysql') {
    const dynamicGroups = this.dynamicSqlAnalyzer.analyze(resolvedTree);
    const { parameters, warnings: parameterWarnings } = this.parameterAnalyzer.analyze(resolvedTree);
    const { points, variants } = this.sqlAnalyzer.analyzeVariants(resolvedTree, dialect);
    const parsed = variants.filter((v) => !v.error);
    const sql = (parsed[0] ?? variants[0]).sql;

    const warnings = [...parameterWarnings];
    let tables = [];
    let columns = [];
    let joins = [];
    let where = null;
    let lineage = { selects: [], columnLineage: [], counts: { selects: 0, subqueries: 0, unions: 0, ctes: 0, joins: 0 } };

    if (!parsed.length) {
      warnings.push({
        severity: 'WARNING',
        code: 'SQL_PARSE_FAILED',
        message: `Flattened SQL could not be parsed for table/column/join analysis: ${variants[0].error}`,
        sql,
      });
    } else {
      // one analysis per dynamic-table variant, merged: every table any condition can pick
      const results = parsed.map((v) => ({ ...this.tableAnalyzer.analyze(v.ast), lineage: this.lineageAnalyzer.analyze(v.ast), picks: v.picks }));
      ({ tables, columns, joins, where, lineage } = mergeVariants(results, points));
    }

    return {
      id: qualifiedId,
      type: statementNode.statementType,
      tables,
      parameters,
      includes: collectResolvedIncludeIds(resolvedTree),
      columns,
      joins,
      where,
      lineage,
      dynamicConditions: DynamicSqlAnalyzer.collectConditions(dynamicGroups),
      warnings,
      sql,
    };
  }
}
