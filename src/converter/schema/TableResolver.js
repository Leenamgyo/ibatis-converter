import { TokenKind } from './SqlLexer.js';

/**
 * Step 1 of schema migration: read a token stream and work out, *before
 * anything is renamed*, which tables each part of the SQL can see.
 *
 * Output is a `SqlResolution`:
 *   - a tree of `Scope`s — one BLOCK per statement / parenthesised
 *     subquery / CTE body, one QUERY per SELECT / INSERT / UPDATE /
 *     DELETE / MERGE inside it (a UNION branch is a sibling QUERY, an
 *     `INSERT ... SELECT`'s SELECT is a child of the INSERT);
 *   - every `TableRef` (FROM / JOIN / UPDATE / INSERT INTO / DELETE FROM /
 *     MERGE INTO..USING target), with its schema, original name and alias —
 *     i.e. the alias -> original-table map each scope resolves
 *     qualifiers against. CTE names and derived tables are TableRefs too
 *     (kind CTE / DERIVED), so they shadow a mapped table of the same name
 *     instead of being mistaken for it;
 *   - every `ColumnRef` site (`COL`, `c.COL`, `schema.T.COL`, `c.*`) that
 *     is not a keyword, table, alias, function name or column alias,
 *     tagged with its scope and clause.
 *
 * Nothing here knows about the mapping: deciding *what* a column becomes
 * is ColumnConverter's job, renaming tables is TableConverter's. Because
 * every decision downstream is made against these original names, the
 * order "resolve -> convert columns -> convert tables" can never lose the
 * old table name a column's mapping is keyed by.
 *
 * Deliberately a structural scanner, not a full SQL grammar: it only has
 * to know where table references, aliases and scopes begin and end, and
 * it never fails — SQL it doesn't understand just yields fewer
 * references, which the converter then leaves untouched.
 */

/** values of a MARKER token's `value` the scanner reacts to */
export const MarkerKind = Object.freeze({ INCLUDE: 'INCLUDE', BRANCH_START: 'BRANCH_START', BRANCH_END: 'BRANCH_END' });

export const ScopeKind = Object.freeze({ BLOCK: 'BLOCK', QUERY: 'QUERY', CONTEXT: 'CONTEXT' });
export const TableRefKind = Object.freeze({ TABLE: 'TABLE', CTE: 'CTE', DERIVED: 'DERIVED' });
export const TokenRole = Object.freeze({
  TABLE_SCHEMA: 'TABLE_SCHEMA',
  TABLE_NAME: 'TABLE_NAME',
  TABLE_ALIAS: 'TABLE_ALIAS',
  CTE_NAME: 'CTE_NAME',
  CTE_COLUMN: 'CTE_COLUMN',
  COLUMN_ALIAS: 'COLUMN_ALIAS',
  TYPE_NAME: 'TYPE_NAME',
  FUNCTION_NAME: 'FUNCTION_NAME',
  COLUMN_PART: 'COLUMN_PART',
});

/** Structural words: never a column, never a table alias. */
const RESERVED = new Set(`
  SELECT FROM WHERE AND OR NOT NULL IS IN EXISTS BETWEEN LIKE ILIKE ESCAPE AS ON USING
  JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL APPLY LATERAL STRAIGHT_JOIN
  UNION ALL INTERSECT EXCEPT MINUS DISTINCT DISTINCTROW GROUP BY HAVING ORDER ASC DESC
  NULLS FIRST LAST LIMIT OFFSET FETCH NEXT ROWS ROW ONLY TOP PERCENT TIES
  INSERT INTO VALUES VALUE UPDATE SET DELETE MERGE MATCHED REPLACE WHEN THEN ELSE END CASE
  WITH RECURSIVE RETURNING FOR SHARE NOWAIT WAIT SKIP LOCKED OF START CONNECT PRIOR NOCYCLE
  PARTITION OVER WINDOW WITHIN KEEP DUPLICATE KEY IGNORE USE FORCE INDEX
  TRUE FALSE UNKNOWN ANY SOME INTERVAL COLLATE SIBLINGS PIVOT UNPIVOT QUALIFY MODEL
  TABLESAMPLE SAMPLE
`.trim().split(/\s+/));

