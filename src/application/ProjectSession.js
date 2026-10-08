import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseIbatisMapperSource } from '../parser/ibatis/IbatisMapperParser.js';
import { IncludeNode } from '../ast/ibatis/nodes.js';
import { SymbolType } from '../ast/ibatis/enums.js';
import { buildSymbolTable } from '../resolver/symbol/ProjectScanner.js';
import { ReferenceResolver } from '../resolver/reference/ReferenceResolver.js';
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
import { decodeXml, classifyXml, classifyHead, HEAD_BYTES, SKIP_REASONS } from './mapperDetection.js';
import { LruCache } from './LruCache.js';

/**
 * A project opened for interactive or batch work WITHOUT holding it in
 * memory. AnalyzerPipeline analyses and converts everything up front and
 * keeps all of it. A session instead:
 *
 * 1. **On open, builds an index only.** Each file is read, classified and
 *    parsed once. What is kept is the file list, every statement / fragment
 *    / resultMap id and, per node, just its `<include refid>` list as a
 *    tiny stub. The text and the AST are dropped.
 * 2. **Resolves the project-wide reference graph on the stubs.** That is
 *    include chains, missing / circular / ambiguous / nested-namespace
 *    diagnostics, and which namespaces include each fragment. It uses the
 *    same ReferenceResolver as the pipeline (identical rules), without
 *    reading a file again.
 * 3. **Loads on demand.** A statement's analysis, conversion, XML or
 *    schema migration reads only the files it needs (its own, its
 *    fragments', and for schema inference a capped number of includers').
 *    Those files go through bounded LRU caches: file text, parsed AST,
 *    analyses. A real symbol table resolves includes by loading fragment
 *    files lazily.
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

  /** Builds the index. Returns this. */
  open() {
    const diagnostics = new DiagnosticBag();
    const files = [];
    const skipped = [];
    const stubMappers = [];
    for (const { sourceFile, size } of this.source.list()) {
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
        if (early && early !== 'IBATIS_MAPPER') {
          skipped.push({ sourceFile, kind: early, reason: SKIP_REASONS[early] });
          continue;
        }
        ({ text, encoding } = this.source.read(sourceFile));
      } catch (e) {
        skipped.push({ sourceFile, kind: 'UNREADABLE', reason: e.message });
        continue;
      }
      const kind = classifyXml(text);
      if (kind !== 'IBATIS_MAPPER') {
        skipped.push({ sourceFile, kind, reason: SKIP_REASONS[kind] });
        continue;
      }
      const { sqlMap, diagnostics: fileDiagnostics } = parseIbatisMapperSource(text, sourceFile);
      diagnostics.merge(fileDiagnostics);
      const entry = { sourceFile, size, encoding, lines: text.split('\n').length, namespace: sqlMap?.namespace ?? null, parsed: Boolean(sqlMap), statements: [], fragments: [], resultMaps: [] };
      files.push(entry);
      if (!sqlMap) continue;
      const ns = sqlMap.namespace;
      // the stub mapper keeps ids, include lists and the attributes reference resolution reads
      const stub = { namespace: ns, sourceFile, statements: [], sqlFragments: [], resultMaps: [], parameterMaps: [], cacheModels: [] };
      const includeStubs = (node) => collectIncludes(node).map((inc) => new IncludeNode({ refid: inc.refid, sourceFile: inc.sourceFile, sourceLine: inc.sourceLine }));
      for (const st of sqlMap.statements) {
        stub.statements.push({ type: 'Statement', id: st.id, statementType: st.statementType, resultMap: st.resultMap, parameterMap: st.parameterMap, sourceFile, sourceLine: st.sourceLine, children: includeStubs(st) });
        entry.statements.push({ id: st.id, qualifiedId: qualify(ns, st.id), type: st.statementType, line: st.sourceLine, parameterClass: st.parameterClass, resultClass: st.resultClass, resultMap: st.resultMap });
      }
      for (const f of sqlMap.sqlFragments) {
        stub.sqlFragments.push({ type: 'SqlFragment', id: f.id, sourceFile, sourceLine: f.sourceLine, children: includeStubs(f) });
        entry.fragments.push({ id: f.id, qualifiedId: qualify(ns, f.id), line: f.sourceLine });
      }
      for (const rm of sqlMap.resultMaps) {
        stub.resultMaps.push({ type: 'ResultMap', id: rm.id, extends: rm.extends, sourceFile, sourceLine: rm.sourceLine, results: [], resolvedParent: null });
        entry.resultMaps.push({ id: rm.id, extends: rm.extends, line: rm.sourceLine });
      }
      for (const pm of sqlMap.parameterMaps) stub.parameterMaps.push({ type: 'ParameterMap', id: pm.id, sourceFile, sourceLine: pm.sourceLine });
      for (const cm of sqlMap.cacheModels) stub.cacheModels.push({ type: 'CacheModel', id: cm.id, sourceFile, sourceLine: cm.sourceLine });
      stubMappers.push({ sourceFile, sqlMap: stub });
      // the parse is already paid for: keep it while the cache has room (no extra memory past its bound)
      this.mappers.set(sourceFile, this.#indexMapper(sqlMap));
    }

    // project-wide reference graph on the stubs: same resolver, same rules, no file reads
    const { symbolTable } = buildSymbolTable(stubMappers, diagnostics);
    const graph = new ReferenceResolver(symbolTable, diagnostics);
    for (const { sqlMap } of stubMappers) {
      for (const st of sqlMap.statements) {
        const qid = qualify(sqlMap.namespace, st.id);
        graph.resolve(st, sqlMap.namespace, qid);
        graph.linkStatementDependencies(st, sqlMap.namespace, qid);
      }
      for (const rm of sqlMap.resultMaps) graph.resolveResultMapExtends(rm, sqlMap.namespace);
    }
    this.graph = graph;
    // include edges, deduplicated, both directions (the resolver records a fragment's edges once per inclusion)
    this.includes = new Map();
    this.includedBy = new Map();
    const link = (map, a, b) => (map.get(a) ?? map.set(a, new Set()).get(a)).add(b);
    for (const [from, edges] of graph.dependencyGraph._edges) {
      for (const { to, kind } of edges) {
        if (kind !== 'INCLUDE') continue;
        link(this.includes, from, to);
        link(this.includedBy, to, from);
      }
    }
    this.diagnostics = diagnostics;
    this.files = files;
    this.skipped = skipped;
    this.fileByQualifiedId = new Map();
    this.namespaceOfFile = new Map();
    this.fileEntries = new Map(files.map((f) => [f.sourceFile, f]));
    this.statementIds = new Set(files.flatMap((f) => f.statements.map((st) => st.qualifiedId)));
    for (const f of files) {
      this.namespaceOfFile.set(f.sourceFile, f.namespace);
      for (const s of f.statements) this.fileByQualifiedId.set(s.qualifiedId, f.sourceFile);
      for (const s of f.fragments) this.fileByQualifiedId.set(s.qualifiedId, f.sourceFile);
    }
    // From here on the graph resolver only reads ids and namespaces (qualifiedIdOf), so the same
    // table becomes the real one: each symbol's `node` loads the real AST on first touch, and the
    // stubs, no longer referenced, are collected.
    for (const list of symbolTable._byQualifiedId.values()) {
      for (const symbol of list) {
        const { sourceFile, type, localId } = symbol;
        Object.defineProperty(symbol, 'node', { configurable: true, get: () => this.#realNode(sourceFile, type, localId) });
      }
    }
    this.realSymbols = symbolTable;
    return this;
  }

  // ---------------------------------------------------------------- loading

  #indexMapper(sqlMap) {
    return {
      sqlMap,
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
      const { sqlMap } = parseIbatisMapperSource(this.text(sourceFile), sourceFile);
      return this.#indexMapper(sqlMap);
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

  #locate(qualifiedId) {
    const sourceFile = this.fileByQualifiedId.get(qualifiedId);
    if (!sourceFile) return null;
    const namespace = this.namespaceOfFile.get(sourceFile);
    const localId = namespace ? qualifiedId.slice(namespace.length + 1) : qualifiedId;
    return { sourceFile, namespace, localId };
  }

  hasStatement(qualifiedId) {
    return this.statementIds.has(qualifiedId);
  }

  #assertOpen() {
    if (this.closed) throw new Error('project session is closed');
  }

  /** a resolver over the real (lazily loading) symbols — fresh per use, nothing accumulates */
  #realResolver() {
    return new ReferenceResolver(this.realSymbols, new DiagnosticBag());
  }

  // ---------------------------------------------------------------- per statement

  /** @returns {object|null} StatementAnalysis (cached, LRU) */
  analyze(qualifiedId) {
    const at = this.#locate(qualifiedId);
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
    const at = this.#locate(qualifiedId);
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
    const at = this.#locate(qualifiedId);
    if (!at) return [];
    const m = this.mapper(at.sourceFile);
    const node = m.statements.get(at.localId) ?? m.fragments.get(at.localId);
    if (!node) return [];
    const { resolvedTree } = this.#realResolver().resolve(node, at.namespace, qualifiedId);
    const walk = (children, out = []) => {
      for (const child of children ?? []) {
        if (child.type === 'ResolvedInclude') out.push({ refid: child.refid, qualifiedId: child.qualifiedId, children: walk(child.children) });
        else if (child.type === 'UnresolvedInclude') out.push({ refid: child.refid, unresolved: child.reason });
        else walk(child.children, out);
      }
      return out;
    };
    return walk(resolvedTree.children);
  }

  #context(namespace, extra = {}) {
    return { namespace, resolveReference: (ref, ns, type, options) => this.graph.qualifiedIdOf(ref, ns, type, options), ...extra };
  }

  /** MyBatis conversion of one statement: { node, events, safetySummary, xml } */
  convertStatement(qualifiedId) {
    const at = this.#locate(qualifiedId);
    const statement = at && this.mapper(at.sourceFile).statements.get(at.localId);
    if (!statement) return null;
    const { node, events } = this.converter.convertStatement(statement, this.#context(at.namespace));
    const preview = new MapperNode({ namespace: at.namespace });
    preview.statements = [node];
    return { node, events, safetySummary: this.safety.summarize(events), xml: this.xml.generate(preview) };
  }

  /** MyBatis conversion of a whole file (statements, fragments, resultMaps) */
  convertFile(sourceFile) {
    const m = this.mapper(sourceFile);
    const ns = m.sqlMap.namespace;
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

  /** qualified ids of the fragments a statement / fragment includes, transitively (from the graph) */
  includedFragments(qualifiedId) {
    const seen = new Set();
    const walk = (id) => {
      for (const to of this.includes.get(id) ?? []) {
        if (seen.has(to)) continue;
        seen.add(to);
        walk(to);
      }
    };
    walk(qualifiedId);
    return [...seen];
  }

  /** files whose statements include `fragmentQualifiedId` (directly or through other fragments) */
  includerFiles(fragmentQualifiedId) {
    const files = new Set();
    const walk = (id, seen) => {
      for (const from of this.includedBy.get(id) ?? []) {
        if (seen.has(from)) continue;
        seen.add(from);
        const file = this.fileByQualifiedId.get(from);
        if (file) files.add(file);
        walk(from, seen);
      }
    };
    walk(fragmentQualifiedId, new Set());
    return [...files];
  }

  /**
   * The original XML of a statement and of every fragment it includes
   * (for the lineage view): sliced from the files, never the whole project.
   */
  statementXml(qualifiedId) {
    const at = this.#locate(qualifiedId);
    if (!at) return null;
    const entry = this.fileEntries.get(at.sourceFile);
    const meta = entry.statements.find((s) => s.id === at.localId);
    const fragments = {};
    for (const fid of this.includedFragments(qualifiedId)) {
      const fat = this.#locate(fid);
      if (!fat) continue;
      const fmeta = this.fileEntries.get(fat.sourceFile).fragments.find((f) => f.id === fat.localId);
      fragments[fid] = { namespace: fat.namespace, sourceFile: fat.sourceFile, xml: this.#slice(fat.sourceFile, fmeta.line, 'sql') };
    }
    return {
      qualifiedId,
      namespace: at.namespace,
      sourceFile: at.sourceFile,
      line: meta.line,
      lines: entry.lines,
      resultMaps: this.#resultMapChain(meta.resultMap, at.namespace),
      xml: this.#slice(at.sourceFile, meta.line, STATEMENT_TAGS[meta.type] ?? 'select'),
      fragments,
    };
  }

  /** `<resultMap>` XML following `extends`, leaf first (resolved by the resolver's rules) */
  #resultMapChain(name, namespace) {
    const chain = [];
    const seen = new Set();
    let current = name;
    let ns = namespace;
    while (current) {
      const symbol = this.graph._resolveRefid(current, ns, SymbolType.RESULT_MAP);
      this.graph._ambiguous = null;
      if (!symbol || seen.has(symbol.qualifiedId)) break;
      seen.add(symbol.qualifiedId);
      const meta = this.fileEntries.get(symbol.sourceFile)?.resultMaps.find((r) => r.id === symbol.localId);
      if (!meta) break;
      chain.push({ qualifiedId: symbol.qualifiedId, sourceFile: symbol.sourceFile, xml: this.#slice(symbol.sourceFile, meta.line, 'resultMap') });
      current = meta.extends;
      ns = symbol.mapper;
    }
    return chain;
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
  schemaMigration(qualifiedId, mapping, options = {}) {
    const at = this.#locate(qualifiedId);
    if (!at) return null;
    const fragmentIds = this.includedFragments(qualifiedId);
    const { results, sampled } = this.#migrateFiles(this.#schemaFiles([at.sourceFile], fragmentIds), mapping, options);
    const pick = (qid, kind) => {
      const loc = this.#locate(qid);
      const r = results.get(loc.sourceFile);
      const i = kind === 'statement'
        ? r.ibatis.mapper.statements.findIndex((s) => s.id === loc.localId)
        : r.ibatis.mapper.sqlFragments.findIndex((s) => s.id === loc.localId);
      const list = (side) => (kind === 'statement' ? side.mapper.statements : side.mapper.sqlFragments);
      const originalList = (side) => (kind === 'statement' ? side.original.statements : side.original.sqlFragments);
      const texts = {
        ibatisBefore: this.ibatisXml.generateNode(originalList(r.ibatis)[i]),
        ibatisAfter: this.ibatisXml.generateNode(list(r.ibatis)[i]),
        mybatisBefore: this.xml.generateNode(originalList(r.mybatis)[i]),
        mybatisAfter: this.xml.generateNode(list(r.mybatis)[i]),
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
    for (const fid of fragmentIds) if (this.#locate(fid)) fragments[fid] = { id: this.#locate(fid).localId, ...pick(fid, 'fragment') };
    return { statement: { ...pick(qualifiedId, 'statement'), includes: fragmentIds }, fragments };
  }

  /**
   * Schema migration scoped to one file: the file, every fragment its
   * statements include (transitively, from any file) and, for those
   * fragments' context, up to `schemaSiteFiles` of their includers' files.
   * @returns {{ results: Map, fragmentIds: string[], sampled: Map<string, number> }}
   */
  migrateForFile(sourceFile, mapping, options = {}) {
    const entry = this.fileEntries.get(sourceFile);
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
      const loc = this.#locate(fid);
      if (loc) files.add(loc.sourceFile);
      const includers = this.includerFiles(fid);
      if (includers.length > this.schemaSiteFiles) sampled.set(fid, includers.length);
      for (const f of includers.slice(0, this.schemaSiteFiles)) files.add(f);
      // the includers' own fragments must resolve too
      for (const f of includers.slice(0, this.schemaSiteFiles)) {
        for (const st of this.fileEntries.get(f)?.statements ?? []) {
          for (const dep of this.includedFragments(st.qualifiedId)) {
            const dl = this.#locate(dep);
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
    const originals = files.map((f) => this.mapper(f).sqlMap);
    const mybatis = converter.convertMappers(conversions.map((c) => c.mapperNode));
    const ibatis = converter.convertMappers(originals);
    const results = new Map();
    files.forEach((f, i) => results.set(f, {
      mybatis: { ...mybatis[i], original: conversions[i].mapperNode },
      ibatis: { ...ibatis[i], original: originals[i] },
      conversion: conversions[i],
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
        const loc = this.#locate(fid);
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
      tableDependencyGraph: new DependencyAnalyzer(this.graph.dependencyGraph).buildTableDependencyGraph(slim),
    };
    return this.reportCache;
  }

  #analyzeUncached(qualifiedId) {
    const at = this.#locate(qualifiedId);
    const statement = this.mapper(at.sourceFile).statements.get(at.localId);
    const resolved = this.#realResolver().resolve(statement, at.namespace, qualifiedId);
    return this.statementAnalyzer.analyze(resolved.originalTree, resolved.resolvedTree, qualifiedId, this.dialect);
  }

  // ---------------------------------------------------------------- summary, lifecycle

  /** the index as JSON: what the UI tree and the stat strip need, nothing heavier */
  summary() {
    return {
      files: this.files.map((f) => ({
        sourceFile: f.sourceFile,
        namespace: f.namespace,
        encoding: f.encoding,
        lines: f.lines,
        parsed: f.parsed,
        statements: f.statements.map((s) => ({ ...s, includes: this.includedFragments(s.qualifiedId).length })),
        fragments: f.fragments,
        resultMaps: f.resultMaps,
      })),
      skipped: this.skipped,
      errors: this.diagnostics.errors,
      warnings: this.diagnostics.warnings,
      circularReferences: this.graph.circularReferences.map((c) => c.path),
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
    const usage = {};
    for (const f of this.files) {
      for (const s of f.statements) for (const fid of this.includedFragments(s.qualifiedId)) usage[fid] = (usage[fid] ?? 0) + 1;
    }
    return usage;
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
    this.graph = this.realSymbols = this.includes = this.includedBy = null;
    this.files = this.skipped = this.diagnostics = this.fileByQualifiedId = this.namespaceOfFile = this.fileEntries = this.statementIds = null;
    this.source.close();
  }
}
