/**
 * Deterministic generator for a ~2000-line iBATIS mapper used as a
 * large-scale oracle test for converter/schema.
 *
 * Every statement is written once from a template whose table/column names
 * are placeholders, then rendered twice:
 *   - LEGACY: the old names  -> what the migration tool is fed
 *   - TARGET: the new names  -> what a person would have written by hand
 * If the schema migration is right, migrating LEGACY gives exactly the
 * same MyBatis XML as converting TARGET without any migration.
 *
 * Text that must NOT be migrated (string literals, comments, hints,
 * unmapped tables, `$...$`) is written literally, so it is the same in both.
 */

export const TABLES = {
  TB_CUST_M: {
    target: 'CUSTOMER', alias: 'C',
    columns: { CUST_NO: 'CUSTOMER_ID', CUST_NM: 'CUSTOMER_NAME', RGN_CD: 'REGION_CODE', USE_YN: 'IS_ACTIVE', REG_DT: 'CREATED_AT' },
    extra: ['TEL_NO', 'EMAIL'], key: 'CUST_NO',
  },
  TB_ORD_H: {
    target: 'ORDERS', alias: 'H',
    columns: { ORD_NO: 'ORDER_ID', CUST_NO: 'CUSTOMER_ID', ORD_DT: 'ORDERED_AT', ORD_STAT_CD: 'STATUS', TOT_AMT: 'TOTAL_AMOUNT' },
    extra: ['REG_ID', 'UPD_DT'], key: 'ORD_NO',
  },
  TB_ORD_D: {
    target: 'ORDER_ITEM', alias: 'D',
    columns: { ORD_NO: 'ORDER_ID', ITEM_SEQ: 'LINE_NO', PRD_CD: 'PRODUCT_ID', ORD_QTY: 'QUANTITY', UNIT_PRC: 'UNIT_PRICE' },
    extra: ['DC_AMT'], key: 'ITEM_SEQ',
  },
  TB_PRD_M: {
    target: 'PRODUCT', alias: 'P',
    columns: { PRD_CD: 'PRODUCT_ID', PRD_NM: 'PRODUCT_NAME', CTG_CD: 'CATEGORY_CODE', USE_YN: 'IS_SELLABLE' },
    extra: ['SALE_PRC'], key: 'PRD_CD',
  },
  TB_CMM_CD: {
    target: 'COMMON_CODE', alias: 'CC',
    columns: { GRP_CD: 'GROUP_CODE', CD: 'CODE', CD_NM: 'CODE_NAME', SORT_SEQ: 'SORT_ORDER' },
    extra: ['RMK'], key: 'CD',
  },
  'LEGACY.TB_PAY_H': {
    target: 'BILLING.PAYMENT', alias: 'PY',
    columns: { PAY_NO: 'PAYMENT_ID', ORD_NO: 'ORDER_ID', PAY_AMT: 'AMOUNT', PAY_DT: 'PAID_AT' },
    extra: ['PAY_MTHD_CD'], key: 'PAY_NO',
  },
};

export function mappingJson() {
  return Object.fromEntries(Object.entries(TABLES).map(([name, t]) => [name, { targetTable: t.target, columns: t.columns }]));
}

/** join edges: [left, right, [[leftCol, rightCol], ...]] */
const JOINS = [
  ['TB_ORD_H', 'TB_CUST_M', [['CUST_NO', 'CUST_NO']]],
  ['TB_ORD_H', 'TB_ORD_D', [['ORD_NO', 'ORD_NO']]],
  ['TB_ORD_D', 'TB_PRD_M', [['PRD_CD', 'PRD_CD']]],
  ['TB_ORD_H', 'LEGACY.TB_PAY_H', [['ORD_NO', 'ORD_NO']]],
  ['TB_ORD_H', 'TB_CMM_CD', [['ORD_STAT_CD', 'CD']]],
];

