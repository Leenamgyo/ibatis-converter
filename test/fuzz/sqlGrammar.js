/**
 * Random-SQL oracle generator for converter/schema.
 *
 * Builds a random statement once, with every table/column name as a
 * placeholder, and renders it twice: LEGACY (old names, random case, what
 * the migration is fed) and TARGET (what the migration must produce). The
 * generator only emits shapes whose correct answer is decidable from the
 * mapping alone — an unqualified column appears only where exactly one
 * table is in scope, correlated references are always qualified — so any
 * difference between migrate(LEGACY) and TARGET is a converter bug.
 */

export const MAPPING = {
  O_ACCT: { targetTable: 'N_ACCOUNT', columns: { ID: 'ACCOUNT_ID', NM: 'ACCOUNT_NAME', CD: 'ACCOUNT_CODE', AMT: 'BALANCE', DT: 'OPENED_AT', ST: 'STATUS' } },
  O_TXN: { targetTable: 'N_TRANSACTION', columns: { ID: 'TXN_ID', ACCT_ID: 'ACCOUNT_ID', AMT: 'TXN_AMOUNT', DT: 'TXN_AT', CD: 'TXN_TYPE' } },
  O_CUST: { targetTable: 'N_CUSTOMER', columns: { ID: 'CUSTOMER_ID', NM: 'CUSTOMER_NAME', ST: 'CUST_STATE', GRD: 'GRADE' } },
  O_BR: { targetTable: 'N_BRANCH', columns: { CD: 'BRANCH_CODE', NM: 'BRANCH_NAME' } },
  'LEG.O_FEE': { targetTable: 'FIN.N_FEE', columns: { ID: 'FEE_ID', AMT: 'FEE_AMOUNT', CD: 'FEE_CODE' } },
};

/** column pool per table (mapped + unmapped columns, overlapping names on purpose) */
const COLUMNS = {
  O_ACCT: ['ID', 'NM', 'CD', 'AMT', 'DT', 'ST', 'MEMO', 'CUST_ID', 'BR_CD'],
  O_TXN: ['ID', 'ACCT_ID', 'AMT', 'DT', 'CD', 'MEMO'],
  O_CUST: ['ID', 'NM', 'ST', 'GRD', 'MEMO'],
  O_BR: ['CD', 'NM', 'MEMO'],
  'LEG.O_FEE': ['ID', 'AMT', 'CD', 'TXN_ID'],
  U_LOG: ['ID', 'AMT', 'CD', 'MSG'], // unmapped table, same column names
};
const TABLES = Object.keys(COLUMNS);

export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A piece of SQL that renders differently per version. */
class Name {
  constructor(legacy, target) { this.legacy = legacy; this.target = target; }
}

