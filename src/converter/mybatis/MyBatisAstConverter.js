import {
  StatementNode,
  SqlFragmentNode as MyBatisSqlFragmentNode,
  TextSqlNode,
  IncludeNode,
  SelectKeyNode,
  TrimNode,
} from '../../ast/mybatis/nodes.js';
import { ParameterConverter, resolveCollectionExpression } from './ParameterConverter.js';
import { ConditionalConverter } from './ConditionalConverter.js';
import { DynamicConverter } from './DynamicConverter.js';
import { IterateConverter } from './IterateConverter.js';
import { ResultMapConverter } from './ResultMapConverter.js';
import { ConversionEvent, MigrationGrade } from './ConversionEvent.js';

/**
 * Composition root for the converter package: walks the ORIGINAL
 * (unresolved) iBATIS AST — `<include>` is kept as a MyBatis
 * `<include refid>`, not inlined, so the generated mapper keeps its own
 * reusable `<sql>` fragments rather than duplicating their SQL into every
 * referencing statement — and produces `ast/mybatis` nodes by delegating
 * to ParameterConverter / ConditionalConverter / DynamicConverter /
 * IterateConverter for each node kind. Every transformation is a typed
 * AST-to-AST mapping (see "핵심 구현 원칙" in the spec) — nothing here
 * touches XML or SQL as strings.
 */

/**
 * iBATIS renders a `prepend` connector itself, at runtime, suppressing it
 * for whichever sibling happens to come first. MyBatis has no equivalent
 * mechanism: `<where>`/`<set>`/`<trim>` only ever *strip* a connector the
 * body already carries. So the connector has to be written into the body
 * - "AND"/"OR" in front (`<where>`, and the `prefixOverrides` of an
 * inferred `<trim>`, drop the leading one), a "," behind (`<set>`, and a
 * `suffixOverrides` trim, drop the trailing one).
 *
 * Without this the converted mapper looks right and is silently broken:
 * two matching conditions render as `WHERE A = ? B = ?`.
 */
function withConnector(prepend, children) {
  const connector = (prepend ?? '').trim();
  if (!connector || !children.length) return children;

  // Merged into the neighbouring SQL text rather than added as its own
  // node, so the generated mapper reads like hand-written MyBatis
  // ("AND STATUS = #{status}") instead of putting the connector on a line
  // of its own.
  // The connector is inserted *inside* the existing leading/trailing
  // whitespace so the SQL text itself is still emitted byte-for-byte
  // (see XmlGenerator's "SQL 내용 임의 변경 금지" note) and the generated
  // mapper keeps its indentation.
  if (connector === ',') {
    const last = children[children.length - 1];
    if (last.type !== 'TextSql') return [...children, new TextSqlNode({ text: ',' })];
    return [...children.slice(0, -1), new TextSqlNode({ text: last.text.replace(/(\s*)$/, ',$1') })];
  }
  const first = children[0];
  if (first.type !== 'TextSql') return [new TextSqlNode({ text: `${connector} ` }), ...children];
  return [new TextSqlNode({ text: first.text.replace(/^(\s*)/, `$1${connector} `) }), ...children.slice(1)];
}

/**
 * A conditional with no prepend (and no removeFirstPrepend / open / close) is
 * transparent in iBATIS 2.3: its children take part in the ENCLOSING tag's
 * "first content" rule (SqlTagContext: such a tag "looks to the parent").
 */
export function isTransparentConditional(node) {
  return node.type === 'Conditional' && !node.prepend?.trim() && !node.removeFirstPrepend && !node.open && !node.close;
}

/**
 * Connector tokens ("AND ", "OR ", ", ") of the tags that can render first
 * inside `children`: the ones before the first non-blank text, looking
 * through transparent conditionals. An <include> there adds AND/OR — its
 * fragment (inlined by iBATIS) may begin with a prepend-bearing tag.
 */
function leadingPrepends(children, tokens = new Set()) {
  for (const child of children) {
    if (child.type === 'TextSql') {
      if (child.text.trim()) break;
      continue;
    }
    if (child.type === 'Include') {
      tokens.add('AND ');
      tokens.add('OR ');
    } else if (isTransparentConditional(child)) {
      leadingPrepends(child.children, tokens); // may not render: keep looking at the next siblings too
    } else if ((child.type === 'Conditional' || child.type === 'Dynamic' || child.type === 'Iterate') && child.prepend?.trim()) {
      tokens.add(`${child.prepend.trim().toUpperCase()} `);
    }
  }
  return [...tokens];
}

/**
 * A reference as MyBatis needs it written. MyBatis resolves a refid / resultMap /
 * extends / select WITHOUT a dot inside the CURRENT namespace only, while iBATIS with
 * useStatementNamespaces=false (its default) resolves a bare id project-wide. So a
 * bare reference that the resolver found in ANOTHER mapper is written fully
 * qualified. `context.resolveReference(ref, namespace, type)` comes from the
 * pipeline's ReferenceResolver; without it (unit tests) references are kept.
 */
