/**
 * Directed graph of qualifiedId -> qualifiedId edges discovered while
 * resolving `<include refid>` and `resultMap extends` references. Reused
 * later by `analyzer/dependency` to answer "what breaks if I change this
 * sql fragment / resultMap?" (spec sections 21-22).
 */
export class DependencyGraph {
  constructor() {
    /** @type {Map<string, {to: string, kind: string}[]>} */
    this._edges = new Map();
  }

  addEdge(from, to, kind = 'INCLUDE') {
    if (!this._edges.has(from)) this._edges.set(from, []);
    this._edges.get(from).push({ to, kind });
  }

  /** Outgoing edges: things `id` depends on. */
  getDependencies(id) {
    return this._edges.get(id) ?? [];
  }

  /** Incoming edges: things that depend on `id`. */
  getDependents(id) {
    const result = [];
    for (const [from, edges] of this._edges.entries()) {
      for (const e of edges) {
        if (e.to === id) result.push({ from, kind: e.kind });
      }
    }
    return result;
  }

  allNodes() {
    const nodes = new Set();
    for (const [from, edges] of this._edges.entries()) {
      nodes.add(from);
      for (const e of edges) nodes.add(e.to);
    }
    return [...nodes];
  }

  toJSON() {
    const obj = {};
    for (const [from, edges] of this._edges.entries()) obj[from] = edges;
    return obj;
  }
}
