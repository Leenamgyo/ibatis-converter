import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCase, listCases, resultsDir } from '../fixtures/schema-migration/cases.js';

// The 10 scenario mappers in test/fixtures/schema-migration/cases/ and their
// reviewed results in results/ (see that directory's README.md). If a change
// alters a result on purpose, regenerate with
// `node test/fixtures/schema-migration/generate-results.js` and review the diff.

const cases = listCases();

test('there are 10 schema-migration scenario cases', () => {
  assert.equal(cases.length, 10);
});

for (const name of cases) {
  test(`${name}: migrated mapper and events match the reviewed results`, () => {
    const { result, migratedXml, mybatisXml, eventsText } = runCase(name);
    assert.equal(result.diagnostics.errors.length, 0);
    assert.equal(mybatisXml, fs.readFileSync(path.join(resultsDir, `${name}.mybatis.xml`), 'utf8'));
    assert.equal(migratedXml, fs.readFileSync(path.join(resultsDir, `${name}.migrated.xml`), 'utf8'));
    assert.equal(eventsText, fs.readFileSync(path.join(resultsDir, `${name}.events.txt`), 'utf8'));
  });
}

// The snapshot alone would happily freeze a wrong answer, so the property each
// case exists for is also asserted directly.
const expectations = {
  '01-single-table': [/SELECT C\.CUSTOMER_ID\s+AS custNo/, /C\.UPD_DT\s+AS updDt/, /FROM CUSTOMER C/, /<result property="custNo" column="CUST_NO"\/>/],
  '02-join-same-column': [/C\.CUSTOMER_ID = H\.CUSTOMER_ID/, /D\.ORDER_ID {2}= H\.ORDER_ID/, /P\.IS_SELLABLE = 'Y'/, /CC\.CODE = H\.STATUS/],
  '03-dynamic-search': [/<if test="custNo != null and custNo != ''">\s+AND H\.CUSTOMER_ID = #\{custNo\}/, /AND TOTAL_AMOUNT &gt; 100000/, /ORDER BY \$\{sortColumn\} \$\{sortDir\}/],
  '04-include-fragments': [/P\.PRODUCT_ID AS prdCd, P\.PRODUCT_NAME AS prdNm, P\.CATEGORY_CODE AS ctgCd/, /AND CATEGORY_CODE = #\{ctgCd\}/, /<sql id="activeOnly">\s+AND USE_YN = 'Y'/],
  '05-insert': [/SEQ_ORD_NO\.NEXTVAL, 9, '0'\) FROM DUAL/, /INSERT INTO ORDERS \(ORDER_ID, CUSTOMER_ID, ORDERED_AT, STATUS, TOTAL_AMOUNT, REG_ID\)/, /SELECT #\{newOrdNo\}, S\.LINE_NO, S\.PRODUCT_ID, S\.QUANTITY, P\.SALE_PRC/],
  '06-update-dynamic-set': [/CUSTOMER_NAME = #\{custNm\},/, /IS_ACTIVE = #\{useYn\},/, /SUM\(D\.QUANTITY \* D\.UNIT_PRICE\) FROM ORDER_ITEM D WHERE D\.ORDER_ID = H\.ORDER_ID/],
  '07-delete-subquery': [/DELETE FROM ORDER_ITEM D/, /H\.ORDER_ID = D\.ORDER_ID/, /SELECT PRODUCT_ID FROM PRODUCT WHERE IS_SELLABLE = 'N'/, /DELETE COMMON_CODE WHERE GROUP_CODE/],
  '08-derived-table': [/SELECT T\.CUSTOMER_ID,/, /T\.ORD_CNT,/, /C\.CUSTOMER_ID = T\.CUSTOMER_ID/, /SELECT X\.ORDER_ID AS ordNo, X\.ORDERED_AT AS ordDt/],
  '09-cte-union': [/SUM\(M\.TOTAL_AMOUNT\)/, /SELECT TO_CHAR\(ORD_DT, 'YYYYMM'\) AS YM, TOT_AMT\s+FROM TB_ORD_H_ARCH/, /ON H\.STATUS = S\.CODE/],
  '10-edge-cases': [/FROM BILLING\.PAYMENT PY/, /'TB_ORD_H\.ORD_NO' AS srcLabel, {3}-- TB_ORD_H\.ORD_NO/, /L\.ORD_NO AS logOrdNo/, /WHERE USE_YN = 'Y'/],
};

for (const [name, patterns] of Object.entries(expectations)) {
  test(`${name}: the behaviour the case exists for`, () => {
    const { migratedXml } = runCase(name);
    for (const pattern of patterns) assert.match(migratedXml, pattern);
  });
}

test('graded events: the cases that need a human are flagged, the rest are not', () => {
  const nonSafe = Object.fromEntries(cases.map((name) => [
    name,
    runCase(name).events.filter((e) => e.grade !== 'SAFE').map((e) => `${e.grade}:${e.code}`),
  ]));
  assert.deepEqual(nonSafe['02-join-same-column'], []);
  assert.deepEqual(nonSafe['06-update-dynamic-set'], []);
  assert.deepEqual(nonSafe['07-delete-subquery'], []);
  assert.ok(nonSafe['04-include-fragments'].includes('MANUAL:FRAGMENT_CONTEXT_CONFLICT'));
  assert.ok(nonSafe['10-edge-cases'].includes('MANUAL:COLUMN_AMBIGUOUS'));
  assert.ok(nonSafe['10-edge-cases'].includes('WARNING:HINT_NOT_MIGRATED'));
  assert.ok(nonSafe['03-dynamic-search'].every((e) => e === 'WARNING:RUNTIME_SUBSTITUTION'));
});
