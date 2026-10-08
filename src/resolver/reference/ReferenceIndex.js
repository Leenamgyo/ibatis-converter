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
   *   3. the id as written, defined in ANOTHER mapper (useStatementNamespaces=false, the
   *      iBATIS default: every id is global AS WRITTEN — so a dotted `<sql id="common.paging">`
   *      inside namespace "common" is `common.paging` too), among symbols of `type`.
   *   4. several mappers define that id (a common fragment copy-pasted into each module):
   *      the same SQL everywhere -> any of them is it (DUPLICATE_SAME); different SQL -> the
   *      one nearest the referencing file's folder (NEAREST_DUPLICATE), the others reported.
   *      Only when even the nearest is a tie is it left ambiguous.
   * Steps 1-2 match any type, so an existing qualified id always wins.
   * @param {{ fromFile?: string|null }} [where] the file the reference is written in (for step 4)
   * @returns {{ symbol: object|undefined, candidates: object[], rule?: string, alternatives?: object[] }}
   *   candidates: the ambiguous ones when unresolved; alternatives: the other copies when step 4 chose
   */
  lookup(refid, namespace, type = null, { fromFile = null } = {}) {
    if (this.symbolTable.has(refid)) return { symbol: this.symbolTable.get(refid), candidates: [] };
    if (namespace) {
      const qualified = `${namespace}.${refid}`;
      if (this.symbolTable.has(qualified)) return { symbol: this.symbolTable.get(qualified), candidates: [] };
    }
    if (!type || this.strictNamespaces.has(namespace)) return { symbol: undefined, candidates: [] };
    const candidates = this.#byLocalId(type).get(refid) ?? [];
    if (candidates.length === 1) return { symbol: candidates[0], candidates: [] };
    if (candidates.length < 2) return { symbol: undefined, candidates: [] };
    return this.#chooseDuplicate(candidates, fromFile);
  }

  /** several symbols of one id: identical copies, or the nearest one; a tie stays ambiguous */
  #chooseDuplicate(candidates, fromFile) {
    const sorted = [...candidates].sort((a, b) => a.qualifiedId.localeCompare(b.qualifiedId));
    const signatures = sorted.map((s) => contentSignature(s.node));
    if (signatures[0] !== null && signatures.every((sig) => sig === signatures[0])) {
      return { symbol: sorted[0], candidates: [], rule: 'DUPLICATE_SAME', alternatives: sorted.slice(1) };
    }
    if (!fromFile) return { symbol: undefined, candidates: sorted };
    const nearness = (s) => sharedFolders(fromFile, s.sourceFile);
    const best = Math.max(...sorted.map(nearness));
    const nearest = sorted.filter((s) => nearness(s) === best);
    if (nearest.length !== 1) return { symbol: undefined, candidates: sorted };
    return { symbol: nearest[0], candidates: [], rule: 'NEAREST_DUPLICATE', alternatives: sorted.filter((s) => s !== nearest[0]) };
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
  includeTarget(refid, writtenIn, rootNamespace = writtenIn, fromFile = null) {
    const writtenLookup = this.lookup(refid, writtenIn, SymbolType.SQL_FRAGMENT, { fromFile });
    const how = (ns, symbol, found = writtenLookup) => {
      if (!symbol) return 'MISSING';
      if (symbol.qualifiedId === refid) return 'QUALIFIED';
      if (ns && symbol.qualifiedId === `${ns}.${refid}`) return 'NAMESPACE';
      return found.rule ?? 'GLOBAL_UNIQUE';
    };
    const { symbol: written, candidates, alternatives = [] } = writtenLookup;
    const ambiguous = written ? [] : candidates;
    if (rootNamespace === undefined || rootNamespace === writtenIn || refid.includes('.')) {
      return { symbol: written, rule: how(writtenIn, written), written, runtime: undefined, ambiguous, alternatives };
    }
    // a bare refid inside a fragment of mapper `writtenIn`, included from a statement of `rootNamespace`:
    // the runtime looks it up in `rootNamespace`, the fragment's author meant `writtenIn`
    const runtimeLookup = this.lookup(refid, rootNamespace, SymbolType.SQL_FRAGMENT, { fromFile });
    const { symbol: runtime } = runtimeLookup;
    if (runtime && written && runtime.qualifiedId !== written.qualifiedId) return { symbol: runtime, rule: 'RUNTIME_SHADOWED', written, runtime, ambiguous, alternatives: runtimeLookup.alternatives ?? [] };
    if (!runtime && written) return { symbol: written, rule: written.qualifiedId === `${writtenIn}.${refid}` ? 'AUTHOR_NAMESPACE' : how(writtenIn, written), written, runtime, ambiguous, alternatives };
    if (runtime && !written) return { symbol: runtime, rule: how(rootNamespace, runtime, runtimeLookup), written, runtime, ambiguous: [], alternatives: runtimeLookup.alternatives ?? [] };
    return { symbol: written, rule: how(writtenIn, written), written, runtime, ambiguous, alternatives };
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

/**
 * What a fragment says, for telling identical copies apart from different fragments of the
 * same id: a stub carries `signature` (computed from the real AST when the project was
 * opened); a real AST node is summarised here. Null when unknown (an unparsed file).
 */
export function contentSignature(node) {
  if (!node) return null;
  if (node.signature !== undefined) return node.signature;
  if (node.unparsed) return null;
  return fragmentSignature(node);
}

/** a fragment's SQL and structure, whitespace-normalised (text, tags with their attributes, include refids) */
export function fragmentSignature(node) {
  const parts = [];
  const walk = (children) => {
    for (const child of children ?? []) {
      if (child.type === 'TextSql') parts.push(child.text.replace(/\s+/g, ' ').trim());
      else if (child.type === 'Include') parts.push(`<include ${child.refid}>`);
      else {
        const { children: inner, sourceFile, sourceLine, ...attributes } = child;
        parts.push(`<${JSON.stringify(attributes)}>`);
        walk(inner);
        parts.push('</>');
      }
    }
  };
  walk(node.children);
  return parts.filter(Boolean).join('|');
}

/** how many leading folders two paths share (the nearer, the higher) */
function sharedFolders(a, b) {
  if (!a || !b) return 0;
  const x = a.split('/').slice(0, -1);
  const y = b.split('/').slice(0, -1);
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}
