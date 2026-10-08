import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseIbatisMapperSource } from '../parser/ibatis/IbatisMapperParser.js';
import { parseMyBatisMapperSource } from '../parser/mybatis/MyBatisMapperParser.js';

/** the kinds of XML a session reads: any mapper with SQL in it */
const MAPPER_KINDS = { IBATIS_MAPPER: 'ibatis', MYBATIS_MAPPER: 'mybatis' };

/** XML text -> { sqlMap (analysis AST), mybatis (a MyBatis file's own AST, else null), diagnostics } */
function parseMapper(text, sourceFile, syntax) {
  if (syntax === 'mybatis') {
    const { mapper, sqlMap, diagnostics } = parseMyBatisMapperSource(text, sourceFile);
    return { sqlMap, mybatis: mapper, diagnostics };
  }
  const { sqlMap, diagnostics } = parseIbatisMapperSource(text, sourceFile);
  return { sqlMap, mybatis: null, diagnostics };
}
import { IncludeNode } from '../ast/ibatis/nodes.js';
import { SymbolType } from '../ast/ibatis/enums.js';
import { buildSymbolTable } from '../resolver/symbol/ProjectScanner.js';
import { ReferenceResolver } from '../resolver/reference/ReferenceResolver.js';
import { fragmentSignature } from '../resolver/reference/ReferenceIndex.js';
import { DiagnosticBag } from '../parser/xml/ParserDiagnostics.js';
import { StatementAnalyzer } from '../analyzer/statement/StatementAnalyzer.js';
import { DependencyAnalyzer } from '../analyzer/dependency/DependencyAnalyzer.js';
import { MyBatisAstConverter } from '../converter/mybatis/MyBatisAstConverter.js';
import { SqlSchemaMigrationConverter } from '../converter/schema/index.js';
import { XmlGenerator } from '../generator/xml/XmlGenerator.js';
import { IbatisXmlGenerator } from '../generator/xml/IbatisXmlGenerator.js';
import { MapperNode } from '../ast/mybatis/nodes.js';
import { MapperReport } from '../report/migration/MapperReport.js';
import { ProjectReport } from '../report/migration/ProjectReport.js';
import { MigrationSafetyAnalyzer } from '../report/migration/MigrationSafetyAnalyzer.js';
import { findXmlFiles } from './ProjectLoader.js';
import { decodeXml, classifyXml, classifyHead, HEAD_BYTES, SKIP_REASONS, copyScore, scanMapperIds } from './mapperDetection.js';
import { LruCache } from './LruCache.js';
import { ProjectMetadata } from './ProjectMetadata.js';
import { buildColumnRemovalGuide } from './ColumnRemovalGuide.js';

/**
 * A project opened for interactive or batch work WITHOUT holding it in
 * memory. AnalyzerPipeline analyses and converts everything up front and
 * keeps all of it. A session instead:
 *
 * 1. **On open, builds an index only.** Each file is read, classified and
 *    parsed once. What is kept is the file list, every statement / fragment
 *    / resultMap id and, per node, just its `<include refid>` list as a
 *    tiny stub. The text and the AST are dropped.
 * 2. **Hands everything it knows to ProjectMetadata** — the registry
 *    (files, symbols, namespaces), the one lookup rule (ReferenceIndex) and
 *    the include graph resolved over the stubs. Every question about where
 *    something is or what a refid points at is answered there; this class
 *    keeps none of it.
 * 3. **Loads on demand.** A statement's analysis, conversion, XML or
 *    schema migration reads only the files it needs (its own, its
 *    fragments', and for schema inference a capped number of includers').
 *    Those files go through bounded LRU caches: file text, parsed AST,
 *    analyses. The real ASTs are resolved by a ReferenceResolver over the
 *    metadata's own symbol table and index, loading nodes from files
 *    (`#realResolver`) — the graph's walk with a different node loader.
 * 4. **Streams whole-project work** (reports, schema summary, CLI)
 *    file by file, keeping aggregates only.
 * 5. **`close()` drops every cache** and, for an upload, deletes its
 *    temporary directory.
 */

/** Files on disk, read (and decoded: EUC-KR / MS949 when declared) only when asked. */
export class DirectorySource {
  constructor(root, { temporary = false } = {}) {
    this.root = path.resolve(root);
    this.temporary = temporary;
  }

  list() {
    return findXmlFiles(this.root).map((full) => {
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch { /* reported as UNREADABLE when it is read */ }
      return { sourceFile: path.relative(this.root, full).split(path.sep).join('/'), size };
    });
  }