/** Words after which the next statement-level clause begins (only at expression depth 0). */
const CLAUSE_KEYWORDS = new Set([
  'WHERE', 'GROUP', 'HAVING', 'ORDER', 'SET', 'VALUES', 'VALUE', 'ON', 'LIMIT', 'OFFSET', 'FETCH',
  'RETURNING', 'CONNECT', 'START', 'WINDOW', 'QUALIFY', 'FOR',
]);
const JOIN_KEYWORDS = new Set(['JOIN', 'STRAIGHT_JOIN', 'APPLY']);
const SET_OPERATORS = new Set(['UNION', 'INTERSECT', 'EXCEPT', 'MINUS']);
const STATEMENT_KEYWORDS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE']);
/** A bare word right after one of these (in a SELECT list) is a column alias: `COL alias`, `CASE ... END alias`. */
const OPERAND_END_WORDS = new Set(['END', 'NULL', 'TRUE', 'FALSE']);

export class Scope {
  constructor({ id, kind, parent = null, statement = null }) {
    this.id = id;
    this.kind = kind;
    this.parent = parent;
    /** SELECT | INSERT | UPDATE | DELETE | MERGE for a QUERY */
    this.statement = statement;
    /** @type {TableRef[]} tables this scope itself introduces */
    this.tables = [];
    /** upper-cased CTE names declared by a WITH in this BLOCK */
    this.ctes = new Set();
    /** upper-cased SELECT-list column aliases (for ORDER BY alias references) */
    this.outputAliases = new Set();
    /** ColumnRefs that are a whole SELECT-list item on their own (`COL`, `t.COL`): they name an output column */
    this.selectItems = [];
    /** SELECT-list `*` (null) and `t.*` (qualifier parts) items */
    this.selectStars = [];
    /** inside a non-RECURSIVE CTE body, the CTE's own name means the base table, not the CTE */
    this.hiddenCte = null;
    /** BLOCK only: upper-cased CTE name -> { body: Scope, hasColumnList } */
    this.cteBodies = new Map();
    // scanner state
    this.clause = null;
    this.depth = 0;
    this.expectTable = false;
    this.expectDerivedAlias = false;
  }

  /** this scope, then each enclosing one */
  *chain() {
    for (let scope = this; scope; scope = scope.parent) yield scope;
  }

  /** @returns {{ body: Scope|null, hasColumnList: boolean }|null} the CTE `name` refers to here, if any */
  findCte(name) {
    const upper = name.toUpperCase();
    for (const scope of this.chain()) {
      if (scope.hiddenCte === upper) return null;
      if (scope.ctes.has(upper)) return scope.cteBodies.get(upper) ?? { body: null, hasColumnList: false };
    }
    return null;
  }

  /**
   * The alias -> original table map, applied to a column qualifier
   * (`c` in `c.COL`, `T` or `S.T` in `S.T.COL`), innermost scope first.
   * An alias match wins over a table-name match within the same scope.
   * @param {string[]} qualifier
   * @returns {{ table: TableRef, by: 'alias'|'name' }|null}
   */
  lookupQualifier(qualifier) {
    const name = qualifier[qualifier.length - 1].toUpperCase();
    const schema = qualifier.length > 1 ? qualifier[qualifier.length - 2].toUpperCase() : null;
    for (const scope of this.chain()) {
      const byAlias = scope.tables.find((t) => t.alias && t.alias.toUpperCase() === name && !schema);
      if (byAlias) return { table: byAlias, by: 'alias' };
      const byName = scope.tables.find((t) =>
        t.name && t.name.toUpperCase() === name && (!schema || (t.schema ?? '').toUpperCase() === schema));
      if (byName) return { table: byName, by: 'name' };
    }
    return null;
  }
}

export class TableRef {
  constructor({ kind, name = null, schema = null, alias = null, nameToken = null, schemaTokens = [], aliasToken = null, scope, body = null, hasColumnList = false, clause = null }) {
    this.kind = kind;
    this.name = name;
    this.schema = schema;
    this.alias = alias;
    /** token index of the table name (null for DERIVED) */
    this.nameToken = nameToken;
    /** token indexes of schema / catalog qualifiers, outermost first */
    this.schemaTokens = schemaTokens;
    this.aliasToken = aliasToken;
    this.scope = scope;
    /** CTE / DERIVED: the BLOCK whose first SELECT defines this table's columns */
    this.body = body;
    /** CTE declared with its own column list — `WITH x (a, b) AS (...)` — so its column names never change */
    this.hasColumnList = hasColumnList;
    /** the clause that introduced it: FROM (incl. JOIN), INTO (INSERT / MERGE target), USING, UPDATE, DELETE */
    this.clause = clause;
  }

