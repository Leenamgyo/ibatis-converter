/**
 * The old-schema -> new-schema mapping table, one entry per legacy table:
 *
 *   {
 *     OLD_COUNTRY: { targetTable: 'COUNTRY', columns: { COUNTRY_CD: 'COUNTRY_CODE' } },
 *     'LEGACY.OLD_CODE_DETAIL': { targetTable: 'CODE_DETAIL', columns: { CD: 'CODE' } },
 *   }
 *
 * Columns are scoped to their table on purpose: the same legacy column
 * name (`CD`, `USE_YN`, ...) routinely maps to different new names in
 * different tables, so there is no global column lookup to fall back to.
 *
 * Lookups are case-insensitive (SQL identifiers are, unquoted). A key may
 * be schema-qualified; a qualified key wins over a bare one, so
 * `LEGACY.OLD_COUNTRY` can be mapped differently from `OLD_COUNTRY` in
 * another schema. `targetTable` may itself carry a schema (`NEW.COUNTRY`).
 */
export class TableMapping {
  /**
   * @param {{ sourceTable: string, targetTable?: string|null, columns?: Record<string,string>|Map<string,string> }} init
   */
  constructor({ sourceTable, targetTable = null, columns = {} }) {
    this.sourceTable = sourceTable;
    /** null means "the table keeps its name, only its columns move" */
    this.targetTable = targetTable;
    const entries = columns instanceof Map ? [...columns] : Object.entries(columns ?? {});
    /** @type {Map<string, string>} upper-cased legacy column -> new column */
    this.columns = new Map(entries.map(([from, to]) => [String(from).toUpperCase(), String(to)]));
    Object.freeze(this);
  }

  /** @returns {string|null} the new column name, or null if this column is not remapped */
  column(name) {
    return this.columns.get(String(name).toUpperCase()) ?? null;
  }
}

export class MigrationMapping {
  /**
   * @param {Record<string, { targetTable?: string, columns?: Record<string,string> }>|Map<string, object>} tables
   */
  constructor(tables = {}) {
    const entries = tables instanceof Map ? [...tables] : Object.entries(tables);
    /** @type {Map<string, TableMapping>} upper-cased (optionally schema-qualified) legacy table -> mapping */
    this.tables = new Map();
    /** every legacy column name that appears anywhere, for "did we miss one?" diagnostics */
    this.allColumns = new Set();
    for (const [key, value] of entries) {
      if (!value || typeof value !== 'object') {
        throw new Error(`MigrationMapping: entry "${key}" must be an object with targetTable/columns`);
      }
      const mapping = value instanceof TableMapping
        ? value
        : new TableMapping({ sourceTable: key, targetTable: value.targetTable ?? null, columns: value.columns });
      this.tables.set(String(key).toUpperCase(), mapping);
      for (const column of mapping.columns.keys()) this.allColumns.add(column);
    }
    Object.freeze(this);
  }

  /** Accepts an existing MigrationMapping, a plain object or a Map. */
  static from(value) {
    return value instanceof MigrationMapping ? value : new MigrationMapping(value ?? {});
  }

  /**
   * @param {string} name   bare table name
   * @param {string|null} schema  schema/owner qualifier as written in the SQL, if any
   * @returns {TableMapping|null}
   */
  table(name, schema = null) {
    const bare = String(name).toUpperCase();
    if (schema) {
      const qualified = this.tables.get(`${String(schema).toUpperCase()}.${bare}`);
      if (qualified) return qualified;
    }
    return this.tables.get(bare) ?? null;
  }

  /** true if `name` is a legacy column of any mapped table */
  isKnownColumn(name) {
    return this.allColumns.has(String(name).toUpperCase());
  }
}
