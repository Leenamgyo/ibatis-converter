import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalyzerPipeline } from '../../src/application/AnalyzerPipeline.js';
import { parseXml } from '../../src/parser/xml/XmlParser.js';
import { DiagnosticBag } from '../../src/parser/xml/ParserDiagnostics.js';

/**
 * The sample project the UI's "Load sample" button loads is not demo
 * filler: it is the scenario matrix for the whole tool (basic CRUD,
 * dynamic SQL, joins, subqueries, UNION/CTE, refid, resultMap, a legacy
 * report query, and the cases that must degrade loudly). This test
 * analyzes those exact files, so a scenario can never drift between what
 * the dashboard demos and what CI actually checks.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const samplesDir = path.join(__dirname, '..', '..', 'src', 'interfaces', 'api', 'public', 'samples');

const manifest = JSON.parse(fs.readFileSync(path.join(samplesDir, 'manifest.json'), 'utf8'));
const files = manifest.files.map((name) => ({
  sourceFile: name,
  source: fs.readFileSync(path.join(samplesDir, name), 'utf8'),
}));
const result = new AnalyzerPipeline().run(files);

const analysis = (id) => {
  const found = result.statementAnalyses.get(id);
  assert.ok(found, `no analysis for ${id}`);
  return found;
};
const lineageOf = (id) => analysis(id).lineage;
const selectById = (id, selectId) => lineageOf(id).selects.find((s) => s.id === selectId);
const warningCodes = (id) => analysis(id).warnings.map((w) => w.code);

/**
 * The statements that are *supposed* to fail SQL analysis, and why. Every
 * one of them still parses, resolves, converts and reports — only
 * table/column/join/lineage analysis is unavailable, which is the whole
 * point of the degrade-not-throw contract.
 */
const EXPECTED_SQL_PARSE_FAILURES = new Set([
  'edge.rawSubstitutionOrderBy',        // ORDER BY $a$ $b$ -> "ORDER BY ? ?"
  'edge.dynamicTableName',              // FROM $tableName$ -> "FROM ?" is not a table
  'edge.mutuallyExclusiveFromBranches', // both branches kept -> two FROM tables
  'edge.oracleOuterJoinOperator',       // Oracle (+) - no supported dialect parses it
  'frag.missingRefid',                  // the fragment never resolved, so nothing to parse
  'frag.circularRefid',                 // ditto, chain broken at the cycle
]);

/* ------------------------------------------------------------------ *
 * Project-wide                                                         *
 * ------------------------------------------------------------------ */

test('the whole sample project analyzes, and the only errors are the two deliberate ones', () => {
  assert.deepEqual(
    result.diagnostics.errors.map((e) => e.code).sort(),
    ['CIRCULAR_REFERENCE', 'MISSING_REFERENCE'],
  );
  assert.equal(result.mapperReports.length, manifest.files.length);
  assert.ok(result.statementAnalyses.size >= 45, `only ${result.statementAnalyses.size} statements analyzed`);
});

test('only the deliberately-broken statements fail SQL analysis', () => {
  const failed = [...result.statementAnalyses.values()]
    .filter((a) => a.warnings.some((w) => w.code === 'SQL_PARSE_FAILED'))
    .map((a) => a.id)
    .sort();
  assert.deepEqual(failed, [...EXPECTED_SQL_PARSE_FAILURES].sort());
});

