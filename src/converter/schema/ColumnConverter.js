import { TableRefKind, ScopeKind } from './TableResolver.js';
import { TableMapping } from './MigrationMapping.js';
import { SchemaMigrationEvent, SchemaMigrationGrade, SchemaMigrationCode } from './SchemaMigrationEvent.js';
import { renderIdentifier } from './identifiers.js';

/**
 * Step 2 of schema migration: decide, for every column reference the
 * TableResolver found, which *original* table owns it, and rename it from
 * that table's own column map — never from a global column list, since
 * `TABLE_A.CODE` and `TABLE_B.CODE` may become different names.
 *
 *   - `q.COL`  -> `q` is resolved through the scope's alias -> table map
 *                (innermost scope first, so a correlated subquery sees the
 *                outer query's aliases);
 *   - `COL`    -> the nearest enclosing scope that has any tables decides:
 *                exactly one mapped table maps COL -> renamed; two mapped
 *                tables map it to different names -> left alone, MANUAL;
 *                an unmapped table shares the scope -> renamed but WARNING
 *                (it could be that table's column); the mapped tables there
 *                don't list COL -> it keeps its name. A scope with no tables
 *                at all (a `<sql>` fragment like `AND APP_ID = #{appId}`)
 *                defers outward, ending at the caller's contextTable scope.
 *
 * A derived table or CTE gets a *virtual* column map from its own SELECT
 * list: `(SELECT CD FROM OLD_CODE_DETAIL) t` renames its inner `CD` to
 * `CODE`, so its output column is now `CODE`, and `t.CD` outside must
 * follow. Unaliased items and `*` / `x.*` (which re-expose a mapped
 * table's columns) feed that map; aliased items keep their alias as the
 * output name, so they don't. A CTE declared with its own column list
 * (`WITH x (a, b) AS ...`) has fixed names and no virtual map.
 *
 * Column aliases, table aliases, keywords, functions and parameters never
 * reach this class — the resolver doesn't report them as column
 * references. An ORDER BY name that is one of the query's own output
 * aliases is that alias, not a column, and is skipped.
 *
 * Renaming an unaliased item of the statement's top-level SELECT changes
 * the result-set label MyBatis maps by (`<result column=...>`, or
 * auto-mapping to a property): that is reported as WARNING, or — with
 * `preserveResultColumnNames` — the old name is kept as an alias
 * (`c.COUNTRY_CODE AS COUNTRY_CD`).
 *
 * Returns edits keyed by token index (applied once, after TableConverter
 * has added its own) plus the bindings TableConverter needs to rename a
 * qualifier that names a table directly (`OLD_COUNTRY.COUNTRY_CD`).
 */
export class ColumnConverter {
  constructor({ preserveResultColumnNames = false } = {}) {
    this.preserveResultColumnNames = preserveResultColumnNames;
  }

  /**
   * @param {import('./TableResolver.js').SqlResolution} resolution
   * @param {import('./MigrationMapping.js').MigrationMapping} mapping
   * @returns {{ edits: Map<number,string>, events: SchemaMigrationEvent[], bindings: { columnRef: object, table: object, by: string }[] }}
   */
  convert(resolution, mapping) {
    const run = new ColumnRun(resolution, mapping);
    const edits = new Map();
    const events = [];
    const bindings = [];
    const { tokens } = resolution;
    // the statement's own SELECT (its first branch, if it's a UNION) is what labels the result set
    const resultQuery = resolution.scopes.find((s) => s.kind === ScopeKind.QUERY && s.parent === resolution.rootScope);

    for (const columnRef of resolution.columnRefs) {
      const decision = run.decide(columnRef);
      if (decision.binding) bindings.push({ columnRef, ...decision.binding });
      if (decision.event) events.push(decision.event);
      if (!decision.target) continue;

      const index = columnRef.columnToken;
      const token = tokens[index];
      const renamed = renderIdentifier(token, decision.target);
      const topLevelItem = columnRef.bareSelectItem && columnRef.scope === resultQuery && resultQuery.statement === 'SELECT';
      const keepLabel = topLevelItem && this.preserveResultColumnNames
        && token.value.toUpperCase() !== decision.target.toUpperCase();
      const replacement = keepLabel ? `${renamed} AS ${token.text}` : renamed;
      edits.set(index, replacement);

      const owner = decision.table.name ?? decision.table.alias;
      const through = decision.table.kind === TableRefKind.TABLE ? '' : ` through ${decision.table.kind === TableRefKind.CTE ? 'CTE' : 'subquery'} ${owner}`;
      events.push(new SchemaMigrationEvent({
        grade: decision.grade,
        code: decision.code,
        message: `${owner}.${token.value} -> ${decision.target}${through}${decision.why ? ` (${decision.why})` : ''}`,
        original: token.text,
        replacement,
        tokenIndex: index,
        table: owner,
        column: token.value,
      }));
      if (topLevelItem) {
        events.push(keepLabel
          ? new SchemaMigrationEvent({
            grade: SchemaMigrationGrade.SAFE,
            code: SchemaMigrationCode.RESULT_COLUMN_ALIASED,
            message: `result column label ${token.value} kept as an alias of ${decision.target}`,
            original: token.text,
            replacement,
            tokenIndex: index,
            table: owner,
            column: token.value,
          })
          : new SchemaMigrationEvent({
            grade: SchemaMigrationGrade.WARNING,
            code: SchemaMigrationCode.RESULT_COLUMN_RENAMED,
            message: `result column ${token.value} is now labelled ${decision.target}: update resultMap column="${token.value}" / the mapped property, or enable preserveResultColumnNames`,
            original: token.text,
            replacement,
            tokenIndex: index,
            table: owner,
            column: token.value,
          }));
      }
    }
    return { edits, events, bindings };
  }
}

