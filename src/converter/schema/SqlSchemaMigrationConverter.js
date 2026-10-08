import { tokenize, syntheticToken, TokenKind, ParamStyle } from './SqlLexer.js';
import { TableResolver, Scope, MarkerKind, contextScopeFrom } from './TableResolver.js';
import { ColumnConverter } from './ColumnConverter.js';
import { TableConverter } from './TableConverter.js';
import { MigrationMapping } from './MigrationMapping.js';
import { SchemaMigrationEvent, SchemaMigrationGrade, SchemaMigrationCode } from './SchemaMigrationEvent.js';

/**
 * Old-schema -> new-schema SQL migration (table and column renames),
 * a separate concern from — and independent of — the iBATIS -> MyBatis
 * *syntax* conversion in `converter/mybatis`. It only imports `ast/mybatis`
 * node shapes, never the syntax converter, and it can run on its own over
 * plain SQL (`convert`), over an already-converted MyBatis mapper AST, or
 * over the original iBATIS AST (`convertMapper(s)` — `SqlMapNode`s work
 * too, so the column renames can be applied while keeping iBATIS syntax).
 *
 *   SqlSchemaMigrationConverter
 *    ├─ TableResolver    tokens -> scopes, table refs, alias -> table, column sites
 *    ├─ ColumnConverter  column site -> owning original table -> its column map
 *    ├─ TableConverter   table-name tokens -> targetTable (aliases untouched)
 *    └─ MigrationMapping Map<legacy table, TableMapping{ targetTable, columns }>
 *
 * Both converters compute edits against the same immutable token stream
 * and original names; the edits are applied once at the end. So there is
 * no "rename tables first and lose the key the column map is under"
 * ordering hazard, and every token nobody edited — keywords, whitespace,
 * comments, string literals, `#{}`/`${}` — is emitted byte-for-byte.
 *
 * On a mapper, all SQL text of one statement (across `<if>`, `<where>`,
 * `<foreach>`, `<trim>` ...) is resolved as *one* token stream, so
 * `AND APP_ID = #{appId}` inside an `<if>` resolves against the FROM in
 * the statement's first text node. `test=` expressions are attributes and
 * never part of the stream. An `<include>`d fragment's SQL is spliced into
 * the including statement's stream read-only (so a FROM that lives in a
 * fragment still counts), and the fragment itself is converted on its own
 * — with the caller's `fragmentContexts`, or else the tables its include
 * sites see, when it has no FROM of its own.
 */
export class SqlSchemaMigrationConverter {
  /**
   * @param {MigrationMapping|object|Map<string, object>} mapping
   * @param {{ preserveResultColumnNames?: boolean, fragmentContexts?: Record<string, string|string[]> }} [options]
   *   preserveResultColumnNames: a renamed unaliased top-level SELECT item keeps
   *   its old result label (`COUNTRY_CODE AS COUNTRY_CD`), so resultMaps /
   *   auto-mapping still match. fragmentContexts: default context table(s) per
   *   `<sql>` fragment (`namespace.id` or bare id), used by convertMapper(s) —
   *   this is how they reach a conversion run through AnalyzerPipeline
   */
  constructor(mapping, {
    preserveResultColumnNames = false,
    fragmentContexts = {},
    tableResolver = new TableResolver(),
    columnConverter = new ColumnConverter({ preserveResultColumnNames }),
    tableConverter = new TableConverter(),
  } = {}) {
    this.mapping = MigrationMapping.from(mapping);
    this.fragmentContexts = fragmentContexts;
    this.tableResolver = tableResolver;
    this.columnConverter = columnConverter;
    this.tableConverter = tableConverter;
  }

  /**
   * @param {string} sql
   * @param {string|string[]|null} [contextTable] tables a FROM-less fragment
   *   belongs to: `'OLD_CONTENT'`, `'OLD_CONTENT c'`, `['A a', 'B b']`
   * @returns {{ sql: string, events: SchemaMigrationEvent[] }}
   */
  convert(sql, contextTable = null) {
    const segment = { tokens: tokenize(sql), writable: true };
    const { texts, events } = this.#run([segment], this.#contextScope(contextTable));
    return { sql: texts[0], events };
  }

  /**
   * @param {import('../../ast/mybatis/nodes.js').MapperNode} mapperNode
   * @param {{ fragmentContexts?: Record<string, string|string[]> }} [options]
   * @returns {{ mapper: import('../../ast/mybatis/nodes.js').MapperNode, events: SchemaMigrationEvent[] }}
   */
  convertMapper(mapperNode, options = {}) {
    return this.convertMappers([mapperNode], options)[0];
  }

