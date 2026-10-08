import { parseXml } from '../xml/XmlParser.js';
import { DiagnosticBag } from '../xml/ParserDiagnostics.js';
import * as mb from '../../ast/mybatis/nodes.js';
import * as ib from '../../ast/ibatis/nodes.js';
import { ConditionType } from '../../ast/ibatis/enums.js';

/**
 * A project's own MyBatis 3 mappers (`<mapper>`), read as INPUT. A project
 * mid-migration has both kinds; a MyBatis project has only these, and its
 * SQL still deserves lineage and the old -> new schema renames.
 *
 * Two trees come out, both typed ASTs:
 *
 *   mapper  `ast/mybatis` — the file as written. It is what the 변환 view
 *           shows and what the schema migration rewrites (no iBATIS ->
 *           MyBatis syntax conversion applies: it already is MyBatis).
 *   sqlMap  `ast/ibatis`, mapped node by node from `mapper` — what the
 *           resolver and every analyzer read, so a MyBatis statement gets
 *           the same includes, parameters, tables, joins and lineage as an
 *           iBATIS one:
 *             <if test>              -> Conditional TEST (no prepend: transparent)
 *             <choose>/<when>/<otherwise> -> Conditional CHOOSE of WHEN / OTHERWISE
 *             <where> / <set> / <trim> -> Dynamic with `trim` rules
 *             <foreach>              -> Iterate (collection, open, close, separator)
 *             <include>, <selectKey>, <sql>, <resultMap> -> their iBATIS counterparts
 *             <bind>                 -> nothing (an OGNL variable, no SQL)
 */

const STATEMENT_TAGS = { select: 'SELECT', insert: 'INSERT', update: 'UPDATE', delete: 'DELETE' };
const KNOWN_STATEMENT_ATTRS = new Set(['id', 'parameterType', 'resultType', 'resultMap', 'statementType']);
const IGNORED_TOP_LEVEL = new Set(['cache', 'cache-ref', 'parameterMap']);

const at = (node, sourceFile, sourceLine) => Object.assign(node, { sourceFile, sourceLine });
const splitOverrides = (value) => (value ? value.split('|').map((s) => s.trim()).filter(Boolean) : []);

function parseSqlNodes(children, sourceFile, diagnostics) {
  const out = [];
  for (const child of children) {
    if (child.kind === 'text') {
      out.push(at(new mb.TextSqlNode({ text: child.text }), sourceFile, child.sourceLine));
      continue;
    }
    const line = child.sourceLine;
    const withChildren = (node) => {
      node.children = parseSqlNodes(child.children, sourceFile, diagnostics);
      return at(node, sourceFile, line);
    };
    switch (child.name) {
      case 'if': out.push(withChildren(new mb.IfNode({ test: child.attr('test') }))); break;
      case 'choose': out.push(withChildren(new mb.ChooseNode())); break;
      case 'when': out.push(withChildren(new mb.WhenNode({ test: child.attr('test') }))); break;
      case 'otherwise': out.push(withChildren(new mb.OtherwiseNode())); break;
      case 'where': out.push(withChildren(new mb.WhereNode())); break;
      case 'set': out.push(withChildren(new mb.SetNode())); break;
      case 'trim':
        out.push(withChildren(new mb.TrimNode({
          prefix: child.attr('prefix'),
          suffix: child.attr('suffix'),
          prefixOverrides: child.attr('prefixOverrides'),
          suffixOverrides: child.attr('suffixOverrides'),
        })));
        break;
      case 'foreach':
        out.push(withChildren(new mb.ForeachNode({
          collection: child.attr('collection'),
          item: child.attr('item'),
          index: child.attr('index'),
          open: child.attr('open'),
          close: child.attr('close'),
          separator: child.attr('separator'),
        })));
        break;
      case 'include':
        if (child.elementChildren('property').length) {
          diagnostics.warn(`<include refid="${child.attr('refid')}"> <property> values are not substituted in the analysis`, sourceFile, line, 'INCLUDE_PROPERTY_IGNORED');
        }
        out.push(at(new mb.IncludeNode({ refid: child.attr('refid') }), sourceFile, line));
        break;
      case 'selectKey':
        out.push(withChildren(new mb.SelectKeyNode({
          keyProperty: child.attr('keyProperty'),
          resultType: child.attr('resultType'),
          order: child.attr('order') ?? 'AFTER',
        })));
        break;
      case 'bind':
        out.push(at(new mb.BindNode({ name: child.attr('name'), value: child.attr('value') }), sourceFile, line));
        break;
      default:
        diagnostics.warn(`Unsupported tag <${child.name}> inside a MyBatis statement ignored`, sourceFile, line, 'UNSUPPORTED_TAG');
    }
  }
  return out;
}

