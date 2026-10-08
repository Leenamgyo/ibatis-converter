import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import { SKIPPED_DIRECTORIES } from '../../application/mapperDetection.js';
import { ProjectSession, DirectorySource, UploadSource, createUploadSource } from '../../application/ProjectSession.js';
import { DependencyAnalyzer } from '../../analyzer/dependency/DependencyAnalyzer.js';
import { SessionManager } from './SessionManager.js';
import { XmlGenerator } from '../../generator/xml/XmlGenerator.js';
import { IbatisXmlGenerator } from '../../generator/xml/IbatisXmlGenerator.js';
import { validateMappingDefinition } from '../../converter/schema/index.js';
import { DatasetStore } from './DatasetStore.js';
import { LayoutStore, layoutError } from './LayoutStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Section 23 — analysis API — plus the sections 24-26 UI, served as plain
 * static files (`public/`) that call this same API via `fetch`. There is
 * no separate frontend build: `public/app.js` is loaded directly by the
 * browser, matching the rest of the project's "no bundler" stance.
 *
 * The API is stateless per HTTP connection but not per analysis: since
 * `GET /statements/:id` and `GET /tables/:tableName` need to look something
 * up by an id that's only unique *within* one `POST /analyze` run, that
 * run's result is kept in memory keyed by a generated `projectId` (also
 * usable as a `?projectId=` query param; omit it to mean "the most
 * recently analyzed project", which is enough for this tool's actual
 * usage pattern — a single local user, not a multi-tenant service).
 *
 * `GET /statements/:id/mybatis-preview` returns the converted MyBatis XML
 * for one statement plus its migration-safety summary (spec sections
 * 12-18); `GET /statements/:id/dependencies` returns its include/extends/
 * resultMap/parameterMap dependency tree (spec section 22); `analyze`'s
 * response also includes `tableDependencyGraph` (spec section 21).
 *
 * Schema migration (`converter/schema`, see docs/features/schema-migration.md):
 * `/api/v1/datasets` stores named old -> new mapping definitions as JSON files
 * (`datasetDir`, default `<repo>/data/datasets`), `/api/v1/datasets/validate`
 * checks one without saving, and `POST /api/v1/schema-migration` runs a
 * dataset (or an inline mapping) over an analyzed project's converted
 * MyBatis mappers, returning before/after XML per statement, fragment and file.
 */
const DEFAULT_DATASET_DIR = path.resolve(__dirname, '..', '..', '..', 'data', 'datasets');
const DEFAULT_LAYOUT_DIR = path.resolve(__dirname, '..', '..', '..', 'data', 'layouts');

/**
 * JSON, gzipped when the client accepts it and it's big. The analyze and
 * schema-migration responses of a large project are tens of MB of XML text,
 * which compresses ~10x. Done with node:zlib: no compression dependency.
 */
const isLoopback = (address = '') => address === '::1' || address.startsWith('127.') || address === '::ffff:127.0.0.1';

function sendJson(req, res, body) {
  const json = JSON.stringify(body);
  if (json.length < 64 * 1024 || !/\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
    res.json(body);
    return;
  }
  res.set({ 'content-type': 'application/json; charset=utf-8', 'content-encoding': 'gzip', vary: 'Accept-Encoding' });
  res.send(gzipSync(json));
}

