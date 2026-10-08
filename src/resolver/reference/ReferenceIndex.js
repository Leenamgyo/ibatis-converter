import { SymbolType } from '../../ast/ibatis/enums.js';

/**
 * THE reference lookup of the project — the only place that decides what a
 * refid / resultMap / parameterMap name points at. Everything that needs an
 * answer (the resolver walking trees, the converter qualifying refids, the
 * schema migration, the project metadata's include graph, the UI's include
 * tree) asks this, so a reference cannot resolve one way here and another
 * way there. Pure: no diagnostics, no state beyond its indexes.
 *
 * Built over a SymbolTable (the registry of every statement / <sql> /
 * resultMap / parameterMap / cacheModel, keyed `namespace.id`).
 */
export class ReferenceIndex {
  /**
   * @param {import('../symbol/SymbolTable.js').SymbolTable} symbolTable
   * @param {{ strictNamespaces?: Set<string>, mybatisNamespaces?: Set<string> }} [options]
   *   strictNamespaces: no project-wide bare-id fallback for these namespaces.
   *   mybatisNamespaces: MyBatis 3 mappers (a bare refid into another file is found, and flagged).
   */
  constructor(symbolTable, { strictNamespaces = new Set(), mybatisNamespaces = new Set() } = {}) {
    this.symbolTable = symbolTable;
    this.strictNamespaces = strictNamespaces;
    this.mybatisNamespaces = mybatisNamespaces;
    this.byLocalId = new Map(); // type -> local id -> symbols
  }

  has(qualifiedId) {
    return this.symbolTable.has(qualifiedId);
  }

  get(qualifiedId) {
    return this.symbolTable.get(qualifiedId);
  }

  /** local id -> symbols of `type`, for bare cross-mapper references */
  #byLocalId(type) {
    if (!this.byLocalId.has(type)) {
      const index = new Map();
      for (const symbol of this.symbolTable.getAllByType(type)) {
        if (!index.has(symbol.localId)) index.set(symbol.localId, []);
        index.get(symbol.localId).push(symbol);
      }
      this.byLocalId.set(type, index);
    }
    return this.byLocalId.get(type);
  }

  /**
   * iBATIS reference lookup, in the order iBATIS itself applies:
   *   1. `refid` as a fully qualified id (`ns.id`)
   *   2. `namespace.refid`
   *   3. a bare `refid` defined in ANOTHER mapper (useStatementNamespaces=false, the
   *      iBATIS default: every id is global), matched by local id among symbols of
   *      `type`. Two candidates is ambiguous: returned as such, never guessed.
   * Steps 1-2 match any type, so an existing qualified id always wins.
   * @returns {{ symbol: object|undefined, candidates: object[] }} candidates: the ambiguous ones
   */
  lookup(refid, namespace, type = null) {
    if (this.symbolTable.has(refid)) return { symbol: this.symbolTable.get(refid), candidates: [] };
    if (namespace) {
      const qualified = `${namespace}.${refid}`;
      if (this.symbolTable.has(qualified)) return { symbol: this.symbolTable.get(qualified), candidates: [] };
    }
    if (!type || refid.includes('.') || this.strictNamespaces.has(namespace)) return { symbol: undefined, candidates: [] };
    const candidates = this.#byLocalId(type).get(refid) ?? [];
    return candidates.length === 1 ? { symbol: candidates[0], candidates: [] } : { symbol: undefined, candidates: candidates.length > 1 ? candidates : [] };
  }

  /**
   * Where an `<include refid>` points.
   * @param refid as written
   * @param writtenIn the namespace of the mapper the `<include>` is written in
   * @param rootNamespace the namespace of the statement being resolved (iBATIS and
   *   MyBatis resolve every include of a statement — nested ones too — against it)
   * @returns {{ symbol: object|undefined, rule: string, written: object|undefined, runtime: object|undefined, ambiguous: object[] }}
   *   rule: QUALIFIED | NAMESPACE | GLOBAL_UNIQUE | RUNTIME_SHADOWED | AUTHOR_NAMESPACE | MISSING
   */
  includeTarget(refid, writtenIn, rootNamespace = writtenIn) {
    const how = (ns, symbol) => {
      if (!symbol) return 'MISSING';
      if (symbol.qualifiedId === refid) return 'QUALIFIED';
      if (ns && symbol.qualifiedId === `${ns}.${refid}`) return 'NAMESPACE';
      return 'GLOBAL_UNIQUE';
    };
    const { symbol: written, candidates } = this.lookup(refid, writtenIn, SymbolType.SQL_FRAGMENT);
    const ambiguous = written ? [] : candidates;
    if (rootNamespace === undefined || rootNamespace === writtenIn || refid.includes('.')) {
      return { symbol: written, rule: how(writtenIn, written), written, runtime: undefined, ambiguous };
    }
    // a bare refid inside a fragment of mapper `writtenIn`, included from a statement of `rootNamespace`:
    // the runtime looks it up in `rootNamespace`, the fragment's author meant `writtenIn`
    const { symbol: runtime } = this.lookup(refid, rootNamespace, SymbolType.SQL_FRAGMENT);
    if (runtime && written && runtime.qualifiedId !== written.qualifiedId) return { symbol: runtime, rule: 'RUNTIME_SHADOWED', written, runtime, ambiguous };
    if (!runtime && written) return { symbol: written, rule: written.qualifiedId === `${writtenIn}.${refid}` ? 'AUTHOR_NAMESPACE' : how(writtenIn, written), written, runtime, ambiguous };
    if (runtime && !written) return { symbol: runtime, rule: how(rootNamespace, runtime), written, runtime, ambiguous: [] };
    return { symbol: written, rule: how(writtenIn, written), written, runtime, ambiguous };
  }

  /** "X is ambiguous: a, b — qualify it" for a lookup that found several candidates */
  static ambiguousMessage(kind, refid, candidates) {
    return candidates.length > 1
      ? `${kind} "${refid}" is ambiguous: ${candidates.map((s) => s.qualifiedId).join(', ')} — qualify it with the namespace`
      : null;
  }

  /** " — did you mean …?" when only letter case differs (iBATIS / MyBatis ids are case-sensitive) */
  nearMiss(refid, namespace) {
    const wanted = [refid, namespace ? `${namespace}.${refid}` : null].filter(Boolean).map((s) => s.toLowerCase());
    const hits = this.symbolTable.getAllByType(SymbolType.SQL_FRAGMENT).map((s) => s.qualifiedId)
      .filter((q) => wanted.includes(q.toLowerCase()) || (!refid.includes('.') && q.toLowerCase().endsWith(`.${refid.toLowerCase()}`)));
    return hits.length ? ` — did you mean ${hits.slice(0, 3).map((h) => `"${h}"`).join(', ')}? (ids are case-sensitive)` : '';
  }
}
