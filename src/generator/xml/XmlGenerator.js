const STATEMENT_TAG = Object.freeze({ SELECT: 'select', INSERT: 'insert', UPDATE: 'update', DELETE: 'delete' });

function escapeText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function attrsString(pairs) {
  return pairs
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([name, value]) => ` ${name}="${escapeAttr(value)}"`)
    .join('');
}

function renderChildren(nodes, level, lines) {
  for (const node of nodes) renderNode(node, level, lines);
}

function renderNode(node, level, lines) {
  const pad = '  '.repeat(level);
  switch (node.type) {
    case 'TextSql':
      // Original SQL text is emitted verbatim (its own internal whitespace
      // from the source file is preserved byte-for-byte) — only re-escaped
      // for XML, never reformatted. See "SQL 내용 임의 변경 금지" in the spec.
      if (node.text !== '') lines.push(escapeText(node.text));
      break;
    case 'Include':
      lines.push(`${pad}<include${attrsString([['refid', node.refid]])}/>`);
      break;
    case 'If':
      lines.push(`${pad}<if${attrsString([['test', node.test]])}>`);
      renderChildren(node.children, level + 1, lines);
      lines.push(`${pad}</if>`);
      break;
    case 'Choose':
      lines.push(`${pad}<choose>`);
      renderChildren(node.children, level + 1, lines);
      lines.push(`${pad}</choose>`);
      break;
    case 'When':
      lines.push(`${pad}<when${attrsString([['test', node.test]])}>`);
      renderChildren(node.children, level + 1, lines);
      lines.push(`${pad}</when>`);
      break;
    case 'Otherwise':
      lines.push(`${pad}<otherwise>`);
      renderChildren(node.children, level + 1, lines);
      lines.push(`${pad}</otherwise>`);
      break;
    case 'Bind':
      lines.push(`${pad}<bind${attrsString([['name', node.name], ['value', node.value]])}/>`);
      break;
    case 'Where':
      lines.push(`${pad}<where>`);
      renderChildren(node.children, level + 1, lines);
      lines.push(`${pad}</where>`);
      break;
    case 'Set':
      lines.push(`${pad}<set>`);
      renderChildren(node.children, level + 1, lines);
      lines.push(`${pad}</set>`);
      break;
    case 'Trim':
      lines.push(`${pad}<trim${attrsString([
        ['prefix', node.prefix],
        ['suffix', node.suffix],
        ['prefixOverrides', node.prefixOverrides],
        ['suffixOverrides', node.suffixOverrides],
      ])}>`);
      renderChildren(node.children, level + 1, lines);
      lines.push(`${pad}</trim>`);
      break;
    case 'Foreach':
      lines.push(`${pad}<foreach${attrsString([
        ['collection', node.collection],
        ['item', node.item],
        ['index', node.index],
        ['open', node.open],
        ['close', node.close],
        ['separator', node.separator],
      ])}>`);
      renderChildren(node.children, level + 1, lines);
      lines.push(`${pad}</foreach>`);
      break;
    case 'SelectKey':
      lines.push(`${pad}<selectKey${attrsString([
        ['keyProperty', node.keyProperty],
        ['resultType', node.resultType],
        ['order', node.order],
      ])}>`);
      renderChildren(node.children, level + 1, lines);
      lines.push(`${pad}</selectKey>`);
      break;
    case 'SqlFragment':
      lines.push(`${pad}<sql${attrsString([['id', node.id]])}>`);
      renderChildren(node.children, level + 1, lines);
      lines.push(`${pad}</sql>`);
      break;
    case 'ResultMap': {
      lines.push(`${pad}<resultMap${attrsString([['id', node.id], ['type', node.resultType], ['extends', node.extendsId]])}>`);
      const resultPad = '  '.repeat(level + 1);
      // the DTD requires id*, result*, association*, collection* in that order
      const order = { Id: 0, Result: 1, Association: 2, Collection: 3 };
      const results = [...node.results].sort((a, b) => (order[a.type] ?? 1) - (order[b.type] ?? 1));
      for (const result of results) {
        if (result.type === 'Association' || result.type === 'Collection') {
          lines.push(`${resultPad}<${result.type === 'Association' ? 'association' : 'collection'}${attrsString([
            ['property', result.property],
            ['column', result.column],
            ['javaType', result.javaType],
            ['ofType', result.ofType],
            ['resultMap', result.resultMap],
            ['select', result.select],
          ])}/>`);
          continue;
        }
        lines.push(`${resultPad}<${result.type === 'Id' ? 'id' : 'result'}${attrsString([
          ['property', result.property],
          ['column', result.column],
          ['jdbcType', result.jdbcType],
          ['javaType', result.javaType],
          ['typeHandler', result.typeHandler],
        ])}/>`);
      }
      lines.push(`${pad}</resultMap>`);
      break;
    }
    case 'Statement': {
      // a procedure call that returns rows is a <select>, otherwise an <update>
      const tagName = node.callable
        ? (node.resultType || node.resultMap ? 'select' : 'update')
        : STATEMENT_TAG[node.statementType] ?? 'select';
      lines.push(`${pad}<${tagName}${attrsString([
        ['id', node.id],
        ['parameterType', node.parameterType],
        ['resultType', node.resultType],
        ['resultMap', node.resultMap],
        ['statementType', node.callable ? 'CALLABLE' : null],
        ...(node.otherAttributes ?? []),
      ])}>`);
      renderChildren(node.children, level + 1, lines);
      lines.push(`${pad}</${tagName}>`);
      break;
    }
    default:
      break;
  }
}

/**
 * Section 17 — renders an `ast/mybatis` MapperNode back to XML text.
 *
 * Structural indentation (2 spaces per nesting level) is applied
 * consistently to every tag; leaf SQL text is emitted verbatim (re-escaped
 * for XML, never reformatted or reindented) so the original SQL content is
 * never altered beyond the deliberate `#x#`/`$x$` conversions already
 * applied by `converter/mybatis`.
 */
export class XmlGenerator {
  /**
   * @param {import('../../ast/mybatis/nodes.js').MapperNode} mapperNode
   * @returns {string} MyBatis mapper XML text
   */
  /**
   * One statement / `<sql>` fragment / resultMap on its own, without the
   * XML prolog, DOCTYPE and `<mapper>` wrapper — for previews of a single
   * node (the schema-migration view diffs these).
   * @returns {string}
   */
  generateNode(node) {
    const lines = [];
    renderNode(node, 0, lines);
    return lines.join('\n');
  }

  generate(mapperNode) {
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">',
      `<mapper${attrsString([['namespace', mapperNode.namespace]])}>`,
    ];

    for (const fragment of mapperNode.sqlFragments) {
      lines.push('');
      renderNode(fragment, 1, lines);
    }
    for (const resultMap of mapperNode.resultMaps) {
      lines.push('');
      renderNode(resultMap, 1, lines);
    }
    for (const statement of mapperNode.statements) {
      lines.push('');
      renderNode(statement, 1, lines);
    }

    lines.push('', '</mapper>');
    return lines.join('\n');
  }
}