export function createApp({
  datasetDir = process.env.DATASET_DIR ?? DEFAULT_DATASET_DIR,
  layoutDir = process.env.LAYOUT_DIR ?? DEFAULT_LAYOUT_DIR,
  sessionOptions = {},
} = {}) {
  const app = express();
  app.use(express.json({ limit: '100mb' }));
  app.use(express.static(path.join(__dirname, 'public')));
  // the folder upload decides "is this XML an iBATIS mapper?" with the same code as the CLI
  app.get('/shared/mapperDetection.js', (req, res) => {
    res.type('application/javascript').sendFile(path.resolve(__dirname, '..', '..', 'application', 'mapperDetection.js'));
  });

  const sessions = new SessionManager(sessionOptions);
  app.locals.sessions = sessions;

  function resolveProject(req, res) {
    const projectId = req.query.projectId ?? sessions.lastId;
    const project = projectId ? sessions.get(projectId) : undefined;
    if (!project) {
      res.status(404).json({ error: projectId ? `Unknown projectId "${projectId}" (closed or expired — open the project again)` : 'No project has been analyzed yet — POST /api/v1/projects/analyze first' });
      return null;
    }
    return project;
  }

  /** a session over uploaded `{ files }`: written to a temp dir, read back lazily */
  function openUpload(req, res) {
    const files = req.body?.files;
    if (!Array.isArray(files) || files.some((f) => typeof f.sourceFile !== 'string' || typeof f.source !== 'string')) {
      res.status(400).json({ error: 'Expected { files: [{ sourceFile, source }] }' });
      return null;
    }
    try {
      return new ProjectSession(createUploadSource(files)).open();
    } catch (err) {
      res.status(400).json({ error: err.message });
      return null;
    }
  }

  const indexBody = (projectId, session) => ({ projectId, ...session.summary() });

  // A big project arrives in batches: each batch is written to the upload's temp dir as it
  // comes, so neither the browser nor the server ever holds the whole project in one body.
  // An upload not opened within 10 minutes is deleted.
  const uploads = new SessionManager({ ttlMs: 10 * 60 * 1000, maxSessions: 4, sweepMs: sessionOptions.sweepMs ?? 60 * 1000 });
  app.locals.uploads = uploads;
  const validFiles = (files) => Array.isArray(files) && files.every((f) => typeof f?.sourceFile === 'string' && typeof f.source === 'string');

  app.post('/api/v1/uploads', (req, res) => {
    res.json({ uploadId: uploads.add(new UploadSource()) });
  });

  app.post('/api/v1/uploads/:uploadId/files', (req, res) => {
    const upload = uploads.get(req.params.uploadId);
    if (!upload) {
      res.status(404).json({ error: `Unknown uploadId "${req.params.uploadId}" (expired?)` });
      return;
    }
    if (!validFiles(req.body?.files)) {
      res.status(400).json({ error: 'Expected { files: [{ sourceFile, source }] }' });
      return;
    }
    try {
      res.json({ received: upload.add(req.body.files), bytes: upload.bytes });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/v1/uploads/:uploadId/open', (req, res) => {
    const upload = uploads.detach(req.params.uploadId);
    if (!upload) {
      res.status(404).json({ error: `Unknown uploadId "${req.params.uploadId}" (expired?)` });
      return;
    }
    const session = new ProjectSession(upload).open();
    sendJson(req, res, indexBody(sessions.add(session), session));
  });

  // Opening a project builds its index only; statements are analysed when they are asked for.
  app.post('/api/v1/projects', (req, res) => {
    const session = openUpload(req, res);
    if (session) sendJson(req, res, indexBody(sessions.add(session), session));
  });

  // A folder on this machine, read in place (nothing is uploaded or copied). Local requests only:
  // it reads the server's file system.
  app.post('/api/v1/projects/open', (req, res) => {
    if (!isLoopback(req.socket.remoteAddress)) {
      res.status(403).json({ error: 'opening a server-side folder is allowed from this machine only' });
      return;
    }
    const dir = req.body?.path;
    if (typeof dir !== 'string' || !dir.trim() || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      res.status(400).json({ error: 'Expected { path } naming an existing folder' });
      return;
    }
    const session = new ProjectSession(new DirectorySource(dir)).open();
    sendJson(req, res, indexBody(sessions.add(session), session));
  });

  // The UI's version: the newest modification time of its static files. A tab left open across
  // an update keeps running the old script; the page compares this on focus and offers a reload.
  const publicDir = path.join(__dirname, 'public');
  app.get('/api/v1/version', (req, res) => {
    let newest = 0;
    for (const name of fs.readdirSync(publicDir)) {
      if (/\.(js|css|html)$/.test(name)) newest = Math.max(newest, fs.statSync(path.join(publicDir, name)).mtimeMs);
    }
    res.set('cache-control', 'no-store').json({ ui: String(Math.floor(newest)) });
  });

  // The in-app folder browser behind 프로젝트 폴더: folder NAMES under a path on this machine
  // (never file contents), so a project is picked without the browser's own picker — which
  // refuses folders it deems sensitive ("시스템 파일이 포함되어 있으므로 열 수 없습니다") and,
  // as a plain input, offers to upload every file. Local requests only, like /projects/open.
  app.get('/api/v1/fs/dirs', (req, res) => {
    if (!isLoopback(req.socket.remoteAddress)) {
      res.status(403).json({ error: 'browsing server-side folders is allowed from this machine only' });
      return;
    }
    // default: the folder this tool sits in (its sibling projects), i.e. the working directory's parent
    const dir = path.resolve(typeof req.query.path === 'string' && req.query.path.trim() ? req.query.path : path.join(process.cwd(), '..'));
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      res.status(400).json({ error: `cannot read ${dir}: ${err.code ?? err.message}`, path: dir, parent: path.dirname(dir) });
      return;
    }
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIPPED_DIRECTORIES.has(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    const xmlHere = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.xml')).length;
    res.json({ path: dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), dirs, xmlHere, home: os.homedir() });
  });

  app.get('/api/v1/projects/:projectId', (req, res) => {
    const session = sessions.get(req.params.projectId);
    if (!session) {
      res.status(404).json({ error: `Unknown projectId "${req.params.projectId}"` });
      return;
    }
    sendJson(req, res, indexBody(req.params.projectId, session));
  });

  app.get('/api/v1/projects/:projectId/stats', (req, res) => {
    const session = sessions.get(req.params.projectId);
    if (!session) {
      res.status(404).json({ error: `Unknown projectId "${req.params.projectId}"` });
      return;
    }
    res.json(session.stats());
  });

  app.delete('/api/v1/projects/:projectId', (req, res) => {
    if (!sessions.close(req.params.projectId)) {
      res.status(404).json({ error: `Unknown projectId "${req.params.projectId}"` });
      return;
    }
    res.status(204).end();
  });

  // The whole-project analysis in one response (the original API). Computed from a session file
  // by file; the session stays open for the follow-up GETs, the full result is not kept.
  app.post('/api/v1/projects/analyze', (req, res) => {
    const session = openUpload(req, res);
    if (!session) return;
    const projectId = sessions.add(session);
    const report = session.report();
    const summary = session.summary();
    const generatedMapperXml = {};
    for (const f of session.files) if (f.parsed) generatedMapperXml[f.sourceFile] = session.convertFile(f.sourceFile).xml;
    sendJson(req, res, {
      projectId,
      mappers: report.mappers,
      dependencies: session.graph.dependencyGraph.toJSON(),
      circularReferences: summary.circularReferences,
      warnings: summary.warnings,
      errors: summary.errors,
      tables: report.tables,
      tableDependencyGraph: report.tableDependencyGraph,
      generatedMapperXml,
    });
  });

  const knownStatement = (session, id, res) => {
    if (session.hasStatement(id)) return true;
    res.status(404).json({ error: `Unknown statement id "${id}"` });
    return false;
  };

  app.get('/api/v1/statements/:id', (req, res) => {
    const project = resolveProject(req, res);
    if (!project || !knownStatement(project, req.params.id, res)) return;
    sendJson(req, res, project.analyze(req.params.id));
  });

  // search the project: ids, paths, and the mapper text (tables, columns, aliases, refids...)
  app.get('/api/v1/search', (req, res) => {
    const project = resolveProject(req, res);
    if (!project) return;
    sendJson(req, res, project.search(req.query.q));
  });

  // the statement's original XML and the XML of every fragment it includes (sliced from the files)
  app.get('/api/v1/statements/:id/xml', (req, res) => {
    const project = resolveProject(req, res);
    if (!project || !knownStatement(project, req.params.id, res)) return;
    sendJson(req, res, project.statementXml(req.params.id));
  });

  app.get('/api/v1/tables/:tableName', (req, res) => {
    const project = resolveProject(req, res);
    if (!project) return;
    const table = project.report().tables[req.params.tableName];
    if (!table) {
      res.status(404).json({ error: `Unknown table "${req.params.tableName}"` });
      return;
    }
    res.json({ name: req.params.tableName, ...table });
  });

  app.get('/api/v1/statements/:id/dependencies', (req, res) => {
    const project = resolveProject(req, res);
    if (!project || !knownStatement(project, req.params.id, res)) return;
    res.json(new DependencyAnalyzer(project.graph.dependencyGraph).buildStatementDependencyTree(req.params.id));
  });

  app.get('/api/v1/statements/:id/mybatis-preview', (req, res) => {
    const project = resolveProject(req, res);
    if (!project || !knownStatement(project, req.params.id, res)) return;
    const conversion = project.convertStatement(req.params.id);
    res.json({ id: req.params.id, xml: conversion.xml, safetySummary: conversion.safetySummary, events: conversion.events });
  });

  // ---- schema-migration datasets ----------------------------------------
  const datasets = new DatasetStore(datasetDir);
  const datasetSummary = (dataset) => {
    const { summary } = validateMappingDefinition(dataset.mapping);
    return { id: dataset.id, name: dataset.name, description: dataset.description, updatedAt: dataset.updatedAt, ...summary };
  };

  app.get('/api/v1/datasets', (req, res) => {
    res.json(datasets.list().map(datasetSummary));
  });

  app.post('/api/v1/datasets/validate', (req, res) => {
    res.json(validateMappingDefinition(req.body?.mapping));
  });

  app.get('/api/v1/datasets/:id', (req, res) => {
    const dataset = datasets.get(req.params.id);
    if (!dataset) {
      res.status(404).json({ error: `Unknown dataset "${req.params.id}"` });
      return;
    }
    res.json({ ...dataset, validation: validateMappingDefinition(dataset.mapping) });
  });

  app.put('/api/v1/datasets/:id', (req, res) => {
    const { id } = req.params;
    if (!DatasetStore.isValidId(id)) {
      res.status(400).json({ error: 'dataset id: letters, digits, "-" and "_" only (max 64)' });
      return;
    }
    const { name, description = '', mapping } = req.body ?? {};
    const validation = validateMappingDefinition(mapping);
    if (!validation.valid) {
      res.status(400).json({ error: 'mapping is not valid', validation });
      return;
    }
    const saved = datasets.save(id, { name: typeof name === 'string' ? name.trim() : '', description: String(description), mapping });
    res.json({ ...saved, validation });
  });

  app.delete('/api/v1/datasets/:id', (req, res) => {
    if (!datasets.delete(req.params.id)) {
      res.status(404).json({ error: `Unknown dataset "${req.params.id}"` });
      return;
    }
    res.status(204).end();
  });

  // ---- saved lineage-graph layouts (dragged boxes + zoom/pan), per statement ----
  const layouts = new LayoutStore(layoutDir);
  const layoutKey = (req, res) => {
    const { key } = req.params;
    if (!key || key.length > 512) {
      res.status(400).json({ error: 'layout key: the statement id (max 512 chars)' });
      return null;
    }
    return key;
  };

  app.get('/api/v1/layouts/:key', (req, res) => {
    const key = layoutKey(req, res);
    if (!key) return;
    const layout = layouts.get(key);
    if (!layout) {
      res.status(404).json({ error: `No saved layout for "${key}"` });
      return;
    }
    res.json(layout);
  });

  app.put('/api/v1/layouts/:key', (req, res) => {
    const key = layoutKey(req, res);
    if (!key) return;
    const error = layoutError(req.body);
    if (error) {
      res.status(400).json({ error });
      return;
    }
    const { offsets, view = null, sourceFile = null } = req.body;
    // nothing moved and no view: there is nothing to keep
    if (!Object.keys(offsets).length && !view) {
      layouts.delete(key);
      res.status(204).end();
      return;
    }
    res.json(layouts.save(key, { sourceFile, offsets, view }));
  });

  app.delete('/api/v1/layouts/:key', (req, res) => {
    const key = layoutKey(req, res);
    if (!key) return;
    if (!layouts.delete(key)) {
      res.status(404).json({ error: `No saved layout for "${key}"` });
      return;
    }
    res.status(204).end();
  });

  // ---- run a schema migration over an analyzed project ------------------
  /** the mapping of a request: { datasetId } or an inline { mapping }; null after answering an error */
  function requestMapping(req, res) {
    const { datasetId } = req.body ?? {};
    let mapping = req.body?.mapping ?? {};
    if (datasetId !== undefined) {
      const dataset = datasets.get(datasetId);
      if (!dataset) {
        res.status(404).json({ error: `Unknown dataset "${datasetId}"` });
        return null;
      }
      mapping = dataset.mapping;
    }
    const validation = validateMappingDefinition(mapping);
    if (!validation.valid) {
      res.status(400).json({ error: 'mapping is not valid', validation });
      return null;
    }
    return mapping;
  }
  const migrationOptions = (req) => ({ preserveResultColumnNames: Boolean(req.body?.preserveResultColumnNames) });

  // One statement: only its file, its fragments' files and (capped) their includers' are loaded.
  app.post('/api/v1/statements/:id/schema-migration', (req, res) => {
    const project = resolveProject(req, res);
    if (!project || !knownStatement(project, req.params.id, res)) return;
    const mapping = requestMapping(req, res);
    if (mapping) sendJson(req, res, project.schemaMigration(req.params.id, mapping, migrationOptions(req)));
  });

  // Counts per statement (tree badges, totals), computed file by file.
  app.post('/api/v1/schema-summary', (req, res) => {
    const project = resolveProject(req, res);
    if (!project) return;
    const mapping = requestMapping(req, res);
    if (mapping) sendJson(req, res, project.schemaSummary(mapping, migrationOptions(req)));
  });

  // The whole project in one response (export / the original API). Loads every file for the
  // duration of this request only.
  app.post('/api/v1/schema-migration', (req, res) => {
    const project = resolveProject(req, res);
    if (!project) return;
    const mapping = requestMapping(req, res);
    if (!mapping) return;
    // `?file=` scopes it to one file (what the 변환 view asks for): that file's statements and
    // fragments plus the fragments they include; only the files involved are loaded
    const file = req.query.file;
    if (file !== undefined) {
      const scoped = project.migrateForFile(file, mapping, migrationOptions(req));
      if (!scoped) {
        res.status(404).json({ error: `Unknown mapper file "${file}"` });
        return;
      }
      sendJson(req, res, shapeSchemaMigration(scoped.results, { files: new Set([file]), fragments: new Set(scoped.fragmentIds), sampled: scoped.sampled, project }));
      return;
    }
    // no dataset yet is fine: the view still shows the iBATIS -> MyBatis conversion
    sendJson(req, res, shapeSchemaMigration(project.migrateFiles(project.files.filter((f) => f.parsed).map((f) => f.sourceFile), mapping, migrationOptions(req))));
  });

  // The API answers in JSON even when the request never reached a route:
  // Express's default handler would send an HTML page (with a stack trace
  // outside production) for a malformed or oversized JSON body.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      res.status(400).json({ error: `request body is not valid JSON: ${err.message}` });
    } else if (err.type === 'entity.too.large') {
      res.status(413).json({ error: `request body is larger than ${err.limit} bytes` });
    } else {
      // eslint-disable-next-line no-console
      console.error(err);
      res.status(err.status ?? 500).json({ error: err.expose ? err.message : 'internal error' });
    }
  });

  return app;
}