function qualifyReference(ref, type, context, events, node) {
  if (!context?.resolveReference || !ref || ref.includes('.')) return ref;
  const target = context.resolveReference(ref, context.namespace, type, { fragmentQualifiedId: context.fragmentQualifiedId });
  if (target?.perIncluderConflict) {
    const { shadowing, unresolved } = target.perIncluderConflict;
    events.push(new ConversionEvent({
      grade: MigrationGrade.MANUAL,
      code: 'REFID_DEPENDS_ON_INCLUDER',
      message: `<include refid="${ref}"> in fragment ${context.fragmentQualifiedId}: iBATIS and MyBatis resolve it against the including statement's namespace — ${shadowing.map((ns) => `${ns}.${ref}`).join(', ')} for ${shadowing.join(', ')}, nothing (an error) for ${unresolved.join(', ')}. Kept as written; qualify it or split the fragment`,
      sourceFile: node?.sourceFile ?? null,
      sourceLine: node?.sourceLine ?? null,
    }));
    return ref;
  }
  if (!target || (target.namespace === context.namespace && !target.mustQualify)) return ref;
  events.push(new ConversionEvent({
    grade: MigrationGrade.SAFE,
    code: 'REFERENCE_QUALIFIED',
    message: target.namespace === context.namespace
      ? `"${ref}" inside a fragment that other mappers include -> "${target.qualifiedId}": iBATIS and MyBatis resolve a bare refid against the INCLUDING statement's namespace`
      : `"${ref}" is defined in ${target.namespace} (iBATIS resolves bare ids project-wide) -> "${target.qualifiedId}", since MyBatis looks a bare id up in the current namespace only`,
    sourceFile: node?.sourceFile ?? null,
    sourceLine: node?.sourceLine ?? null,
  }));
  return target.qualifiedId;
}

export class MyBatisAstConverter {
  constructor({
    parameterConverter = new ParameterConverter(),
    conditionalConverter = new ConditionalConverter(),
    dynamicConverter = new DynamicConverter(),
    iterateConverter = new IterateConverter(),
    resultMapConverter = new ResultMapConverter(),
  } = {}) {
    this.parameterConverter = parameterConverter;
    this.conditionalConverter = conditionalConverter;
    this.dynamicConverter = dynamicConverter;
    this.iterateConverter = iterateConverter;
    this.resultMapConverter = resultMapConverter;
  }

  /**
   * @param {object} statementNode original (unresolved) StatementNode
   * @returns {{ node: import('../../ast/mybatis/nodes.js').StatementNode, events: ConversionEvent[] }}
   */
  convertStatement(statementNode, context = {}) {
    const state = { events: [], iterateCounter: 0, context };
    const node = new StatementNode({
      id: statementNode.id,
      statementType: statementNode.statementType,
      parameterType: statementNode.parameterClass,
      resultType: statementNode.resultClass,
      resultMap: statementNode.resultMap ? qualifyReference(statementNode.resultMap, 'RESULT_MAP', context, state.events, statementNode) : null,
    });
    node.children = this._convertList(statementNode.children, [], state);

    if (statementNode.statementType === 'PROCEDURE') {
      node.callable = true;
      state.events.push(new ConversionEvent({
        grade: MigrationGrade.SAFE,
        code: 'PROCEDURE_TO_CALLABLE',
        message: `<procedure> -> <${node.resultType || node.resultMap ? 'select' : 'update'} statementType="CALLABLE">`,
        sourceFile: statementNode.sourceFile,
        sourceLine: statementNode.sourceLine,
      }));
    }
    if (statementNode.cacheModel) {
      state.events.push(new ConversionEvent({
        grade: MigrationGrade.WARNING,
        code: 'CACHE_MODEL_DROPPED',
        message: `cacheModel="${statementNode.cacheModel}" has no per-statement MyBatis equivalent — configure the namespace <cache> (and useCache/flushCache) by hand`,
        sourceFile: statementNode.sourceFile,
        sourceLine: statementNode.sourceLine,
      }));
    }

    if (statementNode.parameterMap) {
      state.events.push(new ConversionEvent({
        grade: MigrationGrade.MANUAL,
        code: 'PARAMETER_MAP_STATEMENT',
        message: `parameterMap="${statementNode.parameterMap}" binds parameters positionally ("?") — review and convert to inline #{} bindings manually`,
        sourceFile: statementNode.sourceFile,
        sourceLine: statementNode.sourceLine,
      }));
    }

    return { node, events: state.events };
  }

  /**
   * @param {object} sqlFragmentNode original (unresolved) SqlFragmentNode
   * @returns {{ node: import('../../ast/mybatis/nodes.js').SqlFragmentNode, events: ConversionEvent[] }}
   */
  convertSqlFragment(sqlFragmentNode, context = {}) {
    const state = { events: [], iterateCounter: 0, context };
    const node = new MyBatisSqlFragmentNode({ id: sqlFragmentNode.id });
    node.children = this._convertList(sqlFragmentNode.children, [], state);
    return { node, events: state.events };
  }

