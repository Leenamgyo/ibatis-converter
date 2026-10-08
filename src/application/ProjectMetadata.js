import { buildSymbolTable } from '../resolver/symbol/ProjectScanner.js';
import { ReferenceResolver } from '../resolver/reference/ReferenceResolver.js';
import { ReferenceIndex } from '../resolver/reference/ReferenceIndex.js';
import { DiagnosticBag } from '../parser/xml/ParserDiagnostics.js';
import { SymbolType } from '../ast/ibatis/enums.js';

const qualify = (namespace, id) => (namespace ? `${namespace}.${id}` : id);

/**
 * Everything a project knows about its mappers WITHOUT their SQL — built once,
 * when the project is opened, and the only place any component asks "where is
 * X / what does this refid point at / who includes this":
 *
 *   registry   files (path, namespace, kind, parsed, external) and every
 *              statement / <sql> / resultMap / parameterMap of every file,
 *              keyed `namespace.id` (a namespace may span many files)
 *   lookup     ReferenceIndex — THE refid rule (qualified / namespace /
 *              project-unique / statement-namespace-first)
 *   graph      the include / extends / resultMap / parameterMap edges, found
 *              by resolving every statement once, over include-only stubs,
 *              with the same ReferenceResolver the analysis uses — plus the
 *              reference diagnostics, cycles and unresolved includes
 *   queries    includeTree, includedFragments, includerStatements,
 *              includeSites, resultMap chains, namespaces…
 *
 * Stubs are the nodes of this graph: a statement / <sql> stub holds just its
 * `<include>`s in document order, a resultMap stub its `extends`. ProjectSession
 * analyses the real ASTs with a resolver over the SAME symbol table and index,
 * loading nodes from files instead of stubs — so the graph here and the
 * analysis there cannot disagree.
 */
export class ProjectMetadata {
  /**
   * @param {{ files: object[], stubMappers: { sourceFile: string, sqlMap: object }[], diagnostics: DiagnosticBag }} input
   *   files: the session's file entries (sourceFile, namespace, syntax, parsed, external,
   *   statements[], fragments[], resultMaps[], unparsedStatements?)
   */
  constructor({ files, stubMappers, diagnostics }) {
    this.files = files;
    this.diagnostics = diagnostics;
    this.fileEntries = new Map(files.map((f) => [f.sourceFile, f]));
    this.fileByQualifiedId = new Map();
    for (const f of files) {
      for (const s of f.statements) this.fileByQualifiedId.set(s.qualifiedId, f.sourceFile);
      for (const s of f.fragments) this.fileByQualifiedId.set(s.qualifiedId, f.sourceFile);
    }
    this.statementIds = new Set(files.flatMap((f) => f.statements.map((s) => s.qualifiedId)));

    // registry + lookup
    this.symbolTable = buildSymbolTable(stubMappers, diagnostics).symbolTable;
    // MyBatis mappers: a bare refid into another file is found, and flagged (MYBATIS_BARE_REFID)
    this.mybatisNamespaces = new Set(files.filter((f) => f.syntax === 'mybatis' && f.namespace !== null).map((f) => f.namespace));
    this.index = new ReferenceIndex(this.symbolTable, { mybatisNamespaces: this.mybatisNamespaces });

    // graph: every statement resolved once over the stubs (no file is read)
    const graph = new ReferenceResolver(this.symbolTable, diagnostics, { index: this.index });
    for (const { sqlMap } of stubMappers) {
      for (const st of sqlMap.statements) {
        const qid = qualify(sqlMap.namespace, st.id);
        graph.resolve(st, sqlMap.namespace, qid);
        graph.linkStatementDependencies(st, sqlMap.namespace, qid);
      }
      for (const rm of sqlMap.resultMaps) graph.resolveResultMapExtends(rm, sqlMap.namespace);
    }
    this.graph = graph;
    this.dependencyGraph = graph.dependencyGraph;
    this.circularReferences = graph.circularReferences;
    this.missingIncludes = graph.missingIncludes;
    // include edges, deduplicated, both directions (the resolver records a fragment's edges once per inclusion)
    this.includes = new Map();
    this.includedBy = new Map();
    const link = (map, a, b) => (map.get(a) ?? map.set(a, new Set()).get(a)).add(b);
    for (const [from, edges] of graph.dependencyGraph._edges) {
      for (const { to, kind } of edges) {
        if (kind !== 'INCLUDE') continue;
        link(this.includes, from, to);
        link(this.includedBy, to, from);
      }
    }
  }

