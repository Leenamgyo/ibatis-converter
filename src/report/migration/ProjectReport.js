/**
 * Section 20 — project-wide, table-centric usage report: for every table,
 * which statements READ/CREATE/UPDATE/DELETE it, and (per column) which
 * SELECT/WHERE/JOIN/... clauses reference it — the "what breaks if I
 * change this table/column" view.
 *
 * Built purely from `MapperReport#statements` (each a `StatementAnalysis`
 * from `analyzer/statement`), so it works the same whether it's fed one
 * mapper or an entire project's worth.
 */
export class ProjectReport {
  /**
   * @param {object[]} mapperReports from MapperReport#build, one per file
   * @returns {Record<string, { operations: Record<string, string[]>, columns: Record<string, Record<string, number>> }>}
   */
  build(mapperReports) {
    const tables = new Map();

    const ensureTable = (name) => {
      if (!tables.has(name)) {
        tables.set(name, { operations: { READ: [], CREATE: [], UPDATE: [], DELETE: [] }, columns: new Map() });
      }
      return tables.get(name);
    };
    const ensureColumn = (tableEntry, columnName) => {
      if (!tableEntry.columns.has(columnName)) tableEntry.columns.set(columnName, {});
      return tableEntry.columns.get(columnName);
    };

    for (const mapperReport of mapperReports) {
      for (const statement of mapperReport.statements ?? []) {
        // subqueries and CTEs are reported per statement, not as tables of the project
        const derived = new Set(statement.tables.filter((t) => t.derived).map((t) => t.name));
        for (const t of statement.tables) {
          if (t.derived) continue;
          const entry = ensureTable(t.name);
          if (!entry.operations[t.operation].includes(statement.id)) entry.operations[t.operation].push(statement.id);
        }
        for (const c of statement.columns) {
          if (c.table === 'UNKNOWN') continue; // unresolved columns aren't attributable to a specific table
          if (derived.has(c.table)) continue; // a subquery's / CTE's output column
          const entry = ensureTable(c.table);
          const columnUsage = ensureColumn(entry, c.column);
          columnUsage[c.usedIn] = (columnUsage[c.usedIn] ?? 0) + 1;
        }
      }
    }

    const result = {};
    for (const [name, entry] of tables.entries()) {
      result[name] = {
        operations: entry.operations,
        columns: Object.fromEntries(entry.columns.entries()),
      };
    }
    return result;
  }
}
