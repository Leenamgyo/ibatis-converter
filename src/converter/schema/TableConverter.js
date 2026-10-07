import { TableRefKind } from './TableResolver.js';
import { TokenKind, tokenize } from './SqlLexer.js';
import { SchemaMigrationEvent, SchemaMigrationGrade, SchemaMigrationCode } from './SchemaMigrationEvent.js';
import { renderIdentifier, splitQualifiedName } from './identifiers.js';

/**
 * Step 3 of schema migration: rename table references — and only the
 * table-name tokens of them. The alias (`OLD_COUNTRY c` -> `COUNTRY c`)
 * is a separate token and is never touched, so every `c.COL` elsewhere
 * keeps working.
 *
 * A schema written in the SQL is kept unless the mapping's targetTable
 * names its own: `LEGACY.OLD_COUNTRY` -> `LEGACY.COUNTRY` for
 * `targetTable: COUNTRY`, -> `NEW.COUNTRY` for `targetTable: NEW.COUNTRY`.
 *
 * A column qualifier that names a table directly rather than through an
 * alias (`OLD_COUNTRY.COUNTRY_CD`) is the same table reference written a
 * second time, so it is renamed the same way (ColumnConverter's
 * bindings say which qualifiers those are).
 *
 * Runs after ColumnConverter but works purely from the resolver's
 * original names, so it can't change what any column resolved to.
 */
export class TableConverter {
  /**
   * @param {import('./TableResolver.js').SqlResolution} resolution
   * @param {import('./MigrationMapping.js').MigrationMapping} mapping
   * @param {{ columnRef: object, table: object, by: string }[]} bindings from ColumnConverter
   * @returns {{ edits: Map<number,string>, events: SchemaMigrationEvent[] }}
   */
  convert(resolution, mapping, bindings = []) {
    const edits = new Map();
    const events = [];
    const { tokens } = resolution;

    const renameReference = (nameIndex, schemaIndexes, table, targetTable) => {
      const target = splitQualifiedName(targetTable);
      const nameToken = tokens[nameIndex];
      if (target.schema && schemaIndexes.length) {
        // replace the innermost schema qualifier, keep any catalog in front of it
        const schemaIndex = schemaIndexes[schemaIndexes.length - 1];
        edits.set(schemaIndex, renderIdentifier(tokens[schemaIndex], target.schema));
        edits.set(nameIndex, renderIdentifier(nameToken, target.name));
      } else {
        edits.set(nameIndex, renderIdentifier(nameToken, target.schema ? targetTable : target.name));
      }
    };

    for (const table of resolution.tableRefs) {
      if (table.kind !== TableRefKind.TABLE) continue;
      const targetTable = mapping.table(table.name, table.schema)?.targetTable;
      if (!targetTable || targetTable.toUpperCase() === table.name.toUpperCase()) continue;
      renameReference(table.nameToken, table.schemaTokens, table, targetTable);
      events.push(new SchemaMigrationEvent({
        grade: SchemaMigrationGrade.SAFE,
        code: SchemaMigrationCode.TABLE_RENAMED,
        message: `${table.schema ? `${table.schema}.` : ''}${table.name} -> ${targetTable}${table.alias ? ` (alias ${table.alias} kept)` : ''}`,
        original: tokens[table.nameToken].text,
        replacement: edits.get(table.nameToken),
        tokenIndex: table.nameToken,
        table: table.schema ? `${table.schema}.${table.name}` : table.name,
      }));
    }

    for (const { columnRef, table, by } of bindings) {
      if (by !== 'name' || table.kind !== TableRefKind.TABLE) continue;
      const targetTable = mapping.table(table.name, table.schema)?.targetTable;
      if (!targetTable || targetTable.toUpperCase() === table.name.toUpperCase()) continue;
      const qualifier = columnRef.qualifierTokens;
      renameReference(qualifier[qualifier.length - 1], qualifier.slice(0, -1), table, targetTable);
    }

    events.push(...this.#hintWarnings(tokens, mapping));
    return { edits, events };
  }

  /** `/*+ INDEX(OLD_COUNTRY IDX_X) *\/` is a comment, so it is never rewritten — but it should be looked at. */
  #hintWarnings(tokens, mapping) {
    const events = [];
    for (const [index, token] of tokens.entries()) {
      if (token.kind !== TokenKind.COMMENT || !token.text.startsWith('/*+')) continue;
      const named = tokenize(token.text.slice(3, -2))
        .filter((t) => t.kind === TokenKind.WORD && mapping.table(t.value)?.targetTable);
      if (!named.length) continue;
      events.push(new SchemaMigrationEvent({
        grade: SchemaMigrationGrade.WARNING,
        code: SchemaMigrationCode.HINT_NOT_MIGRATED,
        message: `optimizer hint ${token.text} names ${named.map((t) => t.value).join(', ')}; hints are comments and are not rewritten`,
        original: token.text,
        tokenIndex: index,
      }));
    }
    return events;
  }
}