  /**
   * Several mappers at once, so a cross-mapper `<include refid="ns.id">`
   * finds its fragment. Input nodes are never mutated.
   *
   * @param {import('../../ast/mybatis/nodes.js').MapperNode[]} mapperNodes
   * @param {{ fragmentContexts?: Record<string, string|string[]>, resolveInclude?: Function }} [options]
   *   fragmentContexts: explicit context table(s) per fragment, keyed by `namespace.id` or bare id.
   *   resolveInclude(refid, writtenIn, rootNamespace) -> qualified id | null: the PROJECT's
   *   include lookup (ProjectSession passes ReferenceResolver#includeTarget), so a refid
   *   resolves here exactly as in the analysis even when only some of the project's mappers
   *   are given. Without it, the same rules are applied to the given mappers.
   *   onInclude({ refid, writtenIn, root, qualifiedId }): called for every include resolved (tests)
   * @returns {{ mapper: object, events: SchemaMigrationEvent[] }[]}
   */
  convertMappers(mapperNodes, { fragmentContexts = this.fragmentContexts, resolveInclude = null, onInclude = null } = {}) {
    const fragments = new Map();
    const fragmentNamespace = new Map();
    for (const mapper of mapperNodes) {
      for (const fragment of mapper.sqlFragments) {
        fragments.set(qualify(mapper.namespace, fragment.id), fragment);
        fragmentNamespace.set(qualify(mapper.namespace, fragment.id), mapper.namespace);
      }
    }
    // a bare refid may name a fragment in another mapper (iBATIS useStatementNamespaces=false)
    const byLocalId = new Map();
    for (const mapper of mapperNodes) {
      for (const fragment of mapper.sqlFragments) {
        if (!byLocalId.has(fragment.id)) byLocalId.set(fragment.id, []);
        byLocalId.get(fragment.id).push(qualify(mapper.namespace, fragment.id));
      }
    }
    const lookupLocal = (refid, namespace) => {
      if (fragments.has(refid)) return refid;
      if (namespace && fragments.has(qualify(namespace, refid))) return qualify(namespace, refid);
      const global = refid.includes('.') ? [] : byLocalId.get(refid) ?? [];
      return global.length === 1 ? global[0] : null;
    };
    // the resolver's rule (ReferenceResolver#includeTarget) over the given mappers: a nested bare
    // refid is looked up in the statement's namespace first, the fragment author's otherwise
    const localTarget = (refid, writtenIn, root = writtenIn) => {
      const written = lookupLocal(refid, writtenIn);
      if (root === writtenIn || refid.includes('.')) return written;
      const runtime = lookupLocal(refid, root);
      if (runtime && written && runtime !== written) return runtime;
      return written ?? runtime;
    };
    const target = resolveInclude ?? localTarget;
    const project = {
      lookup: (qualifiedId) => (qualifiedId ? fragments.get(qualifiedId) ?? null : null),
      /** (refid as written, namespace it is written in, the statement's namespace) -> qualified id | null */
      qualifiedIdOf: (refid, writtenIn, root = writtenIn) => {
        const qualifiedId = target(refid, writtenIn, root);
        onInclude?.({ refid, writtenIn, root, qualifiedId }); // observation only (tests)
        return qualifiedId;
      },
      namespaceOf: (qualifiedId) => fragmentNamespace.get(qualifiedId),
      /** fragment qualified id -> scopes seen at its include sites */
      includeSites: new Map(),
    };

    // Statements first: converting them is what records each fragment's include-site scopes.
    const statementResults = mapperNodes.map((mapper) => mapper.statements.map((statement) =>
      this.#convertTree(statement, mapper.namespace, project, null, [])));

    return mapperNodes.map((mapper, m) => {
      const overrides = new Map();
      const events = [];
      mapper.statements.forEach((statement, s) => {
        const result = statementResults[m][s];
        mergeOverrides(overrides, result.overrides);
        events.push(...tag(result.events, statement.id));
      });
      for (const fragment of mapper.sqlFragments) {
        const qualifiedId = qualify(mapper.namespace, fragment.id);
        const explicit = fragmentContexts[qualifiedId] ?? fragmentContexts[fragment.id] ?? null;
        const result = this.#convertFragment(fragment, mapper.namespace, qualifiedId, explicit, project);
        mergeOverrides(overrides, result.overrides);
        events.push(...tag(result.events, fragment.id));
      }

      const migrated = cloneNode(mapper, new Map());
      migrated.statements = mapper.statements.map((node) => cloneNode(node, overrides));
      migrated.sqlFragments = mapper.sqlFragments.map((node) => cloneNode(node, overrides));
      migrated.resultMaps = mapper.resultMaps.map((node) => cloneNode(node, overrides));
      return { mapper: migrated, events };
    });
  }

  #convertFragment(fragment, namespace, qualifiedId, explicit, project) {
    // fragment runs never record include sites: a statement inlines the whole include chain
    // (fragment -> nested fragment) with its own tables, a fragment on its own has none
    if (explicit) return this.#convertTree(fragment, namespace, project, this.#contextScope(explicit), [qualifiedId], { record: false });

    const standalone = this.#convertTree(fragment, namespace, project, null, [qualifiedId], { record: false });
    const sites = [];
    for (const site of project.includeSites.get(qualifiedId) ?? []) {
      if (!sites.some((s) => s.scope === site.scope && JSON.stringify(s.start) === JSON.stringify(site.start))) sites.push(site);
    }
    if (!sites.length) return standalone;

    const candidates = sites.map(({ scope, start }) => this.#convertTree(fragment, namespace, project, scope, [qualifiedId], { record: false, start }));
    const signature = (result) => JSON.stringify([...result.overrides].map(([, value]) => value));
    const distinct = new Set(candidates.map(signature));
    if (distinct.size === 1) {
      const [chosen] = candidates;
      if (signature(chosen) === signature(standalone)) return standalone;
      const tables = [...new Set(sites.flatMap(({ scope }) => visibleTables(scope)))];
      const asFromList = sites.every(({ start }) => start);
      return {
        overrides: chosen.overrides,
        events: [
          new SchemaMigrationEvent({
            grade: SchemaMigrationGrade.SAFE,
            code: SchemaMigrationCode.FRAGMENT_CONTEXT_INFERRED,
            message: asFromList
              ? `<sql id="${fragment.id}"> is included in a FROM clause at all ${sites.length} site(s): read as its table list`
              : `<sql id="${fragment.id}"> has no table of its own; resolved against ${tables.join(', ')} from its ${sites.length} include site(s)`,
          }),
          ...chosen.events,
        ],
      };
    }
    return {
      overrides: standalone.overrides,
      events: [
        new SchemaMigrationEvent({
          grade: SchemaMigrationGrade.MANUAL,
          code: SchemaMigrationCode.FRAGMENT_CONTEXT_CONFLICT,
          message: `<sql id="${fragment.id}"> converts differently depending on which statement includes it; only its self-contained references were migrated — pass fragmentContexts["${qualifiedId}"] or split the fragment`,
        }),
        ...standalone.events,
      ],
    };
  }

  /**
   * One statement or fragment (plus, separately, each `<selectKey>` body,
   * which is its own SQL statement).
   * @returns {{ overrides: Map<object, object>, events: SchemaMigrationEvent[] }}
   */
  #convertTree(root, namespace, project, outerScope, includeStack, { record = true, start = null } = {}) {
    const overrides = new Map();
    const events = [];
    const runs = [{ nodes: root.children ?? [] }];
    const selectKeys = [];
    const collect = (nodes) => {
      for (const node of nodes) {
        if (node.type === 'SelectKey') selectKeys.push(node);
        else if (node.children) collect(node.children);
      }
    };
    collect(root.children ?? []);
    for (const selectKey of selectKeys) runs.push({ nodes: selectKey.children });

    runs.forEach(({ nodes }) => {
      const markers = [];
      const segments = this.#segmentsOf(nodes, namespace, project, true, includeStack, markers);
      const { texts, events: runEvents, resolution } = this.#run(segments, outerScope, start);
      segments.forEach((segment, i) => {
        if (!segment.writable || texts[i] === segment.original) return;
        const entry = overrides.get(segment.node) ?? {};
        entry[segment.field] = texts[i];
        overrides.set(segment.node, entry);
      });
      events.push(...runEvents);
      if (record) {
        for (const { marker, qualifiedId } of markers) {
          if (!qualifiedId) continue; // a refid that resolves nowhere has no include site to record
          const scope = resolution.tokenScopes[resolution.tokens.indexOf(marker)];
          // a fragment included in a FROM clause continues it: `FROM <include/>` is a table list
          const at = resolution.markerStates.get(marker);
          const start = at?.clause === 'FROM' ? { clause: 'FROM', expectTable: at.expectTable } : null;
          if (!project.includeSites.has(qualifiedId)) project.includeSites.set(qualifiedId, []);
          project.includeSites.get(qualifiedId).push({ scope, start });
        }
      }
    });
    return { overrides, events };
  }

  /**
   * Flattens a dynamic-SQL subtree into token segments, in document order.
   * Only SQL is included: TextSql, `<trim prefix/suffix>`, `<foreach
   * open/close>` (writable), the implied WHERE / SET keyword of `<where>` /
   * `<set>`, and an included fragment's SQL (read-only). `test=`,
   * `collection=`, `item=` etc. are never tokenized.
   */
  #segmentsOf(nodes, namespace, project, writable, includeStack, markers, writtenIn = namespace) {
    const segments = [];
    const text = (node, field) => {
      const original = node[field];
      if (original === null || original === undefined || original === '') return;
      segments.push({ tokens: tokenize(original), writable, node, field, original });
    };
    const keyword = (word) => segments.push({ tokens: [syntheticToken(TokenKind.WORD, word)], writable: false });
    // an iBATIS `prepend` ("WHERE", "AND", ",") is SQL the runtime inserts: part of the stream, never rewritten
    const prepend = (node) => {
      if (node.prepend) segments.push({ tokens: tokenize(` ${node.prepend} `), writable: false });
    };
    const marker = (kind) => {
      const token = syntheticToken(TokenKind.MARKER, '', { value: kind });
      segments.push({ tokens: [token], writable: false });
      return token;
    };

    const walk = (list) => {
      for (const node of list) {
        switch (node.type) {
          case 'TextSql':
            text(node, 'text');
            break;
          case 'If':
          case 'When':
          case 'Otherwise':
            marker(MarkerKind.BRANCH_START);
            walk(node.children);
            marker(MarkerKind.BRANCH_END);
            break;
          // ---- iBATIS AST (a schema migration that keeps iBATIS syntax) ----
          case 'Conditional':
            marker(MarkerKind.BRANCH_START);
            prepend(node);
            text(node, 'open');
            walk(node.children);
            text(node, 'close');
            marker(MarkerKind.BRANCH_END);
            break;
          case 'Dynamic':
            prepend(node);
            text(node, 'open');
            walk(node.children);
            text(node, 'close');
            break;
          case 'Iterate':
            prepend(node);
            text(node, 'open');
            walk(node.children);
            text(node, 'close');
            break;
          case 'Where':
            keyword('WHERE');
            walk(node.children);
            break;
          case 'Set':
            keyword('SET');
            walk(node.children);
            break;
          case 'Trim':
            text(node, 'prefix');
            walk(node.children);
            text(node, 'suffix');
            break;
          case 'Foreach':
            text(node, 'open');
            walk(node.children);
            text(node, 'close');
            break;
          case 'Include': {
            // `namespace` is the statement's (the runtime resolves every include against it),
            // `writtenIn` the mapper this <include> is written in
            const qualifiedId = project.qualifiedIdOf(node.refid, writtenIn, namespace);
            markers.push({ marker: marker(MarkerKind.INCLUDE), qualifiedId });
            const fragment = project.lookup(qualifiedId);
            if (fragment && !includeStack.includes(qualifiedId)) {
              const inner = this.#segmentsOf(fragment.children, namespace, project, false, [...includeStack, qualifiedId], markers, project.namespaceOf(qualifiedId) ?? namespace);
              segments.push(...inner);
            }
            break;
          }
          case 'SelectKey':
            break; // its own statement, converted as a separate run
          default:
            if (node.children) walk(node.children);
        }
      }
    };
    walk(nodes);
    return segments;
  }