  get label() {
    const qualified = this.schema ? `${this.schema}.${this.name}` : this.name ?? '(subquery)';
    return this.alias && this.alias !== this.name ? `${qualified} ${this.alias}` : qualified;
  }
}

export class ColumnRef {
  constructor({ parts, scope, clause, bareSelectItem = false }) {
    /** token indexes of the dotted chain: qualifiers..., column (or `*`) */
    this.parts = parts;
    this.scope = scope;
    this.clause = clause;
    /** the whole SELECT-list item, unaliased — so its name is the query's output column name */
    this.bareSelectItem = bareSelectItem;
  }

  get columnToken() {
    return this.parts[this.parts.length - 1];
  }

  get qualifierTokens() {
    return this.parts.slice(0, -1);
  }
}

export class SqlResolution {
  constructor({ tokens, rootScope, scopes, tableRefs, columnRefs, roles, tokenScopes, markerStates = new Map() }) {
    this.tokens = tokens;
    this.rootScope = rootScope;
    this.scopes = scopes;
    this.tableRefs = tableRefs;
    this.columnRefs = columnRefs;
    /** @type {Map<number, string>} token index -> TokenRole */
    this.roles = roles;
    /** token index -> Scope that was current at that token (also for whitespace/markers) */
    this.tokenScopes = tokenScopes;
    /** INCLUDE marker token -> { clause, expectTable } at that point */
    this.markerStates = markerStates;
  }
}

export class TableResolver {
  /**
   * @param {import('./SqlLexer.js').SqlToken[]} tokens
   * @param {{ outerScope?: Scope|null }} [options] an enclosing scope chain
   *   the SQL is evaluated inside of — the contextTable(s) of a fragment, or
   *   the scope at an `<include>` site
   * @returns {SqlResolution}
   */
  resolve(tokens, { outerScope = null, start = null } = {}) {
    return new Scan(tokens, outerScope, start).run();
  }
}

class Scan {
  /**
   * @param {{ clause: string, expectTable: boolean }|null} start the state the SQL begins in:
   *   a `<sql>` fragment included right after `FROM` (`FROM <include refid="tables"/>`) is a
   *   table list, so it starts in the FROM clause expecting a table
   */
  constructor(tokens, outerScope, start = null) {
    this.tokens = tokens;
    this.sig = [];
    tokens.forEach((token, index) => { if (token.significant) this.sig.push(index); });
    this.scopes = [];
    this.tableRefs = [];
    this.columnRefs = [];
    this.roles = new Map();
    this.tokenScopes = new Array(tokens.length);
    this.root = this.newScope(ScopeKind.BLOCK, outerScope);
    if (start) {
      this.root.clause = start.clause;
      this.root.expectTable = start.expectTable;
    }
    /** INCLUDE marker token -> { clause, expectTable } where it sits (what an included fragment starts in) */
    this.markerStates = new Map();
    /** @type {Scope[]} open BLOCKs, innermost last; each may have a `current` QUERY */
    this.blocks = [this.root];
    /** one entry per open `(`: { opensBlock, cteColumns, derived, owner } */
    this.parens = [];
    /** open `<if>` branches and the one that just closed (see marker()) */
    this.branches = [];
    this.lastBranch = null;
  }

  newScope(kind, parent, statement = null) {
    const scope = new Scope({ id: this.scopes.length, kind, parent, statement });
    if (kind === ScopeKind.BLOCK) {
      scope.current = null;
      scope.pendingSetOp = false;
      scope.cteState = null;
      scope.cteName = null;
      scope.cteRecursive = false;
    }
    this.scopes.push(scope);
    return scope;
  }

  get block() {
    return this.blocks[this.blocks.length - 1];
  }

  /** the scope a token at this point belongs to */
  get scope() {
    return this.block.current ?? this.block;
  }

  tok(k) {
    return k < this.sig.length ? this.tokens[this.sig[k]] : null;
  }