export function generate(seed) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const chance = (p) => r() < p;
  const int = (n) => Math.floor(r() * n);
  let aliasN = 0;
  const newAlias = () => `${pick(['a', 'b', 't', 'x', 'q'])}${++aliasN}`;
  const kw = (w) => (chance(0.15) ? w.toLowerCase() : w).replace(/^ | $/g, () => pick([' ', ' ', ' ', '\n  ', '\t', ' -- O_ACCT.ID note\n ', ' /* NM */ '])); // case + whitespace noise
  const cased = (s) => (chance(0.15) ? s.toLowerCase() : s);
  // a quoted identifier is one name: never quote a dotted schema.table as a whole
  const quoted = (legacy, target) => (!legacy.includes('.') && chance(0.08)
    ? new Name(`"${legacy.toUpperCase()}"`, `"${target}"`)
    : new Name(legacy, target));

  const tableName = (table) => {
    const m = MAPPING[table];
    const [schema, bare] = table.includes('.') ? table.split('.') : [null, table];
    if (!m) return new Name(cased(table), null);
    if (schema) return new Name(`${schema}.${cased(bare)}`, m.targetTable); // schema-qualified key -> its own schema
    // a bare-keyed table may be written with any schema in the SQL; the schema is kept
    const written = cased(bare);
    if (chance(0.15)) return new Name(`APP.${written}`, `APP.${m.targetTable}`);
    return quoted(written, m.targetTable);
  };
  const columnName = (table, column) => {
    const target = MAPPING[table]?.columns[column];
    const written = cased(column);
    return target ? quoted(written, target) : new Name(written, written);
  };

  // ---- expressions over a scope: [{ alias, table|derived }] ----
  const parts = [];
  const emit = (...xs) => parts.push(...xs);

  /** a column reference usable in `scope`; unqualified only when it is unambiguous */
  const colRef = (scope, { allowUnqualified = true } = {}) => {
    const src = pick(scope);
    const cols = src.columns;
    const column = pick(cols);
    const name = src.derived ? src.derived.outName(column) : columnName(src.table, column);
    const qualify = !(allowUnqualified && scope.length === 1 && chance(0.4));
    if (!qualify) return [name];
    if (src.alias) return [src.alias, '.', name];
    return [src.tableName, '.', name];
  };

  const literal = () => pick([`'${pick(['O_ACCT.ID', 'AMT', 'x', "it''s NM"])}'`, String(int(100)), '#{p' + int(9) + '}', '#{AMT}', 'NULL', '#ID#', '#NM:VARCHAR#', '?']);

  const expr = (scope, depth = 0) => {
    const k = int(depth > 1 ? 3 : 12);
    if (k === 7) return [kw('EXTRACT'), '(', kw('YEAR FROM '), ...colRef(scope), ')'];
    if (k === 8) return [kw('CAST'), '(', ...colRef(scope), kw(' AS '), pick(['VARCHAR(10)', 'NUMBER', 'DATE']), ')'];
    if (k === 9) return [kw('TRIM'), '(', kw('LEADING '), "'0'", kw(' FROM '), ...colRef(scope), ')'];
    if (k === 10) return [kw('ROW_NUMBER() OVER '), '(', kw('PARTITION BY '), ...colRef(scope), kw(' ORDER BY '), ...colRef(scope), chance(0.5) ? kw(' DESC') : '', ')'];
    if (k === 11) {
      // correlated scalar subquery: inner table aliased, outer refs qualified
      const table = pick(TABLES);
      const alias = newAlias();
      const inner = { alias, table, columns: COLUMNS[table], tableName: tableName(table) };
      return ['(', kw('SELECT '), kw('MAX'), '(', ...colRef([inner], { allowUnqualified: false }), ')', kw(' FROM '), inner.tableName, ` ${alias}`, kw(' WHERE '),
        ...colRef([inner], { allowUnqualified: false }), ' = ', ...colRef(scope, { allowUnqualified: false }), ')'];
    }
    if (k === 0 || k === 1) return colRef(scope);
    if (k === 2) return [literal()];
    if (k === 3) return [kw('NVL'), '(', ...colRef(scope), ', 0)'];
    if (k === 4) return ['(', ...expr(scope, depth + 1), ' + ', ...expr(scope, depth + 1), ')'];
    if (k === 5) return [kw('CASE WHEN '), ...colRef(scope), ' = ', literal(), kw(' THEN '), ...expr(scope, depth + 1), kw(' ELSE '), ...expr(scope, depth + 1), kw(' END')];
    return [kw('UPPER'), '(', ...colRef(scope), ')'];
  };

  const condition = (scope, depth = 0) => {
    const k = int(depth > 1 ? 4 : 7);
    if (k === 0) return [...colRef(scope), ' = ', ...expr(scope, depth + 1)];
    if (k === 1) return [...colRef(scope), kw(' IS NOT NULL')];
    if (k === 2) return [...colRef(scope), kw(' IN '), '(', literal(), ', ', literal(), ')'];
    if (k === 3) return [...colRef(scope), kw(' BETWEEN '), literal(), kw(' AND '), literal()];
    if (k === 4) return ['(', ...condition(scope, depth + 1), kw(' OR '), ...condition(scope, depth + 1), ')'];
    if (k === 5 && chance(0.3)) return [...colRef(scope), kw(' LIKE '), "'%'", ' || ', literal(), ' || ', "'%'"];
    if (k === 5) {
      // correlated EXISTS: inner unqualified columns only refer to the inner table, outer ones are qualified
      const inner = select({ outer: scope, depth: depth + 1, correlated: true, forExists: true });
      return [chance(0.3) ? kw('NOT EXISTS ') : kw('EXISTS '), '(', ...inner.parts, ')'];
    }
    const sub = select({ depth: depth + 1, single: true });
    return [...colRef(scope), kw(' IN '), '(', ...sub.parts, ')'];
  };

  /** FROM item: a table, or a derived table / CTE reference */
  const fromItem = (depth, ctes) => {
    if (ctes.length && chance(0.35)) {
      const cte = pick(ctes);
      const alias = chance(0.7) ? newAlias() : null;
      return { alias, derived: cte, columns: cte.outColumns(), tableName: new Name(cte.name, cte.name), parts: [cte.name, alias ? ` ${alias}` : ''] };
    }
    if (depth < 2 && chance(0.06)) {
      const table = pick(TABLES);
      const tn = tableName(table);
      const alias = newAlias();
      const star = { outColumns: () => COLUMNS[table], outName: (c) => columnName(table, c) };
      return { alias, derived: star, columns: COLUMNS[table], parts: ['(', kw('SELECT '), chance(0.5) ? '*' : `${'z' + aliasN}.*`, kw(' FROM '), tn, chance(0.5) ? '' : '', ` z${aliasN}`, ') ', alias] };
    }
    if (depth < 2 && chance(0.15)) {
      const inner = select({ depth: depth + 1, derivable: true });
      const alias = newAlias();
      return { alias, derived: inner, columns: inner.outColumns(), parts: ['(', ...inner.parts, ') ', alias] };
    }
    const table = pick(TABLES);
    const tn = tableName(table);
    const alias = chance(0.75) ? newAlias() : null;
    return { alias, table, columns: COLUMNS[table], tableName: tn, parts: [tn, alias ? ` ${chance(0.3) ? kw('AS ') : ''}${alias}` : ''] };
  };

  /**
   * SELECT. Returns { parts, outColumns(), outName(col) } so a derived table / CTE
   * reference knows what each output column is called in each version.
   */
  function select({ outer = null, depth = 0, correlated = false, forExists = false, single = false, derivable = false, ctes = [] } = {}) {
    const p = [];
    const from = [fromItem(depth, ctes)];
    if (!single && !forExists && chance(0.5)) from.push(fromItem(depth, ctes));
    if (!single && !forExists && chance(0.25)) from.push(fromItem(depth, ctes));
    // a table without alias can't appear twice
    const seenBare = new Set();
    for (const f of from) {
      if (!f.alias) {
        const key = f.table ?? f.derived?.name;
        if (seenBare.has(key) || !key) f.alias = newAlias(), f.parts = [...f.parts.filter((x) => x !== ''), ` ${f.alias}`];
        seenBare.add(key);
      }
    }
    const scope = from;
    // output items
    const out = []; // { label: Name | string, parts, sourceColumn? }
    const nItems = single ? 1 : 1 + int(4);
    for (let i = 0; i < nItems; i++) {
      if (chance(0.5)) {
        // bare column item: its output name is the (renamed) column name
        const src = pick(scope);
        const column = pick(src.columns);
        const name = src.derived ? src.derived.outName(column) : columnName(src.table, column);
        const qualified = !(scope.length === 1 && chance(0.4));
        const ref = qualified ? [src.alias ?? src.tableName, '.', name] : [name];
        out.push({ key: column, src, parts: ref, outName: name });
      } else {
        const label = chance(0.3) ? pick(['ID', 'NM', 'CD', 'AMT', 'ST']) : `c${i}_${int(99)}`;
        out.push({ key: label, parts: [...expr(scope), ` ${chance(0.6) ? kw('AS ') : ''}${label}`], outName: new Name(label, label), aliased: true });
      }
    }
    // a derived table must not expose two outputs with the same name
    const seen = new Set();
    const items = out.filter((o) => {
      const k = (o.outName.legacy ?? o.outName).toString().toUpperCase().replace(/"/g, '');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (!items.length) items.push(out[0]);

    const oracleJoins = [];
    p.push(kw('SELECT '));
    if (forExists) p.push('1');
    else items.forEach((o, i) => p.push(...(i ? [', '] : []), ...o.parts));
    p.push(kw(' FROM '));
    from.forEach((f, i) => {
      if (i === 0) p.push(...f.parts);
      else if (chance(0.5)) {
        p.push(', ', ...f.parts);
        if (chance(0.3)) oracleJoins.push([...colRef([f], { allowUnqualified: false }), '(+) = ', ...colRef([from[0]], { allowUnqualified: false })]);
      }
      else {
        p.push(` ${pick([kw('JOIN'), kw('LEFT JOIN'), kw('INNER JOIN'), kw('LEFT OUTER JOIN')])} `, ...f.parts, kw(' ON '));
        p.push(...colRef([f], { allowUnqualified: false }), ' = ', ...colRef([from[0]], { allowUnqualified: false }));
      }
    });
    const conds = [...oracleJoins];
    if (correlated && outer) {
      const o = pick(outer);
      conds.push([...colRef([from[0]], { allowUnqualified: false }), ' = ', ...colRef([o], { allowUnqualified: false })]);
    }
    if (chance(0.6)) conds.push(condition(scope, depth));
    if (conds.length) p.push(kw(' WHERE '), ...conds.flatMap((c, i) => [...(i ? [kw(' AND ')] : []), ...c]));
    if (!forExists && !single && chance(0.25)) {
      const g = items.filter((o) => !o.aliased);
      if (g.length) {
        p.push(kw(' GROUP BY '), ...g.flatMap((o, i) => [...(i ? [', '] : []), ...o.parts]));
        if (chance(0.4)) p.push(kw(' HAVING '), kw('COUNT'), '(', ...colRef(scope, { allowUnqualified: scope.length === 1 }), ') > 1');
      }
    }
    if (!forExists && !single && !derivable && chance(0.3)) {
      const o = pick(items);
      // ORDER BY an output alias (never renamed) or the item itself
      p.push(kw(' ORDER BY '), ...(o.aliased ? [o.outName] : o.parts), chance(0.5) ? kw(' DESC') : '');
    }
    return {
      parts: p,
      outColumns: () => items.map((o) => o.key),
      outName: (key) => items.find((o) => o.key === key)?.outName ?? new Name(key, key),
    };
  }

  // ---- statement ----
  const kind = pick(['select', 'select', 'select', 'with', 'union', 'insert', 'insertSelect', 'update', 'delete', 'merge']);
  if (kind === 'select') emit(...select().parts);
  else if (kind === 'union') {
    emit(...select({ derivable: true }).parts, kw(' UNION ALL '), ...select({ derivable: true }).parts);
  } else if (kind === 'with') {
    const ctes = [];
    const n = 1 + int(2);
    emit(kw('WITH '));
    for (let i = 0; i < n; i++) {
      const name = `cte${i}`;
      const body = select({ derivable: true, ctes });
      if (chance(0.25)) {
        // explicit column list: the CTE's output names are these, whatever the body renames
        const cols = body.outColumns().map((_, j) => `k${j}`);
        ctes.push({ name, outColumns: () => cols, outName: (c) => new Name(c, c) });
        emit(...(i ? [', '] : []), name, ` (${cols.join(', ')})`, kw(' AS '), '(', ...body.parts, ')');
      } else {
        ctes.push({ name, outColumns: body.outColumns, outName: body.outName });
        emit(...(i ? [', '] : []), name, kw(' AS '), '(', ...body.parts, ')');
      }
    }
    emit(' ', ...select({ ctes }).parts);
  } else if (kind === 'insert' || kind === 'insertSelect') {
    const table = pick(TABLES);
    const cols = [...new Set(Array.from({ length: 1 + int(3) }, () => pick(COLUMNS[table])))];
    emit(kw('INSERT INTO '), tableName(table), ' (', ...cols.flatMap((c, i) => [...(i ? [', '] : []), columnName(table, c)]), ') ');
    if (kind === 'insert') emit(kw('VALUES '), '(', cols.map(() => literal()).join(', '), ')');
    else {
      const src = select({ derivable: true });
      emit(...src.parts);
    }
  } else if (kind === 'update') {
    const table = pick(TABLES.filter((t) => t !== 'U_LOG'));
    const alias = chance(0.5) ? newAlias() : null;
    const tn = tableName(table);
    const scope = [{ alias, table, columns: COLUMNS[table], tableName: tn }];
    emit(kw('UPDATE '), tn, alias ? ` ${alias}` : '', kw(' SET '));
    const cols = [...new Set(Array.from({ length: 1 + int(3) }, () => pick(COLUMNS[table])))];
    cols.forEach((c, i) => emit(...(i ? [', '] : []), ...(alias && chance(0.5) ? [alias, '.'] : []), columnName(table, c), ' = ', ...expr(scope)));
    if (chance(0.8)) emit(kw(' WHERE '), ...condition(scope, 1));
  } else if (kind === 'delete') {
    const table = pick(TABLES);
    const alias = chance(0.5) ? newAlias() : null;
    const tn = tableName(table);
    const scope = [{ alias, table, columns: COLUMNS[table], tableName: tn }];
    emit(kw('DELETE FROM '), tn, alias ? ` ${alias}` : '', kw(' WHERE '), ...condition(scope, 1));
  } else {
    // MERGE INTO target USING source ON ... WHEN MATCHED UPDATE ... WHEN NOT MATCHED INSERT
    const target = pick(TABLES.filter((t) => MAPPING[t]));
    const source = pick(TABLES);
    const tn = tableName(target);
    const sn = tableName(source);
    const T = { alias: 'tg', table: target, columns: COLUMNS[target], tableName: tn };
    const S = { alias: 'sr', table: source, columns: COLUMNS[source], tableName: sn };
    const setCol = pick(COLUMNS[target]);
    const insCols = [...new Set([pick(COLUMNS[target]), pick(COLUMNS[target])])];
    emit(kw('MERGE INTO '), tn, ' tg', kw(' USING '), sn, ' sr', kw(' ON '), '(', ...colRef([T], { allowUnqualified: false }), ' = ', ...colRef([S], { allowUnqualified: false }), ')',
      kw(' WHEN MATCHED THEN UPDATE SET '), 'tg.', columnName(target, setCol), ' = ', ...colRef([S], { allowUnqualified: false }),
      kw(' WHEN NOT MATCHED THEN INSERT '), '(', ...insCols.flatMap((c, i) => [...(i ? [', '] : []), columnName(target, c)]), ')',
      kw(' VALUES '), '(', ...insCols.flatMap((c, i) => [...(i ? [', '] : []), ...colRef([S], { allowUnqualified: false })]), ')');
  }
  if (chance(0.2)) emit(' /* O_ACCT.ID kept */');

  const render = (version) => parts.map((x) => (x instanceof Name ? (version === 'legacy' ? x.legacy : (x.target ?? x.legacy)) : x)).join('');
  return { legacy: render('legacy'), target: render('target'), kind };
}