  // ---------------------------------------------------------------- registry

  file(sourceFile) {
    return this.fileEntries.get(sourceFile);
  }

  fileOf(qualifiedId) {
    return this.fileByQualifiedId.get(qualifiedId);
  }

  /** { sourceFile, namespace, localId } of a statement / <sql>, or null */
  locate(qualifiedId) {
    const sourceFile = this.fileByQualifiedId.get(qualifiedId);
    if (!sourceFile) return null;
    const namespace = this.fileEntries.get(sourceFile).namespace;
    const localId = namespace ? qualifiedId.slice(namespace.length + 1) : qualifiedId;
    return { sourceFile, namespace, localId };
  }

  hasStatement(qualifiedId) {
    return this.statementIds.has(qualifiedId);
  }

  /** the index entry of a statement ({ id, type, line, parameterClass, resultClass, resultMap }) */
  statementMeta(qualifiedId) {
    return this.file(this.fileOf(qualifiedId))?.statements.find((s) => s.qualifiedId === qualifiedId) ?? null;
  }

  /** namespace -> the files (in any folder) that declare it, and what each declares */
  namespaces() {
    const byNamespace = new Map();
    for (const f of this.files) {
      const ns = f.namespace ?? '';
      if (!byNamespace.has(ns)) byNamespace.set(ns, []);
      byNamespace.get(ns).push({
        sourceFile: f.sourceFile,
        parsed: f.parsed,
        external: f.external,
        statements: f.statements.length + (f.unparsedStatements?.length ?? 0),
        fragments: f.fragments.map((x) => x.id),
      });
    }
    return [...byNamespace].map(([namespace, files]) => ({ namespace, files })).sort((a, b) => b.files.length - a.files.length || a.namespace.localeCompare(b.namespace));
  }

  // ---------------------------------------------------------------- lookup

  /** where an `<include refid>` points (ReferenceIndex#includeTarget) */
  includeTarget(refid, writtenIn, rootNamespace = writtenIn, fromFile = null) {
    return this.index.includeTarget(refid, writtenIn, rootNamespace, fromFile);
  }

  /** the converter's question: what a reference resolves to and whether to write it qualified */
  qualifiedIdOf(refid, namespace, type, options) {
    return this.graph.qualifiedIdOf(refid, namespace, type, options);
  }

  // ---------------------------------------------------------------- graph queries

  /** qualified ids of the fragments a statement / fragment includes, transitively */
  includedFragments(qualifiedId) {
    const seen = new Set();
    const walk = (id) => {
      for (const to of this.includes.get(id) ?? []) {
        if (seen.has(to)) continue;
        seen.add(to);
        walk(to);
      }
    };
    walk(qualifiedId);
    return [...seen];
  }

  /** files whose statements / fragments include `fragmentQualifiedId`, directly or not */
  includerFiles(fragmentQualifiedId) {
    const files = new Set();
    const walk = (id, seen) => {
      for (const from of this.includedBy.get(id) ?? []) {
        if (seen.has(from)) continue;
        seen.add(from);
        const file = this.fileByQualifiedId.get(from);
        if (file) files.add(file);
        walk(from, seen);
      }
    };
    walk(fragmentQualifiedId, new Set());
    return [...files];
  }

  /** statements that include `fragmentQualifiedId`, directly or through other fragments */
  includerStatements(fragmentQualifiedId) {
    const out = new Set();
    const walk = (id, seen) => {
      for (const from of this.includedBy.get(id) ?? []) {
        if (seen.has(from)) continue;
        seen.add(from);
        if (this.statementIds.has(from)) out.add(from);
        else walk(from, seen);
      }
    };
    walk(fragmentQualifiedId, new Set());
    return [...out];
  }