  kw(k) {
    return this.tok(k)?.keyword ?? null;
  }

  isPlainIdentifier(token) {
    if (!token?.isIdentifier) return false;
    return token.kind === TokenKind.QUOTED_IDENTIFIER || !RESERVED.has(token.keyword);
  }

  /** a dotted chain starting at sig position k: `a`, `a.b`, `a.b.c`, `a.*` */
  readChain(k) {
    const parts = [this.sig[k]];
    let end = k;
    while (this.tok(end + 1)?.is('.') && (this.tok(end + 2)?.isIdentifier || this.tok(end + 2)?.is('*'))) {
      parts.push(this.sig[end + 2]);
      end += 2;
    }
    return { parts, end };
  }

  run() {
    let assigned = -1;
    for (let k = 0; k < this.sig.length; k++) {
      // whitespace / comments / markers before a token belong to the scope current before it
      for (let i = assigned + 1; i < this.sig[k]; i++) {
        if (this.tokens[i].kind === TokenKind.MARKER) this.marker(this.tokens[i]);
        this.tokenScopes[i] = this.scope;
      }
      const before = this.scope;
      this.lastBranch = null;
      const opensStatement = STATEMENT_KEYWORDS.has(this.kw(k));
      const consumedTo = this.step(k);
      // a SELECT/INSERT/... keyword belongs to the query it opens
      const owner = opensStatement ? this.scope : before;
      for (let i = this.sig[k]; i <= this.sig[consumedTo]; i++) this.tokenScopes[i] = owner;
      assigned = this.sig[consumedTo];
      k = consumedTo;
    }
    for (let i = assigned + 1; i < this.tokens.length; i++) this.tokenScopes[i] = this.scope;

    return new SqlResolution({
      tokens: this.tokens,
      rootScope: this.root,
      scopes: this.scopes,
      tableRefs: this.tableRefs,
      columnRefs: this.columnRefs,
      roles: this.roles,
      tokenScopes: this.tokenScopes,
      markerStates: this.markerStates,
    });
  }

  /**
   * `<if>` boundaries. Consecutive sibling `<if>`s may be alternatives —
   * `FROM <if>ARCHIVED_ORDERS O</if><if>ORDERS O</if>` — so a branch that
   * starts right where the previous one started (nothing significant in
   * between) inherits a pending "table name comes next" from that point.
   * Only a *pending* table position is carried over, which is harmless
   * when the branches are not alternatives: `FROM A <if>, B</if>` never
   * has one pending at the `<if>`.
   */
  marker(token) {
    const scope = this.scope;
    if (token.value === MarkerKind.BRANCH_START) {
      const inherited = this.lastBranch?.scope === scope && this.lastBranch.expectTable;
      if (inherited) scope.expectTable = true;
      this.branches.push({ scope, expectTable: scope.expectTable });
      this.lastBranch = null;
    } else if (token.value === MarkerKind.BRANCH_END) {
      this.lastBranch = this.branches.pop() ?? null;
    } else if (token.value === MarkerKind.INCLUDE) {
      this.markerStates.set(token, {
        clause: scope.depth === 0 ? scope.clause : null,
        expectTable: scope.depth === 0 && scope.expectTable,
      });
    }
  }

