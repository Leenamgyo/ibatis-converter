import { WhereNode, SetNode, TrimNode } from '../../ast/mybatis/nodes.js';
import { ConversionEvent, MigrationGrade } from './ConversionEvent.js';

function directChildPrepends(dynamicNode, children = dynamicNode.children, tokens = new Set()) {
  for (const child of children) {
    // a prepend-less conditional is transparent: its own children can render first
    if (child.type === 'Conditional' && !child.prepend?.trim() && !child.removeFirstPrepend && !child.open && !child.close) {
      directChildPrepends(dynamicNode, child.children, tokens);
      continue;
    }
    if ((child.type === 'Dynamic' || child.type === 'Conditional' || child.type === 'Iterate') && child.prepend) {
      tokens.add(child.prepend.trim().toUpperCase());
    }
    // an included fragment is inlined by iBATIS: its own leading AND/OR-prepended tag counts too
    if (child.type === 'Include') {
      if ((dynamicNode.prepend ?? '').trim().toUpperCase() === 'SET') tokens.add(',');
      else {
        tokens.add('AND');
        tokens.add('OR');
      }
    }
  }
  return tokens;
}

function buildPrefixOverrides(tokens) {
  return [...tokens].map((t) => `${t} `).join('|');
}

/**
 * Section 14 — decides whether a `<dynamic prepend="...">` becomes a
 * MyBatis `<where>`, `<set>`, or an explicit `<trim>`, based on the
 * connector tokens its own direct children actually use (not a blind
 * string substitution):
 *
 *  - `prepend="WHERE"` with every child prepend in {AND, OR} -> `<where>`
 *    (MyBatis's `<where>` already strips a leading AND/OR itself, which is
 *    exactly the runtime effect iBATIS's own prepend-suppression achieves)
 *  - `prepend="SET"` with every child prepend in {","} -> `<set>`
 *  - anything else (an unexpected connector token mixed in, or a nested
 *    group with a custom prepend like "AND") -> an explicit `<trim>` with
 *    `prefix`/`prefixOverrides` computed from the tokens actually observed
 *
 * The `<where>`/`<set>` cases are SAFE (the mapping is behaviorally
 * equivalent, not just textually similar). A faithfully-inferred `<trim>`
 * for a group that was never claiming to be WHERE/SET in the first place
 * (a nested `<dynamic prepend="AND">`, say) is also SAFE — the connector
 * tokens it's built from are actually observed, not guessed. Only a
 * `WHERE`/`SET` group whose children use a connector *outside* its
 * expected set ({AND, OR} / {","}) is WARNING-graded, since that's a real
 * deviation from the common idiom worth a human glance.
 */
export class DynamicConverter {
  /**
   * @param {import('../../ast/ibatis/nodes.js').DynamicNode} dynamicNode
   * @returns {{ node: WhereNode|SetNode|TrimNode, events: ConversionEvent[] }}
   */
  convert(dynamicNode) {
    const { sourceFile, sourceLine } = dynamicNode;
    const prepend = (dynamicNode.prepend ?? '').trim().toUpperCase();
    const observed = directChildPrepends(dynamicNode);

    // iBATIS `open`/`close` wrap the body only when it renders: `WHERE (a AND b)`.
    // `<where>`/`<set>` can't add them, a `<trim>` can — prefix and suffix render
    // only for a non-empty body too.
    if (dynamicNode.open || dynamicNode.close) {
      const prefix = [dynamicNode.prepend, dynamicNode.open].filter(Boolean).join(' ');
      const overrides = observed.size ? buildPrefixOverrides(observed) : null;
      return {
        node: new TrimNode({ prefix: prefix || null, suffix: dynamicNode.close ?? null, prefixOverrides: overrides }),
        events: [new ConversionEvent({
          grade: MigrationGrade.SAFE,
          code: 'DYNAMIC_OPEN_CLOSE_TO_TRIM',
          message: `<dynamic prepend="${dynamicNode.prepend ?? ''}" open="${dynamicNode.open ?? ''}" close="${dynamicNode.close ?? ''}"> -> <trim prefix="${prefix}" suffix="${dynamicNode.close ?? ''}"${overrides ? ` prefixOverrides="${overrides}"` : ''}>`,
          sourceFile,
          sourceLine,
        })],
      };
    }

    if (prepend === 'WHERE' && [...observed].every((t) => t === 'AND' || t === 'OR')) {
      return {
        node: new WhereNode(),
        events: [new ConversionEvent({ grade: MigrationGrade.SAFE, code: 'DYNAMIC_TO_WHERE', message: '<dynamic prepend="WHERE"> -> <where>', sourceFile, sourceLine })],
      };
    }
    if (prepend === 'SET' && [...observed].every((t) => t === ',')) {
      return {
        node: new SetNode(),
        events: [new ConversionEvent({ grade: MigrationGrade.SAFE, code: 'DYNAMIC_TO_SET', message: '<dynamic prepend="SET"> -> <set>', sourceFile, sourceLine })],
      };
    }

    const trim = new TrimNode({
      prefix: dynamicNode.prepend ?? null,
      prefixOverrides: observed.size > 0 ? buildPrefixOverrides(observed) : null,
    });
    const isUnexpectedForKnownGroup = (prepend === 'WHERE' || prepend === 'SET') && observed.size > 0;
    return {
      node: trim,
      events: [new ConversionEvent({
        grade: isUnexpectedForKnownGroup ? MigrationGrade.WARNING : MigrationGrade.SAFE,
        code: 'DYNAMIC_TRIM_INFERENCE',
        message: isUnexpectedForKnownGroup
          ? `<dynamic prepend="${dynamicNode.prepend}"> has a child connector outside {${prepend === 'WHERE' ? 'AND, OR' : ','}} (found: ${[...observed].join(', ')}) — inferred <trim prefix="${dynamicNode.prepend}" prefixOverrides="${buildPrefixOverrides(observed)}">, please verify`
          : `<dynamic prepend="${dynamicNode.prepend ?? ''}"> is not a WHERE/SET group — inferred <trim prefix="${dynamicNode.prepend ?? ''}" prefixOverrides="${observed.size ? buildPrefixOverrides(observed) : '(none)'}">`,
        sourceFile,
        sourceLine,
      })],
    };
  }
}
