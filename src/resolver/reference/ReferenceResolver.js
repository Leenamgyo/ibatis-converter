import { UnresolvedIncludeNode, ResolvedIncludeNode } from '../../ast/ibatis/nodes.js';
import { DependencyGraph } from './DependencyGraph.js';
import { DiagnosticBag } from '../../parser/xml/ParserDiagnostics.js';

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
  constructor(symbolTable, diagnostics = new DiagnosticBag()) {
    this.symbolTable = symbolTable;
    this.diagnostics = diagnostics;
    this.dependencyGraph = new DependencyGraph();
    /** @type {CircularReferenceInfo[]} */
    this.circularReferences = [];
  }

  _resolveRefid(refid, currentNamespace) {
    if (this.symbolTable.has(refid)) return this.symbolTable.get(refid);
    if (currentNamespace) {
      const qualified = `${currentNamespace}.${refid}`;
      if (this.symbolTable.has(qualified)) return this.symbolTable.get(qualified);
    }
    return undefined;
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
    const resolvedChildren = this._resolveList(rootNode.children, namespace, stack);
    const resolvedTree = cloneShallowWithChildren(rootNode, resolvedChildren);
    return { originalTree: rootNode, resolvedTree };
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

  _resolveInclude(includeNode, namespace, stack) {
    const fromId = stack[stack.length - 1];
    const symbol = this._resolveRefid(includeNode.refid, namespace);

    if (!symbol) {
      this.diagnostics.error(
        `Unresolved <include refid="${includeNode.refid}">: no matching <sql> fragment found`,
        includeNode.sourceFile,
        includeNode.sourceLine,
        'MISSING_REFERENCE',
      );
      this.dependencyGraph.addEdge(fromId, includeNode.refid, 'INCLUDE_MISSING');
      return new UnresolvedIncludeNode({
        refid: includeNode.refid,
        reason: 'MISSING',
        sourceFile: includeNode.sourceFile,
        sourceLine: includeNode.sourceLine,
      });
    }

    this.dependencyGraph.addEdge(fromId, symbol.qualifiedId, 'INCLUDE');

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
      const symbol = this._resolveRefid(current.extends, currentNamespace);
      if (!symbol) {
        this.diagnostics.error(
          `Unresolved <resultMap extends="${current.extends}">`,
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
      const symbol = this._resolveRefid(statementNode.resultMap, namespace);
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
      const symbol = this._resolveRefid(statementNode.parameterMap, namespace);
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