  /**
   * Resolve -> convert columns -> convert tables -> apply edits, over one
   * token stream made of `segments`. Returns each segment's new text
   * (null for read-only segments) and the events raised on writable ones.
   */
  #run(segments, outerScope, start = null) {
    const tokens = [];
    const owners = [];
    segments.forEach((segment, s) => {
      for (const token of segment.tokens) {
        tokens.push(token);
        owners.push(s);
      }
    });

    const resolution = this.tableResolver.resolve(tokens, { outerScope, start });
    const columns = this.columnConverter.convert(resolution, this.mapping);
    const tables = this.tableConverter.convert(resolution, this.mapping, columns.bindings);
    const edits = new Map([...columns.edits, ...tables.edits]);

    const events = [...tables.events.filter((e) => e.code === SchemaMigrationCode.TABLE_RENAMED), ...columns.events,
      ...tables.events.filter((e) => e.code !== SchemaMigrationCode.TABLE_RENAMED)];
    tokens.forEach((token, index) => {
      if (token.kind !== TokenKind.PARAM) return;
      if (token.style !== ParamStyle.MYBATIS_SUBSTITUTION && token.style !== ParamStyle.IBATIS_SUBSTITUTION) return;
      // `TB_ORD_H_${yyyymm}`: an identifier built at runtime. If its fixed part is a mapped
      // legacy table's name, the new name can't be produced by renaming tokens — a human must decide.
      const glued = [tokens[index - 1], tokens[index + 1]].filter((t) => t?.kind === TokenKind.WORD).map((t) => t.value);
      if (glued.length) {
        const built = `${tokens[index - 1]?.kind === TokenKind.WORD ? tokens[index - 1].text : ''}${token.text}${tokens[index + 1]?.kind === TokenKind.WORD ? tokens[index + 1].text : ''}`;
        const legacy = [...this.mapping.tables.keys()].find((name) => glued.some((part) => {
          const upper = part.toUpperCase().replace(/_+$/, '');
          return upper.length > 2 && (name === upper || name.endsWith(`.${upper}`));
        }));
        events.push(new SchemaMigrationEvent({
          grade: legacy ? SchemaMigrationGrade.MANUAL : SchemaMigrationGrade.WARNING,
          code: SchemaMigrationCode.DYNAMIC_IDENTIFIER,
          message: legacy
            ? `${built} builds a table name at runtime from legacy ${legacy} (-> ${this.mapping.tables.get(legacy).targetTable ?? legacy}); rename the fixed part and the runtime values by hand`
            : `${built} builds an identifier at runtime; it is not migrated — check the values the caller passes`,
          original: built,
          tokenIndex: index,
          table: legacy ?? null,
        }));
        return;
      }
      events.push(new SchemaMigrationEvent({
        grade: SchemaMigrationGrade.WARNING,
        code: SchemaMigrationCode.RUNTIME_SUBSTITUTION,
        message: `${token.text} is substituted at runtime: any table or column name it carries is not migrated here — check the values the caller passes`,
        original: token.text,
        tokenIndex: index,
      }));
    });

