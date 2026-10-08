import { DynamicGroup, DynamicCondition, DynamicIterate } from './DynamicSqlModel.js';

/**
 * Section 5 — iBATIS Dynamic SQL Analyzer.
 *
 * Converts the `DynamicNode` / `ConditionalNode` / `IterateNode` subtree of
 * a (resolved) statement tree into the standardized `DynamicSql` model
 * (`DynamicSqlModel.js`). Condition standardization (isNull -> IS_NULL,
 * isEqual -> EQUAL, ...) already happened in the parser via
 * `ast/ibatis/enums.js#CONDITION_TAG_MAP`; this analyzer's job is purely
 * structural: flatten each node's own literal SQL text into `sql` while
 * keeping nested dynamic/conditional/iterate structure intact as `children`.
 */

function flattenText(nodes) {
  return nodes
    .filter((n) => n.type === 'TextSql')
    .map((n) => n.text)
    .join('')
    .trim();
}

function convertChildren(nodes) {
  return nodes.map(convertNode).filter((n) => n !== null);
}

function convertNode(node) {
  switch (node.type) {
    case 'Dynamic':
      return new DynamicGroup({
        prepend: node.prepend ?? node.trim?.prefix ?? null,
        sql: flattenText(node.children),
        children: convertChildren(node.children),
        sourceFile: node.sourceFile,
        sourceLine: node.sourceLine,
      });
    case 'Conditional':
      return new DynamicCondition({
        // a MyBatis <if test> / <when test> carries its OGNL expression instead of a property
        property: node.property ?? node.test ?? null,
        operator: node.conditionType,
        compareValue: node.compareValue,
        prepend: node.prepend,
        sql: flattenText(node.children),
        children: convertChildren(node.children),
        sourceFile: node.sourceFile,
        sourceLine: node.sourceLine,
      });
    case 'Iterate':
      return new DynamicIterate({
        property: node.property,
        open: node.open,
        close: node.close,
        conjunction: node.conjunction,
        prepend: node.prepend,
        sql: flattenText(node.children),
        children: convertChildren(node.children),
        sourceFile: node.sourceFile,
        sourceLine: node.sourceLine,
      });
    default:
      // TextSql / Include / ResolvedInclude / UnresolvedInclude / SelectKey
      // are not part of the *dynamic structure* itself.
      return null;
  }
}

export class DynamicSqlAnalyzer {
  /**
   * @param {object} resolvedStatementTree a StatementNode (typically the
   *   `resolvedTree` from ReferenceResolver#resolve, so includes are
   *   already flattened and can themselves contain dynamic structure)
   * @returns {(DynamicGroup|DynamicCondition|DynamicIterate)[]} one entry
   *   per top-level dynamic/conditional/iterate block found directly among
   *   the statement's children, in document order
   */
  analyze(resolvedStatementTree) {
    return convertChildren(resolvedStatementTree.children);
  }

  /**
   * Recursively collects every `DynamicCondition` in a converted tree —
   * useful for cross-referencing against ParameterAnalyzer output and for
   * the WhereAnalyzer traceability chain built in section 10.
   * @param {(DynamicGroup|DynamicCondition|DynamicIterate)[]} nodes
   * @returns {DynamicCondition[]}
   */
  static collectConditions(nodes) {
    const result = [];
    for (const node of nodes) {
      if (node.kind === 'CONDITION') result.push(node);
      result.push(...DynamicSqlAnalyzer.collectConditions(node.children));
    }
    return result;
  }
}