/**
 * Shapes a schema migration (`ProjectSession#migrateFiles`) for the
 * 변환 view. The migration runs twice — over the converted MyBatis ASTs and
 * over the original iBATIS ASTs — so the UI can show the column renames
 * with or without the iBATIS -> MyBatis syntax conversion. Per statement and
 * per `<sql>` fragment it returns four texts, all generated from ASTs in the
 * same layout (so they line up line by line):
 *
 *   ibatisBefore  original iBATIS                ibatisAfter   iBATIS + renames
 *   mybatisBefore iBATIS -> MyBatis              mybatisAfter  MyBatis + renames
 *
 * plus the schema-migration events, and the MyBatis conversion's own graded
 * events. An `…After` equal to its `…Before` is left out (the client treats
 * a missing after as "unchanged"). Per file: its statement / fragment ids and
 * a summary.
 */
function shapeSchemaMigration(results, { files: onlyFiles = null, fragments: onlyFragments = null, sampled = new Map(), project = null } = {}) {
  const mybatisXml = new XmlGenerator();
  const ibatisXml = new IbatisXmlGenerator();
  const qualify = (namespace, id) => (namespace ? `${namespace}.${id}` : id);
  const tally = (events) => {
    const counts = { SAFE: 0, WARNING: 0, MANUAL: 0, ERROR: 0 };
    for (const e of events) counts[e.grade] = (counts[e.grade] ?? 0) + 1;
    return {
      ...counts,
      tables: events.filter((e) => e.code === 'TABLE_RENAMED').length,
      columns: events.filter((e) => e.code === 'COLUMN_RENAMED' || e.code === 'COLUMN_ASSUMED').length,
    };
  };
  const strip = ({ tokenIndex, ...event }) => event;
  // an "after" identical to its "before" is omitted (most nodes of a big project don't change):
  // a 10k-statement project's response shrinks several-fold
  // the left side is the file's own syntax: iBATIS, or MyBatis for a MyBatis input mapper
  const texts = (ibatisNode, ibatisMigrated, mybatisNode, mybatisMigrated, syntax = 'ibatis') => {
    const sourceXml = syntax === 'mybatis' ? mybatisXml : ibatisXml;
    const ibatisBefore = sourceXml.generateNode(ibatisNode);
    const ibatisAfter = sourceXml.generateNode(ibatisMigrated);
    const mybatisBefore = mybatisXml.generateNode(mybatisNode);
    const mybatisAfter = mybatisXml.generateNode(mybatisMigrated);
    return {
      ibatisBefore,
      ...(ibatisAfter === ibatisBefore ? {} : { ibatisAfter }),
      mybatisBefore,
      ...(mybatisAfter === mybatisBefore ? {} : { mybatisAfter }),
    };
  };

  const statements = {};
  const fragments = {};
  const files = {};
  for (const [sourceFile, result] of results) {
    const { mapper: migrated, events, original: converted } = result.mybatis;
    const { mapper: ibatisMigrated, original: sqlMap } = result.ibatis;
    const namespace = converted.namespace;
    const eventsOf = (id) => events.filter((e) => e.statementId === id).map(strip);

    const outputFile = !onlyFiles || onlyFiles.has(sourceFile);
    converted.statements.forEach((statement, i) => {
      if (!outputFile) return; // loaded only for a fragment's context
      const qualifiedId = qualify(namespace, statement.id);
      const own = eventsOf(statement.id);
      const conversion = result.conversion.statements.get(qualifiedId);
      statements[qualifiedId] = {
        sourceFile,
        ...texts(sqlMap.statements[i], ibatisMigrated.statements[i], statement, migrated.statements[i], result.syntax),
        syntax: result.syntax ?? 'ibatis',
        // scoped: every fragment it includes, transitively, as resolved; whole project: as written
        includes: project ? project.includedFragments(qualifiedId) : collectIncludes(statement, namespace),
        ...(project ? { includeTree: project.includeTree(qualifiedId) } : {}),
        events: own,
        summary: tally(own),
        conversion: conversion ? { events: conversion.events, summary: conversion.safetySummary } : null,
      };
    });
    converted.sqlFragments.forEach((fragment, i) => {
      const qualifiedId = qualify(namespace, fragment.id);
      if (onlyFragments && !onlyFragments.has(qualifiedId)) return;
      const own = eventsOf(fragment.id);
      if (sampled.has(qualifiedId)) {
        own.push({ grade: 'WARNING', code: 'FRAGMENT_CONTEXT_SAMPLED', statementId: fragment.id, message: `context inferred from ${project.schemaSiteFiles} of the ${sampled.get(qualifiedId)} files that include this fragment` });
      }
      const conversion = result.conversion.fragments.get(qualifiedId);
      fragments[qualifiedId] = {
        sourceFile,
        id: fragment.id,
        ...(project ? { includeTree: project.includeTree(qualifiedId) } : {}),
        ...texts(sqlMap.sqlFragments[i], ibatisMigrated.sqlFragments[i], fragment, migrated.sqlFragments[i], result.syntax),
        syntax: result.syntax ?? 'ibatis',
        events: own,
        summary: tally(own),
        conversion: conversion ? { events: conversion.events, summary: conversion.safetySummary } : null,
      };
    });
    if (!outputFile) continue;
    files[sourceFile] = {
      statements: converted.statements.map((s) => qualify(namespace, s.id)),
      fragments: converted.sqlFragments.map((f) => qualify(namespace, f.id)),
      summary: tally(events),
    };
  }
  const all = onlyFiles
    ? [...Object.values(statements), ...Object.values(fragments)].flatMap((e) => e.events)
    : [...results.values()].flatMap((r) => r.mybatis.events);
  return { statements, fragments, files, summary: tally(all) };
}

function collectIncludes(node, namespace, into = []) {
  for (const child of node.children ?? []) {
    if (child.type === 'Include') {
      const id = child.refid.includes('.') ? child.refid : (namespace ? `${namespace}.${child.refid}` : child.refid);
      if (!into.includes(id)) into.push(id);
    }
    collectIncludes(child, namespace, into);
  }
  return into;
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  const port = process.env.PORT || 4000;
  createApp().listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`ibatis-migration-analyzer API listening on :${port}`);
  });
}