  /** handles sig position k, returns the last sig position it consumed */
  step(k) {
    const token = this.tok(k);
    const scope = this.scope;
    const keyword = token.keyword;
    const prev = k > 0 ? this.tok(k - 1) : null;

    // A derived table's alias: FROM (SELECT ...) [AS] t — any other token ends the wait
    if (scope.expectDerivedAlias) {
      if (keyword === 'AS') return k;
      scope.expectDerivedAlias = false;
      if (this.isPlainIdentifier(token)) {
        this.addTable(new TableRef({ kind: TableRefKind.DERIVED, alias: token.value, aliasToken: this.sig[k], scope, body: scope.derivedBody }));
        this.roles.set(this.sig[k], TokenRole.TABLE_ALIAS);
        return k;
      }
    }

    if (token.is('(')) return this.openParen(k);
    if (token.is(')')) return this.closeParen(k);
    if (token.is(';')) {
      this.blocks.length = 1;
      this.parens.length = 0;
      this.root.current = null;
      this.root.pendingSetOp = false;
      return k;
    }
    if (token.is(',')) {
      if (scope.depth === 0 && (scope.clause === 'FROM' || scope.clause === 'ON')) {
        scope.clause = 'FROM';
        scope.expectTable = true;
      }
      if (this.block.cteState === 'AFTER_BODY' && scope === this.block) this.block.cteState = 'NAME';
      return k;
    }

    if (SET_OPERATORS.has(keyword)) {
      if (scope.depth === 0) this.block.pendingSetOp = true;
      return k;
    }
    if (keyword && RESERVED.has(keyword)) return this.keyword(k, keyword, scope);

    if (token.is('*') && scope.clause === 'SELECT' && scope.depth === 0 && this.startsSelectItem(k - 1)) {
      scope.selectStars.push(null);
      return k;
    }
    if (!token.isIdentifier) {
      if (token.kind === TokenKind.PARAM && scope.expectTable) scope.expectTable = false;
      return k;
    }

    // ---- identifiers ----
    const block = this.block;
    if (block.cteState === 'NAME' && scope === block) {
      block.ctes.add(token.value.toUpperCase());
      block.cteName = token.value.toUpperCase();
      block.cteBodies.set(block.cteName, { body: null, hasColumnList: false });
      this.roles.set(this.sig[k], TokenRole.CTE_NAME);
      block.cteState = 'AFTER_NAME';
      return k;
    }
    const paren = this.parens[this.parens.length - 1];
    if (paren?.cteColumns) {
      this.roles.set(this.sig[k], TokenRole.CTE_COLUMN);
      return k;
    }
    if (scope.expectTable) return this.tableReference(k, scope);
    if (prev?.keyword === 'AS') {
      if (scope.clause === 'SELECT' && scope.depth === 0) return this.columnAlias(k, scope);
      this.roles.set(this.sig[k], TokenRole.TYPE_NAME); // CAST(x AS VARCHAR2)
      return k;
    }
    if (prev?.is('@') || prev?.is('.')) return k; // @variable; trailing part of a chain already handled
    if (scope.clause === 'SELECT' && scope.depth === 0 && this.endsOperand(k - 1)) return this.columnAlias(k, scope);

    const { parts, end } = this.readChain(k);
    const oracleOuterJoin = this.tok(end + 2)?.is('+') && this.tok(end + 3)?.is(')'); // S.CTG_CD(+)
    if (this.tok(end + 1)?.is('(') && !oracleOuterJoin) {
      for (const part of parts) this.roles.set(part, TokenRole.FUNCTION_NAME);
      return end;
    }
    for (const part of parts) this.roles.set(part, TokenRole.COLUMN_PART);
    const bareSelectItem = scope.clause === 'SELECT' && scope.depth === 0
      && this.startsSelectItem(k - 1) && this.endsSelectItem(end + 1);
    const columnRef = new ColumnRef({ parts, scope, clause: scope.clause, bareSelectItem });
    this.columnRefs.push(columnRef);
    if (bareSelectItem) {
      if (this.tokens[columnRef.columnToken].is('*')) scope.selectStars.push(columnRef.qualifierTokens.map((i) => this.tokens[i].value));
      else scope.selectItems.push(columnRef);
    }
    return end;
  }

  keyword(k, keyword, scope) {
    const block = this.block;
    const atTop = scope.depth === 0;

    if (keyword === 'WITH' && atTop && !block.current) {
      block.cteState = 'NAME';
      return k;
    }
    if (keyword === 'RECURSIVE') {
      block.cteRecursive = true;
      return k;
    }
    if (keyword === 'AS' && block.cteState === 'AFTER_NAME' && scope === block) {
      block.cteState = 'BODY';
      return k;
    }
    if (STATEMENT_KEYWORDS.has(keyword) && atTop) {
      if (keyword === 'REPLACE' && this.kw(k + 1) !== 'INTO') return k; // REPLACE(...) function
      return this.statement(k, keyword);
    }
    if (!atTop) return k;

    if (keyword === 'FROM') {
      scope.clause = 'FROM';
      scope.expectTable = true;
    } else if (JOIN_KEYWORDS.has(keyword)) {
      scope.clause = 'FROM';
      scope.expectTable = true;
    } else if (keyword === 'INTO') {
      scope.clause = 'INTO';
      scope.expectTable = true;
    } else if (keyword === 'USING') {
      scope.clause = 'USING';
      if (scope.statement === 'MERGE') scope.expectTable = true;
    } else if (keyword === 'LATERAL' || keyword === 'ONLY') {
      // FROM LATERAL (...), FROM ONLY t: keep waiting for the table
    } else if (CLAUSE_KEYWORDS.has(keyword)) {
      scope.clause = keyword;
      scope.expectTable = false;
    }
    return k;
  }

