import { ConditionType } from '../../ast/ibatis/enums.js';
import { IfNode } from '../../ast/mybatis/nodes.js';
import { ConversionEvent, MigrationGrade } from './ConversionEvent.js';
import { resolveExpression } from './ParameterConverter.js';

/**
 * An OGNL literal for an iBATIS compareValue. OGNL reads a one-character
 * '...' literal as a java.lang.Character, and comparing a String with a
 * Character makes OGNL convert both to numbers — `flag == 'Y'` throws
 * NumberFormatException at runtime. `.toString()` makes it a String.
 */
function literal(value) {
  const text = String(value);
  if (/^-?\d+(\.\d+)?$/.test(text)) return text;
  const quoted = `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return [...text].length === 1 ? `${quoted}.toString()` : quoted;
}

/** Is `property` iterated over somewhere in this tag's body (so it is a collection)? */
function iteratedInBody(node, property) {
  for (const child of node.children ?? []) {
    if (child.type === 'Iterate' && child.property === property) return true;
    if (iteratedInBody(child, property)) return true;
  }
  return false;
}

/**
 * Section 13 — converts a standardized `ConditionalNode`
 * (isNull/isNotNull/isEqual/.../isEmpty/isNotEmpty) into a MyBatis
 * `IfNode` with the equivalent OGNL `test` expression. Every mapping is a
 * fixed OGNL idiom and SAFE, except `isPropertyAvailable` (WARNING: OGNL
 * can only ask "non-null", not "present"). `compareProperty` compares two
 * parameter properties (`a != b`), never a literal; a property inside an
 * `<iterate>` is rewritten to the `<foreach>` item (`groups[].x` -> `item.x`).
 *
 * Returns the `IfNode` with empty `children`; the caller
 * (`MyBatisAstConverter`) fills them in after recursively converting the
 * original node's own children, since this converter's only job is the
 * `test` expression.
 */
export class ConditionalConverter {
  /**
   * @param {import('../../ast/ibatis/nodes.js').ConditionalNode} conditionalNode
   * @param {{ property: string, item: string }[]} [iterateStack] enclosing `<iterate>`s — inside a
   *   `<foreach>`, `groups[].qtyList` is not in OGNL scope; it has to become `item.qtyList`
   * @returns {{ node: IfNode, events: ConversionEvent[] }}
   */
  convert(conditionalNode, iterateStack = []) {
    const { conditionType, compareValue, sourceFile, sourceLine } = conditionalNode;
    const property = conditionalNode.property ? resolveExpression(conditionalNode.property, iterateStack) : conditionalNode.property;
    const compareProperty = conditionalNode.compareProperty ? resolveExpression(conditionalNode.compareProperty, iterateStack) : null;
    // `compareProperty` compares two parameter properties; `compareValue` a literal
    const operand = compareProperty ?? literal(compareValue);
    // iBATIS: a null side is "not comparable", so every ordering test is false.
    // OGNL: null in a numeric comparison is 0 (`null < 5` is true) — guard it.
    // Two null properties compare as equal in iBATIS (so >= and <= hold); one null side never compares.
    const notNull = [property, compareProperty].filter(Boolean).map((p) => `${p} != null`).join(' and ');
    const ordered = (op) => {
      const both = `${notNull} and ${property} ${op} ${operand}`;
      return compareProperty && op.includes('=') ? `(${property} == null and ${compareProperty} == null) or (${both})` : both;
    };
    // iBATIS isEmpty is also true for an empty List; OGNL `list != ''` is true for one
    // (a List is never equal to a String), which renders `IN` with nothing after it.
    const collection = iteratedInBody(conditionalNode, conditionalNode.property);
    const events = [];
    let test;
    switch (conditionType) {
      case ConditionType.IS_NULL: test = `${property} == null`; break;
      case ConditionType.IS_NOT_NULL: test = `${property} != null`; break;
      case ConditionType.IS_EMPTY: test = collection ? `${property} == null or ${property}.size() == 0` : `${property} == null or ${property} == ''`; break;
      case ConditionType.IS_NOT_EMPTY: test = collection ? `${property} != null and ${property}.size() > 0` : `${property} != null and ${property} != ''`; break;
      case ConditionType.EQUAL: test = `${property} == ${operand}`; break;
      case ConditionType.NOT_EQUAL: test = `${property} != ${operand}`; break;
      case ConditionType.GREATER_THAN: test = ordered('>'); break;
      case ConditionType.GREATER_EQUAL: test = ordered('>='); break;
      case ConditionType.LESS_THAN: test = ordered('<'); break;
      case ConditionType.LESS_EQUAL: test = ordered('<='); break;
      case ConditionType.PARAMETER_PRESENT: test = '_parameter != null'; break;
      case ConditionType.NOT_PARAMETER_PRESENT: test = '_parameter == null'; break;
      case ConditionType.PROPERTY_AVAILABLE:
      case ConditionType.NOT_PROPERTY_AVAILABLE: {
        // iBATIS asks "does the parameter object HAVE this property" (a Map key, a bean getter);
        // OGNL `!= null` asks "is it non-null" — a key present with a null value differs.
        const available = conditionType === ConditionType.PROPERTY_AVAILABLE;
        test = available ? `${property} != null` : `${property} == null`;
        events.push(new ConversionEvent({
          grade: MigrationGrade.WARNING,
          code: 'PROPERTY_AVAILABLE_APPROXIMATED',
          message: `<${available ? 'isPropertyAvailable' : 'isNotPropertyAvailable'} property="${conditionalNode.property}"> approximated as <if test="${test}">: a key that is present but null now counts as ${available ? 'unavailable' : 'available'} — for a Map parameter use _parameter.containsKey('${conditionalNode.property}') if that matters`,
          sourceFile,
          sourceLine,
        }));
        break;
      }
      default: {
        test = 'true';
        events.push(new ConversionEvent({
          grade: MigrationGrade.MANUAL,
          code: 'UNKNOWN_CONDITION',
          message: `condition type ${conditionType} has no OGNL mapping — <if test="true"> placeholder`,
          sourceFile,
          sourceLine,
        }));
      }
    }

    const node = new IfNode({ test });
    if (!events.length) {
      events.push(new ConversionEvent({
        grade: MigrationGrade.SAFE,
        code: 'CONDITIONAL_TO_IF',
        message: `${conditionType}${compareProperty ? ` (compareProperty=${conditionalNode.compareProperty})` : ''} -> <if test="${test}">`,
        sourceFile,
        sourceLine,
      }));
    }
    return { node, events };
  }
}
