import { parseXml } from '../xml/XmlParser.js';
import { DiagnosticBag } from '../xml/ParserDiagnostics.js';
import {
  SqlMapNode,
  StatementNode,
  SqlFragmentNode,
  TextSqlNode,
  DynamicNode,
  ConditionalNode,
  IterateNode,
  IncludeNode,
  SelectKeyNode,
  ResultMapNode,
  ResultNode,
  ParameterMapNode,
  ParameterNode,
  CacheModelNode,
} from '../../ast/ibatis/nodes.js';
import { STATEMENT_TAG_MAP, CONDITION_TAG_MAP } from '../../ast/ibatis/enums.js';

/**
 * Converts the generic `XmlElement` tree into the semantic iBATIS AST
 * (`ast/ibatis`). This is the only place in the codebase that knows both
 * "XML element" and "iBATIS tag semantics" at the same time — everything
 * downstream (resolver/analyzer/converter) only ever sees AST node types.
 */

function parseSqlNodeList(children, sourceFile, diagnostics) {
  const result = [];
  for (const child of children) {
    if (child.kind === 'text') {
      result.push(new TextSqlNode({ text: child.text, sourceFile, sourceLine: child.sourceLine }));
      continue;
    }

    switch (child.name) {
      case 'dynamic': {
        const node = new DynamicNode({
          prepend: child.attr('prepend'),
          open: child.attr('open'),
          close: child.attr('close'),
          sourceFile,
          sourceLine: child.sourceLine,
        });
        node.children = parseSqlNodeList(child.children, sourceFile, diagnostics);
        result.push(node);
        break;
      }
      case 'iterate': {
        const node = new IterateNode({
          property: child.attr('property'),
          open: child.attr('open'),
          close: child.attr('close'),
          conjunction: child.attr('conjunction'),
          prepend: child.attr('prepend'),
          sourceFile,
          sourceLine: child.sourceLine,
        });
        node.children = parseSqlNodeList(child.children, sourceFile, diagnostics);
        result.push(node);
        break;
      }
      case 'include': {
        const refid = child.attr('refid');
        if (!refid) {
          diagnostics.error('<include> is missing required attribute "refid"', sourceFile, child.sourceLine, 'MISSING_REFID_ATTR');
          break;
        }
        result.push(new IncludeNode({ refid, sourceFile, sourceLine: child.sourceLine }));
        break;
      }
      case 'selectKey': {
        const node = new SelectKeyNode({
          keyProperty: child.attr('keyProperty'),
          resultClass: child.attr('resultClass'),
          timing: child.attr('type', 'post'),
          sourceFile,
          sourceLine: child.sourceLine,
        });
        node.children = parseSqlNodeList(child.children, sourceFile, diagnostics);
        result.push(node);
        break;
      }
      default: {
        if (Object.prototype.hasOwnProperty.call(CONDITION_TAG_MAP, child.name)) {
          const node = new ConditionalNode({
            conditionType: CONDITION_TAG_MAP[child.name],
            property: child.attr('property'),
            compareValue: child.attr('compareValue'),
            compareProperty: child.attr('compareProperty'),
            prepend: child.attr('prepend'),
            open: child.attr('open'),
            close: child.attr('close'),
            removeFirstPrepend: child.boolAttr('removeFirstPrepend', false),
            sourceFile,
            sourceLine: child.sourceLine,
          });
          node.children = parseSqlNodeList(child.children, sourceFile, diagnostics);
          result.push(node);
          break;
        }
        diagnostics.warn(
          `Unsupported tag <${child.name}> treated as transparent (its content is kept, structure is lost)`,
          sourceFile,
          child.sourceLine,
          'UNSUPPORTED_TAG',
        );
        result.push(...parseSqlNodeList(child.children, sourceFile, diagnostics));
      }
    }
  }
  return result;
}

function parseStatement(el, statementType, sourceFile, diagnostics) {
  const id = el.attr('id');
  if (!id) {
    diagnostics.error(`<${el.name}> is missing required attribute "id"`, sourceFile, el.sourceLine, 'MISSING_ID_ATTR');
    return null;
  }
  const node = new StatementNode({
    id,
    statementType,
    parameterClass: el.attr('parameterClass'),
    parameterMap: el.attr('parameterMap'),
    resultClass: el.attr('resultClass'),
    resultMap: el.attr('resultMap'),
    cacheModel: el.attr('cacheModel'),
    fetchSize: el.intAttr('fetchSize'),
    timeout: el.intAttr('timeout'),
    remapResults: el.boolAttr('remapResults', false),
    sourceFile,
    sourceLine: el.sourceLine,
  });
  node.children = parseSqlNodeList(el.children, sourceFile, diagnostics);
  return node;
}

function parseSqlFragment(el, sourceFile, diagnostics) {
  const id = el.attr('id');
  if (!id) {
    diagnostics.error('<sql> is missing required attribute "id"', sourceFile, el.sourceLine, 'MISSING_ID_ATTR');
    return null;
  }
  const node = new SqlFragmentNode({ id, sourceFile, sourceLine: el.sourceLine });
  node.children = parseSqlNodeList(el.children, sourceFile, diagnostics);
  return node;
}

