/**
 * Generator for the "advanced" sample's ~2000-line single statement: a
 * legacy month-end settlement report (`advReport.monthlySettlementReport`).
 *
 * Like large/largeMapper.js it is written once with placeholder names and
 * rendered twice — LEGACY (old tables/columns, what the sample ships) and
 * TARGET (the same SQL as if written on the new schema) — so the schema
 * migration of the 2000-line query can be checked byte for byte.
 *
 * What is in it: 38 CTEs (dynamic iBATIS tags inside the base one, one per
 * region for 17 regions, one per month for 12 months), a ROW_NUMBER() window in a derived table,
 * 9 LEFT JOINs, scalar and EXISTS subqueries, CASE / DECODE / NVL, a
 * cross-namespace `<include>`, `<iterate>`, `<isEqual>`, `<isNotEmpty>`,
 * 17 per-region CTEs, and a UNION ALL totals branch. (No `$sortColumn$`:
 * a `${}` in ORDER BY flattens to `?`, which the SQL analyzer can't parse —
 * the syntax sample covers `$...$`; this one should stay analyzable.)
 */

export const TABLES = {
  TB_ORD_H: { target: 'ORDERS', columns: { ORD_NO: 'ORDER_ID', CUST_NO: 'CUSTOMER_ID', ORD_DT: 'ORDERED_AT', ORD_STAT_CD: 'STATUS', TOT_AMT: 'TOTAL_AMOUNT', ORD_CHNL_CD: 'CHANNEL_CODE', SALE_EMP_NO: 'SALES_REP_ID' } },
  TB_ORD_D: { target: 'ORDER_ITEM', columns: { ORD_NO: 'ORDER_ID', ITEM_SEQ: 'LINE_NO', PRD_CD: 'PRODUCT_ID', ORD_QTY: 'QUANTITY', UNIT_PRC: 'UNIT_PRICE' } },
  TB_CUST_M: { target: 'CUSTOMER', columns: { CUST_NO: 'CUSTOMER_ID', CUST_NM: 'CUSTOMER_NAME', RGN_CD: 'REGION_CODE', USE_YN: 'IS_ACTIVE', CUST_GRD_CD: 'GRADE_CODE' } },
  TB_PRD_M: { target: 'PRODUCT', columns: { PRD_CD: 'PRODUCT_ID', PRD_NM: 'PRODUCT_NAME', CTG_CD: 'CATEGORY_ID', USE_YN: 'IS_SELLABLE' } },
  TB_CTG_M: { target: 'CATEGORY', columns: { CTG_CD: 'CATEGORY_ID', CTG_NM: 'CATEGORY_NAME', UPPER_CTG_CD: 'PARENT_CATEGORY_ID', SORT_SEQ: 'SORT_ORDER' } },
  'LEGACY.TB_PAY_H': { target: 'BILLING.PAYMENT', columns: { PAY_NO: 'PAYMENT_ID', ORD_NO: 'ORDER_ID', PAY_AMT: 'AMOUNT', PAY_DT: 'PAID_AT', PAY_MTHD_CD: 'METHOD_CODE' } },
  TB_DLV_H: { target: 'DELIVERY', columns: { DLV_NO: 'DELIVERY_ID', ORD_NO: 'ORDER_ID', DLV_STAT_CD: 'DELIVERY_STATUS', DLV_DT: 'DELIVERED_AT', DLV_CMP_CD: 'CARRIER_CODE', DLV_REQ_DT: 'PROMISED_AT' } },
  TB_RTN_H: { target: 'RETURN_ORDER', columns: { RTN_NO: 'RETURN_ID', ORD_NO: 'ORDER_ID', RTN_AMT: 'RETURN_AMOUNT', RTN_DT: 'RETURNED_AT', RTN_RSN_CD: 'REASON_CODE' } },
  TB_CPN_U: { target: 'COUPON_USAGE', columns: { CPN_NO: 'COUPON_ID', ORD_NO: 'ORDER_ID', DC_AMT: 'DISCOUNT_AMOUNT' } },
  TB_EMP_M: { target: 'EMPLOYEE', columns: { EMP_NO: 'EMPLOYEE_ID', EMP_NM: 'EMPLOYEE_NAME', DEPT_CD: 'DEPARTMENT_ID' } },
  TB_DEPT_M: { target: 'DEPARTMENT', columns: { DEPT_CD: 'DEPARTMENT_ID', DEPT_NM: 'DEPARTMENT_NAME', UPPER_DEPT_CD: 'PARENT_DEPARTMENT_ID' } },
  TB_CMM_CD: { target: 'COMMON_CODE', columns: { GRP_CD: 'GROUP_CODE', CD: 'CODE', CD_NM: 'CODE_NAME', SORT_SEQ: 'SORT_ORDER' } },
};

