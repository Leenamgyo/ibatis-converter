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
    const { sql, ast, error: sqlError } = this.sqlAnalyzer.analyzeStatement(resolvedTree, dialect);

    const warnings = [...parameterWarnings];
    let tables = [];
    let columns = [];
    let joins = [];
    let where = null;
    let lineage = { selects: [], columnLineage: [], counts: { selects: 0, subqueries: 0, unions: 0, ctes: 0, joins: 0 } };

    if (sqlError) {
      warnings.push({
        severity: 'WARNING',
        code: 'SQL_PARSE_FAILED',
        message: `Flattened SQL could not be parsed for table/column/join analysis: ${sqlError}`,
        sql,
      });
    } else {
      ({ tables, columns, joins, where } = this.tableAnalyzer.analyze(ast));
      lineage = this.lineageAnalyzer.analyze(ast);
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
