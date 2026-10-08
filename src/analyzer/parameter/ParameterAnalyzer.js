import { ParameterUsage, ParameterBindingType, ParameterUsedIn } from './ParameterUsage.js';
import { parseInlineParameter } from '../../ast/ibatis/inlineParameter.js';

/**
 * Section 6 — Parameter Analyzer.
 *
 * Extracts `#prop#` / `$prop$` usages (including `#ids[]#` from
 * `<iterate>`) from a resolved statement tree, classifies each by
 * binding type and by which SQL clause it falls in, links it back to its
 * nearest enclosing standardized dynamic condition (if any), and flags
 * every `$...$` usage as a SQL-injection-risk warning.
 *
 * Clause tracking is a single left-to-right scan across the flattened
 * statement (a lightweight state machine keyed on clause keywords found in
 * literal SQL text), because the real SQL AST (`analyzer/sql`) doesn't
 * exist until section 7 — this keeps the two concerns decoupled per the
 * spec's "SQL 분석과 iBATIS 구조 분석을 분리한다" principle. A `<dynamic
 * prepend="WHERE|SET">` updates the clause even when its own text never
 * literally contains the word WHERE/SET, since iBATIS renders that prefix
 * only at generation time.
 */

const KEYWORD_TO_CLAUSE = {
  SELECT: ParameterUsedIn.SELECT,
  FROM: ParameterUsedIn.OTHER,
  WHERE: ParameterUsedIn.WHERE,
  JOIN: ParameterUsedIn.JOIN,
  'ORDER BY': ParameterUsedIn.ORDER_BY,
  'GROUP BY': ParameterUsedIn.GROUP_BY,
  HAVING: ParameterUsedIn.HAVING,
  VALUES: ParameterUsedIn.INSERT_VALUE,
  SET: ParameterUsedIn.UPDATE_SET,
};

// MyBatis `#{x}` / `${x}` (groups 6-9) before iBATIS `#x#` / `$x$`: `#{a}, #{b}` must not read as one `#...#`
const TOKEN_RE = /(#\{([^}]*)\})|(\$\{([^}]*)\})|(#([^#{]+)#)|(\$([^${]+)\$)|\b(SELECT|FROM|WHERE|ORDER\s+BY|GROUP\s+BY|HAVING|VALUES|SET|JOIN)\b/gi;

/** `#{prop,jdbcType=VARCHAR,javaType=...}` -> its property and jdbcType */
function parseMyBatisParameter(expression) {
  const [property, ...options] = expression.split(',').map((s) => s.trim());
  const jdbcType = options.map((o) => /^jdbcType\s*=\s*(\w+)$/i.exec(o)?.[1]).find(Boolean) ?? null;
  return { property, jdbcType, nullValue: null };
}

function deriveName(property) {
  return property.endsWith('[]') ? property.slice(0, -2) : property;
}

function mapPrependToClause(prepend, fallback) {
  const normalized = (prepend ?? '').trim().toUpperCase();
  if (normalized === 'WHERE') return ParameterUsedIn.WHERE;
  if (normalized === 'SET') return ParameterUsedIn.UPDATE_SET;
  return fallback;
}

function makeParameterUsage(expression, bindingType, clause, conditionStack, textNode, mybatis = false) {
  // `#prop:jdbcType:nullValue#` is one parameter with two extra fields,
  // not a property literally called "prop:jdbcType:nullValue".
  const inline = mybatis
    ? parseMyBatisParameter(expression)
    : bindingType === ParameterBindingType.HASH
      ? parseInlineParameter(expression)
      : { property: expression, jdbcType: null, nullValue: null };
  return new ParameterUsage({
    name: deriveName(inline.property),
    expression,
    jdbcType: inline.jdbcType,
    nullValue: inline.nullValue,
    bindingType,
    usedIn: clause,
    dynamicCondition: conditionStack.length > 0 ? conditionStack[conditionStack.length - 1] : null,
    sourceFragment: textNode.text.trim(),
    sourceFile: textNode.sourceFile,
    sourceLine: textNode.sourceLine,
  });
}

function makeRawSubstitutionWarning(usage, textNode) {
  return {
    severity: 'WARNING',
    code: 'RAW_SQL_SUBSTITUTION',
    parameter: usage.name,
    reason: 'raw SQL substitution',
    risk: 'SQL_INJECTION',
    message: `Parameter: ${usage.name}\nReason: raw SQL substitution\nRisk: SQL_INJECTION`,
    sourceFile: textNode.sourceFile,
    sourceLine: textNode.sourceLine,
  };
}

function scanText(textNode, clause, conditionStack) {
  const parameters = [];
  const warnings = [];
  let currentClause = clause;
  let match;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(textNode.text)) !== null) {
    if (match[1] !== undefined) {
      parameters.push(makeParameterUsage(match[2], ParameterBindingType.HASH, currentClause, conditionStack, textNode, true));
    } else if (match[3] !== undefined) {
      const usage = makeParameterUsage(match[4], ParameterBindingType.DOLLAR, currentClause, conditionStack, textNode, true);
      parameters.push(usage);
      warnings.push(makeRawSubstitutionWarning(usage, textNode));
    } else if (match[5] !== undefined) {
      parameters.push(makeParameterUsage(match[6], ParameterBindingType.HASH, currentClause, conditionStack, textNode));
    } else if (match[7] !== undefined) {
      const usage = makeParameterUsage(match[8], ParameterBindingType.DOLLAR, currentClause, conditionStack, textNode);
      parameters.push(usage);
      warnings.push(makeRawSubstitutionWarning(usage, textNode));
    } else if (match[9] !== undefined) {
      const keyword = match[9].replace(/\s+/g, ' ').toUpperCase();
      currentClause = KEYWORD_TO_CLAUSE[keyword] ?? currentClause;
    }
  }
  return { clause: currentClause, parameters, warnings };
}

