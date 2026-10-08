import { UnresolvedIncludeNode, ResolvedIncludeNode } from '../../ast/ibatis/nodes.js';
import { DependencyGraph } from './DependencyGraph.js';
import { DiagnosticBag } from '../../parser/xml/ParserDiagnostics.js';
import { SymbolType } from '../../ast/ibatis/enums.js';

/** One detected `<include>` cycle, e.g. path = ['a', 'b', 'c', 'a']. */
export class CircularReferenceInfo {
  constructor(path) {
    this.path = path;
  }
}

function cloneShallowWithChildren(node, children) {
  // Preserves the concrete class (instanceof still works) and every
  // scalar field, but is a distinct object from `node` so the original
  // tree is never mutated by resolution.
  const clone = Object.create(Object.getPrototypeOf(node));
  Object.assign(clone, node);
  clone.children = children;
  return clone;
}

/**
 * Resolves `<include refid>` references into fully-flattened SQL trees,
 * and `resultMap extends` chains into parent pointers, against a
 * project-wide SymbolTable (pass 2 of the 2-pass strategy).
 *
 * Guarantees:
 *  - the original AST (as produced by the parser) is never mutated —
 *    `resolve()` returns a distinct `resolvedTree` built by cloning only
 *    the nodes on an include path;
 *  - missing refids and circular refid chains are reported as diagnostics
 *    instead of throwing, with the offending node replaced by an
 *    `UnresolvedIncludeNode` marker so downstream analysis can keep going;
 *  - every include (and extends) edge is recorded into a `DependencyGraph`.
 */
export class ReferenceResolver {
  /**
   * @param {object} symbolTable
   * @param {DiagnosticBag} [diagnostics]
   * @param {{ strictNamespaces?: Set<string>, mybatisNamespaces?: Set<string> }} [options]
   *   strictNamespaces: no project-wide bare-id fallback for these namespaces at all.
   *   mybatisNamespaces: MyBatis 3 mappers. A bare refid naming ANOTHER file's <sql> is still
   *   found (projects do rely on it, and the tool must show where it points), with a
   *   MYBATIS_BARE_REFID warning: MyBatis's own lookup prefixes the current namespace.
   */
  constructor(symbolTable, diagnostics = new DiagnosticBag(), { strictNamespaces = new Set(), mybatisNamespaces = new Set() } = {}) {
    this.symbolTable = symbolTable;
    this.diagnostics = diagnostics;
    this.strictNamespaces = strictNamespaces;
    this.mybatisNamespaces = mybatisNamespaces;
    this.dependencyGraph = new DependencyGraph();
    /** @type {CircularReferenceInfo[]} */
    this.circularReferences = [];
    /** fragment qualifiedId -> namespaces of the statements that (transitively) include it */
    this.includerNamespaces = new Map();
    /** `<include>`s that resolved nowhere: { refid, namespace (written in), root } — what to look for elsewhere */
    this.missingIncludes = [];
    this._warned = new Set();
  }

