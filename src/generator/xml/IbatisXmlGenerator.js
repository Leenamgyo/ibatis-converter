import { CONDITION_TAG_MAP } from '../../ast/ibatis/enums.js';

/**
 * Renders `ast/ibatis` nodes back to iBATIS 2.x sqlMap XML — used to show a
 * statement on its own, and its schema-migrated twin (renames applied, iBATIS
 * syntax kept), in the same layout `XmlGenerator` gives the MyBatis side:
 * tags on their own lines at two spaces per level, SQL text verbatim (only
 * re-escaped). Line for line, a statement therefore usually lines up with
 * its MyBatis conversion, which is what the UI's side-by-side relies on.
 *
 * XML comments and the original indentation of tags are not in the AST, so
 * they are not reproduced; the SQL text inside the tags is.
 */

const CONDITION_TAG = Object.fromEntries(Object.entries(CONDITION_TAG_MAP).map(([tag, type]) => [type, tag]));
const STATEMENT_TAG = { SELECT: 'select', INSERT: 'insert', UPDATE: 'update', DELETE: 'delete', PROCEDURE: 'procedure' };

function escapeText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function attrs(pairs) {
  return pairs
    .filter(([, value]) => value !== null && value !== undefined && value !== '' && value !== false)
    .map(([name, value]) => ` ${name}="${escapeAttr(value)}"`)
    .join('');
}

function render(node, level, lines) {
  const pad = '  '.repeat(level);
  const block = (tag, attributes) => {
    lines.push(`${pad}<${tag}${attrs(attributes)}>`);
    for (const child of node.children ?? []) render(child, level + 1, lines);
    lines.push(`${pad}</${tag}>`);
  };
  switch (node.type) {
    case 'TextSql':
      if (node.text !== '') lines.push(escapeText(node.text));
      break;
    case 'Include':
      lines.push(`${pad}<include${attrs([['refid', node.refid]])}/>`);
      break;
    case 'Dynamic':
      block('dynamic', [['prepend', node.prepend], ['open', node.open], ['close', node.close]]);
      break;
    case 'Conditional':
      block(CONDITION_TAG[node.conditionType] ?? 'isNotNull', [
        ['property', node.property],
        ['compareProperty', node.compareProperty],
        ['compareValue', node.compareValue],
        ['prepend', node.prepend],
        ['open', node.open],
        ['close', node.close],
        ['removeFirstPrepend', node.removeFirstPrepend ? 'true' : null],
      ]);
      break;
    case 'Iterate':
      block('iterate', [['property', node.property], ['prepend', node.prepend], ['open', node.open], ['close', node.close], ['conjunction', node.conjunction]]);
      break;
    case 'SelectKey':
      block('selectKey', [['keyProperty', node.keyProperty], ['resultClass', node.resultClass], ['type', node.timing]]);
      break;
    case 'SqlFragment':
      block('sql', [['id', node.id]]);
      break;
    case 'Statement':
      block(STATEMENT_TAG[node.statementType] ?? 'select', [
        ['id', node.id],
        ['parameterClass', node.parameterClass],
        ['parameterMap', node.parameterMap],
        ['resultClass', node.resultClass],
        ['resultMap', node.resultMap],
        ['cacheModel', node.cacheModel],
      ]);
      break;
    default:
      for (const child of node.children ?? []) render(child, level, lines);
  }
}

export class IbatisXmlGenerator {
  /** One statement / `<sql>` fragment, without the `<sqlMap>` wrapper. */
  generateNode(node) {
    const lines = [];
    render(node, 0, lines);
    return lines.join('\n');
  }
}
