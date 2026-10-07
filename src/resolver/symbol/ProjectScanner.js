import { SymbolType } from '../../ast/ibatis/enums.js';
import { Symbol } from './Symbol.js';
import { SymbolTable } from './SymbolTable.js';
import { DiagnosticBag } from '../../parser/xml/ParserDiagnostics.js';

function qualify(namespace, localId) {
  return namespace ? `${namespace}.${localId}` : localId;
}

/**
 * Pass 1 of the 2-pass resolution strategy: scan every already-parsed
 * mapper (`{ sqlMap, sourceFile }`) and register its statements, sql
 * fragments, resultMaps, parameterMaps and cacheModels into one project-wide
 * SymbolTable *before* any `<include refid>` / `extends` reference is
 * followed. This guarantees cross-mapper references resolve correctly
 * regardless of file processing order.
 *
 * @param {{ sqlMap: import('../../ast/ibatis/nodes.js').SqlMapNode|null }[]} parsedMappers
 * @param {DiagnosticBag} [diagnostics]
 * @returns {{ symbolTable: SymbolTable, diagnostics: DiagnosticBag }}
 */
export function buildSymbolTable(parsedMappers, diagnostics = new DiagnosticBag()) {
  const table = new SymbolTable();

  for (const { sqlMap } of parsedMappers) {
    if (!sqlMap) continue;
    const namespace = sqlMap.namespace;

    for (const stmt of sqlMap.statements) {
      table.register(new Symbol({
        qualifiedId: qualify(namespace, stmt.id),
        localId: stmt.id,
        type: SymbolType.STATEMENT,
        mapper: namespace,
        sourceFile: stmt.sourceFile,
        sourceLine: stmt.sourceLine,
        node: stmt,
      }));
    }
    for (const frag of sqlMap.sqlFragments) {
      table.register(new Symbol({
        qualifiedId: qualify(namespace, frag.id),
        localId: frag.id,
        type: SymbolType.SQL_FRAGMENT,
        mapper: namespace,
        sourceFile: frag.sourceFile,
        sourceLine: frag.sourceLine,
        node: frag,
      }));
    }
    for (const rm of sqlMap.resultMaps) {
      table.register(new Symbol({
        qualifiedId: qualify(namespace, rm.id),
        localId: rm.id,
        type: SymbolType.RESULT_MAP,
        mapper: namespace,
        sourceFile: rm.sourceFile,
        sourceLine: rm.sourceLine,
        node: rm,
      }));
    }
    for (const pm of sqlMap.parameterMaps) {
      table.register(new Symbol({
        qualifiedId: qualify(namespace, pm.id),
        localId: pm.id,
        type: SymbolType.PARAMETER_MAP,
        mapper: namespace,
        sourceFile: pm.sourceFile,
        sourceLine: pm.sourceLine,
        node: pm,
      }));
    }
    for (const cm of sqlMap.cacheModels) {
      table.register(new Symbol({
        qualifiedId: qualify(namespace, cm.id),
        localId: cm.id,
        type: SymbolType.CACHE_MODEL,
        mapper: namespace,
        sourceFile: cm.sourceFile,
        sourceLine: cm.sourceLine,
        node: cm,
      }));
    }
  }

  for (const conflict of table.getConflicts()) {
    const locations = conflict.symbols.map((s) => `${s.sourceFile}:${s.sourceLine}`).join(', ');
    const first = conflict.symbols[0];
    diagnostics.warn(
      `Duplicate symbol "${conflict.qualifiedId}" registered ${conflict.symbols.length} times (${locations}); the first registration (${first.sourceFile}:${first.sourceLine}) wins for resolution`,
      first.sourceFile,
      first.sourceLine,
      'DUPLICATE_SYMBOL',
    );
  }

  return { symbolTable: table, diagnostics };
}