  _warnOnce(key, message, node, code) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    this.diagnostics.warn(message, node.sourceFile, node.sourceLine, code);
  }

  /**
   * iBATIS reference lookup, in the order iBATIS itself applies:
   *   1. `refid` as a fully qualified id (`ns.id`)
   *   2. `currentNamespace.refid`
   *   3. a bare `refid` defined in ANOTHER mapper. With useStatementNamespaces=false
   *      (the iBATIS default) every id is global, so `<include refid="commonWhere"/>`
   *      may name a fragment in any file. Matched by local id among symbols of the
   *      expected `type`. Two candidates is ambiguous: reported, not guessed.
   * Steps 1-2 match any type, so an existing qualified id always wins.
   */
  _resolveRefid(refid, currentNamespace, type = null) {
    if (this.symbolTable.has(refid)) return this.symbolTable.get(refid);
    if (currentNamespace) {
      const qualified = `${currentNamespace}.${refid}`;
      if (this.symbolTable.has(qualified)) return this.symbolTable.get(qualified);
    }
    if (!type || refid.includes('.')) return undefined;
    if (this.strictNamespaces.has(currentNamespace)) return undefined; // MyBatis: own namespace only
    const candidates = this._globalIndex(type).get(refid) ?? [];
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) this._ambiguous = { refid, candidates };
    return undefined;
  }

  /** local id -> symbols of `type`, for bare cross-mapper references */
  _globalIndex(type) {
    this._globalIndexes ??= new Map();
    if (!this._globalIndexes.has(type)) {
      const index = new Map();
      for (const symbol of this.symbolTable.getAllByType(type)) {
        if (!index.has(symbol.localId)) index.set(symbol.localId, []);
        index.get(symbol.localId).push(symbol);
      }
      this._globalIndexes.set(type, index);
    }
    return this._globalIndexes.get(type);
  }

  /**
   * The qualified id a reference resolves to, for the converter: MyBatis looks a
   * bare refid up in the CURRENT namespace only, so a bare reference into another
   * mapper has to be written qualified. Null when it doesn't resolve.
   * @param {'SQL_FRAGMENT'|'RESULT_MAP'|'PARAMETER_MAP'|'STATEMENT'} type
   */
  qualifiedIdOf(refid, currentNamespace, type, { fragmentQualifiedId = null } = {}) {
    const symbol = this._resolveRefid(refid, currentNamespace, SymbolType[type] ?? type);
    this._ambiguous = null;
    if (!symbol) return null;
    const target = { qualifiedId: symbol.qualifiedId, namespace: symbol.mapper, mustQualify: false };
    // Inside a <sql> fragment that statements of OTHER mappers include, a bare refid is
    // resolved against each includer's namespace at runtime. Write it qualified so it means
    // what the fragment's author meant — unless an includer has its own fragment of that
    // id (then the runtime picks that one, and keeping it bare keeps that behaviour).
    if (fragmentQualifiedId && !refid.includes('.')) {
      const includers = [...(this.includerNamespaces.get(fragmentQualifiedId) ?? [])].filter((ns) => ns !== currentNamespace);
      // shadowed: an includer has its OWN, different fragment of that id (the runtime would take it)
      const shadowing = includers.filter((ns) => this.symbolTable.has(`${ns}.${refid}`) && `${ns}.${refid}` !== symbol.qualifiedId);
      const unresolved = includers.filter((ns) => !this.symbolTable.has(`${ns}.${refid}`) && !this.symbolTable.has(refid)
        && (this._globalIndex(SymbolType.SQL_FRAGMENT).get(refid)?.length ?? 0) !== 1);
      if (includers.length && !shadowing.length) target.mustQualify = true;
      if (shadowing.length) {
        target.namespace = currentNamespace; // keep as written: those includers get their own fragment, as before
        // ...but where the runtime finds nothing, it fails: one fragment can't serve both
        if (unresolved.length) target.perIncluderConflict = { shadowing, unresolved };
      }
    }
    return target;
  }

  /** " — did you mean …?" when only letter case differs (iBATIS / MyBatis ids are case-sensitive) */
  _nearMiss(refid, namespace) {
    const wanted = [refid, namespace ? `${namespace}.${refid}` : null].filter(Boolean).map((s) => s.toLowerCase());
    const hits = this.symbolTable.getAllByType(SymbolType.SQL_FRAGMENT).map((s) => s.qualifiedId)
      .filter((q) => wanted.includes(q.toLowerCase()) || (!refid.includes('.') && q.toLowerCase().endsWith(`.${refid.toLowerCase()}`)));
    return hits.length ? ` — did you mean ${hits.slice(0, 3).map((h) => `"${h}"`).join(', ')}? (ids are case-sensitive)` : '';
  }

  /** "no fragment" vs "two fragments of that name": the diagnostic says which */
  _missingMessage(kind, refid) {
    const ambiguous = this._ambiguous?.refid === refid ? this._ambiguous : null;
    this._ambiguous = null;
    return ambiguous
      ? `${kind} "${refid}" is ambiguous: ${ambiguous.candidates.map((s) => s.qualifiedId).join(', ')} — qualify it with the namespace`
      : null;
  }

  /**
   * Resolves one root node (a StatementNode or a standalone
   * SqlFragmentNode being previewed on its own).
   *
   * @param rootNode a node with a `children` array (Statement | SqlFragment)
   * @param namespace the mapper namespace the root node belongs to
   * @param rootQualifiedId the root's own qualifiedId, used as the start of
   *   the cycle-detection stack and as the graph node id for its outgoing
   *   include edges
   * @returns {{ originalTree: object, resolvedTree: object }}
   */
  resolve(rootNode, namespace, rootQualifiedId) {
    const stack = [rootQualifiedId];
    const savedRoot = this._rootNamespace;
    // iBATIS and MyBatis resolve every <include> of a statement — also the ones nested
    // inside an included fragment from another mapper — against the STATEMENT's namespace
    this._rootNamespace = namespace;
    try {
      const resolvedChildren = this._resolveList(rootNode.children, namespace, stack);
      const resolvedTree = cloneShallowWithChildren(rootNode, resolvedChildren);
      return { originalTree: rootNode, resolvedTree };
    } finally {
      this._rootNamespace = savedRoot;
    }
  }

  _resolveList(nodes, namespace, stack) {
    const result = [];
    for (const node of nodes) result.push(...this._resolveNode(node, namespace, stack));
    return result;
  }

  _resolveNode(node, namespace, stack) {
    switch (node.type) {
      case 'Include':
        return [this._resolveInclude(node, namespace, stack)];
      case 'Dynamic':
      case 'Conditional':
      case 'Iterate':
      case 'SelectKey':
        return [cloneShallowWithChildren(node, this._resolveList(node.children, namespace, stack))];
      default:
        return [node];
    }
  }

  /**
   * THE `<include refid>` lookup — the one rule every component uses (the analysis
   * here, the schema converter and the UI through ProjectSession), so a refid can't
   * resolve one way in the graph and another way elsewhere. No side effects.
   *
   * @param refid as written
   * @param writtenIn the namespace of the mapper the `<include>` is written in
   * @param rootNamespace the namespace of the statement being resolved (iBATIS and
   *   MyBatis resolve every include of a statement — nested ones too — against it)
   * @returns {{ symbol: object|undefined, rule: string, written: object|undefined, runtime: object|undefined, missingMessage: string|null }}
   *   rule: QUALIFIED | NAMESPACE | GLOBAL_UNIQUE (by a bare id unique project-wide) |
   *   RUNTIME_SHADOWED (the statement's namespace has its own fragment of that id) |
   *   AUTHOR_NAMESPACE (the statement's namespace has none: the fragment author's) | MISSING
   */
  includeTarget(refid, writtenIn, rootNamespace = writtenIn) {
    const how = (ns, symbol) => {
      if (!symbol) return 'MISSING';
      if (symbol.qualifiedId === refid) return 'QUALIFIED';
      if (ns && symbol.qualifiedId === `${ns}.${refid}`) return 'NAMESPACE';
      return 'GLOBAL_UNIQUE';
    };
    const written = this._resolveRefid(refid, writtenIn, SymbolType.SQL_FRAGMENT);
    const missingMessage = written ? null : this._missingMessage('<include refid>', refid);
    if (rootNamespace === undefined || rootNamespace === writtenIn || refid.includes('.')) {
      return { symbol: written, rule: how(writtenIn, written), written, runtime: undefined, missingMessage };
    }
    // a bare refid inside a fragment of mapper `writtenIn`, included from a statement of `rootNamespace`:
    // the runtime looks it up in `rootNamespace`, the fragment's author meant `writtenIn`
    const runtime = this._resolveRefid(refid, rootNamespace, SymbolType.SQL_FRAGMENT);
    this._ambiguous = null;
    if (runtime && written && runtime.qualifiedId !== written.qualifiedId) return { symbol: runtime, rule: 'RUNTIME_SHADOWED', written, runtime, missingMessage };
    if (!runtime && written) return { symbol: written, rule: written.qualifiedId === `${writtenIn}.${refid}` ? 'AUTHOR_NAMESPACE' : how(writtenIn, written), written, runtime, missingMessage };
    if (runtime && !written) return { symbol: runtime, rule: how(rootNamespace, runtime), written, runtime, missingMessage: null };
    return { symbol: written, rule: how(writtenIn, written), written, runtime, missingMessage };
  }

  _resolveInclude(includeNode, namespace, stack) {
    const fromId = stack[stack.length - 1];
    const { refid } = includeNode;
    const root = this._rootNamespace;
    const target = this.includeTarget(refid, namespace, root);
    let { symbol } = target;
    const { missingMessage } = target;
    if (target.rule === 'GLOBAL_UNIQUE' && this.mybatisNamespaces.has(namespace)) {
      this._warnOnce(`mb|${namespace}|${refid}`, `<include refid="${refid}"> in MyBatis mapper ${namespace} names ${symbol.qualifiedId} in another file by its bare id. Shown as that fragment; MyBatis 3 looks a bare refid up as "${namespace}.${refid}" — write refid="${symbol.qualifiedId}" if the runtime can't find it`, includeNode, 'MYBATIS_BARE_REFID');
    }
    if (target.rule === 'RUNTIME_SHADOWED') {
      this._warnOnce(`${namespace}|${refid}|${root}`, `<include refid="${refid}"> in a fragment of ${namespace}, included from ${root}: iBATIS/MyBatis resolve it against ${root} -> ${target.runtime.qualifiedId}, not ${target.written.qualifiedId}. Analysed as the runtime does; qualify the refid if ${target.written.qualifiedId} was meant`, includeNode, 'NESTED_REFID_SHADOWED');
    } else if (target.written && !target.runtime && root !== undefined && root !== namespace && !refid.includes('.')) {
      this._warnOnce(`${namespace}|${refid}|${root}`, `<include refid="${refid}"> in a fragment of ${namespace}, included from ${root}: iBATIS resolves it against ${root}, where there is no "${refid}" (a runtime error unless useStatementNamespaces=false). Analysed as ${symbol.qualifiedId}; the MyBatis output writes it qualified`, includeNode, 'NESTED_REFID_NAMESPACE');
    }

    if (!symbol) {
      // one error per <include> (file, line, refid), not one per statement that reaches it
      const key = `missing|${includeNode.sourceFile}|${includeNode.sourceLine}|${includeNode.refid}|${root}`;
      if (!this._warned.has(key)) {
        this._warned.add(key);
        this.missingIncludes.push({ refid: includeNode.refid, namespace, root });
        this.diagnostics.error(
          missingMessage ?? `Unresolved <include refid="${includeNode.refid}">: no matching <sql> fragment found${this._nearMiss(includeNode.refid, namespace)}`,
          includeNode.sourceFile,
          includeNode.sourceLine,
          'MISSING_REFERENCE',
        );
      }
      this.dependencyGraph.addEdge(fromId, includeNode.refid, 'INCLUDE_MISSING');
      return new UnresolvedIncludeNode({
        refid: includeNode.refid,
        reason: 'MISSING',
        sourceFile: includeNode.sourceFile,
        sourceLine: includeNode.sourceLine,
      });
    }

    this.dependencyGraph.addEdge(fromId, symbol.qualifiedId, 'INCLUDE');
    // which statement namespaces end up including this fragment (the converter needs it)
    if (!this.includerNamespaces.has(symbol.qualifiedId)) this.includerNamespaces.set(symbol.qualifiedId, new Set());
    this.includerNamespaces.get(symbol.qualifiedId).add(root);

    if (stack.includes(symbol.qualifiedId)) {
      const path = [...stack, symbol.qualifiedId];
      this.circularReferences.push(new CircularReferenceInfo(path));
      this.diagnostics.error(
        `Circular <include> reference detected: ${path.join(' -> ')}`,
        includeNode.sourceFile,
        includeNode.sourceLine,
        'CIRCULAR_REFERENCE',
      );
      return new UnresolvedIncludeNode({
        refid: includeNode.refid,
        reason: 'CIRCULAR',
        path,
        sourceFile: includeNode.sourceFile,
        sourceLine: includeNode.sourceLine,
      });
    }

    const fragment = symbol.node;
    const resolved = new ResolvedIncludeNode({
      refid: includeNode.refid,
      qualifiedId: symbol.qualifiedId,
      sourceFile: includeNode.sourceFile,
      sourceLine: includeNode.sourceLine,
    });
    resolved.children = this._resolveList(fragment.children, symbol.mapper, [...stack, symbol.qualifiedId]);
    return resolved;
  }

  /**
   * Resolves a `<resultMap extends="...">` chain into `resolvedParent`
   * pointers (mutates only the `resolvedParent` annotation field, which
   * exists on ResultMapNode specifically for this purpose).
   *
   * @returns {object[]} chain ordered [leaf, ..., root]
   */
  resolveResultMapExtends(resultMapNode, namespace) {
    const chain = [resultMapNode];
    const selfId = `${namespace}.${resultMapNode.id}`;
    const visitedIds = new Set([selfId]);
    let current = resultMapNode;
    let currentNamespace = namespace;

    while (current.extends) {
      const symbol = this._resolveRefid(current.extends, currentNamespace, SymbolType.RESULT_MAP);
      if (!symbol) {
        this.diagnostics.error(
          this._missingMessage('<resultMap extends>', current.extends) ?? `Unresolved <resultMap extends="${current.extends}">`,
          current.sourceFile,
          current.sourceLine,
          'MISSING_REFERENCE',
        );
        break;
      }
      const fromId = `${currentNamespace}.${current.id}`;
      this.dependencyGraph.addEdge(fromId, symbol.qualifiedId, 'EXTENDS');

      if (visitedIds.has(symbol.qualifiedId)) {
        this.diagnostics.error(
          `Circular resultMap extends chain detected involving "${symbol.qualifiedId}"`,
          current.sourceFile,
          current.sourceLine,
          'CIRCULAR_EXTENDS',
        );
        break;
      }

      current.resolvedParent = symbol.node;
      chain.push(symbol.node);
      visitedIds.add(symbol.qualifiedId);
      current = symbol.node;
      currentNamespace = symbol.mapper;
    }

    return chain;
  }

  /**
   * Records a statement's `resultMap="..."`/`parameterMap="..."` attribute
   * as `RESULT_MAP`/`PARAMETER_MAP` edges in the same `DependencyGraph`
   * used for include/extends — this is what lets
   * `analyzer/dependency/DependencyAnalyzer#buildStatementDependencyTree`
   * (spec section 22) represent resultMap/parameterMap dependency
   * alongside, but distinctly from, the include tree. A reference that
   * doesn't resolve is reported exactly like a missing `<include>` or
   * `extends` — a diagnostic, never a throw.
   */
  linkStatementDependencies(statementNode, namespace, qualifiedId) {
    if (statementNode.resultMap) {
      const symbol = this._resolveRefid(statementNode.resultMap, namespace, SymbolType.RESULT_MAP);
      if (symbol) {
        this.dependencyGraph.addEdge(qualifiedId, symbol.qualifiedId, 'RESULT_MAP');
      } else {
        this.diagnostics.error(
          `Unresolved resultMap="${statementNode.resultMap}" on statement "${qualifiedId}"`,
          statementNode.sourceFile,
          statementNode.sourceLine,
          'MISSING_RESULT_MAP_REFERENCE',
        );
      }
    }
    if (statementNode.parameterMap) {
      const symbol = this._resolveRefid(statementNode.parameterMap, namespace, SymbolType.PARAMETER_MAP);
      if (symbol) {
        this.dependencyGraph.addEdge(qualifiedId, symbol.qualifiedId, 'PARAMETER_MAP');
      } else {
        this.diagnostics.error(
          `Unresolved parameterMap="${statementNode.parameterMap}" on statement "${qualifiedId}"`,
          statementNode.sourceFile,
          statementNode.sourceLine,
          'MISSING_PARAMETER_MAP_REFERENCE',
        );
      }
    }
  }
}