    const texts = segments.map(() => []);
    tokens.forEach((token, index) => {
      if (segments[owners[index]].writable) texts[owners[index]].push(edits.get(index) ?? token.text);
    });
    const visible = events.filter((event) => event.tokenIndex === null || segments[owners[event.tokenIndex]].writable);
    return {
      texts: texts.map((parts, s) => (segments[s].writable ? parts.join('') : null)),
      events: visible,
      resolution,
    };
  }

  #contextScope(contextTable) {
    if (!contextTable) return null;
    if (contextTable instanceof Scope) return contextTable;
    const entries = Array.isArray(contextTable) ? contextTable : [contextTable];
    // read as the table list of a FROM clause: `FROM a, b c, s.d`
    const tokens = [syntheticToken(TokenKind.WORD, 'FROM')];
    entries.forEach((entry, i) => {
      if (i) tokens.push(syntheticToken(TokenKind.PUNCT, ','));
      tokens.push(...tokenize(String(entry)));
    });
    return contextScopeFrom(this.tableResolver.resolve(tokens));
  }
}

function qualify(namespace, id) {
  return namespace ? `${namespace}.${id}` : id;
}

function tag(events, statementId) {
  return events.map((event) => Object.assign(Object.create(SchemaMigrationEvent.prototype), event, { statementId }));
}

function mergeOverrides(into, from) {
  for (const [node, fields] of from) into.set(node, { ...(into.get(node) ?? {}), ...fields });
}

function visibleTables(scope) {
  const names = [];
  for (const s of scope.chain()) for (const table of s.tables) if (table.name) names.push(table.label);
  return names;
}

/** a fresh copy of the subtree (same node classes), with overridden fields applied — the input is never mutated */
function cloneNode(node, overrides) {
  const copy = Object.assign(Object.create(Object.getPrototypeOf(node)), node, overrides.get(node) ?? {});
  if (Array.isArray(node.children)) copy.children = node.children.map((child) => cloneNode(child, overrides));
  if (Array.isArray(node.results)) copy.results = node.results.map((child) => cloneNode(child, overrides));
  return copy;
}