// ---- placeholders -------------------------------------------------------
const T = (table) => `«T:${table}»`;
const Col = (table, column) => `«C:${table}:${column}»`;

export function render(text, version) {
  return text.replace(/«T:([^»]+)»/g, (_, table) => (version === 'TARGET' ? TABLES[table].target : table))
    .replace(/«C:([^:»]+):([^»]+)»/g, (_, table, column) =>
      (version === 'TARGET' ? TABLES[table].columns[column] ?? column : column));
}

// ---- seeded RNG ---------------------------------------------------------
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const camel = (column) => column.toLowerCase().replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());

export function generateLargeMapper({ seed = 20261007, minLines = 2000 } = {}) {
  const random = rng(seed);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const chance = (p) => random() < p;
  const sample = (list, n) => [...list].sort(() => random() - 0.5).slice(0, Math.max(1, Math.min(n, list.length)));
  const tableNames = Object.keys(TABLES);
  const allColumns = (table) => [...Object.keys(TABLES[table].columns), ...TABLES[table].extra];
  const ref = (table, column, alias) => (alias ? `${alias}.${Col(table, column)}` : Col(table, column));

  let counter = 0;
  const id = (prefix) => `${prefix}${String(++counter).padStart(3, '0')}`;
  const blocks = [];
  const fragments = [];

  // a column-list fragment per table (always included under the table's fixed alias),
  // and an unqualified filter fragment per table (only included by single-table statements)
  for (const table of tableNames) {
    const { alias } = TABLES[table];
    const name = table.replace(/^LEGACY\./, '').replace(/^TB_/, '').toLowerCase();
    const cols = allColumns(table).map((c) => `${ref(table, c, alias)} AS ${camel(c)}`);
    fragments.push(`  <sql id="cols_${name}">\n    ${cols.join(',\n    ')}\n  </sql>`);
    const filterCol = pick(Object.keys(TABLES[table].columns));
    fragments.push(`  <sql id="filter_${name}">
    <isNotEmpty property="${camel(filterCol)}" prepend="AND">
      ${Col(table, filterCol)} = #${camel(filterCol)}#
    </isNotEmpty>
  </sql>`);
    TABLES[table].fragmentName = name;
  }

  const where = (table, alias) => {
    const conditions = [`${ref(table, TABLES[table].key, alias)} = #${camel(TABLES[table].key)}#`];
    if (chance(0.5)) conditions.push(`${ref(table, pick(allColumns(table)), alias)} IS NOT NULL`);
    if (chance(0.3)) conditions.push(`${ref(table, pick(Object.keys(TABLES[table].columns)), alias)} &lt;&gt; 'TB_ORD_H.ORD_NO'`);
    return conditions.join('\n       AND ');
  };

  const generators = {
    selectByKey() {
      const table = pick(tableNames);
      const alias = chance(0.6) ? TABLES[table].alias : null;
      const items = sample(allColumns(table), 2 + Math.floor(random() * 4))
        .map((c) => (chance(0.7) ? `${ref(table, c, alias)} AS ${camel(c)}` : ref(table, c, alias)));
      return { kind: 'select', id: id('selectByKey'), body: `
    -- 레거시 ${table} 단건 조회
    SELECT ${items.join(',\n           ')}
      FROM ${T(table)}${alias ? ` ${alias}` : ''}
     WHERE ${where(table, alias)}` };
    },

    joinSelect() {
      const used = ['TB_ORD_H'];
      const lines = [];
      for (const [left, right, on] of sample(JOINS, 1 + Math.floor(random() * 4))) {
        const [from, to] = used.includes(left) ? [left, right] : used.includes(right) ? [right, left] : [null, null];
        if (!from || used.includes(to)) continue;
        used.push(to);
        const conds = on.map(([l, r]) => (from === left
          ? `${ref(to, r, TABLES[to].alias)} = ${ref(from, l, TABLES[from].alias)}`
          : `${ref(to, l, TABLES[to].alias)} = ${ref(from, r, TABLES[from].alias)}`));
        if (to === 'TB_CMM_CD') conds.push(`${ref(to, 'GRP_CD', 'CC')} = 'ORD_STAT'`);
        lines.push(`${pick(['INNER JOIN', 'LEFT OUTER JOIN', 'JOIN'])} ${T(to)} ${TABLES[to].alias} ON ${conds.join(' AND ')}`);
      }
      if (chance(0.3)) lines.push('LEFT JOIN TB_LOG L ON L.ORD_NO = H.' + Col('TB_ORD_H', 'ORD_NO'));
      const items = used.flatMap((t) => sample(allColumns(t), 2).map((c) => `${ref(t, c, TABLES[t].alias)} AS ${camel(c)}${t === 'TB_ORD_H' ? '' : TABLES[t].alias}`));
      if (lines.some((l) => l.includes('TB_LOG'))) items.push('L.MSG AS logMsg');
      return { kind: 'select', id: id('joinSelect'), body: `
    SELECT ${items.join(',\n           ')}
      FROM ${T('TB_ORD_H')} H
     ${lines.join('\n     ')}
     WHERE ${ref('TB_ORD_H', 'ORD_DT', 'H')} &gt;= #fromDt#
     ORDER BY ${ref('TB_ORD_H', 'ORD_NO', 'H')} DESC` };
    },

    dynamicSearch() {
      const table = pick(tableNames);
      const alias = chance(0.5) ? TABLES[table].alias : null;
      const conds = sample(allColumns(table), 2 + Math.floor(random() * 3)).map((c) => {
        const kind = pick(['isNotEmpty', 'isNotNull', 'isEqual', 'cdata']);
        if (kind === 'isEqual') return `      <isEqual property="${camel(c)}Flag" compareValue="Y" prepend="AND">\n        ${ref(table, c, alias)} IS NOT NULL\n      </isEqual>`;
        if (kind === 'cdata') return `      <isNotEmpty property="${camel(c)}From" prepend="AND">\n        <![CDATA[ ${ref(table, c, alias)} >= #${camel(c)}From# ]]>\n      </isNotEmpty>`;
        return `      <${kind} property="${camel(c)}" prepend="AND">\n        ${ref(table, c, alias)} = #${camel(c)}#\n      </${kind}>`;
      });
      const inCol = pick(Object.keys(TABLES[table].columns));
      conds.push(`      <isNotEmpty property="${camel(inCol)}List" prepend="AND">
        ${ref(table, inCol, alias)} IN
        <iterate property="${camel(inCol)}List" open="(" close=")" conjunction=",">#${camel(inCol)}List[]#</iterate>
      </isNotEmpty>`);
      const sort = chance(0.4) ? '\n    ORDER BY $sortColumn$' : '';
      return { kind: 'select', id: id('search'), body: `
    SELECT ${alias ? `<include refid="cols_${TABLES[table].fragmentName}"/>` : sample(allColumns(table), 3).map((c) => Col(table, c)).join(', ')}
      FROM ${T(table)}${alias ? ` ${alias}` : ''}
    <dynamic prepend="WHERE">
${conds.join('\n')}
    </dynamic>${sort}` };
    },

    filterFragment() {
      const table = pick(tableNames);
      return { kind: 'select', id: id('countWithFilter'), body: `
    SELECT COUNT(*)
      FROM ${T(table)}
     WHERE 1 = 1
     <include refid="filter_${TABLES[table].fragmentName}"/>` };
    },

    insert() {
      const table = pick(tableNames);
      const cols = allColumns(table);
      const selectKey = table === 'TB_ORD_H' ? `
    <selectKey keyProperty="ordNo" resultClass="string" type="pre">
      SELECT 'O' || LPAD(SEQ_ORD_NO.NEXTVAL, 9, '0') FROM DUAL
    </selectKey>` : '';
      return { kind: 'insert', id: id('insert'), body: `${selectKey}
    INSERT INTO ${T(table)} (
      ${cols.map((c) => Col(table, c)).join(', ')}
    ) VALUES (
      ${cols.map((c) => `#${camel(c)}#`).join(', ')}
    )` };
    },

    insertSelect() {
      return { kind: 'insert', id: id('copyItems'), body: `
    INSERT INTO ${T('TB_ORD_D')} (${['ORD_NO', 'ITEM_SEQ', 'PRD_CD', 'ORD_QTY', 'UNIT_PRC'].map((c) => Col('TB_ORD_D', c)).join(', ')})
    SELECT #newOrdNo#, S.${Col('TB_ORD_D', 'ITEM_SEQ')}, S.${Col('TB_ORD_D', 'PRD_CD')}, S.${Col('TB_ORD_D', 'ORD_QTY')}, P.SALE_PRC
      FROM ${T('TB_ORD_D')} S
      JOIN ${T('TB_PRD_M')} P ON P.${Col('TB_PRD_M', 'PRD_CD')} = S.${Col('TB_ORD_D', 'PRD_CD')}
     WHERE S.${Col('TB_ORD_D', 'ORD_NO')} = #srcOrdNo#
       AND P.${Col('TB_PRD_M', 'USE_YN')} = 'Y'` };
    },

    updateDynamicSet() {
      const table = pick(tableNames);
      const sets = sample(allColumns(table).filter((c) => c !== TABLES[table].key), 3)
        .map((c) => `      <isNotNull property="${camel(c)}" prepend=",">${Col(table, c)} = #${camel(c)}#</isNotNull>`);
      return { kind: 'update', id: id('update'), body: `
    UPDATE ${T(table)}
    <dynamic prepend="SET">
${sets.join('\n')}
    </dynamic>
     WHERE ${Col(table, TABLES[table].key)} = #${camel(TABLES[table].key)}#` };
    },

    updateCorrelated() {
      return { kind: 'update', id: id('refreshTotal'), body: `
    UPDATE ${T('TB_ORD_H')} H
       SET H.${Col('TB_ORD_H', 'TOT_AMT')} = (SELECT SUM(D.${Col('TB_ORD_D', 'ORD_QTY')} * D.${Col('TB_ORD_D', 'UNIT_PRC')})
                         FROM ${T('TB_ORD_D')} D
                        WHERE D.${Col('TB_ORD_D', 'ORD_NO')} = H.${Col('TB_ORD_H', 'ORD_NO')}),
           H.UPD_DT = SYSDATE
     WHERE H.${Col('TB_ORD_H', 'ORD_NO')} = #ordNo#` };
    },

    deleteSubquery() {
      return { kind: 'delete', id: id('deleteOrphan'), body: `
    DELETE FROM ${T('TB_ORD_D')} D
     WHERE NOT EXISTS (SELECT 1 FROM ${T('TB_ORD_H')} H WHERE H.${Col('TB_ORD_H', 'ORD_NO')} = D.${Col('TB_ORD_D', 'ORD_NO')})
        OR D.${Col('TB_ORD_D', 'PRD_CD')} IN (SELECT ${Col('TB_PRD_M', 'PRD_CD')} FROM ${T('TB_PRD_M')} WHERE ${Col('TB_PRD_M', 'USE_YN')} = 'N')` };
    },

    derivedAggregate() {
      const table = pick(['TB_ORD_H', 'TB_ORD_D', 'LEGACY.TB_PAY_H']);
      const group = pick(Object.keys(TABLES[table].columns));
      const sum = pick(Object.keys(TABLES[table].columns).filter((c) => c !== group));
      return { kind: 'select', id: id('aggregate'), body: `
    SELECT T.${Col(table, group)}, T.CNT, T.MAX_VAL AS maxVal
      FROM (
            SELECT ${Col(table, group)}, COUNT(*) AS CNT, MAX(${Col(table, sum)}) AS MAX_VAL
              FROM ${T(table)}
             GROUP BY ${Col(table, group)}
           ) T
     WHERE T.CNT &gt; #minCnt#
     ORDER BY T.CNT DESC` };
    },

    cte() {
      const table = pick(tableNames);
      const cols = sample(Object.keys(TABLES[table].columns), 2);
      return { kind: 'select', id: id('cte'), body: `
    WITH BASE AS (
      SELECT ${cols.map((c) => Col(table, c)).join(', ')}
        FROM ${T(table)}
       WHERE ${Col(table, TABLES[table].key)} IS NOT NULL
    )
    SELECT ${cols.map((c) => `B.${Col(table, c)} AS ${camel(c)}`).join(', ')}
      FROM BASE B` };
    },

    unionSelect() {
      const table = pick(tableNames);
      const [a, b] = sample(Object.keys(TABLES[table].columns), 2);
      return { kind: 'select', id: id('union'), body: `
    SELECT ${Col(table, a)} AS v, 'A' AS src FROM ${T(table)} WHERE ${Col(table, b)} IS NOT NULL
    UNION ALL
    SELECT ${Col(table, b)} AS v, 'B' AS src FROM ${T(table)} WHERE ${Col(table, a)} IS NULL` };
    },

    scalarAndExists() {
      return { kind: 'select', id: id('customerSummary'), body: `
    SELECT /*+ INDEX(TB_CUST_M IDX_CUST_01) */
           C.${Col('TB_CUST_M', 'CUST_NO')} AS custNo,
           (SELECT COUNT(*) FROM ${T('TB_ORD_H')} H WHERE H.${Col('TB_ORD_H', 'CUST_NO')} = C.${Col('TB_CUST_M', 'CUST_NO')}) AS ordCnt
      FROM ${T('TB_CUST_M')} C
     WHERE EXISTS (SELECT 1 FROM ${T('TB_ORD_H')} H2
                    WHERE H2.${Col('TB_ORD_H', 'CUST_NO')} = C.${Col('TB_CUST_M', 'CUST_NO')}
                      AND H2.${Col('TB_ORD_H', 'ORD_STAT_CD')} = '90')
       AND C.${Col('TB_CUST_M', 'USE_YN')} = 'Y'` };
    },
  };

  const names = Object.keys(generators);
  const statements = [];
  const assemble = () => [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sqlMap namespace="large">',
    '',
    fragments.join('\n\n'),
    '',
    ...statements.map(({ kind, id: sid, body }) => {
      const params = kind === 'select' ? ' parameterClass="map" resultClass="java.util.HashMap"' : ' parameterClass="map"';
      return `  <${kind} id="${sid}"${params}>${body}\n  </${kind}>\n`;
    }),
    '</sqlMap>',
    '',
  ].join('\n');

  // every column-list fragment is included at least once (an unreferenced one has no
  // context to resolve its `C.COL` against — that case is tested on its own)
  for (const table of tableNames) {
    const { alias, fragmentName } = TABLES[table];
    statements.push({ kind: 'select', id: id('listAll'), body: `
    SELECT <include refid="cols_${fragmentName}"/>
      FROM ${T(table)} ${alias}
     WHERE ${where(table, alias)}` });
    statements.push({ kind: 'select', id: id('countFiltered'), body: `
    SELECT COUNT(*)
      FROM ${T(table)}
     WHERE 1 = 1
     <include refid="filter_${fragmentName}"/>` });
  }
  // round-robin so every shape appears, then random fill up to minLines
  for (const name of names) statements.push(generators[name]());
  while (assemble().split('\n').length < minLines) statements.push(generators[pick(names)]());

  const template = assemble();
  return {
    legacyXml: render(template, 'LEGACY'),
    targetXml: render(template, 'TARGET'),
    statementCount: statements.length,
  };
}
