import { parseIbatisMapperSource } from '../parser/ibatis/IbatisMapperParser.js';
import { buildSymbolTable } from '../resolver/symbol/ProjectScanner.js';
import { ReferenceResolver } from '../resolver/reference/ReferenceResolver.js';
import { DiagnosticBag } from '../parser/xml/ParserDiagnostics.js';
import { StatementAnalyzer } from '../analyzer/statement/StatementAnalyzer.js';
import { MapperReport } from '../report/migration/MapperReport.js';
import { ProjectReport } from '../report/migration/ProjectReport.js';
import { MigrationSafetyAnalyzer } from '../report/migration/MigrationSafetyAnalyzer.js';
import { MyBatisAstConverter } from '../converter/mybatis/MyBatisAstConverter.js';
import { XmlGenerator } from '../generator/xml/XmlGenerator.js';
import { MapperNode } from '../ast/mybatis/nodes.js';
import { DependencyAnalyzer } from '../analyzer/dependency/DependencyAnalyzer.js';

/**
 * Composition root wiring every pipeline stage implemented so far:
 *
 *   XML Parsing -> iBATIS AST -> Symbol Table -> Reference Resolver
 *     -> Dynamic SQL / Parameter / SQL / Table Analyzer -> StatementAnalysis
 *     -> Mapper Report -> Project (table usage) Report
 *     -> MyBatis AST Converter -> XML Generator -> Migration Safety Analyzer
 *     -> [optional] SQL Schema Migration (old -> new table/column names) -> XML Generator
 *     -> Table / Statement Dependency Analyzer
 *
 * This class is the single place that owns pipeline ordering — new stages
 * should be added here rather than re-wired ad hoc elsewhere.
 */
export class AnalyzerPipeline {
  constructor({
    statementAnalyzer = new StatementAnalyzer(),
    mapperReport = new MapperReport(),
    projectReport = new ProjectReport(),
    mybatisAstConverter = new MyBatisAstConverter(),
    xmlGenerator = new XmlGenerator(),
    migrationSafetyAnalyzer = new MigrationSafetyAnalyzer(),
    schemaMigrationConverter = null,
    dialect = 'mysql',
  } = {}) {
    this.statementAnalyzer = statementAnalyzer;
    this.mapperReport = mapperReport;
    this.projectReport = projectReport;
    this.mybatisAstConverter = mybatisAstConverter;
    this.xmlGenerator = xmlGenerator;
    this.migrationSafetyAnalyzer = migrationSafetyAnalyzer;
    /**
     * Optional `converter/schema` SqlSchemaMigrationConverter. When set, the
     * converted MyBatis mappers are additionally migrated to the new schema
     * and returned as `schemaMigration` — a separate output, so
     * `generatedMapperXml` stays the pure iBATIS -> MyBatis syntax result.
     */
    this.schemaMigrationConverter = schemaMigrationConverter;
    this.dialect = dialect;
  }