export function mappingJson() {
  return Object.fromEntries(Object.entries(TABLES).map(([name, t]) => [name, { targetTable: t.target, columns: t.columns }]));
}

const T = (table) => `«T:${table}»`;
const C = (table, column) => `«C:${table}:${column}»`;

export function render(text, version) {
  return text
    .replace(/«T:([^»]+)»/g, (_, table) => (version === 'TARGET' ? TABLES[table].target : table))
    .replace(/«C:([^:»]+):([^»]+)»/g, (_, table, column) => (version === 'TARGET' ? TABLES[table].columns[column] ?? column : column));
}

const CHANNELS = [['WEB', '웹'], ['APP', '앱'], ['CALL', '콜센터'], ['STORE', '매장'], ['B2B', '기업']];
const GRADES = ['VVIP', 'VIP', 'GOLD', 'SILVER', 'BASIC'];
const REGIONS = [
  ['SEOUL', '서울'], ['BUSAN', '부산'], ['DAEGU', '대구'], ['INCHEON', '인천'], ['GWANGJU', '광주'], ['DAEJEON', '대전'],
  ['ULSAN', '울산'], ['SEJONG', '세종'], ['GYEONGGI', '경기'], ['GANGWON', '강원'], ['CHUNGBUK', '충북'], ['CHUNGNAM', '충남'],
  ['JEONBUK', '전북'], ['JEONNAM', '전남'], ['GYEONGBUK', '경북'], ['GYEONGNAM', '경남'], ['JEJU', '제주'],
];