function parseResultMap(element, sourceFile, diagnostics) {
  const node = at(new mb.ResultMapNode({ id: element.attr('id'), resultType: element.attr('type'), extendsId: element.attr('extends') }), sourceFile, element.sourceLine);
  for (const child of element.elementChildren()) {
    const common = { property: child.attr('property'), column: child.attr('column'), javaType: child.attr('javaType') };
    if (child.name === 'id') node.results.push(new mb.IdNode({ ...common, jdbcType: child.attr('jdbcType') }));
    else if (child.name === 'result') node.results.push(new mb.ResultNode({ ...common, jdbcType: child.attr('jdbcType'), typeHandler: child.attr('typeHandler') }));
    else if (child.name === 'association') node.results.push(new mb.AssociationNode({ ...common, resultMap: child.attr('resultMap'), select: child.attr('select') }));
    else if (child.name === 'collection') node.results.push(new mb.CollectionNode({ ...common, ofType: child.attr('ofType'), resultMap: child.attr('resultMap'), select: child.attr('select') }));
    else diagnostics.warn(`<resultMap id="${node.id}"> <${child.name}> is not modelled; left out`, sourceFile, child.sourceLine, 'UNSUPPORTED_TAG');
  }
  return node;
}

/** `<mapper>` XmlDocument -> ast/mybatis MapperNode, or null (diagnosed) */
export function parseMyBatisMapper(xmlDocument, sourceFile, diagnostics) {
  if (!xmlDocument) return null;
  const root = xmlDocument.root;
  if (root.name !== 'mapper') {
    diagnostics.error(`Expected root element <mapper> but found <${root.name}>`, sourceFile, root.sourceLine, 'INVALID_ROOT');
    return null;
  }
  const namespace = root.attr('namespace');
  if (!namespace) diagnostics.warn('Missing "namespace" attribute on <mapper>', sourceFile, root.sourceLine, 'MISSING_NAMESPACE');
  const mapper = at(new mb.MapperNode({ namespace: namespace ?? '' }), sourceFile, root.sourceLine);

  for (const child of root.elementChildren()) {
    if (STATEMENT_TAGS[child.name]) {
      const statement = at(new mb.StatementNode({
        id: child.attr('id'),
        statementType: STATEMENT_TAGS[child.name],
        parameterType: child.attr('parameterType'),
        resultType: child.attr('resultType'),
        resultMap: child.attr('resultMap'),
      }), sourceFile, child.sourceLine);
      statement.callable = child.attr('statementType') === 'CALLABLE';
      if (child.attr('statementType') && !statement.callable) statement.otherAttributes.push(['statementType', child.attr('statementType')]);
      for (const [name, value] of Object.entries(child.attributes)) {
        if (!KNOWN_STATEMENT_ATTRS.has(name)) statement.otherAttributes.push([name, value]);
      }
      statement.children = parseSqlNodes(child.children, sourceFile, diagnostics);
      mapper.statements.push(statement);
    } else if (child.name === 'sql') {
      const fragment = at(new mb.SqlFragmentNode({ id: child.attr('id') }), sourceFile, child.sourceLine);
      fragment.children = parseSqlNodes(child.children, sourceFile, diagnostics);
      mapper.sqlFragments.push(fragment);
    } else if (child.name === 'resultMap') {
      mapper.resultMaps.push(parseResultMap(child, sourceFile, diagnostics));
    } else if (!IGNORED_TOP_LEVEL.has(child.name)) {
      diagnostics.warn(`Unsupported top-level tag <${child.name}> ignored`, sourceFile, child.sourceLine, 'UNSUPPORTED_TAG');
    }
  }
  return mapper;
}

// ---------------------------------------------------------------- MyBatis AST -> analysis AST

