/**
 * Two small reference runtimes, for differential testing of the
 * iBATIS -> MyBatis converter: render a statement with a parameter object
 * the way iBATIS 2 would (from the ORIGINAL `ast/ibatis` tree) and the way
 * MyBatis 3 would (from the CONVERTED `ast/mybatis` tree). The same
 * parameters must give the same SQL and the same bound values.
 *
 * iBATIS rules modelled (the same rule `analyzer/sql/SqlFlattener` encodes):
 *  - a tag's `prepend` is written before its rendered body, unless it is
 *    the first non-empty content inside an enclosing `<dynamic>` / `isXxx`
 *    (then it is dropped); `open`/`close` wrap a non-empty body;
 *  - isNull/isNotNull, isEmpty/isNotEmpty (null, "", empty list),
 *    isEqual / isNotEqual / isGreaterXxx / isLessXxx against `compareValue` or
 *    `compareProperty` (a null side is "not comparable": only isNotEqual
 *    holds), isParameterPresent;
 *  - `<iterate>`: open + items joined by conjunction + close, nothing for
 *    an empty list; `#list[]#`, `#list[].x#` refer to the current item.
 *
 * MyBatis rules modelled: `<if test>` with an OGNL subset that keeps the
 * OGNL behaviours that bite migrations — a one-character '...' literal is a
 * Character, and comparing it with a String throws NumberFormatException;
 * `null` in a numeric comparison is 0; a List compared with '' is never
 * equal — plus `<where>`, `<set>`, `<trim>` (prefix/suffix overrides) and
 * `<foreach>` (nothing at all for an empty collection, an error for null).
 *
 * Output: { sql, params } with `?` for binds; `${}`/`$x$` substitute text.
 */

export class RenderError extends Error {}

const isMissing = (v) => v === undefined || v === null;

function getPath(root, path, scope = {}) {
  let value;
  const [head, ...rest] = path.split('.');
  if (head === '_parameter') value = root;
  else if (head in scope) value = scope[head];
  else value = root?.[head];
  for (const part of rest) value = value?.[part];
  return value;
}

// ------------------------------------------------------------------ iBATIS

function ibatisValue(expr, params, iterStack) {
  // `list[]` / `list[].x` / `g[].sub[]` -> the current item of the innermost enclosing iterate it names
  const name = expr.split(':')[0].split(',')[0].trim();
  if (name.includes('[]')) {
    for (let i = iterStack.length - 1; i >= 0; i--) {
      const { property, item } = iterStack[i];
      if (name === `${property}[]`) return item;
      if (name.startsWith(`${property}[].`)) return getPath(item, name.slice(property.length + 3));
    }
    throw new RenderError(`iBATIS: ${name} outside its iterate`);
  }
  if (name === 'value') return params;
  return getPath(params, name);
}

function ibatisText(text, params, iterStack, out) {
  return text.replace(/#([^#]+)#|\$([^$]+)\$/g, (_, bind, sub) => {
    if (bind !== undefined) {
      out.params.push(ibatisValue(bind, params, iterStack));
      return '?';
    }
    return String(ibatisValue(sub, params, iterStack) ?? '');
  });
}

function ibatisCompare(a, b) {
  if (isMissing(a) || isMissing(b)) return isMissing(a) && isMissing(b) ? 0 : null; // null = not comparable
  if (typeof a === 'number') {
    const nb = Number(b);
    if (Number.isNaN(nb)) throw new RenderError('iBATIS: compareValue not convertible');
    return a === nb ? 0 : a > nb ? 1 : -1;
  }
  return String(a) === String(b) ? 0 : String(a) > String(b) ? 1 : -1;
}