test('every statement converts to MyBatis XML that this project can parse back', () => {
  for (const [id, conversion] of result.mybatisConversions) {
    const diagnostics = new DiagnosticBag();
    parseXml(conversion.xml, `${id}.xml`, diagnostics);
    assert.deepEqual(diagnostics.errors, [], `generated XML for ${id} is not well-formed`);
    assert.ok(conversion.xml.trim().length > 0, `${id} generated no XML`);
    // A statement with a binding or a dynamic tag always records at least
    // one graded decision; a plain `SELECT COUNT(*) FROM CUSTOMER` has no
    // decision to record, and an empty event list there is correct.
    const a = analysis(id);
    if (a.parameters.length || a.dynamicConditions.length || a.includes.length) {
      assert.ok(conversion.events.length > 0, `${id} produced no conversion events`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * 1 - basic reads                                                      *
 * ------------------------------------------------------------------ */

test('scenario 1: the baseline read statements analyze as SELECTs', () => {
  // INSERT/UPDATE/DELETE/PROCEDURE moved to
  // test/integration/writeStatements.test.js when this project became
  // SELECT-only; scenario 1 is now the plain-read baseline.
  for (const id of ['basic.getCustomerById', 'basic.getCustomerByTypedId', 'basic.countCustomers', 'basic.getCustomerPage']) {
    assert.equal(analysis(id).type, 'SELECT');
  }
});

test('scenario 1: inline #prop:jdbcType[:nullValue]# is one parameter, and converts to MyBatis attribute syntax', () => {
  const typed = analysis('basic.getCustomerByTypedId');
  assert.deepEqual(typed.parameters.map((p) => p.name), ['customerId', 'regionCode']);
  assert.deepEqual(typed.parameters.map((p) => p.jdbcType), ['NUMERIC', 'VARCHAR']);
  assert.deepEqual(typed.parameters.map((p) => p.nullValue), [null, 'NONE']);

  const conversion = result.mybatisConversions.get('basic.getCustomerByTypedId');
  assert.ok(conversion.xml.includes('#{customerId,jdbcType=NUMERIC}'));
  assert.ok(conversion.xml.includes('#{regionCode,jdbcType=VARCHAR}'));
  assert.ok(!conversion.xml.includes(':NUMERIC'), 'the colon form must not reach MyBatis');
  // The dropped nullValue is surfaced, not silently lost.
  assert.equal(conversion.safetySummary.MANUAL, 1);
  assert.ok(conversion.events.some((e) => e.code === 'UNSUPPORTED_NULL_VALUE'));
});

/* ------------------------------------------------------------------ *
 * 2 - dynamic SQL                                                      *
 * ------------------------------------------------------------------ */

test('scenario 2: all 12 conditional tags are analyzed as conditions', () => {
  const conditions = analysis('dyn.searchCustomersAllConditions').dynamicConditions;
  assert.equal(conditions.length, 12);
  // 11 distinct properties: `grade` carries both isEqual and isNotEqual.
  assert.equal(new Set(conditions.map((c) => c.property)).size, 11);
  assert.deepEqual(
    conditions.map((c) => c.operator).sort(),
    ['EQUAL', 'GREATER_EQUAL', 'GREATER_THAN', 'IS_EMPTY', 'IS_NOT_EMPTY', 'IS_NOT_NULL', 'IS_NULL',
      'LESS_EQUAL', 'LESS_THAN', 'NOT_EQUAL', 'NOT_PROPERTY_AVAILABLE', 'PROPERTY_AVAILABLE'],
  );
});

test('scenario 2: nested <dynamic> conditions are flattened, not lost', () => {
  const conditions = analysis('dyn.searchOrdersNestedDynamic').dynamicConditions;
  assert.deepEqual(conditions.map((c) => c.property).sort(), ['customerId', 'minAmount', 'status']);
});

test('scenario 2: <iterate> (flat and nested) becomes <foreach>, and a dynamic JOIN/UNION still analyzes', () => {
  const flat = result.mybatisConversions.get('dyn.getOrdersByIdList');
  assert.ok(flat.xml.includes('<foreach'));
  const nested = result.mybatisConversions.get('dyn.getOrdersByNestedIterate');
  assert.equal((nested.xml.match(/<foreach/g) ?? []).length, 2);

  // A JOIN added by <isNotNull> is still seen as a join.
  const dynamicJoin = analysis('dyn.dynamicJoinShape');
  assert.equal(dynamicJoin.joins.length, 1);
  assert.equal(dynamicJoin.joins[0].type, 'INNER_JOIN');

  // A UNION branch added by a conditional is still a UNION branch.
  assert.equal(lineageOf('dyn.dynamicUnionBranch').counts.unions, 1);
});

test('scenario 2: converted conditions keep the connector iBATIS used to add at runtime', () => {
  // Regression: <if> bodies used to be emitted without their prepend, so
  // two matching conditions rendered as `WHERE A = ? B = ?`.
  const where = result.mybatisConversions.get('dyn.searchCustomersAllConditions').xml;
  assert.match(where, /AND C\.STATUS = #\{status\}/);
  assert.match(where, /AND C\.CUSTOMER_NAME LIKE #\{customerName\}/);
  assert.equal((where.match(/AND /g) ?? []).length, 12);

  // An <iterate prepend="..."> puts its connector in `open`, which only
  // renders when the collection is non-empty.
  const iterate = result.mybatisConversions.get('dyn.getOrdersByNestedIterate').xml;
  assert.ok(!/>\s*(AND|OR)\s*</.test(iterate), 'a dangling connector must not sit outside the foreach');
});

/* ------------------------------------------------------------------ *
 * 3 - joins                                                            *
 * ------------------------------------------------------------------ */

test('scenario 3: every join type keeps its own kind', () => {
  const typeOf = (id) => analysis(id).joins.map((j) => j.type);
  assert.deepEqual(typeOf('join.innerJoin'), ['INNER_JOIN']);
  assert.deepEqual(typeOf('join.leftJoin'), ['LEFT_JOIN']);
  assert.deepEqual(typeOf('join.rightJoin'), ['RIGHT_JOIN']);
  assert.deepEqual(typeOf('join.fullOuterJoin'), ['FULL_JOIN']);
  assert.deepEqual(typeOf('join.crossJoin'), ['CROSS_JOIN']);
});

test('scenario 3: a comma join is recovered from the WHERE clause, not reported as no join at all', () => {
  const implicit = analysis('join.implicitCommaJoin');
  assert.equal(implicit.joins.length, 1);
  assert.equal(implicit.joins[0].type, 'IMPLICIT_JOIN');
  assert.deepEqual(
    [implicit.joins[0].leftTable, implicit.joins[0].rightTable].sort(),
    ['CUSTOMER', 'ORDERS'],
  );
  // The lineage sees the same join, so the dashboard draws it too.
  const main = lineageOf('join.implicitCommaJoin').selects.find((s) => s.role === 'MAIN');
  assert.equal(main.joins[0].type, 'IMPLICIT_JOIN');

  // ... and the project dependency graph gains the edge it used to miss.
  assert.ok((result.tableDependencyGraph.ORDERS ?? []).some((r) => r.table === 'CUSTOMER'));
});

test('scenario 3: a 5-table chain keeps all five tables and four joins, a self join keeps both aliases', () => {
  const chain = analysis('join.fiveTableChain');
  assert.deepEqual(
    chain.tables.map((t) => t.name).sort(),
    ['CATEGORY', 'CUSTOMER', 'ORDERS', 'ORDER_DETAIL', 'PRODUCT', 'SUPPLIER'],
  );
  assert.equal(chain.joins.length, 5);

  const self = analysis('join.selfJoin');
  assert.deepEqual(self.tables.map((t) => t.alias).sort(), ['CH', 'PAR']);
  assert.equal(self.joins[0].leftTable, self.joins[0].rightTable);
});

/* ------------------------------------------------------------------ *
 * 4 - subqueries (the lineage dashboard's core case)                   *
 * ------------------------------------------------------------------ */

test('scenario 4: a scalar subquery per SELECT-list column, each with its own source table', () => {
  const lineage = lineageOf('sub.scalarSubqueryInSelectList');
  assert.equal(lineage.counts.subqueries, 2);
  for (const select of lineage.selects.filter((s) => s.role === 'SUBQUERY')) {
    assert.equal(select.origin, 'SELECT_LIST');
    assert.equal(select.parentId, 'MAIN');
    assert.deepEqual(select.tables.map((t) => t.name), ['ORDERS']);
  }
  const byAlias = new Map(lineage.columnLineage.map((c) => [c.alias, c]));
  assert.equal(byAlias.get('lastOrderDate').sourceTable, 'ORDERS');
  assert.equal(byAlias.get('lastOrderDate').sourceColumn, 'ORDER_DATE');
  assert.equal(byAlias.get('orderCount').sourceTable, 'ORDERS');
});

test('scenario 4: a derived table is a child SELECT, and the parent reads its output columns', () => {
  const lineage = lineageOf('sub.derivedTableInFrom');
  const derived = lineage.selects.find((s) => s.origin === 'FROM');
  assert.equal(derived.alias, 'T');
  assert.deepEqual(derived.tables.map((t) => t.name), ['PAYMENT']);
  assert.deepEqual(derived.groupBy, ['PM.CUSTOMER_ID']);

  const main = lineage.selects.find((s) => s.role === 'MAIN');
  assert.equal(main.tables[0].derived, true);
  assert.equal(main.tables[0].selectId, derived.id);

  const total = lineage.columnLineage.find((c) => c.alias === 'TOTAL_PAYMENT');
  assert.equal(total.sourceTable, 'PAYMENT');
  assert.equal(total.sourceColumn, 'PAYMENT_AMOUNT');
});

test('scenario 4: WHERE IN / EXISTS subqueries are children of the SELECT that filters on them', () => {
  const inSub = lineageOf('sub.whereInSubquery').selects.find((s) => s.role === 'SUBQUERY');
  assert.equal(inSub.origin, 'WHERE');
  assert.deepEqual(inSub.tables.map((t) => t.name), ['ORDERS']);

  const existsSub = lineageOf('sub.whereExistsCorrelated').selects.find((s) => s.role === 'SUBQUERY');
  assert.equal(existsSub.origin, 'WHERE');
  assert.deepEqual(existsSub.tables.map((t) => t.name), ['PRODUCT_REVIEW']);
});

test('scenario 4: three levels of nesting keep their depth and their parent chain', () => {
  const lineage = lineageOf('sub.threeLevelNesting');
  const inlineView = lineage.selects.find((s) => s.origin === 'JOIN');
  const nested = lineage.selects.find((s) => s.parentId === inlineView.id);

  assert.equal(inlineView.depth, 1);
  assert.equal(inlineView.parentId, 'MAIN');
  assert.equal(nested.depth, 2);
  assert.equal(nested.origin, 'WHERE');
  assert.deepEqual(nested.tables.map((t) => t.name), ['ORDER_DETAIL']);

  const total = lineage.columnLineage.find((c) => c.alias === 'totalPayment');
  assert.equal(total.sourceTable, 'PAYMENT');
  assert.equal(total.sourceColumn, 'PAYMENT_AMOUNT');
  assert.deepEqual(total.path.map((h) => h.selectId), [inlineView.id]);
});

test('scenario 4: a derived table inside a derived table nests, it does not flatten', () => {
  const lineage = lineageOf('sub.derivedTableOfDerivedTable');
  const outer = lineage.selects.find((s) => s.alias === 'OUTER_T');
  const inner = lineage.selects.find((s) => s.alias === 'INNER_T');
  assert.equal(outer.parentId, 'MAIN');
  assert.equal(inner.parentId, outer.id);
  assert.equal(inner.depth, 2);
  assert.deepEqual(inner.tables.map((t) => t.name), ['PAYMENT']);
});

/* ------------------------------------------------------------------ *
 * 5 - UNION / CTE                                                      *
 * ------------------------------------------------------------------ */

test('scenario 5: UNION branches are siblings carrying their set operator', () => {
  const two = lineageOf('setops.unionTwoBranches');
  assert.equal(two.counts.unions, 1);
  const branch = two.selects.find((s) => s.role === 'UNION_BRANCH');
  assert.equal(branch.setOperator, 'UNION ALL');
  assert.deepEqual(branch.tables.map((t) => t.name), ['ARCHIVED_CUSTOMER']);

  const three = lineageOf('setops.unionThreeBranches');
  assert.equal(three.counts.unions, 2);
  assert.deepEqual(
    three.selects.filter((s) => s.role === 'UNION_BRANCH').map((s) => s.setOperator),
    ['UNION ALL', 'UNION'],
  );
});

test('scenario 5: CTEs are named child SELECTs, chained ones included', () => {
  const single = lineageOf('setops.cteSingle');
  const cte = single.selects.find((s) => s.role === 'CTE');
  assert.equal(cte.alias, 'RECENT_ORDER');
  assert.deepEqual(cte.tables.map((t) => t.name), ['ORDERS']);

  const chained = lineageOf('setops.cteChained');
  assert.deepEqual(
    chained.selects.filter((s) => s.role === 'CTE').map((s) => s.alias),
    ['RECENT_ORDER', 'RECENT_DETAIL'],
  );
});

/* ------------------------------------------------------------------ *
 * 6 - refid                                                            *
 * ------------------------------------------------------------------ */

test('scenario 6: same-file, cross-mapper and nested fragments all resolve', () => {
  assert.deepEqual(analysis('frag.sameFileInclude').includes, ['frag.customerColumns']);
  assert.deepEqual(
    analysis('frag.crossMapperInclude').includes,
    ['common.auditColumns', 'common.activeCondition', 'common.pagination'],
  );
  // The nested fragment brings its own children with it.
  assert.deepEqual(
    analysis('frag.nestedFragmentInclude').includes,
    ['frag.customerAndAudit', 'frag.customerColumns', 'common.auditColumns'],
  );
  // A fragment can contribute a JOIN, not just columns.
  assert.equal(analysis('frag.includeSuppliesJoin').joins[0].type, 'INNER_JOIN');
  // Two levels down, from inside a <dynamic>.
  assert.deepEqual(
    analysis('frag.includeInsideDynamic').includes,
    ['frag.customerColumns', 'common.liveRowCondition', 'common.activeCondition', 'common.softDeleteCondition'],
  );
});

test('scenario 6: missing and circular refids are diagnostics, not exceptions', () => {
  const missing = result.diagnostics.errors.filter((e) => e.message.includes('common.doesNotExist'));
  assert.equal(missing.length, 1);
  assert.equal(missing[0].code, 'MISSING_REFERENCE');
  assert.ok(result.circularReferences.length >= 1);
  assert.ok(result.circularReferences.some((c) => c.path.some((id) => id.startsWith('frag.circular'))));
  // Both statements still exist in the analysis, just without SQL analysis.
  assert.ok(warningCodes('frag.missingRefid').includes('SQL_PARSE_FAILED'));
  assert.ok(warningCodes('frag.circularRefid').includes('SQL_PARSE_FAILED'));
});

/* ------------------------------------------------------------------ *
 * 7 - resultMap                                                        *
 * ------------------------------------------------------------------ */

test('scenario 7: a 3-level extends chain resolves and converts', () => {
  const deps = result.dependencyAnalyzer.buildStatementDependencyTree('rm.getCustomerFull');
  const chain = [];
  for (let node = deps.resultMap; node; node = node.parent) chain.push(node.id);
  assert.deepEqual(chain, ['rm.CustomerFull', 'rm.CustomerContact', 'rm.CustomerBase']);

  const xml = result.generatedMapperXml.get('07-resultmap.xml');
  assert.ok(xml.includes('extends="CustomerContact"'));
  assert.ok(xml.includes('property="region.regionCode"'));
});

/* ------------------------------------------------------------------ *
 * 8 - the legacy report query                                          *
 * ------------------------------------------------------------------ */

test('scenario 8: the giant report query keeps every table, join, subquery and dynamic block', () => {
  const report = analysis('report.getProductSalesReport');
  assert.deepEqual(warningCodes(report.id), []);
  // Real tables only: `RET` is the JOINed inline view, which the flat
  // table analysis reports separately as a derived table.
  assert.deepEqual(
    report.tables.filter((t) => !t.derived).map((t) => t.name).sort(),
    ['CATEGORY', 'ORDERS', 'ORDER_DETAIL', 'PRODUCT', 'PRODUCT_REVIEW', 'RETURN_ITEM', 'SUPPLIER'],
  );
  assert.deepEqual(report.tables.filter((t) => t.derived).map((t) => t.name), ['RET']);

  const lineage = report.lineage;
  // One correlated scalar subquery + one JOINed inline view.
  assert.deepEqual(
    lineage.selects.filter((s) => s.role === 'SUBQUERY').map((s) => s.origin).sort(),
    ['JOIN', 'SELECT_LIST'],
  );
  const inlineView = lineage.selects.find((s) => s.origin === 'JOIN');
  assert.equal(inlineView.alias, 'RET');
  assert.deepEqual(inlineView.tables.map((t) => t.name), ['RETURN_ITEM']);

  const main = lineage.selects.find((s) => s.role === 'MAIN');
  assert.ok(main.groupBy.length >= 6);
  assert.ok(main.having, 'the dynamic HAVING block should survive flattening');

  // Both dynamic groups (AND-prepended WHERE tail, HAVING) are analyzed.
  assert.deepEqual(
    report.dynamicConditions.map((c) => c.property).sort(),
    ['categoryId', 'minRevenue', 'minUnits', 'since', 'supplierId'],
  );
  assert.deepEqual(report.includes, ['report.productCoreColumns', 'common.pagination']);
});

test('scenario 8: the customer statistics query resolves its alias lineage through the inline view', () => {
  const lineage = lineageOf('report.getCustomerOrderStatistics');
  const byAlias = new Map(lineage.columnLineage.map((c) => [c.alias, c]));
  assert.equal(byAlias.get('lastOrderDate').sourceTable, 'ORDERS');
  assert.equal(byAlias.get('totalPayment').sourceTable, 'PAYMENT');
  assert.equal(byAlias.get('totalPayment').sourceColumn, 'PAYMENT_AMOUNT');
  assert.equal(byAlias.get('paymentCount').sourceTable, 'PAYMENT');
  // COUNT(*) reads no column, so there is no source column to name — the
  // inline view's own alias must not be reported as one.
  assert.equal(byAlias.get('paymentCount').sourceColumn, null);
  assert.equal(lineage.counts.subqueries, 3); // scalar + inline view + the IN subquery inside it
});

/* ------------------------------------------------------------------ *
 * 9 - degrade-loudly edge cases                                        *
 * ------------------------------------------------------------------ */

test('scenario 9: every $...$ is flagged as an injection risk, per parameter', () => {
  const raw = analysis('edge.rawSubstitutionOrderBy');
  const injections = raw.warnings.filter((w) => w.code === 'RAW_SQL_SUBSTITUTION');
  assert.deepEqual(injections.map((w) => w.parameter), ['orderByColumn', 'orderDirection']);
  assert.ok(injections.every((w) => w.risk === 'SQL_INJECTION'));

  const events = result.mybatisConversions.get('edge.rawSubstitutionOrderBy').events;
  assert.ok(events.some((e) => e.code === 'RAW_SQL_SUBSTITUTION' && e.grade === 'WARNING'));

  // `$a$ $b$` flattens to `? ?`, which no dialect parses — so this one is
  // in EXPECTED_SQL_PARSE_FAILURES too: the injection warning still lands,
  // the table analysis is what's lost.
  assert.ok(warningCodes(raw.id).includes('SQL_PARSE_FAILED'));
  assert.deepEqual(raw.tables, []);
  // A `$...$` in a value position stays analyzable, though:
  const dynamicTable = analysis('edge.dynamicTableName');
  assert.ok(dynamicTable.warnings.some((w) => w.code === 'RAW_SQL_SUBSTITUTION' && w.parameter === 'tableName'));
});

test('scenario 9: unparseable SQL degrades to an empty analysis + a warning, and still converts', () => {
  for (const id of ['edge.mutuallyExclusiveFromBranches', 'edge.oracleOuterJoinOperator']) {
    const a = analysis(id);
    assert.ok(warningCodes(id).includes('SQL_PARSE_FAILED'));
    assert.deepEqual(a.tables, []);
    assert.deepEqual(a.joins, []);
    assert.deepEqual(a.lineage.selects, []);
    assert.deepEqual(a.lineage.columnLineage, []);
    // Conversion is independent of SQL analysis and must still succeed.
    assert.ok(result.mybatisConversions.get(id).xml.includes('<select'));
  }
});

/* ------------------------------------------------------------------ *
 * Project-wide reports over the same sample                            *
 * ------------------------------------------------------------------ */

test('the project table report and dependency graph see the sample project as one whole', () => {
  const tables = result.tableUsageReport;
  assert.ok(tables.CUSTOMER, 'CUSTOMER should be in the project table report');
  assert.ok(tables.CUSTOMER.operations.READ.length >= 10);

  const related = result.tableDependencyGraph.CUSTOMER ?? [];
  assert.ok(related.some((r) => r.table === 'ORDERS'), 'CUSTOMER-ORDERS join edge should exist');
});