  #path(sourceFile) {
    const full = path.resolve(this.root, sourceFile);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new Error(`outside the project: ${sourceFile}`);
    return full;
  }

  read(sourceFile) {
    return decodeXml(fs.readFileSync(this.#path(sourceFile)));
  }

  /** the file's kind from its first bytes, null when they don't decide it (see classifyHead) */
  classify(sourceFile) {
    const fd = fs.openSync(this.#path(sourceFile), 'r');
    try {
      const head = Buffer.alloc(HEAD_BYTES);
      const n = fs.readSync(fd, head, 0, HEAD_BYTES, 0);
      return classifyHead(head.subarray(0, n), n < HEAD_BYTES);
    } finally {
      fs.closeSync(fd);
    }
  }

  close() {
    if (this.temporary) fs.rmSync(this.root, { recursive: true, force: true });
  }
}

/**
 * A folder plus mapper files found OUTSIDE it (ReferenceDiscovery: the
 * `<sql>` its refids name, in a sibling module). External files are listed
 * under their path relative to the folder (`../common/…/CommonMapper.xml`)
 * and flagged `external`: they take part in reference resolution and
 * analysis, and are shown apart; the CLI never writes them out.
 */
export class ReferencedSource extends DirectorySource {
  constructor(root, externalFiles) {
    super(root);
    this.external = new Map(externalFiles.map((abs) => [path.relative(this.root, abs).split(path.sep).join('/'), abs]));
  }

  list() {
    const own = super.list();
    const external = [...this.external].map(([sourceFile, abs]) => ({ sourceFile, size: fs.statSync(abs).size, external: true }));
    return [...own, ...external];
  }

  read(sourceFile) {
    const abs = this.external.get(sourceFile);
    return abs ? decodeXml(fs.readFileSync(abs)) : super.read(sourceFile);
  }

  classify(sourceFile) {
    return this.external.has(sourceFile) ? null : super.classify(sourceFile); // externals were picked as mappers already
  }
}

/**
 * Uploaded files (the browser's folder upload) are written to a temporary
 * directory and read back from disk like any project, so the server holds
 * no copy of their text; the directory is removed when the session closes.
 * Files keep the names they were uploaded with (reports and ids use them);
 * on disk each is stored under a numbered name, so no uploaded name decides
 * where anything is written.
 */
export class UploadSource extends DirectorySource {
  constructor(files = []) {
    super(fs.mkdtempSync(path.join(os.tmpdir(), 'ibatis-project-')), { temporary: true });
    this.diskName = new Map();
    this.bytes = 0;
    this.add(files);
  }

  /** more files (a folder upload arrives in batches); each is on disk once this returns */
  add(files) {
    for (const { sourceFile, source } of files) {
      if (this.diskName.has(sourceFile)) throw new Error(`duplicate file: ${sourceFile}`);
      const name = `${this.diskName.size}.xml`;
      fs.writeFileSync(path.join(this.root, name), source);
      this.diskName.set(sourceFile, name);
      this.bytes += Buffer.byteLength(source);
    }
    return this.diskName.size;
  }

  list() {
    return [...this.diskName].map(([sourceFile, name]) => ({ sourceFile, size: fs.statSync(path.join(this.root, name)).size }));
  }

  read(sourceFile) {
    const name = this.diskName.get(sourceFile);
    if (!name) throw new Error(`not in the project: ${sourceFile}`);
    // uploaded as text (the browser already decoded it): stored and read back as UTF-8,
    // whatever its XML declaration says
    return { text: fs.readFileSync(path.join(this.root, name), 'utf8'), encoding: 'UTF-8' };
  }

  /** uploads were classified by the browser; read whole */
  classify() {
    return null;
  }
}

export function createUploadSource(files) {
  return new UploadSource(files);
}

const qualify = (namespace, id) => (namespace ? `${namespace}.${id}` : id);
const STATEMENT_TAGS = { SELECT: 'select', INSERT: 'insert', UPDATE: 'update', DELETE: 'delete', PROCEDURE: 'procedure' };

/** every <include> under a node, in document order (selectKey bodies included) */
function collectIncludes(node, out = []) {
  for (const child of node.children ?? []) {
    if (child.type === 'Include') out.push(child);
    else collectIncludes(child, out);
  }
  return out;
}

/** the one "conversion" event of a statement / fragment that already is MyBatis */
function alreadyMyBatis(node) {
  return {
    grade: 'SAFE',
    code: 'ALREADY_MYBATIS',
    message: 'MyBatis 3 mapper: no syntax conversion needed (kept as written)',
    sourceFile: node.sourceFile ?? null,
    sourceLine: node.sourceLine ?? null,
  };
}

export class ProjectSession {
  /**
   * @param {DirectorySource} source
   * @param {{ dialect?: string, maxFiles?: number, maxTextBytes?: number, maxAnalyses?: number, schemaSiteFiles?: number }} [options]
   */
  constructor(source, { dialect = 'mysql', maxFiles = 16, maxTextBytes = 32 * 1024 * 1024, maxAnalyses = 256, schemaSiteFiles = 30, maxFileBytes = 20 * 1024 * 1024 } = {}) {
    this.maxFileBytes = maxFileBytes;
    this.source = source;
    this.dialect = dialect;
    this.schemaSiteFiles = schemaSiteFiles;
    this.texts = new LruCache({ maxEntries: maxFiles * 2, maxSize: maxTextBytes, sizeOf: (t) => t.length * 2 });
    this.mappers = new LruCache({ maxEntries: maxFiles });
    this.analyses = new LruCache({ maxEntries: maxAnalyses });
    this.statementAnalyzer = new StatementAnalyzer();
    this.converter = new MyBatisAstConverter();
    this.safety = new MigrationSafetyAnalyzer();
    this.xml = new XmlGenerator();
    this.ibatisXml = new IbatisXmlGenerator();
    this.loads = 0; // file parses after the index was built — "loaded on demand"
    this.closed = false;
  }

  /** the project's files (ProjectMetadata) */
  get files() {
    return this.meta?.files ?? [];
  }

  /** parse + reference diagnostics of the whole project */
  get diagnostics() {
    return this.meta?.diagnostics ?? new DiagnosticBag();
  }

  /** Builds the index. Returns this. */
  open() {
    const diagnostics = new DiagnosticBag();
    const files = [];
    const skipped = [];
    const stubMappers = [];
    const candidates = []; // every mapper file read; copies are dropped below, by content
    for (const { sourceFile, size, external = false } of this.source.list()) {
      // the same guards as scanProject: an oversized or unreadable file is listed, not fatal
      if (size > this.maxFileBytes) {
        skipped.push({ sourceFile, kind: 'TOO_LARGE', reason: `${Math.round(size / 1024 / 1024)}MB — ${Math.round(this.maxFileBytes / 1024 / 1024)}MB 초과` });
        continue;
      }
      let text;
      let encoding;
      try {
        // most of a project's XML is not a mapper: decided from the file's head, never read whole
        const early = this.source.classify?.(sourceFile) ?? null;
        if (early && !MAPPER_KINDS[early]) {
          skipped.push({ sourceFile, kind: early, reason: SKIP_REASONS[early] });
          continue;
        }
        ({ text, encoding } = this.source.read(sourceFile));
      } catch (e) {
        skipped.push({ sourceFile, kind: 'UNREADABLE', reason: e.message });
        continue;
      }
      const kind = classifyXml(text);
      const syntax = MAPPER_KINDS[kind];
      if (!syntax) {
        skipped.push({ sourceFile, kind, reason: SKIP_REASONS[kind] });
        continue;
      }
      const { sqlMap, mybatis, diagnostics: fileDiagnostics } = parseMapper(text, sourceFile, syntax);
      const entry = { sourceFile, size, encoding, syntax, external, lines: text.split('\n').length, namespace: sqlMap?.namespace ?? null, parsed: Boolean(sqlMap), statements: [], fragments: [], resultMaps: [] };
      const candidate = { entry, fileDiagnostics, stub: null, signature: null };
      candidates.push(candidate);
      if (!sqlMap) {
        // Too broken to parse even leniently: its namespace and ids are still registered, from
        // the text, so a refid into it points at the right file and line — never "not found".
        const ids = scanMapperIds(text);
        const ns = ids.namespace ?? '';
        entry.namespace = ids.namespace;
        entry.fragments = ids.fragments.map((f) => ({ id: f.id, qualifiedId: qualify(ns, f.id), line: f.line, unparsed: true }));
        entry.unparsedStatements = ids.statements.map((s) => ({ id: s.id, qualifiedId: qualify(ns, s.id), tag: s.tag, line: s.line }));
        candidate.signature = ['unparsed', syntax, ns, ids.statements.map((s) => s.id).sort().join(','), ids.fragments.map((f) => f.id).sort().join(',')].join('|');
        candidate.stub = {
          namespace: ns, sourceFile, statements: [], resultMaps: [], parameterMaps: [], cacheModels: [],
          sqlFragments: ids.fragments.map((f) => ({ type: 'SqlFragment', id: f.id, sourceFile, sourceLine: f.line, children: [] })),
        };
        continue;
      }
      // the same mapper = the same kind, namespace and ids; a second file like that is a copy
      candidate.signature = [syntax, sqlMap.namespace,
        sqlMap.statements.map((s) => s.id).sort().join(','),
        sqlMap.sqlFragments.map((f) => f.id).sort().join(','),
        sqlMap.resultMaps.map((r) => r.id).sort().join(',')].join('|');
      const ns = sqlMap.namespace;
      // the stub mapper keeps ids, include lists and the attributes reference resolution reads
      const stub = { namespace: ns, sourceFile, statements: [], sqlFragments: [], resultMaps: [], parameterMaps: [], cacheModels: [] };
      const includeStubs = (node) => collectIncludes(node).map((inc) => new IncludeNode({ refid: inc.refid, sourceFile: inc.sourceFile, sourceLine: inc.sourceLine }));
      for (const st of sqlMap.statements) {
        stub.statements.push({ type: 'Statement', id: st.id, statementType: st.statementType, resultMap: st.resultMap, parameterMap: st.parameterMap, sourceFile, sourceLine: st.sourceLine, children: includeStubs(st) });
        entry.statements.push({ id: st.id, qualifiedId: qualify(ns, st.id), type: st.statementType, line: st.sourceLine, parameterClass: st.parameterClass, resultClass: st.resultClass, resultMap: st.resultMap });
      }
      for (const f of sqlMap.sqlFragments) {
        // signature: what the fragment says, so identical copies in other modules are recognised as one
        stub.sqlFragments.push({ type: 'SqlFragment', id: f.id, sourceFile, sourceLine: f.sourceLine, children: includeStubs(f), signature: fragmentSignature(f) });
        entry.fragments.push({ id: f.id, qualifiedId: qualify(ns, f.id), line: f.sourceLine });
      }
      for (const rm of sqlMap.resultMaps) {
        stub.resultMaps.push({ type: 'ResultMap', id: rm.id, extends: rm.extends, sourceFile, sourceLine: rm.sourceLine, results: [], resolvedParent: null });
        entry.resultMaps.push({ id: rm.id, extends: rm.extends, line: rm.sourceLine });
      }
      for (const pm of sqlMap.parameterMaps) stub.parameterMaps.push({ type: 'ParameterMap', id: pm.id, sourceFile, sourceLine: pm.sourceLine });
      for (const cm of sqlMap.cacheModels) stub.cacheModels.push({ type: 'CacheModel', id: cm.id, sourceFile, sourceLine: cm.sourceLine });
      candidate.stub = stub;
      // the parse is already paid for: keep it while the cache has room (no extra memory past its bound)
      this.mappers.set(sourceFile, this.#indexMapper(sqlMap, mybatis));
    }

    // Copies are dropped by CONTENT, never by folder name: of the files holding the same mapper,
    // the one that looks least like build output (copyScore) stays, the others are listed as
    // copies of it. A mapper with a single file stays wherever it is (out/, bin/, WEB-INF/classes…).
    const keep = new Map(); // signature -> candidate
    for (const c of candidates) {
      if (!c.signature) continue;
      const best = keep.get(c.signature);
      const better = !best || copyScore(c.entry.sourceFile) < copyScore(best.entry.sourceFile)
        || (copyScore(c.entry.sourceFile) === copyScore(best.entry.sourceFile) && c.entry.sourceFile.length < best.entry.sourceFile.length);
      if (better) keep.set(c.signature, c);
    }
    for (const c of candidates) {
      const original = c.signature ? keep.get(c.signature) : c;
      if (original !== c) {
        skipped.push({ sourceFile: c.entry.sourceFile, kind: 'BUILD_COPY', reason: `${SKIP_REASONS.BUILD_COPY} (원본: ${original.entry.sourceFile})`, copyOf: original.entry.sourceFile });
        this.mappers.delete(c.entry.sourceFile);
        continue;
      }
      files.push(c.entry);
      diagnostics.merge(c.fileDiagnostics);
      if (c.stub) stubMappers.push({ sourceFile: c.entry.sourceFile, sqlMap: c.stub });
    }

    // everything known about the mappers without their SQL: registry, the one lookup rule, the include graph
    this.meta = new ProjectMetadata({ files, stubMappers, diagnostics });
    this.skipped = skipped;
    return this;
  }

  // ---------------------------------------------------------------- loading

  /** a file that can't be parsed: its fragments as empty placeholders (registered from scanMapperIds) */
  #unparsedIndex(text, sourceFile) {
    const ids = scanMapperIds(text);
    const sqlMap = {
      type: 'SqlMap', namespace: ids.namespace ?? '', sourceFile, statements: [], resultMaps: [], parameterMaps: [], cacheModels: [],
      sqlFragments: ids.fragments.map((f) => ({ type: 'SqlFragment', id: f.id, sourceFile, sourceLine: f.line, children: [], unparsed: true })),
    };
    return this.#indexMapper(sqlMap, null);
  }

  #indexMapper(sqlMap, mybatis = null) {
    return {
      sqlMap,
      /** a MyBatis input file's own AST (null for iBATIS): its "conversion" is itself */
      mybatis,
      statements: new Map(sqlMap.statements.map((s) => [s.id, s])),
      fragments: new Map(sqlMap.sqlFragments.map((s) => [s.id, s])),
      resultMaps: new Map(sqlMap.resultMaps.map((s) => [s.id, s])),
      parameterMaps: new Map(sqlMap.parameterMaps.map((s) => [s.id, s])),
    };
  }

  text(sourceFile) {
    this.#assertOpen();
    return this.texts.getOrLoad(sourceFile, () => this.source.read(sourceFile).text);
  }

  /** the parsed AST of one file, from the cache or loaded now */
  mapper(sourceFile) {
    this.#assertOpen();
    return this.mappers.getOrLoad(sourceFile, () => {
      this.loads++;
      const text = this.text(sourceFile);
      const { sqlMap, mybatis } = parseMapper(text, sourceFile, this.meta.file(sourceFile)?.syntax);
      return sqlMap ? this.#indexMapper(sqlMap, mybatis) : this.#unparsedIndex(text, sourceFile);
    });
  }

  #realNode(sourceFile, type, localId) {
    const m = this.mapper(sourceFile);
    if (type === SymbolType.STATEMENT) return m.statements.get(localId);
    if (type === SymbolType.SQL_FRAGMENT) return m.fragments.get(localId);
    if (type === SymbolType.RESULT_MAP) return m.resultMaps.get(localId);
    if (type === SymbolType.PARAMETER_MAP) return m.parameterMaps.get(localId);
    return null;
  }

  hasStatement(qualifiedId) {
    return this.meta.hasStatement(qualifiedId);
  }

  #assertOpen() {
    if (this.closed) throw new Error('project session is closed');
  }

  /** a resolver over the real (lazily loading) symbols — fresh per use, nothing accumulates */
  #realResolver() {
    return new ReferenceResolver(this.meta.symbolTable, new DiagnosticBag(), {
      index: this.meta.index,
      loadNode: (symbol) => this.#realNode(symbol.sourceFile, symbol.type, symbol.localId),
    });
  }

  // ---------------------------------------------------------------- per statement

  /** @returns {object|null} StatementAnalysis (cached, LRU) */
  analyze(qualifiedId) {
    const at = this.meta.locate(qualifiedId);
    if (!at) return null;
    return this.analyses.getOrLoad(qualifiedId, () => {
      const statement = this.mapper(at.sourceFile).statements.get(at.localId);
      if (!statement) return null;
      const resolved = this.#realResolver().resolve(statement, at.namespace, qualifiedId);
      return this.statementAnalyzer.analyze(resolved.originalTree, resolved.resolvedTree, qualifiedId, this.dialect);
    });
  }

  /** resolved / original trees of one statement (for flattening, tests) */
  resolve(qualifiedId) {
    const at = this.meta.locate(qualifiedId);
    const statement = at && this.mapper(at.sourceFile).statements.get(at.localId);
    return statement ? this.#realResolver().resolve(statement, at.namespace, qualifiedId) : null;
  }

  /**
   * The `<include>`s of a statement or fragment as a tree, every depth, in
   * document order: `[{ refid, qualifiedId, children }]`, or
   * `{ refid, unresolved: 'MISSING' | 'CIRCULAR' }`. Taken from the
   * resolver's resolved tree, so a nested bare refid is followed the way the
   * runtime follows it (against the root statement's namespace).
   */
  includeTree(qualifiedId) {
    return this.meta.includeTree(qualifiedId);
  }


  #context(namespace, extra = {}) {
    return { namespace, resolveReference: (ref, ns, type, options) => this.meta.qualifiedIdOf(ref, ns, type, options), ...extra };
  }

  /** MyBatis conversion of one statement: { node, events, safetySummary, xml } */
  convertStatement(qualifiedId) {
    const at = this.meta.locate(qualifiedId);
    const m = at && this.mapper(at.sourceFile);
    const statement = m?.statements.get(at.localId);
    if (!statement) return null;
    const { node, events } = m.mybatis
      ? { node: m.mybatis.statements.find((s) => s.id === at.localId), events: [alreadyMyBatis(statement)] }
      : this.converter.convertStatement(statement, this.#context(at.namespace));
    const preview = new MapperNode({ namespace: at.namespace });
    preview.statements = [node];
    return { node, events, safetySummary: this.safety.summarize(events), xml: this.xml.generate(preview) };
  }

  /** MyBatis conversion of a whole file (statements, fragments, resultMaps) */
  convertFile(sourceFile) {
    const m = this.mapper(sourceFile);
    const ns = m.sqlMap.namespace;
    if (m.mybatis) {
      // already MyBatis: the file is its own conversion (never mutated: the schema migration copies)
      const graded = (nodes) => new Map(nodes.map((n) => {
        const events = [alreadyMyBatis(n)];
        return [qualify(ns, n.id), { events, safetySummary: this.safety.summarize(events) }];
      }));
      return { mapperNode: m.mybatis, statements: graded(m.sqlMap.statements), fragments: graded(m.sqlMap.sqlFragments), xml: this.xml.generate(m.mybatis), syntax: 'mybatis' };
    }
    const mapperNode = new MapperNode({ namespace: ns });
    const statements = new Map();
    const fragments = new Map();
    for (const st of m.sqlMap.statements) {
      const { node, events } = this.converter.convertStatement(st, this.#context(ns));
      mapperNode.statements.push(node);
      statements.set(qualify(ns, st.id), { events, safetySummary: this.safety.summarize(events) });
    }
    for (const f of m.sqlMap.sqlFragments) {
      const fqid = qualify(ns, f.id);
      const { node, events } = this.converter.convertSqlFragment(f, this.#context(ns, { fragmentQualifiedId: fqid }));
      mapperNode.sqlFragments.push(node);
      fragments.set(fqid, { events, safetySummary: this.safety.summarize(events) });
    }
    const resolver = this.#realResolver();
    for (const rm of m.sqlMap.resultMaps) {
      resolver.resolveResultMapExtends(rm, ns);
      mapperNode.resultMaps.push(this.converter.convertResultMap(rm, this.#context(ns)).node);
    }
    return { mapperNode, statements, fragments, xml: this.xml.generate(mapperNode) };
  }

  /** qualified ids of the fragments a statement / fragment includes, transitively (ProjectMetadata) */
  includedFragments(qualifiedId) {
    return this.meta.includedFragments(qualifiedId);
  }

  /** files whose statements include `fragmentQualifiedId` (directly or through other fragments) */
  includerFiles(fragmentQualifiedId) {
    return this.meta.includerFiles(fragmentQualifiedId);
  }

  /**
   * The original XML of a statement and of every fragment it includes
   * (for the lineage view): sliced from the files, never the whole project.
   */
  statementXml(qualifiedId) {
    const at = this.meta.locate(qualifiedId);
    if (!at) return null;
    const entry = this.meta.file(at.sourceFile);
    const meta = entry.statements.find((s) => s.id === at.localId);
    const fragments = {};
    for (const fid of this.includedFragments(qualifiedId)) {
      const fat = this.meta.locate(fid);
      if (!fat) continue;
      const fmeta = this.meta.file(fat.sourceFile).fragments.find((f) => f.id === fat.localId);
      fragments[fid] = { namespace: fat.namespace, sourceFile: fat.sourceFile, xml: this.#nodeXml(fat.sourceFile, 'fragment', fat.localId) ?? this.#slice(fat.sourceFile, fmeta.line, 'sql') };
    }
    return {
      qualifiedId,
      namespace: at.namespace,
      sourceFile: at.sourceFile,
      line: meta.line,
      lines: entry.lines,
      resultMaps: this.#resultMapChain(meta.resultMap, at.namespace),
      // how every <include> of the statement resolved, nested ones too (the UI expands from this)
      includeTree: this.includeTree(qualifiedId),
      xml: this.#nodeXml(at.sourceFile, 'statement', at.localId) ?? this.#slice(at.sourceFile, meta.line, STATEMENT_TAGS[meta.type] ?? 'select'),
      fragments,
    };
  }

  /**
   * A statement's / fragment's XML regenerated from its parsed AST — always well-formed, so
   * the browser's strict XML parser accepts it even when the file needed lenient parsing
   * (an unescaped "<" in SQL, an unclosed tag). Null for a file that couldn't be parsed:
   * the caller falls back to the raw slice.
   */
  #nodeXml(sourceFile, kind, localId) {
    const entry = this.meta.file(sourceFile);
    if (!entry?.parsed) return null;
    const m = this.mapper(sourceFile);
    if (m.mybatis) {
      const node = (kind === 'statement' ? m.mybatis.statements : m.mybatis.sqlFragments).find((n) => n.id === localId);
      return node ? this.xml.generateNode(node) : null;
    }
    const node = kind === 'statement' ? m.statements.get(localId) : m.fragments.get(localId);
    return node ? this.ibatisXml.generateNode(node) : null;
  }

  /** `<resultMap>` XML following `extends`, leaf first (resolved by the resolver's rules) */
  #resultMapChain(name, namespace) {
    return this.meta.resultMapChain(name, namespace).flatMap(({ qualifiedId, sourceFile, symbol }) => {
      const meta = this.meta.file(sourceFile)?.resultMaps.find((r) => r.id === symbol.localId);
      return meta ? [{ qualifiedId, sourceFile, xml: this.#slice(sourceFile, meta.line, 'resultMap') }] : [];
    });
  }


  /** the element whose start tag is on `line`, up to its end tag (statements and <sql> never nest in themselves) */
  #slice(sourceFile, line, tag) {
    const text = this.text(sourceFile);
    let offset = 0;
    for (let n = 1; n < line && offset !== -1; n++) offset = text.indexOf('\n', offset) + 1 || -1;
    if (offset === -1) return '';
    const open = new RegExp(`<${tag}(?=[\\s>/])`, 'g');
    open.lastIndex = offset;
    const start = open.exec(text)?.index ?? offset;
    const startTagEnd = text.indexOf('>', start);
    if (startTagEnd !== -1 && text[startTagEnd - 1] === '/') return text.slice(start, startTagEnd + 1);
    const close = `</${tag}>`;
    const end = text.indexOf(close, start);
    return end === -1 ? text.slice(start) : text.slice(start, end + close.length);
  }

  /**
   * Old -> new schema migration of one statement and the fragments it
   * includes. Only the files involved are loaded: the statement's, its
   * fragments', and up to `schemaSiteFiles` of the files that include those
   * fragments, which the migration needs to infer a FROM-less fragment's
   * tables.
   */
  schemaMigration(qualifiedId, mapping, options = {}, { formatSql = false, inlineRefid = false } = {}) {
    const mybatisXml = formatSql ? new XmlGenerator({ formatSql }) : this.xml;
    const sourceXml = (r) => (r.syntax === 'mybatis' ? mybatisXml : formatSql ? new IbatisXmlGenerator({ formatSql }) : this.ibatisXml);
    const at = this.meta.locate(qualifiedId);
    if (!at) return null;
    const fragmentIds = this.includedFragments(qualifiedId);
    const { results, sampled } = this.#migrateFiles(this.#schemaFiles([at.sourceFile], fragmentIds), mapping, options);
    const pick = (qid, kind) => {
      const loc = this.meta.locate(qid);
      const r = results.get(loc.sourceFile);
      const i = kind === 'statement'
        ? r.ibatis.mapper.statements.findIndex((s) => s.id === loc.localId)
        : r.ibatis.mapper.sqlFragments.findIndex((s) => s.id === loc.localId);
      const list = (side) => (kind === 'statement' ? side.mapper.statements : side.mapper.sqlFragments);
      const originalList = (side) => (kind === 'statement' ? side.original.statements : side.original.sqlFragments);
      const flat = (node, side, after) => (inlineRefid ? this.inlineIncludes(node, loc.namespace, ProjectSession.fragmentsOf(results, side, after), qid) : node);
      const texts = {
        ibatisBefore: sourceXml(r).generateNode(flat(originalList(r.ibatis)[i], 'ibatis', false)),
        ibatisAfter: sourceXml(r).generateNode(flat(list(r.ibatis)[i], 'ibatis', true)),
        mybatisBefore: mybatisXml.generateNode(flat(originalList(r.mybatis)[i], 'mybatis', false)),
        mybatisAfter: mybatisXml.generateNode(flat(list(r.mybatis)[i], 'mybatis', true)),
      };
      if (texts.ibatisAfter === texts.ibatisBefore) delete texts.ibatisAfter;
      if (texts.mybatisAfter === texts.mybatisBefore) delete texts.mybatisAfter;
      const events = r.mybatis.events.filter((e) => e.statementId === loc.localId).map(({ tokenIndex, ...e }) => e);
      if (kind === 'fragment' && sampled.has(qid)) {
        events.push({ grade: 'WARNING', code: 'FRAGMENT_CONTEXT_SAMPLED', message: `context inferred from ${this.schemaSiteFiles} of the ${sampled.get(qid)} files that include this fragment`, statementId: loc.localId });
      }
      const conversion = kind === 'statement' ? r.conversion.statements.get(qid) : r.conversion.fragments.get(qid);
      return { sourceFile: loc.sourceFile, ...texts, events, conversion: conversion ? { events: conversion.events, summary: conversion.safetySummary } : null };
    };
    const fragments = {};
    for (const fid of fragmentIds) if (this.meta.locate(fid)) fragments[fid] = { id: this.meta.locate(fid).localId, ...pick(fid, 'fragment') };
    return { statement: { ...pick(qualifiedId, 'statement'), includes: fragmentIds }, fragments };
  }

  /**
   * Schema migration scoped to one file: the file, every fragment its
   * statements include (transitively, from any file) and, for those
   * fragments' context, up to `schemaSiteFiles` of their includers' files.
   * @returns {{ results: Map, fragmentIds: string[], sampled: Map<string, number> }}
   */
  migrateForFile(sourceFile, mapping, options = {}) {
    const entry = this.meta.file(sourceFile);
    if (!entry?.parsed) return null;
    const fragmentIds = [...new Set([
      ...entry.fragments.map((f) => f.qualifiedId),
      ...entry.statements.flatMap((st) => this.includedFragments(st.qualifiedId)),
      ...entry.fragments.flatMap((f) => this.includedFragments(f.qualifiedId)),
    ])];
    const scope = this.#schemaFiles([sourceFile], fragmentIds);
    return { ...this.#migrateFiles(scope, mapping, options), fragmentIds };
  }

  /** the files a schema migration of `seedFiles` + `fragmentIds` needs, includer sites capped */
  #schemaFiles(seedFiles, fragmentIds) {
    const files = new Set(seedFiles);
    const sampled = new Map();
    for (const fid of fragmentIds) {
      const loc = this.meta.locate(fid);
      if (loc) files.add(loc.sourceFile);
      const includers = this.includerFiles(fid);
      if (includers.length > this.schemaSiteFiles) sampled.set(fid, includers.length);
      for (const f of includers.slice(0, this.schemaSiteFiles)) files.add(f);
      // the includers' own fragments must resolve too
      for (const f of includers.slice(0, this.schemaSiteFiles)) {
        for (const st of this.meta.file(f)?.statements ?? []) {
          for (const dep of this.includedFragments(st.qualifiedId)) {
            const dl = this.meta.locate(dep);
            if (dl) files.add(dl.sourceFile);
          }
        }
      }
    }
    return { files: [...files], sampled };
  }

  /**
   * Schema migration of a set of files, migrated together so cross-file
   * includes resolve: per file, the iBATIS and MyBatis ASTs before and after,
   * the events, and the MyBatis conversion. Everything returned is built for
   * this call only — the caller keeps what it needs and drops the rest.
   */
  migrateFiles(files, mapping, options = {}) {
    return this.#migrateFiles({ files, sampled: new Map() }, mapping, options).results;
  }

  #migrateFiles({ files, sampled }, mapping, options) {
    const converter = new SqlSchemaMigrationConverter(mapping, options);
    const conversions = files.map((f) => this.convertFile(f));
    // the "keep the syntax" side: an iBATIS file's own AST, or a MyBatis file's own AST
    const originals = files.map((f) => this.mapper(f).mybatis ?? this.mapper(f).sqlMap);
    // includes resolved by the project-wide resolver, not by whichever mappers are loaded
    const resolveInclude = (refid, writtenIn, root, fromFile) => this.meta.includeTarget(refid, writtenIn, root, fromFile ?? null).symbol?.qualifiedId ?? null;
    const mybatis = converter.convertMappers(conversions.map((c) => c.mapperNode), { resolveInclude });
    const ibatis = converter.convertMappers(originals, { resolveInclude });
    const results = new Map();
    files.forEach((f, i) => results.set(f, {
      mybatis: { ...mybatis[i], original: conversions[i].mapperNode },
      ibatis: { ...ibatis[i], original: originals[i] },
      conversion: conversions[i],
      syntax: this.meta.file(f)?.syntax ?? 'ibatis',
    }));
    return { results, sampled };
  }

  // ---------------------------------------------------------------- streaming, whole project

  /**
   * Per-statement schema-migration counts for the whole project (tree badges,
   * reports), file by file: each step loads one file and what it depends on,
   * keeps only counts, and lets the caches drop the rest.
   */
  schemaSummary(mapping, options = {}) {
    const counts = {};
    const totalEvents = [];
    const tally = (events) => {
      const t = { tables: 0, columns: 0, SAFE: 0, WARNING: 0, MANUAL: 0, ERROR: 0 };
      for (const e of events) {
        t[e.grade] = (t[e.grade] ?? 0) + 1;
        if (e.code === 'TABLE_RENAMED') t.tables++;
        if (e.code === 'COLUMN_RENAMED' || e.code === 'COLUMN_ASSUMED') t.columns++;
      }
      return t;
    };
    for (const file of this.files) {
      if (!file.parsed) continue;
      // the file's own fragments come with their includers' files, so their context is the same as in the 변환 view
      const { results, fragmentIds } = this.migrateForFile(file.sourceFile, mapping, options);
      const fragmentEvents = new Map();
      const fragmentConversion = new Map();
      for (const fid of fragmentIds) {
        const loc = this.meta.locate(fid);
        if (!loc) continue;
        const r = results.get(loc.sourceFile);
        fragmentEvents.set(fid, r.mybatis.events.filter((e) => e.statementId === loc.localId));
        fragmentConversion.set(fid, r.conversion.fragments.get(fid)?.events ?? []);
      }
      const own = results.get(file.sourceFile);
      // the project total counts each event once, in the file it belongs to
      for (const e of own.mybatis.events) totalEvents.push({ grade: e.grade, code: e.code });
      for (const st of file.statements) {
        const events = [...own.mybatis.events.filter((e) => e.statementId === st.id), ...this.includedFragments(st.qualifiedId).flatMap((f) => fragmentEvents.get(f) ?? [])];
        const conversion = [...(own.conversion.statements.get(st.qualifiedId)?.events ?? []), ...this.includedFragments(st.qualifiedId).flatMap((f) => fragmentConversion.get(f) ?? [])];
        counts[st.qualifiedId] = { schema: tally(events), conversion: tally(conversion) };
      }
    }
    return { statements: counts, total: tally(totalEvents) };
  }

  /**
   * Mapper reports, the project table usage report and the table dependency
   * graph — the pipeline's project-wide outputs — computed statement by
   * statement without keeping the analyses (their lineage is dropped).
   */
  report() {
    if (this.reportCache) return this.reportCache;
    const mapperReports = [];
    const slim = [];
    for (const file of this.files) {
      const sqlMap = file.parsed ? this.mapper(file.sourceFile).sqlMap : null;
      const analyses = file.statements.map((s) => this.analyses.get(s.qualifiedId) ?? this.#analyzeUncached(s.qualifiedId));
      // the table graph needs only tables and joins: the rest of each analysis is dropped with this file
      for (const a of analyses) slim.push({ id: a.id, tables: a.tables, joins: a.joins });
      const fileDiagnostics = {
        warnings: this.diagnostics.warnings.filter((w) => w.sourceFile === file.sourceFile),
        errors: this.diagnostics.errors.filter((e) => e.sourceFile === file.sourceFile),
      };
      mapperReports.push(new MapperReport().build(sqlMap, analyses, fileDiagnostics));
    }
    // aggregates only (counts, table usage, table-to-table edges), so kept once computed
    this.reportCache = {
      mappers: mapperReports,
      tables: new ProjectReport().build(mapperReports),
      tableDependencyGraph: new DependencyAnalyzer(this.meta.dependencyGraph).buildTableDependencyGraph(slim),
    };
    return this.reportCache;
  }

  #analyzeUncached(qualifiedId) {
    const at = this.meta.locate(qualifiedId);
    const statement = this.mapper(at.sourceFile).statements.get(at.localId);
    const resolved = this.#realResolver().resolve(statement, at.namespace, qualifiedId);
    return this.statementAnalyzer.analyze(resolved.originalTree, resolved.resolvedTree, qualifiedId, this.dialect);
  }

  /**
   * A copy of a statement / fragment AST with every `<include>` replaced by the
   * nodes of the fragment it resolves to (the project rule, includeTarget),
   * recursively — "refid 쿼리에 통합": the query as one text, ready to copy.
   * `fragments` maps qualified id -> the fragment node of the SAME tree (iBATIS
   * or MyBatis, before or after the renames). A refid that resolves nowhere, or
   * back into its own chain, stays an `<include>`. Inputs are never mutated.
   */
  inlineIncludes(root, namespace, fragments, rootQualifiedId = null) {
    const withChildren = (node, children) => Object.assign(Object.create(Object.getPrototypeOf(node)), node, { children });
    const expand = (nodes, writtenIn, stack) => (nodes ?? []).flatMap((node) => {
      if (node.type === 'Include') {
        const qualifiedId = this.meta.includeTarget(node.refid, writtenIn, namespace, node.sourceFile ?? null).symbol?.qualifiedId;
        const fragment = qualifiedId && fragments.get(qualifiedId);
        if (!fragment || stack.includes(qualifiedId)) return [node];
        return expand(fragment.children, this.meta.locate(qualifiedId)?.namespace ?? writtenIn, [...stack, qualifiedId]);
      }
      return node.children ? [withChildren(node, expand(node.children, writtenIn, stack))] : [node];
    });
    return withChildren(root, expand(root.children, namespace, rootQualifiedId ? [rootQualifiedId] : []));
  }

  /** qualified id -> fragment node, for one side of a migration result set ('ibatis' | 'mybatis', before / after) */
  static fragmentsOf(results, side, after) {
    const map = new Map();
    for (const r of results.values()) {
      const mapper = after ? r[side].mapper : r[side].original;
      for (const f of mapper.sqlFragments ?? []) map.set(mapper.namespace ? `${mapper.namespace}.${f.id}` : f.id, f);
    }
    return map;
  }

  /**
   * The namespace registry built at open: every namespace, the files it is spread over
   * (one namespace may span many files in many folders), and what each declares.
   */
  namespaces() {
    return this.meta.namespaces();
  }


  // ---------------------------------------------------------------- column removal guide

  /** the index entry of a statement ({ id, type, line, parameterClass, resultClass, resultMap }) */
  statementMeta(qualifiedId) {
    return this.meta.statementMeta(qualifiedId);
  }


  /** statements that include `fragmentQualifiedId`, directly or through other fragments */
  includerStatements(fragmentQualifiedId) {
    return this.meta.includerStatements(fragmentQualifiedId);
  }


  /** every `<include refid>` that points at `fragmentQualifiedId`: { statement, file, line, refid, text } */
  includeSites(fragmentQualifiedId) {
    return this.meta.includeSites(fragmentQualifiedId).map((site) => ({ ...site, text: (this.text(site.file).split('\n')[site.line - 1] ?? '').trim() }));
  }


  /** a resultMap and the ones it extends, as AST nodes (loaded on demand) */
  resultMapNodes(name, namespace) {
    return this.meta.resultMapChain(name, namespace).flatMap(({ qualifiedId, sourceFile, symbol }) => {
      const node = this.#realNode(sourceFile, symbol.type, symbol.localId);
      return node ? [{ qualifiedId, sourceFile, node }] : [];
    });
  }


  /** statements whose resultMap="…" resolves to `resultMapQualifiedId` */
  statementsUsingResultMap(resultMapQualifiedId) {
    return this.meta.statementsUsingResultMap(resultMapQualifiedId);
  }


  /** see ColumnRemovalGuide: what to remove, and where, to drop one output column */
  columnRemovalGuide(qualifiedId, column) {
    return this.hasStatement(qualifiedId) ? buildColumnRemovalGuide(this, qualifiedId, column) : null;
  }

  // ---------------------------------------------------------------- search

  /**
   * Finds `query` (case-insensitive) in the project's mappers: in file paths,
   * namespaces and ids, and in the XML text itself — so a table, column,
   * alias, parameter or refid finds the statements using it. A text hit
   * belongs to the statement / `<sql>` / resultMap whose element contains
   * that line; a hit inside a `<sql>` fragment also counts for every
   * statement that includes it (directly or not). Files are read through the
   * same bounded cache as everything else.
   * @returns {{ query: string, files: object[], statements: number, truncated: boolean }}
   */
  search(query, { limit = 2000 } = {}) {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return { query: '', files: [], statements: 0, truncated: false };
    const hits = new Map(); // sourceFile -> { file, statements: Map<qid, Set<reason>>, fragments: Map<qid, Set<reason>> }
    const at = (sourceFile) => hits.get(sourceFile) ?? hits.set(sourceFile, { file: false, statements: new Map(), fragments: new Map() }).get(sourceFile);
    const add = (sourceFile, kind, qid, reason) => {
      const map = at(sourceFile)[kind];
      (map.get(qid) ?? map.set(qid, new Set()).get(qid)).add(reason);
    };
    let count = 0;
    for (const file of this.files) {
      if (count >= limit) break;
      if (file.sourceFile.toLowerCase().includes(q) || (file.namespace ?? '').toLowerCase().includes(q)) at(file.sourceFile).file = true;
      for (const s of file.statements) if (s.qualifiedId.toLowerCase().includes(q)) add(file.sourceFile, 'statements', s.qualifiedId, 'id');
      for (const f of file.fragments) if (f.qualifiedId.toLowerCase().includes(q)) add(file.sourceFile, 'fragments', f.qualifiedId, 'id');
      if (!file.parsed) continue;
      // the element owning a line: the last statement / fragment / resultMap starting at or before it
      const owners = [
        ...file.statements.map((s) => ({ line: s.line, kind: 'statements', qid: s.qualifiedId })),
        ...file.fragments.map((f) => ({ line: f.line, kind: 'fragments', qid: f.qualifiedId })),
        ...file.resultMaps.map((r) => ({ line: r.line, kind: 'resultMaps', qid: null })),
      ].sort((a, b) => a.line - b.line);
      const lines = this.text(file.sourceFile).split('\n');
      let o = -1;
      for (let i = 0; i < lines.length; i++) {
        while (o + 1 < owners.length && owners[o + 1].line <= i + 1) o++;
        if (o < 0 || !owners[o].qid || !lines[i].toLowerCase().includes(q)) continue;
        add(file.sourceFile, owners[o].kind, owners[o].qid, 'sql');
      }
      count += hits.get(file.sourceFile)?.statements.size ?? 0;
    }
    // a fragment hit reaches every statement including it (the refid chain), whatever file it is in
    for (const [, hit] of [...hits]) {
      for (const fid of hit.fragments.keys()) {
        for (const from of this.meta.includerStatements(fid)) add(this.meta.fileOf(from), 'statements', from, `refid:${fid}`);
      }
    }
    const files = [...hits].filter(([, h]) => h.file || h.statements.size || h.fragments.size).map(([sourceFile, h]) => ({
      sourceFile,
      file: h.file,
      statements: Object.fromEntries([...h.statements].map(([k, v]) => [k, [...v]])),
      fragments: Object.fromEntries([...h.fragments].map(([k, v]) => [k, [...v]])),
    }));
    const statements = files.reduce((n, f) => n + Object.keys(f.statements).length, 0);
    return { query: q, files, statements, matchedFiles: files.filter((f) => f.file).length, truncated: count >= limit };
  }

  // ---------------------------------------------------------------- summary, lifecycle

  /** the index as JSON: what the UI tree and the stat strip need, nothing heavier */
  summary() {
    return {
      files: this.files.map((f) => ({
        sourceFile: f.sourceFile,
        namespace: f.namespace,
        encoding: f.encoding,
        syntax: f.syntax,
        external: f.external,
        lines: f.lines,
        parsed: f.parsed,
        statements: f.statements.map((s) => ({ ...s, includes: this.includedFragments(s.qualifiedId).length })),
        fragments: f.fragments,
        resultMaps: f.resultMaps,
        ...(f.unparsedStatements ? { unparsedStatements: f.unparsedStatements } : {}),
      })),
      skipped: this.skipped,
      errors: this.diagnostics.errors,
      warnings: this.diagnostics.warnings,
      circularReferences: this.meta.circularReferences.map((c) => c.path),
      includeUsage: this.#includeUsage(),
      totals: {
        files: this.files.length,
        statements: this.files.reduce((n, f) => n + f.statements.length, 0),
        fragments: this.files.reduce((n, f) => n + f.fragments.length, 0),
        lines: this.files.reduce((n, f) => n + f.lines, 0),
      },
    };
  }

  /** fragment -> how many statements include it (directly or not), from the graph */
  #includeUsage() {
    return this.meta.includeUsage();
  }


  stats() {
    return {
      cachedFiles: this.mappers.count,
      cachedTextBytes: this.texts.size,
      cachedAnalyses: this.analyses.count,
      loadsAfterOpen: this.loads,
      caches: { mappers: this.mappers.stats, texts: this.texts.stats, analyses: this.analyses.stats },
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.texts.clear();
    this.mappers.clear();
    this.analyses.clear();
    this.reportCache = null;
    // the index goes too: a closed session holds nothing but its flag
    this.meta = null;
    this.skipped = null;
    this.source.close();
  }
}