function ibatisCondition(node, params, iterStack) {
  const property = node.property ?? '';
  const value = node.conditionType === 'PARAMETER_PRESENT' || node.conditionType === 'NOT_PARAMETER_PRESENT' ? params : ibatisValue(property, params, iterStack);
  const empty = isMissing(value) || value === '' || (Array.isArray(value) && value.length === 0);
  const other = node.compareProperty ? ibatisValue(node.compareProperty, params, iterStack) : node.compareValue;
  switch (node.conditionType) {
    case 'IS_NULL': return isMissing(value);
    case 'IS_NOT_NULL': return !isMissing(value);
    case 'IS_EMPTY': return empty;
    case 'IS_NOT_EMPTY': return !empty;
    case 'PARAMETER_PRESENT': return !isMissing(params);
    case 'NOT_PARAMETER_PRESENT': return isMissing(params);
    case 'EQUAL': return ibatisCompare(value, other) === 0;
    case 'NOT_EQUAL': return ibatisCompare(value, other) !== 0;
    case 'GREATER_THAN': { const c = ibatisCompare(value, other); return c !== null && c > 0; }
    case 'GREATER_EQUAL': { const c = ibatisCompare(value, other); return c !== null && c >= 0; }
    case 'LESS_THAN': { const c = ibatisCompare(value, other); return c !== null && c < 0; }
    case 'LESS_EQUAL': { const c = ibatisCompare(value, other); return c !== null && c <= 0; }
    default: throw new RenderError(`iBATIS: unsupported ${node.conditionType}`);
  }
}

/**
 * Children of a container. `suppressFirst`: inside <dynamic> / a prepend-bearing
 * conditional / removeFirstPrepend, the first rendered tag's prepend is dropped.
 * Transparent: an <include> (inlined at parse time) and a conditional with no
 * prepend and no removeFirstPrepend share the enclosing container's "first
 * content" state (iBATIS 2.3 SqlTagContext: such a tag "looks to the parent").
 */
function ibatisChildren(nodes, ctx, suppressFirst) {
  return ibatisSpliced(nodes, ctx, suppressFirst, { emitted: false });
}

const isTransparent = (node) => node.type === 'Conditional' && !node.prepend && !node.removeFirstPrepend && !node.open && !node.close;

function ibatisSpliced(nodes, ctx, suppressFirst, state) {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'TextSql') {
      const text = ibatisText(node.text, ctx.params, ctx.iterStack, ctx.out);
      out += text;
      if (text.trim()) state.emitted = true;
    } else if (node.type === 'Include') {
      // iBATIS resolves every include of a statement — nested ones too — against the
      // STATEMENT's namespace (ctx.ns never changes while descending)
      const found = ctx.fragment(node.refid, ctx.ns);
      const fragment = found?.node ?? found;
      if (!fragment) continue; // missing: renders nothing
      if (ctx.includeStack.includes(fragment)) throw new RenderError('circular include'); // iBATIS overflows here
      ctx.includeStack.push(fragment);
      out += ibatisSpliced(fragment.children, ctx, suppressFirst, state);
      ctx.includeStack.pop();
    } else if (node.type === 'SelectKey') {
      continue;
    } else if (isTransparent(node)) {
      if (ibatisCondition(node, ctx.params, ctx.iterStack)) out += ibatisSpliced(node.children, ctx, suppressFirst, state);
    } else {
      const body = ibatisTag(node, ctx);
      if (!body.trim()) continue;
      out += node.prepend && !(suppressFirst && !state.emitted) ? ` ${node.prepend} ${body}` : ` ${body}`;
      state.emitted = true;
    }
  }
  return out;
}

function ibatisTag(node, ctx) {
  // params bound inside a tag only count if the tag renders: record and roll back
  const mark = ctx.out.params.length;
  let body = '';
  if (node.type === 'Dynamic') {
    body = ibatisChildren(node.children, ctx, true);
  } else if (node.type === 'Conditional') {
    if (!ibatisCondition(node, ctx.params, ctx.iterStack)) return '';
    body = ibatisChildren(node.children, ctx, true);
  } else if (node.type === 'Iterate') {
    const list = ibatisValue(node.property.includes('[]') ? node.property : node.property, ctx.params, ctx.iterStack);
    if (isMissing(list)) throw new RenderError(`iBATIS: iterate over null ${node.property}`);
    const items = [];
    for (const item of list) {
      ctx.iterStack.push({ property: node.property, item });
      items.push(ibatisChildren(node.children, ctx, false));
      ctx.iterStack.pop();
    }
    const nonEmpty = items.filter((s) => s.trim());
    if (!nonEmpty.length) {
      ctx.out.params.length = mark;
      return '';
    }
    return `${node.open ?? ''}${nonEmpty.join(` ${node.conjunction ?? ''} `)}${node.close ?? ''}`;
  } else {
    throw new RenderError(`iBATIS: unknown node ${node.type}`);
  }
  if (!body.trim()) {
    ctx.out.params.length = mark;
    return '';
  }
  return `${node.open ?? ''}${body}${node.close ?? ''}`;
}

