/**
 * One registered entry in the global SymbolTable: a statement, sql
 * fragment, resultMap, parameterMap or cacheModel, addressable by its
 * namespace-qualified id.
 */
export class Symbol {
  constructor({ qualifiedId, localId, type, mapper, sourceFile, sourceLine, node }) {
    this.qualifiedId = qualifiedId;
    this.localId = localId;
    this.type = type;
    /** Owning mapper's namespace. */
    this.mapper = mapper;
    this.sourceFile = sourceFile;
    this.sourceLine = sourceLine;
    /** The AST node this symbol points at (ast/ibatis). */
    this.node = node;
  }
}
