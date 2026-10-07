/** Reported when the same qualifiedId was registered more than once. */
export class SymbolConflict {
  constructor(qualifiedId, symbols) {
    this.qualifiedId = qualifiedId;
    this.symbols = symbols;
  }
}

/**
 * Global, project-wide index of every statement/sql fragment/resultMap/
 * parameterMap/cacheModel, keyed by namespace-qualified id.
 *
 * Populated once (pass 1, see `ProjectScanner.buildSymbolTable`) before any
 * reference resolution happens (pass 2, `resolver/reference`).
 */
export class SymbolTable {
  constructor() {
    /** @type {Map<string, import('./Symbol.js').Symbol[]>} */
    this._byQualifiedId = new Map();
    /** @type {Map<string, Set<string>>} */
    this._byType = new Map();
  }

  register(symbol) {
    const existing = this._byQualifiedId.get(symbol.qualifiedId);
    if (existing) {
      existing.push(symbol);
    } else {
      this._byQualifiedId.set(symbol.qualifiedId, [symbol]);
    }
    if (!this._byType.has(symbol.type)) this._byType.set(symbol.type, new Set());
    this._byType.get(symbol.type).add(symbol.qualifiedId);
  }

  has(qualifiedId) {
    return this._byQualifiedId.has(qualifiedId);
  }

  /** The first-registered (primary) symbol for a qualifiedId, or undefined. */
  get(qualifiedId) {
    const list = this._byQualifiedId.get(qualifiedId);
    return list ? list[0] : undefined;
  }

  /** Every registration for a qualifiedId, including later duplicates. */
  getAll(qualifiedId) {
    return this._byQualifiedId.get(qualifiedId) ?? [];
  }

  getAllByType(type) {
    const ids = this._byType.get(type);
    if (!ids) return [];
    return [...ids].map((id) => this.get(id));
  }

  /** @returns {SymbolConflict[]} qualifiedIds registered more than once. */
  getConflicts() {
    const conflicts = [];
    for (const [qualifiedId, list] of this._byQualifiedId.entries()) {
      if (list.length > 1) conflicts.push(new SymbolConflict(qualifiedId, list));
    }
    return conflicts;
  }
}
