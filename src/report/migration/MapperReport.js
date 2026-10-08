import { StatementType } from '../../ast/ibatis/enums.js';

/**
 * Section 19 — one Mapper XML's migration report: statement counts by
 * type, sql fragment / resultMap / parameterMap counts, tables touched,
 * and aggregated warnings/errors, plus per-statement detail
 * (`StatementAnalysis`, from `analyzer/statement`).
 */
export class MapperReport {
  /**
   * @param {object} sqlMap parsed SqlMapNode for one file
   * @param {object[]} statementAnalyses StatementAnalysis objects for this file's statements
   * @param {{ warnings: object[], errors: object[] }} fileDiagnostics diagnostics whose `sourceFile` matches this mapper
   * @returns {object} MapperReport
   */
  build(sqlMap, statementAnalyses, fileDiagnostics = { warnings: [], errors: [] }) {
    const byType = {
      [StatementType.SELECT]: 0,
      [StatementType.INSERT]: 0,
      [StatementType.UPDATE]: 0,
      [StatementType.DELETE]: 0,
      [StatementType.PROCEDURE]: 0,
    };
    const tableNames = new Set();
    let statementWarningCount = 0;

    for (const analysis of statementAnalyses) {
      byType[analysis.type] = (byType[analysis.type] ?? 0) + 1;
      for (const t of analysis.tables) if (!t.derived) tableNames.add(t.name);
      statementWarningCount += analysis.warnings.length;
    }

    return {
      sourceFile: sqlMap?.sourceFile ?? null,
      namespace: sqlMap?.namespace ?? null,
      statementCount: statementAnalyses.length,
      byType,
      sqlFragmentCount: sqlMap?.sqlFragments.length ?? 0,
      resultMapCount: sqlMap?.resultMaps.length ?? 0,
      parameterMapCount: sqlMap?.parameterMaps.length ?? 0,
      tables: [...tableNames].sort(),
      warningCount: fileDiagnostics.warnings.length + statementWarningCount,
      errorCount: fileDiagnostics.errors.length,
      statements: statementAnalyses,
    };
  }
}