export function renderIbatis(statement, params, fragment, namespace = null) {
  const ctx = { params, iterStack: [], out: { params: [] }, fragment, ns: namespace, includeStack: [] };
  const sql = ibatisChildren(statement.children, ctx, false);
  return { sql: normalize(sql), params: ctx.out.params };
}

// ------------------------------------------------------------------ OGNL (subset)

class Char {
  constructor(c) { this.c = c; }
}

function tokenizeOgnl(src) {
  const tokens = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|(==|!=|>=|<=|>|<|\(|\)|\.|,)|([A-Za-z_][\w]*))/y;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < src.length) {
    if (/^\s*$/.test(src.slice(re.lastIndex))) break;
    m = re.exec(src);
    if (!m) throw new RenderError(`OGNL: cannot parse "${src}"`);
    if (m[1] !== undefined) tokens.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ t: 'str', v: m[2].length === 1 ? new Char(m[2]) : m[2] }); // OGNL: 'x' is a Character
    else if (m[3] !== undefined) tokens.push({ t: 'str', v: m[3] });
    else if (m[4] !== undefined) tokens.push({ t: 'op', v: m[4] });
    else tokens.push({ t: 'id', v: m[5] });
  }
  return tokens;
}

function ognlNumber(v) {
  if (isMissing(v)) return 0; // OGNL: null in a numeric context is 0
  if (v instanceof Char) return v.c.charCodeAt(0);
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    if (v === '') return 0;
    const n = Number(v);
    if (Number.isNaN(n)) throw new RenderError(`OGNL NumberFormatException: For input string: "${v}"`);
    return n;
  }
  throw new RenderError('OGNL: not a number');
}

function ognlEqual(a, b) {
  if (a === b) return true;
  if (isMissing(a) || isMissing(b)) return isMissing(a) && isMissing(b);
  const numeric = (v) => typeof v === 'number' || v instanceof Char;
  if (Array.isArray(a) || Array.isArray(b)) return false; // a List is not Comparable: equals() only
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  if (numeric(a) || numeric(b)) return ognlNumber(a) === ognlNumber(b);
  return a === b;
}

/** Parses to thunks, so `and` / `or` short-circuit like OGNL (`l != null and l.size() > 0`). */
function evalOgnl(src, root, scope) {
  const tokens = tokenizeOgnl(src);
  let i = 0;
  const peek = () => tokens[i];
  const take = () => tokens[i++];
  const isWord = (w) => peek()?.t === 'id' && peek().v === w;

  const callMethod = (value, name) => {
    if (name === 'toString') {
      if (isMissing(value)) throw new RenderError('OGNL: toString on null');
      return value instanceof Char ? value.c : String(value);
    }
    if (name === 'size' || name === 'isEmpty') {
      if (!Array.isArray(value)) throw new RenderError(`OGNL: ${name}() on non-collection`);
      return name === 'size' ? value.length : value.length === 0;
    }
    throw new RenderError(`OGNL: method ${name}`);
  };

  function primary() {
    const tok = take();
    if (!tok) throw new RenderError(`OGNL: unexpected end in "${src}"`);
    let base;
    if (tok.t === 'num' || tok.t === 'str') { const v = tok.v; base = () => v; }
    else if (tok.t === 'op' && tok.v === '(') { base = or(); take(); }
    else if (tok.t === 'id' && tok.v === 'null') base = () => null;
    else if (tok.t === 'id' && (tok.v === 'true' || tok.v === 'false')) { const v = tok.v === 'true'; base = () => v; }
    else if (tok.t === 'id') { const name = tok.v; base = () => (name === '_parameter' ? root : name in scope ? scope[name] : root?.[name]); }
    else throw new RenderError(`OGNL: unexpected ${tok.v}`);
    // .property / .method()
    const steps = [];
    while (peek()?.v === '.') {
      take();
      const name = take().v;
      if (peek()?.v === '(') { take(); take(); steps.push({ call: name }); } else steps.push({ prop: name });
    }
    return () => steps.reduce((v, step) => (step.call ? callMethod(v, step.call) : v?.[step.prop]), base());
  }
  function comparison() {
    const left = primary();
    const op = peek();
    if (op?.t === 'op' && ['==', '!=', '>', '>=', '<', '<='].includes(op.v)) {
      take();
      const right = primary();
      const cmp = {
        '==': (a, b) => ognlEqual(a, b),
        '!=': (a, b) => !ognlEqual(a, b),
        '>': (a, b) => ognlNumber(a) > ognlNumber(b),
        '>=': (a, b) => ognlNumber(a) >= ognlNumber(b),
        '<': (a, b) => ognlNumber(a) < ognlNumber(b),
        '<=': (a, b) => ognlNumber(a) <= ognlNumber(b),
      }[op.v];
      return () => cmp(left(), right());
    }
    return left;
  }
  function and() {
    let left = comparison();
    while (isWord('and')) {
      take();
      const l = left;
      const r = comparison();
      left = () => Boolean(l()) && Boolean(r());
    }
    return left;
  }
  function or() {
    let left = and();
    while (isWord('or')) {
      take();
      const l = left;
      const r = and();
      left = () => Boolean(l()) || Boolean(r());
    }
    return left;
  }
  const thunk = or();
  if (i < tokens.length) throw new RenderError(`OGNL: trailing input in "${src}"`);
  return thunk();
}

