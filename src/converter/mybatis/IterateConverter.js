import { ForeachNode } from '../../ast/mybatis/nodes.js';
import { ConversionEvent, MigrationGrade } from './ConversionEvent.js';

/**
 * Section 15 — `<iterate property open close conjunction>` -> MyBatis
 * `<foreach collection item open close separator>`. Structurally a 1:1,
 * always-SAFE mapping; the two real decisions are both made by the caller
 * (`MyBatisAstConverter`) and passed in:
 *  - `itemName`, the MyBatis `<foreach item="...">` variable (distinct
 *    names for nested `<iterate>`, since MyBatis has no loop-relative
 *    `#x[]#` syntax — see `ParameterConverter`'s `iterateStack`);
 *  - `collection`, the resolved OGNL collection expression (a nested
 *    `<iterate property="outer[].inner">` must become
 *    `collection="<outerItem>.inner"`, not the raw iBATIS bracket path —
 *    see `ParameterConverter#resolveCollectionExpression`).
 */
export class IterateConverter {
  /**
   * @param {import('../../ast/ibatis/nodes.js').IterateNode} iterateNode
   * @param {string} [itemName] the MyBatis `<foreach item="...">` variable name
   * @param {string} [collection] resolved OGNL collection expression; defaults to the raw `property` (correct for a top-level, non-nested iterate)
   * @returns {{ node: ForeachNode, events: ConversionEvent[] }}
   */
  convert(iterateNode, itemName = 'item', collection = iterateNode.property) {
    const node = new ForeachNode({
      collection,
      item: itemName,
      open: iterateNode.open,
      close: iterateNode.close,
      separator: iterateNode.conjunction,
    });
    const events = [new ConversionEvent({
      grade: MigrationGrade.SAFE,
      code: 'ITERATE_TO_FOREACH',
      message: `<iterate property="${iterateNode.property}"> -> <foreach collection="${collection}" item="${itemName}">`,
      sourceFile: iterateNode.sourceFile,
      sourceLine: iterateNode.sourceLine,
    })];
    return { node, events };
  }
}