  /** every `<include refid>` written to point at `fragmentQualifiedId`: { statement (owner), file, line, refid } */
  includeSites(fragmentQualifiedId) {
    const sites = [];
    for (const owner of this.includedBy.get(fragmentQualifiedId) ?? []) {
      const loc = this.locate(owner);
      const stub = loc && this.symbolTable.get(owner)?.node;
      for (const inc of stub?.children ?? []) {
        if (inc.type !== 'Include') continue;
        if (this.includeTarget(inc.refid, loc.namespace, loc.namespace, inc.sourceFile ?? loc.sourceFile).symbol?.qualifiedId !== fragmentQualifiedId) continue;
        sites.push({ statement: owner, file: loc.sourceFile, line: inc.sourceLine, refid: inc.refid });
      }
    }
    return sites;
  }

  /**
   * The `<include>`s of a statement or fragment as a tree, every depth, in document
   * order, each with the rule that found it: `[{ refid, qualifiedId, rule, unparsed?, file?,
   * children }]` or `{ refid, unresolved: 'MISSING' | 'CIRCULAR', rule }`. Resolved over the
   * stubs with the analysis's own resolver and index — no file is read.
   */
  includeTree(qualifiedId) {
    const at = this.locate(qualifiedId);
    const stub = at && this.symbolTable.get(qualifiedId)?.node;
    if (!stub) return [];
    const { resolvedTree } = new ReferenceResolver(this.symbolTable, new DiagnosticBag(), { index: this.index }).resolve(stub, at.namespace, qualifiedId);
    const walk = (children, writtenIn, out = []) => {
      for (const child of children ?? []) {
        if (child.type === 'ResolvedInclude') {
          const own = this.locate(child.qualifiedId)?.namespace ?? writtenIn;
          const file = this.fileByQualifiedId.get(child.qualifiedId);
          const unparsed = this.fileEntries.get(file)?.parsed === false;
          out.push({ refid: child.refid, qualifiedId: child.qualifiedId, rule: this.includeTarget(child.refid, writtenIn, at.namespace, child.sourceFile ?? null).rule, ...(unparsed ? { unparsed: true, file } : {}), children: walk(child.children, own) });
        } else if (child.type === 'UnresolvedInclude') {
          out.push({ refid: child.refid, unresolved: child.reason, rule: child.reason === 'MISSING' ? 'MISSING' : 'CIRCULAR' });
        } else walk(child.children, writtenIn, out);
      }
      return out;
    };
    return walk(resolvedTree.children, at.namespace);
  }

  /** fragment -> how many statements include it (directly or not) */
  includeUsage() {
    const usage = {};
    for (const id of this.statementIds) for (const fid of this.includedFragments(id)) usage[fid] = (usage[fid] ?? 0) + 1;
    return usage;
  }

  /** a resultMap and the ones it extends, as symbols: [{ qualifiedId, sourceFile, symbol }] */
  resultMapChain(name, namespace) {
    const out = [];
    const seen = new Set();
    let current = name;
    let ns = namespace;
    while (current) {
      const { symbol } = this.index.lookup(current, ns, SymbolType.RESULT_MAP);
      if (!symbol || seen.has(symbol.qualifiedId)) break;
      seen.add(symbol.qualifiedId);
      out.push({ qualifiedId: symbol.qualifiedId, sourceFile: symbol.sourceFile, symbol });
      current = symbol.node?.extends; // the stub keeps `extends`
      ns = symbol.mapper;
    }
    return out;
  }

  /** statements whose resultMap="…" resolves to `resultMapQualifiedId` */
  statementsUsingResultMap(resultMapQualifiedId) {
    const out = [];
    for (const f of this.files) {
      for (const s of f.statements) {
        if (s.resultMap && this.index.lookup(s.resultMap, f.namespace, SymbolType.RESULT_MAP).symbol?.qualifiedId === resultMapQualifiedId) out.push(s.qualifiedId);
      }
    }
    return out;
  }
}