// ------------------------------------------------------------------ MyBatis

function mybatisText(text, ctx) {
  return text.replace(/#\{([^}]*)\}|\$\{([^}]*)\}/g, (_, bind, sub) => {
    const expr = (bind ?? sub).split(',')[0].trim();
    const value = getPath(ctx.params, expr, ctx.scope);
    if (bind !== undefined) {
      ctx.out.params.push(value);
      return '?';
    }
    return String(value ?? '');
  });
}

function applyTrim(body, { prefix, suffix, prefixOverrides, suffixOverrides }) {
  let s = body.trim();
  if (!s) return '';
  const list = (v) => (v ? v.split('|') : []);
  for (const o of list(prefixOverrides)) {
    if (s.toUpperCase().startsWith(o.toUpperCase())) { s = s.slice(o.length); break; }
  }
  for (const o of list(suffixOverrides)) {
    if (s.toUpperCase().endsWith(o.toUpperCase())) { s = s.slice(0, s.length - o.length); break; }
  }
  return ` ${prefix ? `${prefix} ` : ''}${s}${suffix ? ` ${suffix}` : ''} `;
}

const WHERE_OVERRIDES = 'AND |OR |AND\n|OR\n|AND\r|OR\r|AND\t|OR\t';

function mybatisNodes(nodes, ctx) {
  let out = '';
  for (const node of nodes) out += mybatisNode(node, ctx);
  return out;
}

function mybatisNode(node, ctx) {
  switch (node.type) {
    case 'TextSql': return mybatisText(node.text, ctx);
    case 'Include': return mybatisNodes(ctx.fragment(node.refid).children, ctx);
    case 'SelectKey': return '';
    case 'If': return evalOgnl(node.test, ctx.params, ctx.scope) ? mybatisNodes(node.children, ctx) : '';
    case 'Where': return applyTrim(mybatisNodes(node.children, ctx), { prefix: 'WHERE', prefixOverrides: WHERE_OVERRIDES });
    case 'Set': return applyTrim(mybatisNodes(node.children, ctx), { prefix: 'SET', prefixOverrides: ',', suffixOverrides: ',' });
    case 'Trim': return applyTrim(mybatisNodes(node.children, ctx), node);
    case 'Foreach': {
      const list = getPath(ctx.params, node.collection, ctx.scope);
      if (isMissing(list)) throw new RenderError(`MyBatis: foreach collection "${node.collection}" is null`);
      if (!list.length) return '';
      const parts = list.map((item, index) => {
        const saved = ctx.scope;
        ctx.scope = { ...ctx.scope, [node.item]: item, ...(node.index ? { [node.index]: index } : {}) };
        const s = mybatisNodes(node.children, ctx);
        ctx.scope = saved;
        return s;
      });
      // the separator only goes between items that rendered something; open/close whenever the collection is non-empty
      return `${node.open ?? ''}${parts.filter((x) => x.trim()).join(node.separator ?? '')}${node.close ?? ''}`;
    }
    default: throw new RenderError(`MyBatis: unknown node ${node.type}`);
  }
}

export function renderMybatis(statement, params, fragment) {
  const ctx = { params, scope: {}, out: { params: [] }, fragment };
  const sql = mybatisNodes(statement.children, ctx);
  return { sql: normalize(sql), params: ctx.out.params };
}

/** whitespace-insensitive, and a connector or paren is spaced the same either way */
export function normalize(sql) {
  return sql.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s*,\s*/g, ', ').trim();
}