function toAnalysisNodes(nodes) {
  const out = [];
  for (const node of nodes) {
    const where = { sourceFile: node.sourceFile, sourceLine: node.sourceLine };
    const withChildren = (target) => {
      target.children = toAnalysisNodes(node.children);
      return target;
    };
    switch (node.type) {
      case 'TextSql': {
        // MyBatis puts a space between the SQL of separate tags; the flattener honours `spaced`
        const text = new ib.TextSqlNode({ text: node.text, ...where });
        text.spaced = true;
        out.push(text);
        break;
      }
      case 'If': out.push(withChildren(new ib.ConditionalNode({ conditionType: ConditionType.TEST, test: node.test, ...where }))); break;
      case 'Choose': out.push(withChildren(new ib.ConditionalNode({ conditionType: ConditionType.CHOOSE, ...where }))); break;
      case 'When': out.push(withChildren(new ib.ConditionalNode({ conditionType: ConditionType.WHEN, test: node.test, ...where }))); break;
      case 'Otherwise': out.push(withChildren(new ib.ConditionalNode({ conditionType: ConditionType.OTHERWISE, ...where }))); break;
      case 'Where': out.push(withChildren(new ib.DynamicNode({ trim: { prefix: 'WHERE', prefixOverrides: ['AND', 'OR'] }, ...where }))); break;
      // MyBatis's SetSqlNode drops a leading or trailing comma
      case 'Set': out.push(withChildren(new ib.DynamicNode({ trim: { prefix: 'SET', prefixOverrides: [','], suffixOverrides: [','] }, ...where }))); break;
      case 'Trim':
        out.push(withChildren(new ib.DynamicNode({
          trim: { prefix: node.prefix, suffix: node.suffix, prefixOverrides: splitOverrides(node.prefixOverrides), suffixOverrides: splitOverrides(node.suffixOverrides) },
          ...where,
        })));
        break;
      case 'Foreach':
        out.push(withChildren(new ib.IterateNode({ property: node.collection, open: node.open, close: node.close, conjunction: node.separator, ...where })));
        break;
      case 'Include': out.push(new ib.IncludeNode({ refid: node.refid, ...where })); break;
      case 'SelectKey':
        out.push(withChildren(new ib.SelectKeyNode({ keyProperty: node.keyProperty, resultClass: node.resultType, timing: node.order === 'BEFORE' ? 'pre' : 'post', ...where })));
        break;
      default: break; // Bind: no SQL
    }
  }
  return out;
}

/** ast/mybatis MapperNode -> ast/ibatis SqlMapNode, for the resolver and the analyzers */
export function toAnalysisSqlMap(mapper) {
  const { sourceFile } = mapper;
  const sqlMap = new ib.SqlMapNode({ namespace: mapper.namespace, sourceFile, sourceLine: mapper.sourceLine });
  for (const s of mapper.statements) {
    const statement = new ib.StatementNode({
      id: s.id,
      statementType: s.statementType,
      parameterClass: s.parameterType,
      resultClass: s.resultType,
      resultMap: s.resultMap,
      sourceFile,
      sourceLine: s.sourceLine,
    });
    statement.children = toAnalysisNodes(s.children);
    sqlMap.statements.push(statement);
  }
  for (const f of mapper.sqlFragments) {
    const fragment = new ib.SqlFragmentNode({ id: f.id, sourceFile, sourceLine: f.sourceLine });
    fragment.children = toAnalysisNodes(f.children);
    sqlMap.sqlFragments.push(fragment);
  }
  for (const rm of mapper.resultMaps) {
    const resultMap = new ib.ResultMapNode({ id: rm.id, class: rm.resultType, extends: rm.extendsId, sourceFile, sourceLine: rm.sourceLine });
    resultMap.results = rm.results.map((r) => new ib.ResultNode({
      property: r.property, column: r.column, javaType: r.javaType, jdbcType: r.jdbcType ?? null, resultMap: r.resultMap ?? null, select: r.select ?? null, sourceFile, sourceLine: rm.sourceLine,
    }));
    sqlMap.resultMaps.push(resultMap);
  }
  return sqlMap;
}

/**
 * XML text -> both trees.
 * @returns {{ mapper: object|null, sqlMap: object|null, diagnostics: DiagnosticBag }}
 */
export function parseMyBatisMapperSource(source, sourceFile) {
  const diagnostics = new DiagnosticBag();
  const document = parseXml(source, sourceFile, diagnostics);
  const mapper = parseMyBatisMapper(document, sourceFile, diagnostics);
  return { mapper, sqlMap: mapper ? toAnalysisSqlMap(mapper) : null, diagnostics };
}
