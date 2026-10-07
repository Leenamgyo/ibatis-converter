import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalyzerPipeline } from '../../src/application/AnalyzerPipeline.js';
import { parseXml } from '../../src/parser/xml/XmlParser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const complexDir = path.join(__dirname, '..', 'fixtures', 'complex');

function loadComplexFixtures() {
  return fs
    .readdirSync(complexDir)
    .filter((f) => f.endsWith('.xml'))
    .sort()
    .map((f) => {
      const sourceFile = path.join(complexDir, f);
      return { sourceFile, source: fs.readFileSync(sourceFile, 'utf8') };
    });
}

/**
 * A 25-file, 2000+ line "small realistic project" (an e-commerce domain:
 * users/roles/permissions, catalog, inventory, orders/payments/shipping,
 * coupons/cart/wishlist, notifications/audit logs, plus cross-domain
 * reporting) run through every pipeline stage at once. Unlike the other
 * fixtures in test/fixtures/, which each isolate one narrow behavior, this
 * proves the pipeline holds up at realistic scale: many files, many
 * namespaces, many cross-mapper <include refid> edges, every statement
 * type, and every dynamic SQL / iterate / resultMap-extends / selectKey /
 * parameterMap shape combined in the same run.
 */
test('runs the full pipeline (parse -> resolve -> analyze -> convert -> generate) over the 25-file complex fixture project with zero parser/resolver diagnostics', () => {
  const files = loadComplexFixtures();
  assert.ok(files.length >= 20, `expected at least 20 complex fixture files, found ${files.length}`);

  const pipeline = new AnalyzerPipeline();
  const result = pipeline.run(files);

  assert.equal(result.parsedMappers.length, files.length);
  assert.ok(
    result.parsedMappers.every((m) => m.sqlMap !== null),
    'every complex fixture must parse to a non-null sqlMap',
  );

  // No missing/circular refid, no duplicate symbols, no unsupported tags -
  // this project is meant to be entirely well-formed, unlike
  // missing-refid.xml / circular-refid.xml which test the opposite.
  assert.deepEqual(result.diagnostics.errors, []);
  assert.deepEqual(result.diagnostics.warnings, []);

  const expectedStatementCount = result.parsedMappers.reduce(
    (sum, { sqlMap }) => sum + sqlMap.statements.length,
    0,
  );
  assert.equal(result.resolvedStatements.size, expectedStatementCount);
  assert.equal(result.statementAnalyses.size, expectedStatementCount);
  assert.equal(result.mybatisConversions.size, expectedStatementCount);
  assert.equal(result.generatedMapperXml.size, files.length);
});

test('cross-mapper <include refid="common.xxx"> resolves across every domain mapper in the complex fixture project', () => {
  const files = loadComplexFixtures();
  const pipeline = new AnalyzerPipeline();
  const result = pipeline.run(files);

  const paginationDependents = [
    'user.searchUsers',
    'userProfile.searchProfiles',
    'supplier.searchSuppliers',
    'product.searchProducts',
    'product.getTopRatedProducts',
    'review.getReviewsForProduct',
    'coupon.searchCoupons',
    'auth.getLoginHistoryForUser',
    'auditLog.searchLogs',
    'auditLog.getRecentLogsByUser',
    'notification.getNotificationsForUser',
    'report.getUserOrderSummary',
    'report.getProductSalesReport',
    'orderItem.getBestSellingProducts',
    'dashboard.getLowStockAlerts',
    'advancedSearch.advancedProductSearch',
    'report.getCategoryProductCoverage',
  ];
  for (const qualifiedId of paginationDependents) {
    const deps = result.dependencyGraph.getDependencies(qualifiedId);
    assert.ok(
      deps.some((d) => d.to === 'common.pagination' && d.kind === 'INCLUDE'),
      `expected ${qualifiedId} to depend on common.pagination`,
    );
  }

  assert.ok(result.dependencyGraph.getDependencies('user.getActiveUserCount').some((d) => d.to === 'common.activeStatusCondition'));
  assert.ok(result.dependencyGraph.getDependencies('supplier.getActiveSuppliers').some((d) => d.to === 'common.activeStatusCondition'));
  assert.ok(result.dependencyGraph.getDependencies('coupon.getActiveCoupons').some((d) => d.to === 'common.activeStatusCondition'));
  assert.ok(result.dependencyGraph.getDependencies('user.searchUsers').some((d) => d.to === 'common.auditColumns'));

  // A same-file (unqualified) refid, distinct from every cross-mapper
  // "common.xxx" refid above.
  assert.ok(
    result.dependencyGraph.getDependencies('report.getCategoryProductCoverage').some((d) => d.to === 'report.productCoreColumns'),
  );

  assert.equal(result.circularReferences.length, 0);
});