function analyzeList(nodes, clause, conditionStack) {
  let currentClause = clause;
  const parameters = [];
  const warnings = [];

  for (const node of nodes) {
    switch (node.type) {
      case 'TextSql': {
        const result = scanText(node, currentClause, conditionStack);
        currentClause = result.clause;
        parameters.push(...result.parameters);
        warnings.push(...result.warnings);
        break;
      }
      case 'Dynamic':
      case 'ResolvedInclude': {
        const clauseForChildren = node.type === 'Dynamic' ? mapPrependToClause(node.prepend ?? node.trim?.prefix, currentClause) : currentClause;
        const result = analyzeList(node.children ?? [], clauseForChildren, conditionStack);
        currentClause = result.clause;
        parameters.push(...result.parameters);
        warnings.push(...result.warnings);
        break;
      }
      case 'Conditional': {
        const clauseForChildren = mapPrependToClause(node.prepend, currentClause);
        const nextStack = [
          ...conditionStack,
          { property: node.property, operator: node.conditionType, compareValue: node.compareValue, prepend: node.prepend },
        ];
        const result = analyzeList(node.children ?? [], clauseForChildren, nextStack);
        currentClause = result.clause;
        parameters.push(...result.parameters);
        warnings.push(...result.warnings);
        break;
      }
      case 'Iterate': {
        const clauseForChildren = mapPrependToClause(node.prepend, currentClause);
        const result = analyzeList(node.children ?? [], clauseForChildren, conditionStack);
        currentClause = result.clause;
        parameters.push(...result.parameters);
        warnings.push(...result.warnings);
        break;
      }
      case 'SelectKey': {
        // A <selectKey> body is its own embedded SQL statement — its
        // clause context must not leak into the surrounding insert/update.
        const result = analyzeList(node.children ?? [], ParameterUsedIn.OTHER, conditionStack);
        parameters.push(...result.parameters);
        warnings.push(...result.warnings);
        break;
      }
      default:
        // UnresolvedIncludeNode has no SQL content to scan; Include should
        // never appear in a resolved tree.
        break;
    }
  }

  return { clause: currentClause, parameters, warnings };
}

export class ParameterAnalyzer {
  /**
   * @param {object} resolvedStatementTree a StatementNode, typically the
   *   `resolvedTree` from ReferenceResolver#resolve
   * @returns {{ parameters: ParameterUsage[], warnings: object[] }}
   */
  analyze(resolvedStatementTree) {
    const { parameters, warnings } = analyzeList(resolvedStatementTree.children, ParameterUsedIn.OTHER, []);
    return { parameters, warnings };
  }
}
