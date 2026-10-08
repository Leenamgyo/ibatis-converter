import { UnresolvedIncludeNode, ResolvedIncludeNode } from '../../ast/ibatis/nodes.js';
import { DependencyGraph } from './DependencyGraph.js';
import { DiagnosticBag } from '../../parser/xml/ParserDiagnostics.js';
import { SymbolType } from '../../ast/ibatis/enums.js';
import { ReferenceIndex } from './ReferenceIndex.js';

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
  constructor(symbolTable, diagnostics = new DiagnosticBag(), { strictNamespaces = new Set(), mybatisNamespaces = new Set(), index = null, loadNode = null } = {}) {
    this.symbolTable = symbolTable;
    this.diagnostics = diagnostics;
    /** every lookup goes through the one ReferenceIndex (shared, when given) */
    this.index = index ?? new ReferenceIndex(symbolTable, { strictNamespaces, mybatisNamespaces });
    this.mybatisNamespaces = this.index.mybatisNamespaces;
    /**
     * symbol -> the node to walk into. Default: the parsed node registered with it. The
     * project metadata passes include-only stubs (the graph pass) or a loader of the real
     * AST (analysis): the same walk, the same lookups, either way.
     */
    this.loadNode = loadNode ?? ((symbol) => symbol.node);
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

  /** the symbol a reference names (ReferenceIndex#lookup), or undefined */
  _resolveRefid(refid, currentNamespace, type = null) {
    return this.index.lookup(refid, currentNamespace, type).symbol;
  }

  /**
   * The qualified id a reference resolves to, for the converter: MyBatis looks a
   * bare refid up in the CURRENT namespace only, so a bare reference into another
   * mapper has to be written qualified. Null when it doesn't resolve.
   * @param {'SQL_FRAGMENT'|'RESULT_MAP'|'PARAMETER_MAP'|'STATEMENT'} type
   */
  qualifiedIdOf(refid, currentNamespace, type, { fragmentQualifiedId = null, fromFile = null } = {}) {
    const symbol = this.index.lookup(refid, currentNamespace, SymbolType[type] ?? type, { fromFile }).symbol;
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
        && !this.index.lookup(refid, null, SymbolType.SQL_FRAGMENT).symbol);
      if (includers.length && !shadowing.length) target.mustQualify = true;
      if (shadowing.length) {
        target.namespace = currentNamespace; // keep as written: those includers get their own fragment, as before
        // ...but where the runtime finds nothing, it fails: one fragment can't serve both
        if (unresolved.length) target.perIncluderConflict = { shadowing, unresolved };
      }
    }
    return target;
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

  /** where an `<include refid>` points — ReferenceIndex#includeTarget (kept here for callers) */
  includeTarget(refid, writtenIn, rootNamespace = writtenIn) {
    return this.index.includeTarget(refid, writtenIn, rootNamespace);
  }

  _resolveInclude(includeNode, namespace, stack) {
    const fromId = stack[stack.length - 1];
    const { refid } = includeNode;
    const root = this._rootNamespace;
    const target = this.index.includeTarget(refid, namespace, root, includeNode.sourceFile ?? null);
    if (target.rule === 'DUPLICATE_SAME' || target.rule === 'NEAREST_DUPLICATE') {
      const others = target.alternatives.map((s) => `${s.qualifiedId} (${s.sourceFile})`).join(', ');
      this._warnOnce(`dup|${includeNode.sourceFile}|${refid}`, target.rule === 'DUPLICATE_SAME'
        ? `<include refid="${refid}">: the same <sql> is defined in several mappers (identical SQL) — resolved to ${target.symbol.qualifiedId}; also ${others}`
        : `<include refid="${refid}">: several mappers define a different <sql id="${refid}"> — resolved to the nearest, ${target.symbol.qualifiedId} (${target.symbol.sourceFile}); also ${others}. Qualify the refid if another was meant`,
      includeNode, target.rule === 'DUPLICATE_SAME' ? 'REFID_DUPLICATE_SAME' : 'REFID_NEAREST_DUPLICATE');
    }
    const { symbol } = target;
    const missingMessage = ReferenceIndex.ambiguousMessage('<include refid>', refid, target.ambiguous);
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
          missingMessage ?? `Unresolved <include refid="${includeNode.refid}">: no matching <sql> fragment found${this.index.nearMiss(includeNode.refid, namespace)}`,
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

    const fragment = this.loadNode(symbol);
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
      const { symbol, candidates } = this.index.lookup(current.extends, currentNamespace, SymbolType.RESULT_MAP, { fromFile: current.sourceFile ?? null });
      if (!symbol) {
        this.diagnostics.error(
          ReferenceIndex.ambiguousMessage('<resultMap extends>', current.extends, candidates) ?? `Unresolved <resultMap extends="${current.extends}">`,
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

      const parent = this.loadNode(symbol);
      current.resolvedParent = parent;
      chain.push(parent);
      visitedIds.add(symbol.qualifiedId);
      current = parent;
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
      const symbol = this.index.lookup(statementNode.resultMap, namespace, SymbolType.RESULT_MAP, { fromFile: statementNode.sourceFile ?? null }).symbol;
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
      const symbol = this.index.lookup(statementNode.parameterMap, namespace, SymbolType.PARAMETER_MAP, { fromFile: statementNode.sourceFile ?? null }).symbol;
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