function parseResultMap(el, sourceFile, diagnostics) {
  const id = el.attr('id');
  if (!id) {
    diagnostics.error('<resultMap> is missing required attribute "id"', sourceFile, el.sourceLine, 'MISSING_ID_ATTR');
    return null;
  }
  const node = new ResultMapNode({
    id,
    class: el.attr('class'),
    extends: el.attr('extends'),
    groupBy: el.attr('groupBy'),
    sourceFile,
    sourceLine: el.sourceLine,
  });
  for (const resultEl of el.elementChildren('result')) {
    const property = resultEl.attr('property');
    if (!property) {
      diagnostics.error('<result> is missing required attribute "property"', sourceFile, resultEl.sourceLine, 'MISSING_PROPERTY_ATTR');
      continue;
    }
    node.results.push(new ResultNode({
      property,
      column: resultEl.attr('column'),
      jdbcType: resultEl.attr('jdbcType'),
      javaType: resultEl.attr('javaType'),
      typeHandler: resultEl.attr('typeHandler'),
      nullValue: resultEl.attr('nullValue'),
      select: resultEl.attr('select'),
      resultMap: resultEl.attr('resultMap'),
      sourceFile,
      sourceLine: resultEl.sourceLine,
    }));
  }
  return node;
}

function parseParameterMap(el, sourceFile, diagnostics) {
  const id = el.attr('id');
  if (!id) {
    diagnostics.error('<parameterMap> is missing required attribute "id"', sourceFile, el.sourceLine, 'MISSING_ID_ATTR');
    return null;
  }
  const node = new ParameterMapNode({ id, class: el.attr('class'), sourceFile, sourceLine: el.sourceLine });
  for (const paramEl of el.elementChildren('parameter')) {
    const property = paramEl.attr('property');
    if (!property) {
      diagnostics.error('<parameter> is missing required attribute "property"', sourceFile, paramEl.sourceLine, 'MISSING_PROPERTY_ATTR');
      continue;
    }
    node.parameters.push(new ParameterNode({
      property,
      jdbcType: paramEl.attr('jdbcType'),
      javaType: paramEl.attr('javaType'),
      typeHandler: paramEl.attr('typeHandler'),
      nullValue: paramEl.attr('nullValue'),
      mode: paramEl.attr('mode'),
      sourceFile,
      sourceLine: paramEl.sourceLine,
    }));
  }
  return node;
}

function parseCacheModel(el, sourceFile) {
  return new CacheModelNode({
    id: el.attr('id'),
    cacheType: el.attr('type'),
    sourceFile,
    sourceLine: el.sourceLine,
  });
}

/**
 * Walks a parsed `<sqlMap>` XmlDocument and produces a `SqlMapNode`.
 * Returns `null` (with diagnostics recorded) if the document has no usable
 * root element — callers should skip the file and keep processing others.
 */
export function parseIbatisMapper(xmlDocument, sourceFile, diagnostics) {
  if (!xmlDocument) return null;
  const root = xmlDocument.root;
  if (root.name !== 'sqlMap') {
    diagnostics.error(`Expected root element <sqlMap> but found <${root.name}>`, sourceFile, root.sourceLine, 'INVALID_ROOT');
    return null;
  }

  const namespace = root.attr('namespace');
  if (!namespace) {
    diagnostics.warn('Missing "namespace" attribute on <sqlMap>; symbols will be registered without a namespace prefix', sourceFile, root.sourceLine, 'MISSING_NAMESPACE');
  }

  const sqlMap = new SqlMapNode({ namespace: namespace ?? '', sourceFile, sourceLine: root.sourceLine });

  for (const child of root.elementChildren()) {
    if (Object.prototype.hasOwnProperty.call(STATEMENT_TAG_MAP, child.name)) {
      const stmt = parseStatement(child, STATEMENT_TAG_MAP[child.name], sourceFile, diagnostics);
      if (stmt) sqlMap.statements.push(stmt);
      continue;
    }
    switch (child.name) {
      case 'sql': {
        const frag = parseSqlFragment(child, sourceFile, diagnostics);
        if (frag) sqlMap.sqlFragments.push(frag);
        break;
      }
      case 'resultMap': {
        const rm = parseResultMap(child, sourceFile, diagnostics);
        if (rm) sqlMap.resultMaps.push(rm);
        break;
      }
      case 'parameterMap': {
        const pm = parseParameterMap(child, sourceFile, diagnostics);
        if (pm) sqlMap.parameterMaps.push(pm);
        break;
      }
      case 'cacheModel':
        sqlMap.cacheModels.push(parseCacheModel(child, sourceFile));
        break;
      case 'typeAlias':
        // Out of scope for migration analysis; intentionally ignored without warning.
        break;
      default:
        diagnostics.warn(`Unsupported top-level tag <${child.name}> ignored`, sourceFile, child.sourceLine, 'UNSUPPORTED_TAG');
    }
  }

  return sqlMap;
}

/**
 * Convenience one-shot entry point: XML text -> SqlMapNode.
 * @returns {{ sqlMap: SqlMapNode|null, diagnostics: DiagnosticBag }}
 */
export function parseIbatisMapperSource(source, sourceFile) {
  const diagnostics = new DiagnosticBag();
  const document = parseXml(source, sourceFile, diagnostics);
  const sqlMap = parseIbatisMapper(document, sourceFile, diagnostics);
  return { sqlMap, diagnostics };
}