  statement(k, keyword) {
    const block = this.block;
    const current = block.current;
    block.cteState = null;

    if (keyword === 'SELECT') {
      let query;
      if (!current) query = this.newScope(ScopeKind.QUERY, block, 'SELECT');
      else if (block.pendingSetOp) query = this.newScope(ScopeKind.QUERY, current.parent, 'SELECT'); // UNION branch: a sibling
      else query = this.newScope(ScopeKind.QUERY, current, 'SELECT'); // INSERT ... SELECT: sees the INSERT's target as outer
      block.pendingSetOp = false;
      block.current = query;
      query.clause = 'SELECT';
      return k;
    }

    if (current && !block.pendingSetOp) {
      // MERGE ... WHEN MATCHED THEN UPDATE SET / INSERT (...) VALUES, or ON DUPLICATE KEY UPDATE
      current.clause = keyword === 'UPDATE' ? 'SET' : keyword === 'INSERT' ? 'INTO' : current.clause;
      current.expectTable = false;
      return k;
    }
    const query = this.newScope(ScopeKind.QUERY, current ? current.parent : block, keyword === 'REPLACE' ? 'INSERT' : keyword);
    block.pendingSetOp = false;
    block.current = query;
    query.clause = keyword;
    if (keyword === 'UPDATE') query.expectTable = this.kw(k + 1) !== 'SET';
    if (keyword === 'DELETE') {
      // Oracle `DELETE T WHERE ...` names the table directly; `DELETE FROM T` lets FROM do it.
      // MySQL `DELETE t FROM T t ...` lists aliases before FROM — those are not tables.
      const next = this.tok(k + 1);
      if (next?.isIdentifier && this.kw(k + 1) !== 'FROM') {
        const { end } = this.readChain(k + 1);
        let after = end + 1;
        if (this.isPlainIdentifier(this.tok(after))) after++;
        query.expectTable = this.kw(after) !== 'FROM' && !this.tok(after)?.is(',');
      }
    }
    return k;
  }

  tableReference(k, scope) {
    scope.expectTable = false;
    const { parts, end } = this.readChain(k);
    if (this.tok(end + 1)?.is('(') && (scope.clause === 'FROM' || scope.clause === 'USING')) {
      // FROM TABLE(fn(...)), FROM generate_series(...): a table function, not a table
      // (INSERT INTO T (a, b) is a column list, so this only applies to FROM / USING)
      for (const part of parts) this.roles.set(part, TokenRole.FUNCTION_NAME);
      return end;
    }
    const nameIndex = parts[parts.length - 1];
    const nameToken = this.tokens[nameIndex];
    const schemaTokens = parts.slice(0, -1);
    const schema = schemaTokens.length ? schemaTokens.map((i) => this.tokens[i].value).join('.') : null;
    const cte = schema ? null : scope.findCte(nameToken.value);

    let last = end;
    let alias = null;
    let aliasToken = null;
    const afterName = this.tok(end + 1);
    if (afterName?.keyword === 'AS' && this.isPlainIdentifier(this.tok(end + 2))) {
      last = end + 2;
    } else if (this.isPlainIdentifier(afterName)) {
      last = end + 1;
    }
    if (last !== end) {
      aliasToken = this.sig[last];
      alias = this.tokens[aliasToken].value;
      this.roles.set(aliasToken, TokenRole.TABLE_ALIAS);
    }

    for (const index of schemaTokens) this.roles.set(index, TokenRole.TABLE_SCHEMA);
    this.roles.set(nameIndex, TokenRole.TABLE_NAME);
    this.addTable(new TableRef({
      kind: cte ? TableRefKind.CTE : TableRefKind.TABLE,
      clause: scope.clause,
      body: cte?.body ?? null,
      hasColumnList: cte?.hasColumnList ?? false,
      name: nameToken.value,
      schema,
      alias,
      nameToken: nameIndex,
      schemaTokens,
      aliasToken,
      scope,
    }));
    return last;
  }