test('report.getCategoryProductCoverage exercises a RIGHT JOIN, a correlated subquery, and a same-file <include refid> together', () => {
  const files = loadComplexFixtures();
  const pipeline = new AnalyzerPipeline();
  const result = pipeline.run(files);

  const analysis = result.statementAnalyses.get('report.getCategoryProductCoverage');
  assert.ok(analysis, 'expected report.getCategoryProductCoverage to be analyzed');

  assert.ok(
    analysis.joins.some((j) => (j.joinType ?? j.type) === 'RIGHT_JOIN'),
    'every other join fixture in this project is LEFT/INNER - this one must be RIGHT_JOIN',
  );

  const tableNames = analysis.tables.map((t) => t.name).sort();
  assert.deepEqual(tableNames, ['CATEGORIES', 'PRODUCTS', 'PRODUCT_REVIEWS']);
});

test('every generated MyBatis mapper XML for the complex fixture project round-trips through this project\'s own well-formedness parser', () => {
  const files = loadComplexFixtures();
  const pipeline = new AnalyzerPipeline();
  const result = pipeline.run(files);

  for (const [sourceFile, xml] of result.generatedMapperXml) {
    assert.doesNotThrow(() => parseXml(xml, sourceFile), `generated XML for ${sourceFile} must be well-formed`);
  }
});

test('the deliberately unusual statements in the complex fixture project degrade to diagnostics instead of crashing the pipeline', () => {
  const files = loadComplexFixtures();
  const pipeline = new AnalyzerPipeline();
  const result = pipeline.run(files);

  // advancedSearch.fullConditionMatrix reuses conditions.xml's placeholder
  // (non-real) column names, which node-sql-parser can't parse, so
  // table/column analysis must degrade to a SQL_PARSE_FAILED warning
  // rather than throwing.
  const parseFailed = [...result.statementAnalyses.entries()].filter(([, analysis]) =>
    (analysis.warnings ?? []).some((w) => w.code === 'SQL_PARSE_FAILED'),
  );
  const parseFailedIds = parseFailed.map(([id]) => id).sort();
  assert.deepEqual(parseFailedIds, ['advancedSearch.fullConditionMatrix']);

  // Every $orderBy$ / $...$ raw substitution site must be flagged, never
  // silently converted.
  const rawSubstitutionIds = [...result.statementAnalyses.entries()]
    .filter(([, analysis]) => (analysis.warnings ?? []).some((w) => w.code === 'RAW_SQL_SUBSTITUTION'))
    .map(([id]) => id)
    .sort();
  assert.deepEqual(rawSubstitutionIds, [
    'advancedSearch.advancedProductSearch',
    'auditLog.searchLogs',
    'product.searchProducts',
    'user.searchUsers',
  ]);

  // This project is SELECT-only, so nothing here should be graded MANUAL
  // any more - the parameterMap statement that used to be moved out with
  // the writes (see test/integration/writeStatements.test.js).
  const manualIds = [...result.mybatisConversions.entries()]
    .filter(([, conversion]) => conversion.events.some((e) => e.grade === 'MANUAL'))
    .map(([id]) => id);
  assert.deepEqual(manualIds, []);
});

test('the table usage report and table dependency graph cover the complex fixture project\'s full schema', () => {
  const files = loadComplexFixtures();
  const pipeline = new AnalyzerPipeline();
  const result = pipeline.run(files);

  const tableNames = Object.keys(result.tableUsageReport);
  for (const expected of ['USERS', 'ORDERS', 'PRODUCTS', 'ORDER_ITEMS', 'INVENTORY', 'PAYMENTS']) {
    assert.ok(tableNames.includes(expected), `expected table usage report to include ${expected}`);
  }

  assert.ok(Object.keys(result.tableDependencyGraph).length > 0);
});
