/**
 * Random iBATIS 2 statements + parameter objects for the differential
 * runtime test (see runtimes.js). Shapes stick to what iBATIS defines
 * unambiguously; value types fit each condition (numbers for numeric
 * comparisons, strings / lists for emptiness), so a mismatch between the
 * two runtimes is a conversion bug, not a type-coercion corner both sides
 * would reject anyway.
 */
import { rng } from './sqlGrammar.js';

const STR = ['s1', 's2', 's3'];
const NUM = ['n1', 'n2'];
const LIST = ['l1', 'l2'];
const OBJ_LIST = ['g1'];

/** fragments the statements may include: a prepend-bearing conditional first, and plain text first */
const FRAGMENTS = `<sql id="fragA"><isNotEmpty property="s1" prepend="AND"> FA = #s1# </isNotEmpty><isNotNull property="n1" prepend="OR"> FB = #n1# </isNotNull></sql>
<sql id="fragB"><isNotNull property="s2" prepend="AND"> FC = #s2# </isNotNull></sql>`;

export function generateStatement(seed) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const chance = (p) => r() < p;
  let col = 0;
  const column = () => `C${++col}`;

  const cond = (depth, { parentHasPrepend, inIterate = null }) => {
    const k = Math.floor(r() * 11);
    // the prepend of a nested tag: only where the iBATIS rule is unambiguous
    const prepend = chance(0.85) ? pick(['AND', 'OR']) : null;
    const attr = (name, v) => (v === null || v === undefined ? '' : ` ${name}="${v}"`);
    const body = (prop) => ` ${column()} = #${prop}# `;
    const nested = () => (depth < 2 && chance(0.35) ? cond(depth + 1, { parentHasPrepend: Boolean(prepend), inIterate }) : '');
    const tag = (name, attrs, inner) => `<${name}${attrs}${attr('prepend', prepend)}>${inner}</${name}>`;
    if (depth < 2 && prepend && chance(0.15)) {
      // the FIRST content of a prepend-bearing tag is a nested tag with its own prepend:
      // iBATIS drops the nested prepend (the parent's already served as the connector)
      const p = pick(STR);
      return tag(pick(['isNotNull', 'isNotEmpty', 'isNull']), ` property="${p}"`, ` ${cond(depth + 1, { parentHasPrepend: true, inIterate })} ${column()} = #${p}# `);
    }
    if (depth < 2 && chance(0.12)) {
      // a prepend-LESS wrapper (isPropertyAvailable-style) around prepend-bearing tags:
      // transparent, so its children are first / not first in the enclosing tag
      const p = pick(STR);
      const wrapper = pick(['isNotNull', 'isNull', 'isNotEmpty']);
      const inner = Array.from({ length: 1 + Math.floor(r() * 2) }, () => cond(depth + 1, { parentHasPrepend: true, inIterate }));
      return `<${wrapper} property="${p}">${inner.join(' ')}</${wrapper}>`;
    }
    if (depth < 2 && chance(0.08)) {
      // an included fragment as the first content (iBATIS inlines it at parse time)
      return `<include refid="${pick(['fragA', 'fragB'])}"/>`;
    }
    if (inIterate && chance(0.5)) {
      // a condition on the current item inside <iterate property="g1">
      return tag(pick(['isNotEmpty', 'isNotNull']), ` property="${inIterate}[].x"`, ` X = #${inIterate}[].x# ${nested()}`);
    }
    switch (k) {
      case 0: { const p = pick(STR); return tag(pick(['isNull', 'isNotNull']), ` property="${p}"`, body(p) + nested()); }
      case 1: { const p = pick(STR); return tag(pick(['isEmpty', 'isNotEmpty']), ` property="${p}"`, body(p) + nested()); }
      case 2: { const p = pick(STR); return tag(pick(['isEqual', 'isNotEqual']), ` property="${p}" compareValue="${pick(['Y', 'N', 'AB'])}"`, body(p) + nested()); }
      case 3: { const p = pick(NUM); return tag(pick(['isEqual', 'isNotEqual', 'isGreaterThan', 'isGreaterEqual', 'isLessThan', 'isLessEqual']), ` property="${p}" compareValue="${pick(['0', '5', '10'])}"`, body(p) + nested()); }
      case 4: { const [a, b] = [pick(STR), pick(STR)]; return tag(pick(['isEqual', 'isNotEqual']), ` property="${a}" compareProperty="${b}"`, body(a) + nested()); }
      case 5: { const [a, b] = [pick(NUM), pick(NUM)]; return tag(pick(['isGreaterThan', 'isLessThan', 'isGreaterEqual', 'isLessEqual']), ` property="${a}" compareProperty="${b}"`, body(a) + nested()); }
      case 6: {
        // guarded IN list
        const l = pick(LIST);
        const iterPrepend = chance(0.3) ? ' prepend="AND"' : '';
        return tag('isNotEmpty', ` property="${l}"`, ` ${column()} IN <iterate property="${l}" open="(" close=")" conjunction=","${iterPrepend}>#${l}[]#</iterate> `);
      }
      case 7: {
        // iterate over objects, conjunction OR, with a condition inside and a nested iterate
        const g = pick(OBJ_LIST);
        return tag('isNotEmpty', ` property="${g}"`, ` <iterate property="${g}" open="(" close=")" conjunction="OR"> (G = #${g}[].x#${chance(0.5) ? ` <isNotEmpty property="${g}[].sub" prepend="AND"> S IN <iterate property="${g}[].sub" open="(" close=")" conjunction=",">#${g}[].sub[]#</iterate></isNotEmpty>` : ''}) </iterate> `);
      }
      case 8: { const p = pick(STR); return tag('isNotEmpty', ` property="${p}"`, ` ${column()} LIKE '%' || #${p}# || '%' ${nested()}`); }
      case 9: { const p = pick(STR); return tag('isNotEmpty', ` property="${p}" open="(" close=")"`, body(p) + nested()); }
      default: return tag('isParameterPresent', '', ` ${column()} = 1 ${nested()}`);
    }
  };

  const kind = pick(['where', 'where', 'whereNoDynamic', 'set', 'nestedDynamic', 'openClose']);
  let body;
  if (kind === 'set') {
    const sets = Array.from({ length: 1 + Math.floor(r() * 4) }, () => {
      const p = pick([...STR, ...NUM]);
      return `<isNotNull property="${p}" prepend=","> ${column()} = #${p}# </isNotNull>`;
    });
    body = `UPDATE T <dynamic prepend="SET">${sets.join('\n')}</dynamic> WHERE ID = #id#`;
  } else {
    const n = 1 + Math.floor(r() * 4);
    const conds = Array.from({ length: n }, () => cond(0, { parentHasPrepend: true }));
    if (kind === 'whereNoDynamic') body = `SELECT * FROM T WHERE 1 = 1 ${conds.map((c) => (c.includes('prepend=') ? c : c)).join('\n')}`;
    else if (kind === 'nestedDynamic') body = `SELECT * FROM T <dynamic prepend="WHERE">${conds[0]} <dynamic prepend="AND">${conds.slice(1).join('\n') || cond(0, { parentHasPrepend: true })}</dynamic></dynamic>`;
    else if (kind === 'openClose') body = `SELECT * FROM T <dynamic prepend="WHERE" open="(" close=")">${conds.join('\n')}</dynamic>`;
    else body = `SELECT * FROM T <dynamic prepend="WHERE">${conds.join('\n')}</dynamic>`;
  }
  const tag = kind === 'set' ? 'update' : 'select';
  return {
    kind,
    xml: `<?xml version="1.0" encoding="UTF-8"?>\n<sqlMap namespace="fz">\n${FRAGMENTS}\n<${tag} id="s${seed}" parameterClass="map">\n${body}\n</${tag}>\n</sqlMap>\n`,
  };
}

export function generateParams(seed) {
  const r = rng(seed * 7919 + 13);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const params = { id: 1 };
  for (const p of STR) { const v = pick(['', 'Y', 'N', 'AB', null, undefined]); if (v !== undefined) params[p] = v; }
  for (const p of NUM) { const v = pick([0, 5, 10, 7, null, undefined]); if (v !== undefined) params[p] = v; }
  for (const p of LIST) {
    const v = pick([undefined, [], [1], [1, 2, 3]]);
    if (v !== undefined) params[p] = v;
  }
  for (const p of OBJ_LIST) {
    const v = pick([undefined, [], [{ x: 1, sub: [5, 6] }, { x: 2, sub: [] }], [{ x: null, sub: [7] }]]);
    if (v !== undefined) params[p] = v;
  }
  return params;
}