/** Builds the statement body (inside `<select>`), with placeholders. */
function body() {
  const L = [];
  const push = (...lines) => L.push(...lines);
  const H = (c) => `O.${C('TB_ORD_H', c)}`;

  push(
    '    /* ==================================================================',
    '     * 월 정산 리포트 (레거시)  -  채널/등급/카테고리/월별 매출 · 결제 · 반품 · 배송',
    '     * 2009 최초 작성, 2014 채널 추가, 2018 쿠폰/반품 반영, 2021 B2B 추가',
    '     * 주의: 결제는 LEGACY 스키마 테이블 사용, 취소(99) 주문은 제외',
    '     * ================================================================== */',
    '    WITH ORD_BASE AS (',
    '      /* 기준 주문: 기간/상태/채널 조건은 화면에서 동적으로 들어온다 */',
    '      SELECT O.' + C('TB_ORD_H', 'ORD_NO') + ',',
    '             O.' + C('TB_ORD_H', 'CUST_NO') + ',',
    '             O.' + C('TB_ORD_H', 'ORD_DT') + ',',
    '             O.' + C('TB_ORD_H', 'ORD_STAT_CD') + ',',
    '             O.' + C('TB_ORD_H', 'TOT_AMT') + ',',
    '             O.' + C('TB_ORD_H', 'ORD_CHNL_CD') + ',',
    '             O.' + C('TB_ORD_H', 'SALE_EMP_NO') + ',',
    `             TO_CHAR(${H('ORD_DT')}, 'YYYYMM') AS ORD_YM,`,
    `             C.${C('TB_CUST_M', 'CUST_NM')} AS CUST_NAME,`,
    `             C.${C('TB_CUST_M', 'RGN_CD')} AS CUST_RGN,`,
    `             NVL(C.${C('TB_CUST_M', 'CUST_GRD_CD')}, 'BASIC') AS CUST_GRD`,
    `        FROM ${T('TB_ORD_H')} O`,
    `       INNER JOIN ${T('TB_CUST_M')} C ON C.${C('TB_CUST_M', 'CUST_NO')} = ${H('CUST_NO')}`,
    `       WHERE ${H('ORD_STAT_CD')} &lt;&gt; '99'`,
    `         AND C.${C('TB_CUST_M', 'USE_YN')} = 'Y'`,
    '       <include refid="advCommon.orderPeriodCondition"/>',
    '       <isNotEmpty property="chnlList" prepend="AND">',
    `         ${H('ORD_CHNL_CD')} IN`,
    '         <iterate property="chnlList" open="(" close=")" conjunction=",">#chnlList[]#</iterate>',
    '       </isNotEmpty>',
    '       <isNotEmpty property="rgnCd" prepend="AND">',
    `         C.${C('TB_CUST_M', 'RGN_CD')} = #rgnCd#`,
    '       </isNotEmpty>',
    '       <isEqual property="excludeB2b" compareValue="Y" prepend="AND">',
    `         ${H('ORD_CHNL_CD')} &lt;&gt; 'B2B'`,
    '       </isEqual>',
    '    ),',
  );

  push(
    '    ITEM_AGG AS (',
    '      /* 주문별 상품 금액/수량 */',
    `      SELECT D.${C('TB_ORD_D', 'ORD_NO')},`,
    `             SUM(D.${C('TB_ORD_D', 'ORD_QTY')} * D.${C('TB_ORD_D', 'UNIT_PRC')}) AS ITEM_AMT,`,
    `             SUM(D.${C('TB_ORD_D', 'ORD_QTY')}) AS ITEM_QTY,`,
    '             COUNT(*) AS ITEM_LINES,',
    `             COUNT(DISTINCT D.${C('TB_ORD_D', 'PRD_CD')}) AS PRD_KINDS`,
    `        FROM ${T('TB_ORD_D')} D`,
    `       WHERE EXISTS (SELECT 1 FROM ORD_BASE B WHERE B.${C('TB_ORD_H', 'ORD_NO')} = D.${C('TB_ORD_D', 'ORD_NO')})`,
    `       GROUP BY D.${C('TB_ORD_D', 'ORD_NO')}`,
    '    ),',
    '    PAY_AGG AS (',
    '      /* 결제: 레거시 스키마, 결제수단별 분리 */',
    `      SELECT P.${C('LEGACY.TB_PAY_H', 'ORD_NO')},`,
    `             SUM(P.${C('LEGACY.TB_PAY_H', 'PAY_AMT')}) AS PAY_SUM,`,
    `             SUM(CASE WHEN P.${C('LEGACY.TB_PAY_H', 'PAY_MTHD_CD')} = 'CARD' THEN P.${C('LEGACY.TB_PAY_H', 'PAY_AMT')} ELSE 0 END) AS CARD_SUM,`,
    `             SUM(CASE WHEN P.${C('LEGACY.TB_PAY_H', 'PAY_MTHD_CD')} = 'BANK' THEN P.${C('LEGACY.TB_PAY_H', 'PAY_AMT')} ELSE 0 END) AS BANK_SUM,`,
    `             SUM(CASE WHEN P.${C('LEGACY.TB_PAY_H', 'PAY_MTHD_CD')} = 'POINT' THEN P.${C('LEGACY.TB_PAY_H', 'PAY_AMT')} ELSE 0 END) AS POINT_SUM,`,
    `             MAX(P.${C('LEGACY.TB_PAY_H', 'PAY_DT')}) AS LAST_PAY_DT`,
    `        FROM ${T('LEGACY.TB_PAY_H')} P`,
    `       WHERE P.${C('LEGACY.TB_PAY_H', 'ORD_NO')} IN (SELECT B.${C('TB_ORD_H', 'ORD_NO')} FROM ORD_BASE B)`,
    `       GROUP BY P.${C('LEGACY.TB_PAY_H', 'ORD_NO')}`,
    '    ),',
    '    DLV_LAST AS (',
    '      /* 주문별 최종 배송 1건 (ROW_NUMBER) */',
    `      SELECT X.${C('TB_DLV_H', 'ORD_NO')}, X.${C('TB_DLV_H', 'DLV_STAT_CD')}, X.${C('TB_DLV_H', 'DLV_DT')}, X.${C('TB_DLV_H', 'DLV_REQ_DT')}, X.${C('TB_DLV_H', 'DLV_CMP_CD')}`,
    '        FROM (',
    `              SELECT V.${C('TB_DLV_H', 'ORD_NO')}, V.${C('TB_DLV_H', 'DLV_STAT_CD')}, V.${C('TB_DLV_H', 'DLV_DT')}, V.${C('TB_DLV_H', 'DLV_REQ_DT')}, V.${C('TB_DLV_H', 'DLV_CMP_CD')},`,
    `                     ROW_NUMBER() OVER (PARTITION BY V.${C('TB_DLV_H', 'ORD_NO')} ORDER BY V.${C('TB_DLV_H', 'DLV_DT')} DESC, V.${C('TB_DLV_H', 'DLV_NO')} DESC) AS RN`,
    `                FROM ${T('TB_DLV_H')} V`,
    `               WHERE V.${C('TB_DLV_H', 'DLV_STAT_CD')} &lt;&gt; 'CANCEL'`,
    '             ) X',
    '       WHERE X.RN = 1',
    '    ),',
    '    RTN_AGG AS (',
    `      SELECT R.${C('TB_RTN_H', 'ORD_NO')},`,
    `             SUM(R.${C('TB_RTN_H', 'RTN_AMT')}) AS RTN_SUM,`,
    '             COUNT(*) AS RTN_CNT,',
    `             MAX(CASE WHEN R.${C('TB_RTN_H', 'RTN_RSN_CD')} = 'DEFECT' THEN 1 ELSE 0 END) AS HAS_DEFECT`,
    `        FROM ${T('TB_RTN_H')} R`,
    `       GROUP BY R.${C('TB_RTN_H', 'ORD_NO')}`,
    '    ),',
    '    CPN_AGG AS (',
    `      SELECT U.${C('TB_CPN_U', 'ORD_NO')}, SUM(U.${C('TB_CPN_U', 'DC_AMT')}) AS DC_SUM, COUNT(DISTINCT U.${C('TB_CPN_U', 'CPN_NO')}) AS CPN_CNT`,
    `        FROM ${T('TB_CPN_U')} U`,
    `       GROUP BY U.${C('TB_CPN_U', 'ORD_NO')}`,
    '    ),',
    '    EMP_DEPT AS (',
    '      /* 영업사원 -> 부서 -> 상위부서 */',
    `      SELECT E.${C('TB_EMP_M', 'EMP_NO')}, E.${C('TB_EMP_M', 'EMP_NM')}, DP.${C('TB_DEPT_M', 'DEPT_NM')}, UP.${C('TB_DEPT_M', 'DEPT_NM')} AS UPPER_DEPT_NM`,
    `        FROM ${T('TB_EMP_M')} E`,
    `        LEFT JOIN ${T('TB_DEPT_M')} DP ON DP.${C('TB_DEPT_M', 'DEPT_CD')} = E.${C('TB_EMP_M', 'DEPT_CD')}`,
    `        LEFT JOIN ${T('TB_DEPT_M')} UP ON UP.${C('TB_DEPT_M', 'DEPT_CD')} = DP.${C('TB_DEPT_M', 'UPPER_DEPT_CD')}`,
    '    ),',
    '    CTG_SALES AS (',
    '      /* 대분류 카테고리별 매출 */',
    `      SELECT D.${C('TB_ORD_D', 'ORD_NO')},`,
    `             NVL(PC.${C('TB_CTG_M', 'CTG_NM')}, CT.${C('TB_CTG_M', 'CTG_NM')}) AS TOP_CTG_NM,`,
    `             SUM(D.${C('TB_ORD_D', 'ORD_QTY')} * D.${C('TB_ORD_D', 'UNIT_PRC')}) AS CTG_AMT`,
    `        FROM ${T('TB_ORD_D')} D`,
    `       INNER JOIN ${T('TB_PRD_M')} PR ON PR.${C('TB_PRD_M', 'PRD_CD')} = D.${C('TB_ORD_D', 'PRD_CD')}`,
    `       INNER JOIN ${T('TB_CTG_M')} CT ON CT.${C('TB_CTG_M', 'CTG_CD')} = PR.${C('TB_PRD_M', 'CTG_CD')}`,
    `        LEFT JOIN ${T('TB_CTG_M')} PC ON PC.${C('TB_CTG_M', 'CTG_CD')} = CT.${C('TB_CTG_M', 'UPPER_CTG_CD')}`,
    `       WHERE PR.${C('TB_PRD_M', 'USE_YN')} = 'Y'`,
    `       GROUP BY D.${C('TB_ORD_D', 'ORD_NO')}, NVL(PC.${C('TB_CTG_M', 'CTG_NM')}, CT.${C('TB_CTG_M', 'CTG_NM')})`,
    '    ),',
  );

  // one CTE per region: grade mix and delivery quality per customer in that region
  for (const [rgn, label] of REGIONS) {
    push(`    R_${rgn} AS (`, `      /* ${label} 권역 */`, `      SELECT B.${C('TB_ORD_H', 'CUST_NO')},`);
    for (const grade of GRADES) {
      push(`             SUM(CASE WHEN B.CUST_GRD = '${grade}' THEN NVL(I.ITEM_AMT, 0) ELSE 0 END) AS ${grade}_AMT,`);
    }
    for (const [ch] of CHANNELS) {
      push(`             SUM(CASE WHEN B.${C('TB_ORD_H', 'ORD_CHNL_CD')} = '${ch}' THEN B.${C('TB_ORD_H', 'TOT_AMT')} ELSE 0 END) AS ${ch}_AMT,`);
    }
    push(
      `             SUM(CASE WHEN DL.${C('TB_DLV_H', 'DLV_DT')} &gt; DL.${C('TB_DLV_H', 'DLV_REQ_DT')} THEN 1 ELSE 0 END) AS LATE_CNT,`,
      `             COUNT(DISTINCT B.${C('TB_ORD_H', 'ORD_NO')}) AS ORD_CNT`,
      '        FROM ORD_BASE B',
      `        LEFT JOIN ITEM_AGG I ON I.${C('TB_ORD_D', 'ORD_NO')} = B.${C('TB_ORD_H', 'ORD_NO')}`,
      `        LEFT JOIN DLV_LAST DL ON DL.${C('TB_DLV_H', 'ORD_NO')} = B.${C('TB_ORD_H', 'ORD_NO')}`,
      `       WHERE B.CUST_RGN = '${rgn}'`,
      `       GROUP BY B.${C('TB_ORD_H', 'CUST_NO')}`,
      '    ),',
    );
  }

  // one CTE per month: monthly metrics per channel, each a block of CASE aggregates
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    push(`    M${mm} AS (`, `      /* ${m}월 채널별 실적 */`, `      SELECT B.${C('TB_ORD_H', 'CUST_NO')},`);
    for (const [ch, label] of CHANNELS) {
      push(
        `             /* ${label} */`,
        `             SUM(CASE WHEN B.${C('TB_ORD_H', 'ORD_CHNL_CD')} = '${ch}'`,
        `                      THEN NVL(I.ITEM_AMT, 0) - NVL(CP.DC_SUM, 0)`,
        '                      ELSE 0 END) AS ' + ch + '_NET,',
        `             SUM(CASE WHEN B.${C('TB_ORD_H', 'ORD_CHNL_CD')} = '${ch}' THEN 1 ELSE 0 END) AS ${ch}_CNT,`,
        `             SUM(CASE WHEN B.${C('TB_ORD_H', 'ORD_CHNL_CD')} = '${ch}' AND RT.RTN_CNT > 0 THEN RT.RTN_SUM ELSE 0 END) AS ${ch}_RTN,`,
        `             SUM(CASE WHEN B.${C('TB_ORD_H', 'ORD_CHNL_CD')} = '${ch}' THEN NVL(I.ITEM_QTY, 0) ELSE 0 END) AS ${ch}_QTY,`,
        `             SUM(CASE WHEN B.${C('TB_ORD_H', 'ORD_CHNL_CD')} = '${ch}' THEN NVL(CP.DC_SUM, 0) ELSE 0 END) AS ${ch}_DC,`,
        `             SUM(CASE WHEN B.${C('TB_ORD_H', 'ORD_CHNL_CD')} = '${ch}' THEN NVL(PY.PAY_SUM, 0) ELSE 0 END) AS ${ch}_PAY,`,
        `             SUM(CASE WHEN B.${C('TB_ORD_H', 'ORD_CHNL_CD')} = '${ch}'`,
        `                       AND B.${C('TB_ORD_H', 'TOT_AMT')} &gt;= 1000000 THEN 1 ELSE 0 END) AS ${ch}_BIG_CNT,`,
      );
    }
    push(
      `             SUM(NVL(PY.PAY_SUM, 0)) AS PAY_TOTAL,`,
      `             MAX(B.${C('TB_ORD_H', 'ORD_DT')}) AS LAST_ORD_DT`,
      '        FROM ORD_BASE B',
      `        LEFT JOIN ITEM_AGG I ON I.${C('TB_ORD_D', 'ORD_NO')} = B.${C('TB_ORD_H', 'ORD_NO')}`,
      `        LEFT JOIN CPN_AGG CP ON CP.${C('TB_CPN_U', 'ORD_NO')} = B.${C('TB_ORD_H', 'ORD_NO')}`,
      `        LEFT JOIN RTN_AGG RT ON RT.${C('TB_RTN_H', 'ORD_NO')} = B.${C('TB_ORD_H', 'ORD_NO')}`,
      `        LEFT JOIN PAY_AGG PY ON PY.${C('LEGACY.TB_PAY_H', 'ORD_NO')} = B.${C('TB_ORD_H', 'ORD_NO')}`,
      `       WHERE B.ORD_YM = #year# || '${mm}'`,
      `       GROUP BY B.${C('TB_ORD_H', 'CUST_NO')}`,
      m === 12 ? '    )' : '    ),',
    );
  }

  // the report: one row per customer, then a UNION ALL totals row
  const select = (isTotal) => {
    const out = [];
    const key = isTotal ? `'TOTAL'` : `B.${C('TB_ORD_H', 'CUST_NO')}`;
    out.push(
      `    SELECT ${key} AS CUST_KEY,`,
      isTotal ? `           '합계' AS CUST_NAME,` : '           MAX(B.CUST_NAME) AS CUST_NAME,',
      isTotal ? `           NULL AS CUST_GRD_NM,` : `           MAX((SELECT G.${C('TB_CMM_CD', 'CD_NM')} FROM ${T('TB_CMM_CD')} G WHERE G.${C('TB_CMM_CD', 'GRP_CD')} = 'CUST_GRD' AND G.${C('TB_CMM_CD', 'CD')} = B.CUST_GRD)) AS CUST_GRD_NM,`,
      isTotal ? '           NULL AS SALES_REP,' : `           MAX(ED.${C('TB_EMP_M', 'EMP_NM')} || ' (' || ED.${C('TB_DEPT_M', 'DEPT_NM')} || ')') AS SALES_REP,`,
      `           COUNT(DISTINCT B.${C('TB_ORD_H', 'ORD_NO')}) AS ORD_CNT,`,
      `           SUM(B.${C('TB_ORD_H', 'TOT_AMT')}) AS ORD_AMT,`,
      '           SUM(NVL(I.ITEM_AMT, 0)) AS ITEM_AMT,',
      '           SUM(NVL(I.ITEM_QTY, 0)) AS ITEM_QTY,',
      '           SUM(NVL(PY.PAY_SUM, 0)) AS PAY_AMT,',
      '           SUM(NVL(PY.CARD_SUM, 0)) AS CARD_AMT,',
      '           SUM(NVL(PY.BANK_SUM, 0)) AS BANK_AMT,',
      '           SUM(NVL(PY.POINT_SUM, 0)) AS POINT_AMT,',
      '           SUM(NVL(CP.DC_SUM, 0)) AS DC_AMT,',
      '           SUM(NVL(RT.RTN_SUM, 0)) AS RTN_AMT,',
      `           SUM(CASE WHEN DL.${C('TB_DLV_H', 'DLV_STAT_CD')} = 'DONE' THEN 1 ELSE 0 END) AS DLV_DONE_CNT,`,
      `           SUM(CASE WHEN DL.${C('TB_DLV_H', 'DLV_DT')} > DL.${C('TB_DLV_H', 'DLV_REQ_DT')} THEN 1 ELSE 0 END) AS DLV_LATE_CNT,`,
      `           SUM(DECODE(DL.${C('TB_DLV_H', 'DLV_CMP_CD')}, 'CJ', 1, 0)) AS DLV_CJ_CNT,`,
    );
    for (const grade of GRADES) {
      for (const [ch] of CHANNELS) {
        out.push(`           SUM(CASE WHEN B.CUST_GRD = '${grade}' AND B.${C('TB_ORD_H', 'ORD_CHNL_CD')} = '${ch}' THEN 1 ELSE 0 END) AS GRD_${grade}_${ch}_CNT,`);
      }
      out.push(
        `           SUM(CASE WHEN B.CUST_GRD = '${grade}'`,
        '                    THEN NVL(I.ITEM_AMT, 0) - NVL(CP.DC_SUM, 0) - NVL(RT.RTN_SUM, 0)',
        `                    ELSE 0 END) AS GRD_${grade}_NET,`,
      );
    }
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      for (const [ch] of CHANNELS) {
        out.push(`           SUM(NVL(M${mm}.${ch}_NET, 0)) AS M${mm}_${ch}_NET,`);
        out.push(`           SUM(NVL(M${mm}.${ch}_CNT, 0) - NVL(M${mm}.${ch}_RTN, 0) / 10000) AS M${mm}_${ch}_IDX,`);
        out.push(`           SUM(NVL(M${mm}.${ch}_PAY, 0) - NVL(M${mm}.${ch}_DC, 0)) AS M${mm}_${ch}_CASH,`);
        out.push(`           SUM(NVL(M${mm}.${ch}_BIG_CNT, 0)) AS M${mm}_${ch}_BIG,`);
      }
    }
    out.push(
      ...REGIONS.map(([rgn]) => `           SUM(NVL(R_${rgn}.VVIP_AMT, 0) + NVL(R_${rgn}.VIP_AMT, 0)) AS R_${rgn}_TOP_AMT,`),
      ...REGIONS.map(([rgn]) => `           SUM(NVL(R_${rgn}.LATE_CNT, 0)) AS R_${rgn}_LATE,`),
      '           SUM(NVL(CS.CTG_AMT, 0)) AS CTG_AMT,',
      '           MAX(CS.TOP_CTG_NM) AS TOP_CTG_NM,',
      `           MAX(B.${C('TB_ORD_H', 'ORD_DT')}) AS LAST_ORD_DT`,
      '      FROM ORD_BASE B',
      `      LEFT JOIN ITEM_AGG I ON I.${C('TB_ORD_D', 'ORD_NO')} = B.${C('TB_ORD_H', 'ORD_NO')}`,
      `      LEFT JOIN PAY_AGG PY ON PY.${C('LEGACY.TB_PAY_H', 'ORD_NO')} = B.${C('TB_ORD_H', 'ORD_NO')}`,
      `      LEFT JOIN CPN_AGG CP ON CP.${C('TB_CPN_U', 'ORD_NO')} = B.${C('TB_ORD_H', 'ORD_NO')}`,
      `      LEFT JOIN RTN_AGG RT ON RT.${C('TB_RTN_H', 'ORD_NO')} = B.${C('TB_ORD_H', 'ORD_NO')}`,
      `      LEFT JOIN DLV_LAST DL ON DL.${C('TB_DLV_H', 'ORD_NO')} = B.${C('TB_ORD_H', 'ORD_NO')}`,
      `      LEFT JOIN EMP_DEPT ED ON ED.${C('TB_EMP_M', 'EMP_NO')} = B.${C('TB_ORD_H', 'SALE_EMP_NO')}`,
      `      LEFT JOIN CTG_SALES CS ON CS.${C('TB_ORD_D', 'ORD_NO')} = B.${C('TB_ORD_H', 'ORD_NO')}`,
    );
    for (const [rgn] of REGIONS) {
      out.push(`      LEFT JOIN R_${rgn} ON R_${rgn}.${C('TB_ORD_H', 'CUST_NO')} = B.${C('TB_ORD_H', 'CUST_NO')}`);
    }
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      out.push(`      LEFT JOIN M${mm} ON M${mm}.${C('TB_ORD_H', 'CUST_NO')} = B.${C('TB_ORD_H', 'CUST_NO')}`);
    }
    out.push(
      '     WHERE 1 = 1',
      '     <isNotEmpty property="minOrdCnt" prepend="AND">',
      `       B.${C('TB_ORD_H', 'CUST_NO')} IN (SELECT S.${C('TB_ORD_H', 'CUST_NO')} FROM ORD_BASE S GROUP BY S.${C('TB_ORD_H', 'CUST_NO')} HAVING COUNT(*) &gt;= #minOrdCnt#)`,
      '     </isNotEmpty>',
    );
    if (!isTotal) out.push(`     GROUP BY B.${C('TB_ORD_H', 'CUST_NO')}`);
    return out;
  };

  push(...select(false), '    UNION ALL', ...select(true), '    ORDER BY ORD_AMT DESC, CUST_KEY');
  return L;
}

export function generateMegaReport() {
  const template = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE sqlMap PUBLIC "-//ibatis.apache.org//DTD SQL Map 2.0//EN" "http://ibatis.apache.org/dtd/sql-map-2.dtd">',
    '<!-- 2000줄짜리 단일 쿼리: 월 정산 리포트. test/fixtures/schema-migration/advanced/megaReport.js 로 생성 -->',
    '<sqlMap namespace="advReport">',
    '',
    '  <select id="monthlySettlementReport" parameterClass="map" resultClass="java.util.HashMap">',
    ...body(),
    '  </select>',
    '',
    '</sqlMap>',
    '',
  ].join('\n');
  return { legacyXml: render(template, 'LEGACY'), targetXml: render(template, 'TARGET') };
}
