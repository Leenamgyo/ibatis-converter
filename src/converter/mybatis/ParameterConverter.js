import { ConversionEvent, MigrationGrade } from './ConversionEvent.js';
import { parseInlineParameter } from '../../ast/ibatis/inlineParameter.js';

const TOKEN_RE = /#([^#]+)#|\$([^$]+)\$/g;

/**
 * Section 12 — `#prop#` -> `#{prop}`, `$prop$` -> `${prop}` (always
 * converted, but every `${...}` also raises a WARNING-grade
 * RAW_SQL_SUBSTITUTION event since it's a literal SQL splice, not a bind
 * parameter).
 *
 * iBATIS's inline `#prop:jdbcType#` / `#prop:jdbcType:nullValue#` forms
 * are mapped to MyBatis's own attribute syntax (`#{prop,jdbcType=X}`) —
 * copying the colon form through would emit `#{prop:jdbcType}`, which
 * MyBatis does not understand and which only fails at runtime. MyBatis
 * has no per-parameter `nullValue`, so that third field is dropped with a
 * MANUAL event rather than silently ignored.
 *
 * `#ids[]#`-style iterate item references need the enclosing `<iterate>`
 * chain to resolve correctly (the loop variable's MyBatis name isn't
 * "ids", it's whatever `IterateConverter` assigned as `item`) — see
 * `resolveExpression` below and `converter/mybatis/IterateConverter.js`.
 */
export function resolveExpression(expression, iterateStack) {
  for (let i = iterateStack.length - 1; i >= 0; i--) {
    const { property, item } = iterateStack[i];
    if (expression === `${property}[]`) return item;
    if (expression.startsWith(`${property}[].`)) return `${item}.${expression.slice(property.length + 3)}`;
  }
  return expression;
}

/**
 * Resolves a NESTED `<iterate>`'s own `property` (e.g. `"groups[].subIds"`,
 * meaning "subIds of the current item while iterating groups") into the
 * MyBatis `<foreach collection="...">` value, which must be an OGNL
 * expression relative to the CURRENT scope — i.e. `"item.subIds"`, not the
 * original iBATIS bracket path (which isn't valid OGNL at that nesting
 * level; "groups" isn't in scope once you're inside the outer `<foreach>`).
 * A top-level `<iterate>`'s `property` needs no resolution and is returned
 * as-is.
 */
export function resolveCollectionExpression(property, iterateStack) {
  for (let i = iterateStack.length - 1; i >= 0; i--) {
    const { property: outerProperty, item } = iterateStack[i];
    const prefix = `${outerProperty}[].`;
    if (property.startsWith(prefix)) return `${item}.${property.slice(prefix.length)}`;
  }
  return property;
}

export class ParameterConverter {
  /**
   * @param {string} text raw SQL text possibly containing #x# / $x$ tokens
   * @param {{ property: string, item: string }[]} [iterateStack] enclosing
   *   `<iterate>` scopes (outermost first), so `#prop[]#` maps to the
   *   correct MyBatis `<foreach item="...">` variable
   * @param {{ sourceFile: string|null, sourceLine: number|null }} [location]
   * @returns {{ text: string, events: ConversionEvent[] }}
   */
  convert(text, iterateStack = [], location = {}) {
    const events = [];
    const converted = text.replace(TOKEN_RE, (match, hashExpr, dollarExpr) => {
      if (hashExpr !== undefined) {
        const { property, jdbcType, nullValue } = parseInlineParameter(hashExpr);
        const resolved = resolveExpression(property, iterateStack);
        const binding = jdbcType ? `#{${resolved},jdbcType=${jdbcType}}` : `#{${resolved}}`;
        events.push(new ConversionEvent({
          grade: MigrationGrade.SAFE,
          code: 'HASH_PARAMETER',
          message: `#${hashExpr}# -> ${binding}`,
          sourceFile: location.sourceFile,
          sourceLine: location.sourceLine,
        }));
        if (nullValue !== null) {
          events.push(new ConversionEvent({
            grade: MigrationGrade.MANUAL,
            code: 'UNSUPPORTED_NULL_VALUE',
            message: `#${hashExpr}# carries nullValue="${nullValue}", which MyBatis has no inline equivalent for — handle it with a typeHandler or by defaulting the value before the call`,
            sourceFile: location.sourceFile,
            sourceLine: location.sourceLine,
          }));
        }
        return binding;
      }
      const resolved = resolveExpression(dollarExpr, iterateStack);
      events.push(new ConversionEvent({
        grade: MigrationGrade.WARNING,
        code: 'RAW_SQL_SUBSTITUTION',
        message: `$${dollarExpr}$ -> \${${resolved}} is a literal SQL splice, not a bind parameter — verify it cannot carry attacker-controlled input (SQL injection risk)`,
        sourceFile: location.sourceFile,
        sourceLine: location.sourceLine,
      }));
      return `\${${resolved}}`;
    });
    return { text: converted, events };
  }
}
