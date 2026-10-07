import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { AnalyzerPipeline } from '../../application/AnalyzerPipeline.js';
import { XmlGenerator } from '../../generator/xml/XmlGenerator.js';
import { IbatisXmlGenerator } from '../../generator/xml/IbatisXmlGenerator.js';
import { SqlSchemaMigrationConverter, validateMappingDefinition } from '../../converter/schema/index.js';
import { DatasetStore } from './DatasetStore.js';

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

/**
 * JSON, gzipped when the client accepts it and it's big. The analyze and
 * schema-migration responses of a large project are tens of MB of XML text,
 * which compresses ~10x. Done with node:zlib: no compression dependency.
 */
function sendJson(req, res, body) {
  const json = JSON.stringify(body);
  if (json.length < 64 * 1024 || !/\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
    res.json(body);
    return;
  }
  res.set({ 'content-type': 'application/json; charset=utf-8', 'content-encoding': 'gzip', vary: 'Accept-Encoding' });
  res.send(gzipSync(json));
}

export function createApp({ datasetDir = process.env.DATASET_DIR ?? DEFAULT_DATASET_DIR } = {}) {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  const projects = new Map();
  let lastProjectId = null;

  function resolveProject(req, res) {
    const projectId = req.query.projectId ?? lastProjectId;
    const project = projectId ? projects.get(projectId) : undefined;
    if (!project) {
      res.status(404).json({ error: projectId ? `Unknown projectId "${projectId}"` : 'No project has been analyzed yet — POST /api/v1/projects/analyze first' });
      return null;
    }
    return project;
  }

  app.post('/api/v1/projects/analyze', (req, res) => {
    const files = req.body?.files;
    if (!Array.isArray(files) || files.some((f) => typeof f.sourceFile !== 'string' || typeof f.source !== 'string')) {
      res.status(400).json({ error: 'Expected { files: [{ sourceFile, source }] }' });
      return;
    }

    const pipeline = new AnalyzerPipeline();
    const result = pipeline.run(files);

    const projectId = randomUUID();
    projects.set(projectId, result);
    lastProjectId = projectId;

    sendJson(req, res, {
      projectId,
      mappers: result.mapperReports,
      dependencies: result.dependencyGraph.toJSON(),
      circularReferences: result.circularReferences.map((c) => c.path),
      warnings: result.diagnostics.warnings,
      errors: result.diagnostics.errors,
      tables: result.tableUsageReport,
      tableDependencyGraph: result.tableDependencyGraph,
      generatedMapperXml: Object.fromEntries(result.generatedMapperXml),
    });
  });

  app.get('/api/v1/statements/:id', (req, res) => {
    const project = resolveProject(req, res);
    if (!project) return;
    const analysis = project.statementAnalyses.get(req.params.id);
    if (!analysis) {
      res.status(404).json({ error: `Unknown statement id "${req.params.id}"` });
      return;
    }
    res.json(analysis);
  });

  app.get('/api/v1/tables/:tableName', (req, res) => {
    const project = resolveProject(req, res);
    if (!project) return;
    const table = project.tableUsageReport[req.params.tableName];
    if (!table) {
      res.status(404).json({ error: `Unknown table "${req.params.tableName}"` });
      return;
    }
    res.json({ name: req.params.tableName, ...table });
  });

  app.get('/api/v1/statements/:id/dependencies', (req, res) => {
    const project = resolveProject(req, res);
    if (!project) return;
    if (!project.statementAnalyses.has(req.params.id)) {
      res.status(404).json({ error: `Unknown statement id "${req.params.id}"` });
      return;
    }
    res.json(project.dependencyAnalyzer.buildStatementDependencyTree(req.params.id));
  });

  app.get('/api/v1/statements/:id/mybatis-preview', (req, res) => {
    const project = resolveProject(req, res);
    if (!project) return;
    const conversion = project.mybatisConversions.get(req.params.id);
    if (!conversion) {
      res.status(404).json({ error: `Unknown statement id "${req.params.id}"` });
      return;
    }
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

  // ---- run a schema migration over an analyzed project ------------------
  app.post('/api/v1/schema-migration', (req, res) => {
    const project = resolveProject(req, res);
    if (!project) return;
    const { datasetId, preserveResultColumnNames = false } = req.body ?? {};
    let mapping = req.body?.mapping ?? {};
    if (datasetId !== undefined) {
      const dataset = datasets.get(datasetId);
      if (!dataset) {
        res.status(404).json({ error: `Unknown dataset "${datasetId}"` });
        return;
      }
      mapping = dataset.mapping;
    }
    const validation = validateMappingDefinition(mapping);
    if (!validation.valid) {
      res.status(400).json({ error: 'mapping is not valid', validation });
      return;
    }
    // no dataset yet is fine: the view still shows the iBATIS -> MyBatis conversion
    sendJson(req, res, runSchemaMigration(project, mapping, { preserveResultColumnNames: Boolean(preserveResultColumnNames) }));
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
 * Re-runs `converter/schema` over a project and shapes the result for the
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
function runSchemaMigration(project, mapping, options) {
  const mybatisXml = new XmlGenerator();
  const ibatisXml = new IbatisXmlGenerator();
  const converter = new SqlSchemaMigrationConverter(mapping, options);
  const mybatisMappers = project.mybatisMappers;
  const ibatisMappers = project.parsedMappers.filter((p) => p.sqlMap);
  const mybatisResults = converter.convertMappers(mybatisMappers.map((m) => m.mapperNode));
  const ibatisResults = converter.convertMappers(ibatisMappers.map((p) => p.sqlMap));
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
  const texts = (ibatisNode, ibatisMigrated, mybatisNode, mybatisMigrated) => {
    const ibatisBefore = ibatisXml.generateNode(ibatisNode);
    const ibatisAfter = ibatisXml.generateNode(ibatisMigrated);
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
  mybatisResults.forEach(({ mapper: migrated, events }, m) => {
    const { sourceFile, mapperNode: converted } = mybatisMappers[m];
    const ibatisIndex = ibatisMappers.findIndex((p) => p.sourceFile === sourceFile);
    const sqlMap = ibatisMappers[ibatisIndex].sqlMap;
    const ibatisMigrated = ibatisResults[ibatisIndex].mapper;
    const namespace = converted.namespace;
    const eventsOf = (id) => events.filter((e) => e.statementId === id).map(strip);

    converted.statements.forEach((statement, i) => {
      const qualifiedId = qualify(namespace, statement.id);
      const own = eventsOf(statement.id);
      const conversion = project.mybatisConversions.get(qualifiedId);
      statements[qualifiedId] = {
        sourceFile,
        ...texts(sqlMap.statements[i], ibatisMigrated.statements[i], statement, migrated.statements[i]),
        includes: collectIncludes(statement, namespace),
        events: own,
        summary: tally(own),
        conversion: conversion ? { events: conversion.events, summary: conversion.safetySummary } : null,
      };
    });
    converted.sqlFragments.forEach((fragment, i) => {
      const qualifiedId = qualify(namespace, fragment.id);
      const own = eventsOf(fragment.id);
      const conversion = project.fragmentConversions.get(qualifiedId);
      fragments[qualifiedId] = {
        sourceFile,
        id: fragment.id,
        ...texts(sqlMap.sqlFragments[i], ibatisMigrated.sqlFragments[i], fragment, migrated.sqlFragments[i]),
        events: own,
        summary: tally(own),
        conversion: conversion ? { events: conversion.events, summary: conversion.safetySummary } : null,
      };
    });
    files[sourceFile] = {
      statements: converted.statements.map((s) => qualify(namespace, s.id)),
      fragments: converted.sqlFragments.map((f) => qualify(namespace, f.id)),
      summary: tally(events),
    };
  });
  const all = mybatisResults.flatMap((r) => r.events);
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
  const port = process.env.PORT || 3000;
  createApp().listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`ibatis-migration-analyzer API listening on :${port}`);
  });
}