/** Decisions for one resolution, memoized so derived tables can ask about their own SELECT items. */
class ColumnRun {
  constructor(resolution, mapping) {
    this.resolution = resolution;
    this.mapping = mapping;
    this.tokens = resolution.tokens;
    this.decisions = new Map();
    this.virtual = new Map();
  }

  /** @returns {TableMapping|null} the real mapping of a table, or the virtual one of a CTE / subquery */
  mappingFor(table) {
    if (table.kind === TableRefKind.TABLE) return this.mapping.table(table.name, table.schema);
    if (this.virtual.has(table)) return this.virtual.get(table);
    this.virtual.set(table, null); // cycle guard (recursive CTE)
    const virtual = this.#virtualMapping(table);
    this.virtual.set(table, virtual);
    return virtual;
  }

  #virtualMapping(table) {
    if (!table.body || table.hasColumnList) return null;
    const query = this.resolution.scopes.find((s) => s.kind === ScopeKind.QUERY && s.parent === table.body);
    if (!query) return null;
    const columns = new Map();
    for (const star of query.selectStars) {
      const sources = star === null ? query.tables : [query.lookupQualifier(star)?.table].filter(Boolean);
      for (const source of sources) {
        for (const [from, to] of this.mappingFor(source)?.columns ?? []) columns.set(from, to);
      }
    }
    for (const item of query.selectItems) {
      const { target } = this.decide(item);
      if (target) columns.set(this.tokens[item.columnToken].value.toUpperCase(), target);
    }
    return columns.size ? new TableMapping({ sourceTable: table.alias ?? table.name, columns }) : null;
  }

  /** Output column names of a subquery / CTE, or null when unknown (a real table, `*`, a column list). */
  #outputsOf(table) {
    if (table.kind === TableRefKind.TABLE || !table.body || table.hasColumnList) return null;
    const query = this.resolution.scopes.find((s) => s.kind === ScopeKind.QUERY && s.parent === table.body);
    if (!query || query.selectStars.length) return null;
    const names = new Set(query.outputAliases);
    for (const item of query.selectItems) {
      names.add(this.tokens[item.columnToken].value.toUpperCase());
      const renamed = this.decide(item).target;
      if (renamed) names.add(renamed.toUpperCase());
    }
    return names;
  }

  /**
   * @returns {{ target?: string, table?: object, grade?: string, code?: string, why?: string,
   *             binding?: { table: object, by: string }, event?: SchemaMigrationEvent }}
   */
  decide(columnRef) {
    if (this.decisions.has(columnRef)) return this.decisions.get(columnRef);
    this.decisions.set(columnRef, {}); // cycle guard
    const decision = columnRef.qualifierTokens.length ? this.#qualified(columnRef) : this.#unqualified(columnRef);
    this.decisions.set(columnRef, decision);
    return decision;
  }

  #qualified(columnRef) {
    const columnToken = this.tokens[columnRef.columnToken];
    const qualifier = columnRef.qualifierTokens.map((i) => this.tokens[i].value);
    const found = columnRef.scope.lookupQualifier(qualifier);
    if (!found) {
      if (columnToken.is('*') || !this.mapping.isKnownColumn(columnToken.value)) return {};
      const written = `${qualifier.join('.')}.${columnToken.value}`;
      return {
        event: new SchemaMigrationEvent({
          grade: SchemaMigrationGrade.WARNING,
          code: SchemaMigrationCode.UNRESOLVED_QUALIFIER,
          message: `"${written}": "${qualifier.join('.')}" is not a table or alias in scope, so the column was left as is`,
          original: written,
          tokenIndex: columnRef.columnToken,
          column: columnToken.value,
        }),
      };
    }
    const binding = { table: found.table, by: found.by };
    if (columnToken.is('*')) return { binding };
    const column = columnToken.value;

    // the same alias declared more than once in one scope — alternative <if> branches
    // (`FROM <if>A c</if><if>B c</if>`): every declaration has to agree on the new name
    const declarations = found.by === 'alias'
      ? found.table.scope.tables.filter((t) => t.alias?.toUpperCase() === found.table.alias.toUpperCase())
      : [found.table];
    if (declarations.length > 1) {
      const options = declarations.map((t) => ({ table: t, target: this.mappingFor(t)?.column(column) ?? column }));
      if (new Set(options.map((o) => o.target.toUpperCase())).size > 1) {
        return {
          binding,
          event: new SchemaMigrationEvent({
            grade: SchemaMigrationGrade.MANUAL,
            code: SchemaMigrationCode.COLUMN_AMBIGUOUS,
            message: `"${qualifier.join('.')}.${column}": alias ${found.table.alias} is declared for ${declarations.map((t) => t.label).join(' and ')}, which map ${column} differently (${options.map((o) => o.target).join(' / ')})`,
            original: `${qualifier.join('.')}.${column}`,
            tokenIndex: columnRef.columnToken,
            column,
          }),
        };
      }
    }

    const target = this.mappingFor(found.table)?.column(column);
    if (!target) return { binding };
    return { binding, target, table: found.table, grade: SchemaMigrationGrade.SAFE, code: SchemaMigrationCode.COLUMN_RENAMED };
  }

  #unqualified(columnRef) {
    const column = this.tokens[columnRef.columnToken].value;
    if (columnRef.clause === 'ORDER' && columnRef.scope.outputAliases.has(column.toUpperCase())) return {};

    for (const scope of columnRef.scope.chain()) {
      if (!scope.tables.length) continue;
      // an INSERT / MERGE ... INSERT column list names the target table's columns, never a USING source's
      const intoTargets = columnRef.clause === 'INTO' ? scope.tables.filter((t) => t.clause === 'INTO') : [];
      const tables = intoTargets.length ? intoTargets : scope.tables;
      const candidates = tables
        .map((table) => ({ table, target: this.mappingFor(table)?.column(column) ?? null }))
        .filter((c) => c.target);
      if (!candidates.length) return {}; // owned by a table here that doesn't remap it
      const targets = new Set(candidates.map((c) => c.target.toUpperCase()));
      if (targets.size > 1) {
        return {
          event: new SchemaMigrationEvent({
            grade: SchemaMigrationGrade.MANUAL,
            code: SchemaMigrationCode.COLUMN_AMBIGUOUS,
            message: `unqualified "${column}" could be ${candidates.map((c) => `${c.table.name ?? c.table.alias}.${column} -> ${c.target}`).join(' or ')}; qualify it with a table alias`,
            original: column,
            tokenIndex: columnRef.columnToken,
            column,
          }),
        };
      }
      const { table, target } = candidates[0];
      // an unmapped table could own this column too — unless it is a subquery / CTE whose
      // output columns are all named and this isn't one of them
      const opaque = tables.filter((t) => {
        if (this.mappingFor(t)) return false;
        const outputs = this.#outputsOf(t);
        return outputs === null || outputs.has(column.toUpperCase());
      });
      if (opaque.length) {
        return {
          target,
          table,
          grade: SchemaMigrationGrade.WARNING,
          code: SchemaMigrationCode.COLUMN_ASSUMED,
          why: `assumed: ${opaque.map((t) => t.label).join(', ')} in the same scope is not in the mapping`,
        };
      }
      return { target, table, grade: SchemaMigrationGrade.SAFE, code: SchemaMigrationCode.COLUMN_RENAMED };
    }
    // no scope had any table: nothing to decide against — say so rather than leave it silently
    if (!this.mapping.isKnownColumn(column)) return {};
    return {
      event: new SchemaMigrationEvent({
        grade: SchemaMigrationGrade.WARNING,
        code: SchemaMigrationCode.NO_TABLE_CONTEXT,
        message: `"${column}" is a legacy column name but no table is in scope (a <sql> fragment nothing includes, or no contextTable given); left as is — pass contextTable / fragmentContexts`,
        original: column,
        tokenIndex: columnRef.columnToken,
        column,
      }),
    };
  }
}