  /**
   * @param {{ sourceFile: string, source: string }[]} files raw mapper XML sources
   */
  run(files) {
    const diagnostics = new DiagnosticBag();

    const parsedMappers = files.map(({ sourceFile, source }) => {
      const { sqlMap, diagnostics: fileDiagnostics } = parseIbatisMapperSource(source, sourceFile);
      diagnostics.merge(fileDiagnostics);
      return { sourceFile, sqlMap };
    });

    const { symbolTable } = buildSymbolTable(parsedMappers, diagnostics);
    const resolver = new ReferenceResolver(symbolTable, diagnostics);

    const resolvedStatements = new Map();
    const statementAnalyses = new Map();
    const mybatisConversions = new Map();
    const generatedMapperXml = new Map();
    const mybatisMappers = [];
    const fragmentConversions = new Map();

    // Pass A: resolve every statement and resultMap first. Converting a <sql> fragment
    // needs to know which mappers include it, which is only known once all are resolved.
    for (const { sqlMap } of parsedMappers) {
      if (!sqlMap) continue;
      const namespace = sqlMap.namespace;
      for (const stmt of sqlMap.statements) {
        const qualifiedId = namespace ? `${namespace}.${stmt.id}` : stmt.id;
        const resolved = resolver.resolve(stmt, namespace, qualifiedId);
        resolver.linkStatementDependencies(stmt, namespace, qualifiedId);
        resolvedStatements.set(qualifiedId, resolved);
        statementAnalyses.set(
          qualifiedId,
          this.statementAnalyzer.analyze(resolved.originalTree, resolved.resolvedTree, qualifiedId, this.dialect),
        );
      }
      for (const resultMap of sqlMap.resultMaps) resolver.resolveResultMapExtends(resultMap, namespace);
    }

    // Pass B: convert
    for (const { sourceFile, sqlMap } of parsedMappers) {
      if (!sqlMap) continue;
      const namespace = sqlMap.namespace;
      const mapperNode = new MapperNode({ namespace });
      // references MyBatis couldn't resolve as written get qualified (see qualifyReference)
      const resolveReference = (ref, ns, type, options) => resolver.qualifiedIdOf(ref, ns, type, options);
      const context = { namespace, resolveReference };

      for (const stmt of sqlMap.statements) {
        const qualifiedId = namespace ? `${namespace}.${stmt.id}` : stmt.id;
        const resolved = resolvedStatements.get(qualifiedId);
        const { node: mybatisNode, events } = this.mybatisAstConverter.convertStatement(resolved.originalTree, context);
        mapperNode.statements.push(mybatisNode);

        const previewMapper = new MapperNode({ namespace });
        previewMapper.statements = [mybatisNode];
        mybatisConversions.set(qualifiedId, {
          node: mybatisNode,
          events,
          safetySummary: this.migrationSafetyAnalyzer.summarize(events),
          xml: this.xmlGenerator.generate(previewMapper),
        });
      }
      for (const fragment of sqlMap.sqlFragments) {
        const fragmentQualifiedId = namespace ? `${namespace}.${fragment.id}` : fragment.id;
        const { node, events } = this.mybatisAstConverter.convertSqlFragment(fragment, { ...context, fragmentQualifiedId });
        mapperNode.sqlFragments.push(node);
        fragmentConversions.set(fragmentQualifiedId, {
          events,
          safetySummary: this.migrationSafetyAnalyzer.summarize(events),
        });
      }
      for (const resultMap of sqlMap.resultMaps) {
        mapperNode.resultMaps.push(this.mybatisAstConverter.convertResultMap(resultMap, context).node);
      }

      generatedMapperXml.set(sourceFile, this.xmlGenerator.generate(mapperNode));
      mybatisMappers.push({ sourceFile, mapperNode });
    }

    let schemaMigration = null;
    if (this.schemaMigrationConverter) {
      // all mappers at once, so a cross-mapper <include> still finds its fragment
      const results = this.schemaMigrationConverter.convertMappers(mybatisMappers.map((m) => m.mapperNode));
      schemaMigration = { mapperXml: new Map(), events: new Map() };
      results.forEach(({ mapper, events }, i) => {
        schemaMigration.mapperXml.set(mybatisMappers[i].sourceFile, this.xmlGenerator.generate(mapper));
        schemaMigration.events.set(mybatisMappers[i].sourceFile, events);
      });
    }

    const mapperReports = parsedMappers.map(({ sourceFile, sqlMap }) => {
      const namespace = sqlMap?.namespace;
      const ownStatements = (sqlMap?.statements ?? []).map((stmt) => {
        const qualifiedId = namespace ? `${namespace}.${stmt.id}` : stmt.id;
        return statementAnalyses.get(qualifiedId);
      });
      const fileDiagnostics = {
        warnings: diagnostics.warnings.filter((w) => w.sourceFile === sourceFile),
        errors: diagnostics.errors.filter((e) => e.sourceFile === sourceFile),
      };
      return this.mapperReport.build(sqlMap, ownStatements, fileDiagnostics);
    });

    const tableUsageReport = this.projectReport.build(mapperReports);
    const dependencyAnalyzer = new DependencyAnalyzer(resolver.dependencyGraph);
    const tableDependencyGraph = dependencyAnalyzer.buildTableDependencyGraph([...statementAnalyses.values()]);

    return {
      parsedMappers,
      symbolTable,
      resolver,
      resolvedStatements,
      statementAnalyses,
      mybatisConversions,
      fragmentConversions,
      generatedMapperXml,
      /** [{ sourceFile, mapperNode }] — the converted MyBatis ASTs, for re-running the schema migration later */
      mybatisMappers,
      schemaMigration,
      mapperReports,
      tableUsageReport,
      dependencyAnalyzer,
      tableDependencyGraph,
      dependencyGraph: resolver.dependencyGraph,
      circularReferences: resolver.circularReferences,
      diagnostics,
    };
  }
}