  /**
   * @param {object} resultMapNode
   * @returns {{ node: import('../../ast/mybatis/nodes.js').ResultMapNode, events: ConversionEvent[] }}
   */
  convertResultMap(resultMapNode, context = {}) {
    const events = [];
    const qualify = (ref, type) => (ref ? qualifyReference(ref, type, context, events, resultMapNode) : ref);
    const converted = this.resultMapConverter.convert(resultMapNode, { qualify });
    return { node: converted.node, events: [...events, ...converted.events] };
  }

  _nextItemName(state) {
    state.iterateCounter += 1;
    return state.iterateCounter === 1 ? 'item' : `item${state.iterateCounter}`;
  }

  _convertList(nodes, iterateStack, state) {
    const result = [];
    for (const node of nodes) {
      switch (node.type) {
        case 'TextSql': {
          const { text, events } = this.parameterConverter.convert(
            node.text,
            iterateStack,
            { sourceFile: node.sourceFile, sourceLine: node.sourceLine },
          );
          state.events.push(...events);
          result.push(new TextSqlNode({ text }));
          break;
        }
        case 'Include': {
          result.push(new IncludeNode({ refid: qualifyReference(node.refid, 'SQL_FRAGMENT', state.context, state.events, node) }));
          state.events.push(new ConversionEvent({
            grade: MigrationGrade.SAFE,
            code: 'INCLUDE_KEPT',
            message: `<include refid="${node.refid}"> kept as a MyBatis <include>`,
            sourceFile: node.sourceFile,
            sourceLine: node.sourceLine,
          }));
          break;
        }
        case 'Conditional': {
          const { node: ifNode, events } = this.conditionalConverter.convert(node, iterateStack);
          state.events.push(...events);
          let body = this._convertList(node.children, iterateStack, state);
          // iBATIS drops the prepend of whatever renders FIRST inside a prepend-bearing
          // conditional tag (the tag's own prepend already served as the connector). Which child that is
          // is only known at runtime, so the body goes in a <trim> whose prefixOverrides are the
          // prepends of the children that can come first (before any real text). An <include>
          // there may start with an AND/OR-prepended tag of its own.
          // a transparent conditional suppresses nothing itself — its parent's trim/<where> does
          const overrides = isTransparentConditional(node) ? [] : leadingPrepends(node.children);
          if (overrides.length) {
            const trim = new TrimNode({ prefixOverrides: overrides.join('|') });
            trim.children = body;
            body = [trim];
          }
          if (node.removeFirstPrepend || overrides.length) {
            state.events.push(new ConversionEvent({
              grade: MigrationGrade.SAFE,
              code: 'REMOVE_FIRST_PREPEND',
              message: overrides.length
                ? `first nested prepend dropped at runtime -> <trim prefixOverrides="${overrides.join('|')}">`
                : 'removeFirstPrepend has no nested prepend to remove here — nothing to convert',
              sourceFile: node.sourceFile,
              sourceLine: node.sourceLine,
            }));
          }
          // iBATIS renders prepend + open + body + close
          if (node.open) body = [new TextSqlNode({ text: node.open }), ...body];
          if (node.close) body = [...body, new TextSqlNode({ text: node.close })];
          ifNode.children = withConnector(node.prepend, body);
          result.push(ifNode);
          break;
        }
        case 'Iterate': {
          const itemName = this._nextItemName(state);
          const collection = resolveCollectionExpression(node.property, iterateStack);
          const { node: foreachNode, events } = this.iterateConverter.convert(node, itemName, collection);
          state.events.push(...events);
          foreachNode.children = this._convertList(node.children, [...iterateStack, { property: node.property, item: itemName }], state);
          // An <iterate prepend="AND"> needs its connector too, but a
          // sibling text node would render even when the collection is
          // empty (leaving a dangling AND). `open`/`close` only render
          // around actual items, so the connector rides along there.
          const connector = (node.prepend ?? '').trim();
          if (connector === ',') foreachNode.close = `${foreachNode.close ?? ''},`;
          else if (connector) foreachNode.open = `${connector} ${foreachNode.open ?? ''}`;
          result.push(foreachNode);
          break;
        }
        case 'Dynamic': {
          const { node: groupNode, events } = this.dynamicConverter.convert(node);
          state.events.push(...events);
          groupNode.children = this._convertList(node.children, iterateStack, state);
          result.push(groupNode);
          break;
        }
        case 'SelectKey': {
          const order = node.timing === 'pre' ? 'BEFORE' : 'AFTER';
          const selectKeyNode = new SelectKeyNode({ keyProperty: node.keyProperty, resultType: node.resultClass, order });
          selectKeyNode.children = this._convertList(node.children, iterateStack, state);
          state.events.push(new ConversionEvent({
            grade: MigrationGrade.SAFE,
            code: 'SELECT_KEY_CONVERTED',
            message: `<selectKey type="${node.timing}"> -> <selectKey order="${order}">`,
            sourceFile: node.sourceFile,
            sourceLine: node.sourceLine,
          }));
          result.push(selectKeyNode);
          break;
        }
        default:
          break;
      }
    }
    return result;
  }
}
