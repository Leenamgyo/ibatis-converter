import { ResultMapNode, ResultNode, IdNode, AssociationNode, CollectionNode } from '../../ast/mybatis/nodes.js';
import { ConversionEvent, MigrationGrade } from './ConversionEvent.js';

/**
 * Section 16 — resultMap conversion.
 *
 * MyBatis 3.x's `<resultMap extends="...">` is itself a direct,
 * first-class equivalent of iBATIS's `<resultMap extends="...">` — so
 * rather than flattening the extends chain that
 * `ReferenceResolver#resolveResultMapExtends` already validated (spec's
 * "실제 부모 resultMap을 resolve한다" is analysis, not necessarily
 * flattening), this keeps the reference as-is and only converts this
 * resultMap's own `<result>` entries. That keeps the generated mapper's
 * structure recognizable and avoids duplicating inherited fields across
 * every descendant.
 *
 * `nullValue` has no MyBatis equivalent and is flagged MANUAL per
 * affected `<result>`; `column`, `jdbcType`, `javaType`, `typeHandler`
 * map 1:1. Nested mappings become their own elements, never a bare
 * `<result>` (which would silently drop the nesting):
 *
 *  - `groupBy="a,b"` -> the grouped properties become `<id>` (MyBatis
 *    groups nested rows by its `<id>`s). A grouped property only mapped in
 *    an `extends` parent is re-declared as `<id>` here, column taken from
 *    the parent chain.
 *  - `<result resultMap="x">` -> `<collection resultMap="x">` when the map
 *    has `groupBy` (that is what iBATIS grouping builds: a list), else
 *    `<association resultMap="x">`.
 *  - `<result select="x">` -> `<association select="x">`, or
 *    `<collection select="x">` when its javaType is a List/Collection/Set.
 *
 * These are WARNING-graded: the mapping is the documented equivalent,
 * but association-vs-collection is read off groupBy/javaType, not the
 * Java class, so it deserves a look.
 */
export class ResultMapConverter {
  /**
   * @param {import('../../ast/ibatis/nodes.js').ResultMapNode} resultMapNode
   * @returns {{ node: ResultMapNode, events: ConversionEvent[] }}
   */
  convert(resultMapNode) {
    const events = [];
    const node = new ResultMapNode({
      id: resultMapNode.id,
      resultType: resultMapNode.class,
      extendsId: resultMapNode.extends,
    });
    const at = (r) => ({ sourceFile: r.sourceFile, sourceLine: r.sourceLine });
    const groupBy = (resultMapNode.groupBy ?? '').split(',').map((p) => p.trim()).filter(Boolean);
    const isListType = (javaType) => /(^|\.)(List|ArrayList|LinkedList|Collection|Set|HashSet)$/.test(javaType ?? '');

    for (const result of resultMapNode.results) {
      if (result.resultMap) {
        const Nested = groupBy.length ? CollectionNode : AssociationNode;
        const tag = groupBy.length ? 'collection' : 'association';
        node.results.push(new Nested({ property: result.property, javaType: groupBy.length ? null : result.javaType, resultMap: result.resultMap }));
        events.push(new ConversionEvent({
          grade: MigrationGrade.WARNING,
          code: 'NESTED_RESULT_MAP',
          message: `<result property="${result.property}" resultMap="${result.resultMap}"> -> <${tag}> (${groupBy.length ? `the map has groupBy="${resultMapNode.groupBy}"` : 'no groupBy: one nested object'}) — check it matches the Java property type`,
          ...at(result),
        }));
      } else if (result.select) {
        const many = isListType(result.javaType);
        const Nested = many ? CollectionNode : AssociationNode;
        node.results.push(new Nested({ property: result.property, column: result.column, javaType: result.javaType, select: result.select }));
        events.push(new ConversionEvent({
          grade: MigrationGrade.WARNING,
          code: 'NESTED_SELECT',
          message: `<result property="${result.property}" select="${result.select}"> -> <${many ? 'collection' : 'association'} column="${result.column}" select="${result.select}"> — a nested select still runs once per row (N+1)${many ? '' : '; if the property is a List, change it to <collection>'}`,
          ...at(result),
        }));
      } else {
        const Plain = groupBy.includes(result.property) ? IdNode : ResultNode;
        node.results.push(new Plain({
          property: result.property,
          column: result.column,
          jdbcType: result.jdbcType,
          javaType: result.javaType,
          typeHandler: result.typeHandler,
        }));
      }
      if (result.nullValue !== null && result.nullValue !== undefined) {
        events.push(new ConversionEvent({
          grade: MigrationGrade.MANUAL,
          code: 'UNSUPPORTED_NULL_VALUE',
          message: `<result property="${result.property}" nullValue="${result.nullValue}"> has no MyBatis equivalent — handle the null-substitution in application code or a custom TypeHandler`,
          ...at(result),
        }));
      }
    }

    for (const property of groupBy) {
      if (resultMapNode.results.some((r) => r.property === property && !r.resultMap && !r.select)) continue;
      // grouped by a property the parent maps: re-declare it here as <id>
      let inherited = null;
      for (let parent = resultMapNode.resolvedParent; parent && !inherited; parent = parent.resolvedParent) {
        inherited = parent.results.find((r) => r.property === property) ?? null;
      }
      if (inherited) {
        node.results.push(new IdNode({ property, column: inherited.column, jdbcType: inherited.jdbcType, javaType: inherited.javaType }));
      }
      events.push(new ConversionEvent({
        grade: inherited ? MigrationGrade.WARNING : MigrationGrade.MANUAL,
        code: 'GROUP_BY_TO_ID',
        message: inherited
          ? `groupBy="${property}" -> <id property="${property}" column="${inherited.column}"> (mapped in the extends parent)`
          : `groupBy="${property}" names a property this resultMap (and its parents) never maps — add the <id> by hand`,
        sourceFile: resultMapNode.sourceFile,
        sourceLine: resultMapNode.sourceLine,
      }));
    }
    if (groupBy.length && !events.some((e) => e.code === 'GROUP_BY_TO_ID')) {
      events.push(new ConversionEvent({
        grade: MigrationGrade.SAFE,
        code: 'GROUP_BY_TO_ID',
        message: `groupBy="${resultMapNode.groupBy}" -> <id> on ${groupBy.join(', ')}`,
        sourceFile: resultMapNode.sourceFile,
        sourceLine: resultMapNode.sourceLine,
      }));
    }

    if (events.length === 0) {
      events.push(new ConversionEvent({
        grade: MigrationGrade.SAFE,
        code: 'RESULT_MAP_CONVERTED',
        message: `<resultMap id="${resultMapNode.id}"> converted with no unsupported attributes`,
        sourceFile: resultMapNode.sourceFile,
        sourceLine: resultMapNode.sourceLine,
      }));
    }

    return { node, events };
  }
}