  columnAlias(k, scope) {
    const token = this.tok(k);
    this.roles.set(this.sig[k], TokenRole.COLUMN_ALIAS);
    scope.outputAliases.add(token.value.toUpperCase());
    return k;
  }

  /** does the significant token at k end an operand (so a bare word after it can only be an alias)? */
  endsOperand(k) {
    const token = this.tok(k);
    if (!token) return false;
    if (token.is(')') || token.kind === TokenKind.STRING || token.kind === TokenKind.PARAM) return true;
    if (token.kind === TokenKind.NUMBER) return this.kw(k - 1) !== 'TOP';
    if (token.kind === TokenKind.QUOTED_IDENTIFIER) return true;
    if (token.kind === TokenKind.WORD) return OPERAND_END_WORDS.has(token.keyword) || !RESERVED.has(token.keyword);
    return false;
  }

  startsSelectItem(k) {
    const token = this.tok(k);
    return !!token && (token.is(',') || ['SELECT', 'DISTINCT', 'ALL', 'DISTINCTROW'].includes(token.keyword));
  }

  endsSelectItem(k) {
    const token = this.tok(k);
    return !token || token.is(',') || token.is(')') || token.is(';') || token.keyword === 'FROM' || token.keyword === 'INTO';
  }

  openParen(k) {
    const scope = this.scope;
    const next = this.kw(k + 1);
    if (next === 'SELECT' || next === 'WITH') {
      const derived = scope.expectTable;
      scope.expectTable = false;
      const outer = this.block;
      const block = this.newScope(ScopeKind.BLOCK, scope);
      const cteBody = outer.cteState === 'BODY';
      if (cteBody) {
        outer.cteBodies.get(outer.cteName).body = block;
        if (!outer.cteRecursive) block.hiddenCte = outer.cteName;
      }
      this.parens.push({ opensBlock: true, derived, owner: scope, cteBody, block });
      this.blocks.push(block);
      return k;
    }
    const cteColumns = this.block.cteState === 'AFTER_NAME' && scope === this.block;
    if (cteColumns) this.block.cteBodies.get(this.block.cteName).hasColumnList = true;
    this.parens.push({ opensBlock: false, owner: scope, cteColumns });
    scope.depth++;
    if (!cteColumns) scope.expectTable = false;
    return k;
  }

  closeParen(k) {
    const paren = this.parens.pop();
    if (!paren) return k; // unbalanced (fragment text): ignore
    if (paren.opensBlock) {
      while (this.blocks.length > 1 && this.blocks[this.blocks.length - 1].parent !== paren.owner) this.blocks.pop();
      if (this.blocks.length > 1) this.blocks.pop();
      if (paren.derived) {
        paren.owner.expectDerivedAlias = true;
        paren.owner.derivedBody = paren.block;
      }
      if (paren.cteBody) this.block.cteState = 'AFTER_BODY';
    } else {
      paren.owner.depth = Math.max(0, paren.owner.depth - 1);
    }
    return k;
  }

  addTable(ref) {
    ref.scope.tables.push(ref);
    this.tableRefs.push(ref);
  }
}

/**
 * Builds the CONTEXT scope a fragment is evaluated inside of, from table
 * references the caller declares: `'OLD_CONTENT'`, `'OLD_CONTENT c'`,
 * `'LEGACY.OLD_CONTENT c'`, or an array of those. The declaration is read
 * by the same tokenizer + table-reference scanner as real SQL (as the
 * table list of a FROM clause), so aliases and schemas mean exactly what
 * they would in a query.
 *
 * @param {SqlResolution} resolution the declaration resolved as a FROM list
 * @returns {Scope|null}
 */
export function contextScopeFrom(resolution) {
  if (!resolution.tableRefs.length) return null;
  const context = new Scope({ id: -1, kind: ScopeKind.CONTEXT });
  for (const ref of resolution.tableRefs) {
    context.tables.push(new TableRef({ ...ref, nameToken: null, schemaTokens: [], aliasToken: null, scope: context, body: null }));
  }
  return context;
}
