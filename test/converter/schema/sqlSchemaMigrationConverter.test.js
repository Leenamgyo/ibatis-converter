import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SqlSchemaMigrationConverter,
  MigrationMapping,
  SchemaMigrationGrade,
  SchemaMigrationCode,
} from '../../../src/converter/schema/index.js';

const MAPPING = {
  OLD_COUNTRY: {
    targetTable: 'COUNTRY',
    columns: { COUNTRY_CD: 'COUNTRY_CODE', COUNTRY_NM: 'COUNTRY_NAME', USE_YN: 'IS_ENABLED' },
  },
  OLD_CODE_DETAIL: {
    targetTable: 'CODE_DETAIL',
    columns: { GRP_ID: 'GROUP_ID', CD: 'CODE', CD_NM: 'CODE_NAME' },
  },
  OLD_CONTENT: { targetTable: 'CONTENT', columns: { APP_ID: 'APPLICATION_ID' } },
  TABLE_A: { targetTable: 'TABLE_A', columns: { CODE: 'NEW_CODE' } },
  TABLE_B: { targetTable: 'TABLE_B', columns: { CODE: 'DETAIL_CODE' } },
};

const converter = new SqlSchemaMigrationConverter(MAPPING);
const sqlOf = (sql, context) => converter.convert(sql, context).sql;
const codes = (events) => events.map((e) => e.code);

test('단일 테이블: table and its columns are renamed', () => {
  assert.equal(
    sqlOf('SELECT COUNTRY_CD, COUNTRY_NM FROM OLD_COUNTRY WHERE USE_YN = \'Y\''),
    'SELECT COUNTRY_CODE, COUNTRY_NAME FROM COUNTRY WHERE IS_ENABLED = \'Y\'',
  );
});

test('table alias: the alias is kept and alias-qualified columns follow the aliased table', () => {
  assert.equal(
    sqlOf('SELECT c.COUNTRY_CD FROM OLD_COUNTRY c WHERE c.USE_YN = \'Y\''),
    'SELECT c.COUNTRY_CODE FROM COUNTRY c WHERE c.IS_ENABLED = \'Y\'',
  );
  assert.equal(sqlOf('SELECT x.COUNTRY_CD FROM OLD_COUNTRY AS x'), 'SELECT x.COUNTRY_CODE FROM COUNTRY AS x');
});

test('JOIN: alias -> original table decides each column (spec example, formatting preserved)', () => {
  const input = `SELECT
    c.COUNTRY_CD,
    d.CD
FROM OLD_COUNTRY c
JOIN OLD_CODE_DETAIL d
    ON c.COUNTRY_CD = d.CD`;
  const expected = `SELECT
    c.COUNTRY_CODE,
    d.CODE
FROM COUNTRY c
JOIN CODE_DETAIL d
    ON c.COUNTRY_CODE = d.CODE`;
  const { sql, events } = converter.convert(input);
  assert.equal(sql, expected);
  const renames = events.filter((e) => e.code !== SchemaMigrationCode.RESULT_COLUMN_RENAMED);
  assert.deepEqual(codes(renames), ['TABLE_RENAMED', 'TABLE_RENAMED', 'COLUMN_RENAMED', 'COLUMN_RENAMED', 'COLUMN_RENAMED', 'COLUMN_RENAMED']);
  assert.ok(renames.every((e) => e.grade === SchemaMigrationGrade.SAFE));
  // the two unaliased SELECT items change the result labels the resultMap maps by
  assert.equal(events.filter((e) => e.code === SchemaMigrationCode.RESULT_COLUMN_RENAMED).length, 2);
});

test('same column name in two tables maps per table, not globally', () => {
  assert.equal(
    sqlOf('SELECT TABLE_A.CODE, TABLE_B.CODE FROM TABLE_A LEFT OUTER JOIN TABLE_B ON TABLE_A.CODE = TABLE_B.CODE'),
    'SELECT TABLE_A.NEW_CODE, TABLE_B.DETAIL_CODE FROM TABLE_A LEFT OUTER JOIN TABLE_B ON TABLE_A.NEW_CODE = TABLE_B.DETAIL_CODE',
  );
  assert.equal(
    sqlOf('SELECT a.CODE, b.CODE FROM TABLE_A a, TABLE_B b WHERE a.CODE = b.CODE'),
    'SELECT a.NEW_CODE, b.DETAIL_CODE FROM TABLE_A a, TABLE_B b WHERE a.NEW_CODE = b.DETAIL_CODE',
  );
});

test('an unqualified column two joined tables map differently is left alone and graded MANUAL', () => {
  const { sql, events } = converter.convert('SELECT CODE FROM TABLE_A a JOIN TABLE_B b ON a.ID = b.ID');
  assert.equal(sql, 'SELECT CODE FROM TABLE_A a JOIN TABLE_B b ON a.ID = b.ID');
  const ambiguous = events.find((e) => e.code === SchemaMigrationCode.COLUMN_AMBIGUOUS);
  assert.equal(ambiguous.grade, SchemaMigrationGrade.MANUAL);
});

test('INSERT: target table and its column list; VALUES params untouched', () => {
  assert.equal(
    sqlOf('INSERT INTO OLD_COUNTRY (COUNTRY_CD, COUNTRY_NM, USE_YN) VALUES (#{code}, #{name}, \'Y\')'),
    'INSERT INTO COUNTRY (COUNTRY_CODE, COUNTRY_NAME, IS_ENABLED) VALUES (#{code}, #{name}, \'Y\')',
  );
});

test('INSERT ... SELECT: the target column list and the SELECT each resolve against their own table', () => {
  assert.equal(
    sqlOf('INSERT INTO OLD_COUNTRY (COUNTRY_CD, COUNTRY_NM) SELECT CD, CD_NM FROM OLD_CODE_DETAIL WHERE GRP_ID = \'NATION\''),
    'INSERT INTO COUNTRY (COUNTRY_CODE, COUNTRY_NAME) SELECT CODE, CODE_NAME FROM CODE_DETAIL WHERE GROUP_ID = \'NATION\'',
  );
});

test('UPDATE: SET and WHERE columns', () => {
  assert.equal(
    sqlOf('UPDATE OLD_COUNTRY SET COUNTRY_NM = #{name}, USE_YN = #{useYn} WHERE COUNTRY_CD = #{code}'),
    'UPDATE COUNTRY SET COUNTRY_NAME = #{name}, IS_ENABLED = #{useYn} WHERE COUNTRY_CODE = #{code}',
  );
  assert.equal(
    sqlOf('UPDATE OLD_COUNTRY c SET c.USE_YN = \'N\' WHERE c.COUNTRY_CD = #{code}'),
    'UPDATE COUNTRY c SET c.IS_ENABLED = \'N\' WHERE c.COUNTRY_CODE = #{code}',
  );
});

test('DELETE: with and without FROM', () => {
  assert.equal(sqlOf('DELETE FROM OLD_COUNTRY WHERE COUNTRY_CD = #{code}'), 'DELETE FROM COUNTRY WHERE COUNTRY_CODE = #{code}');
  assert.equal(sqlOf('DELETE OLD_COUNTRY WHERE USE_YN = \'N\''), 'DELETE COUNTRY WHERE IS_ENABLED = \'N\'');
});

test('MyBatis #{} is never touched, even when its property name equals a mapped column', () => {
  const input = 'SELECT APP_ID\nFROM OLD_CONTENT\nWHERE APP_ID = #{appId} AND APP_ID <> #{APP_ID,jdbcType=VARCHAR}';
  assert.equal(
    sqlOf(input),
    'SELECT APPLICATION_ID\nFROM CONTENT\nWHERE APPLICATION_ID = #{appId} AND APPLICATION_ID <> #{APP_ID,jdbcType=VARCHAR}',
  );
});

test('MyBatis ${} is kept verbatim and flagged: its runtime value is not migrated', () => {
  const { sql, events } = converter.convert('SELECT APP_ID FROM OLD_CONTENT ORDER BY ${order} ${dir}');
  assert.equal(sql, 'SELECT APPLICATION_ID FROM CONTENT ORDER BY ${order} ${dir}');
  const runtime = events.filter((e) => e.code === SchemaMigrationCode.RUNTIME_SUBSTITUTION);
  assert.deepEqual(runtime.map((e) => e.original), ['${order}', '${dir}']);
  assert.ok(runtime.every((e) => e.grade === SchemaMigrationGrade.WARNING));
});

test('iBATIS #x# / $x$ parameters are tokens too, never identifiers', () => {
  assert.equal(
    sqlOf('SELECT APP_ID FROM OLD_CONTENT WHERE APP_ID = #APP_ID# ORDER BY $APP_ID$'),
    'SELECT APPLICATION_ID FROM CONTENT WHERE APPLICATION_ID = #APP_ID# ORDER BY $APP_ID$',
  );
});

test('SQL fragment without FROM + contextTable', () => {
  assert.equal(sqlOf('AND APP_ID = #{appId}', 'OLD_CONTENT'), 'AND APPLICATION_ID = #{appId}');
  // aliased context: `c.COL` in a column-list fragment
  assert.equal(sqlOf('c.COUNTRY_CD, c.COUNTRY_NM', 'OLD_COUNTRY c'), 'c.COUNTRY_CODE, c.COUNTRY_NAME');
  // several context tables, each decided by its alias
  assert.equal(
    sqlOf('AND c.COUNTRY_CD = d.CD AND GRP_ID = #{group}', ['OLD_COUNTRY c', 'OLD_CODE_DETAIL d']),
    'AND c.COUNTRY_CODE = d.CODE AND GROUP_ID = #{group}',
  );
  // without a context nothing is guessed
  assert.equal(sqlOf('AND APP_ID = #{appId}'), 'AND APP_ID = #{appId}');
});

test('a fragment\'s own FROM wins over the context table', () => {
  assert.equal(
    sqlOf('SELECT CD FROM OLD_CODE_DETAIL', 'OLD_COUNTRY'),
    'SELECT CODE FROM CODE_DETAIL',
  );
});

test('a column not in the table\'s mapping keeps its name', () => {
  assert.equal(
    sqlOf('SELECT c.COUNTRY_CD, c.REG_DT, CREATED_BY FROM OLD_COUNTRY c'),
    'SELECT c.COUNTRY_CODE, c.REG_DT, CREATED_BY FROM COUNTRY c',
  );
});

test('a table not in the mapping keeps its name and its columns, even ones named like a mapped column', () => {
  assert.equal(
    sqlOf('SELECT u.CD, u.USE_YN FROM USERS u WHERE USE_YN = \'Y\''),
    'SELECT u.CD, u.USE_YN FROM USERS u WHERE USE_YN = \'Y\'',
  );
});

test('an unmapped table sharing the scope makes an unqualified rename WARNING, not SAFE', () => {
  const { sql, events } = converter.convert('SELECT COUNTRY_NM FROM OLD_COUNTRY JOIN USERS u ON u.ID = 1');
  assert.equal(sql, 'SELECT COUNTRY_NAME FROM COUNTRY JOIN USERS u ON u.ID = 1');
  assert.equal(events.find((e) => e.code === SchemaMigrationCode.COLUMN_ASSUMED).grade, SchemaMigrationGrade.WARNING);
});

test('schema.table: the SQL\'s schema is kept unless targetTable names its own', () => {
  assert.equal(
    sqlOf('SELECT c.COUNTRY_CD FROM LEGACY.OLD_COUNTRY c'),
    'SELECT c.COUNTRY_CODE FROM LEGACY.COUNTRY c',
  );
  const moved = new SqlSchemaMigrationConverter({
    'LEGACY.OLD_COUNTRY': { targetTable: 'MASTER.COUNTRY', columns: { COUNTRY_CD: 'COUNTRY_CODE' } },
  });
  assert.equal(
    moved.convert('SELECT LEGACY.OLD_COUNTRY.COUNTRY_CD FROM LEGACY.OLD_COUNTRY').sql,
    'SELECT MASTER.COUNTRY.COUNTRY_CODE FROM MASTER.COUNTRY',
  );
  // a schema-qualified key only matches that schema
  assert.equal(moved.convert('SELECT COUNTRY_CD FROM OTHER.OLD_COUNTRY').sql, 'SELECT COUNTRY_CD FROM OTHER.OLD_COUNTRY');
});

test('table-name qualifier (no alias) is renamed along with the table', () => {
  assert.equal(
    sqlOf('SELECT OLD_COUNTRY.COUNTRY_CD, OLD_COUNTRY.* FROM OLD_COUNTRY'),
    'SELECT COUNTRY.COUNTRY_CODE, COUNTRY.* FROM COUNTRY',
  );
});

test('column alias AS (and bare alias) is kept; only the source column is renamed', () => {
  assert.equal(
    sqlOf('SELECT c.COUNTRY_CD AS COUNTRY_CD, c.COUNTRY_NM name, COUNT(*) AS CD FROM OLD_COUNTRY c ORDER BY CD'),
    'SELECT c.COUNTRY_CODE AS COUNTRY_CD, c.COUNTRY_NAME name, COUNT(*) AS CD FROM COUNTRY c ORDER BY CD',
  );
});

test('subquery: IN / EXISTS / scalar / correlated each resolve in their own scope', () => {
  assert.equal(
    sqlOf(`SELECT c.COUNTRY_CD,
       (SELECT d.CD_NM FROM OLD_CODE_DETAIL d WHERE d.CD = c.COUNTRY_CD) AS name
  FROM OLD_COUNTRY c
 WHERE c.COUNTRY_CD IN (SELECT CD FROM OLD_CODE_DETAIL WHERE GRP_ID = 'NATION')
   AND EXISTS (SELECT 1 FROM OLD_CODE_DETAIL x WHERE x.CD = c.COUNTRY_CD AND USE_YN = 'Y')`),
    `SELECT c.COUNTRY_CODE,
       (SELECT d.CODE_NAME FROM CODE_DETAIL d WHERE d.CODE = c.COUNTRY_CODE) AS name
  FROM COUNTRY c
 WHERE c.COUNTRY_CODE IN (SELECT CODE FROM CODE_DETAIL WHERE GROUP_ID = 'NATION')
   AND EXISTS (SELECT 1 FROM CODE_DETAIL x WHERE x.CODE = c.COUNTRY_CODE AND USE_YN = 'Y')`,
  );
});

test('derived table: an inner rename carries through to the outer t.COL', () => {
  assert.equal(
    sqlOf('SELECT t.CD, t.label FROM (SELECT CD, CD_NM AS label FROM OLD_CODE_DETAIL) t WHERE t.CD = #{cd}'),
    'SELECT t.CODE, t.label FROM (SELECT CODE, CODE_NAME AS label FROM CODE_DETAIL) t WHERE t.CODE = #{cd}',
  );
  assert.equal(
    sqlOf('SELECT x.COUNTRY_CD FROM (SELECT * FROM OLD_COUNTRY) x'),
    'SELECT x.COUNTRY_CODE FROM (SELECT * FROM COUNTRY) x',
  );
});

test('CTE: body and outer query, including a CTE that shadows a mapped table name', () => {
  assert.equal(
    sqlOf('WITH nation AS (SELECT CD, CD_NM FROM OLD_CODE_DETAIL WHERE GRP_ID = \'N\') SELECT n.CD, CD_NM FROM nation n'),
    'WITH nation AS (SELECT CODE, CODE_NAME FROM CODE_DETAIL WHERE GROUP_ID = \'N\') SELECT n.CODE, CODE_NAME FROM nation n',
  );
  // inside its own (non-recursive) body, OLD_COUNTRY is the base table; outside it is the CTE
  assert.equal(
    sqlOf('WITH OLD_COUNTRY AS (SELECT COUNTRY_CD AS id FROM OLD_COUNTRY) SELECT id FROM OLD_COUNTRY'),
    'WITH OLD_COUNTRY AS (SELECT COUNTRY_CODE AS id FROM COUNTRY) SELECT id FROM OLD_COUNTRY',
  );
  // a CTE with its own column list has fixed output names
  assert.equal(
    sqlOf('WITH n (CD) AS (SELECT CD FROM OLD_CODE_DETAIL) SELECT CD FROM n'),
    'WITH n (CD) AS (SELECT CODE FROM CODE_DETAIL) SELECT CD FROM n',
  );
});

test('UNION branches are separate scopes', () => {
  assert.equal(
    sqlOf('SELECT COUNTRY_CD FROM OLD_COUNTRY UNION ALL SELECT CD FROM OLD_CODE_DETAIL'),
    'SELECT COUNTRY_CODE FROM COUNTRY UNION ALL SELECT CODE FROM CODE_DETAIL',
  );
});

test('MERGE: INTO target and USING source', () => {
  assert.equal(
    sqlOf('MERGE INTO OLD_COUNTRY t USING OLD_CODE_DETAIL s ON (t.COUNTRY_CD = s.CD) '
      + 'WHEN MATCHED THEN UPDATE SET t.COUNTRY_NM = s.CD_NM WHEN NOT MATCHED THEN INSERT (COUNTRY_CD) VALUES (s.CD)'),
    'MERGE INTO COUNTRY t USING CODE_DETAIL s ON (t.COUNTRY_CODE = s.CODE) '
      + 'WHEN MATCHED THEN UPDATE SET t.COUNTRY_NAME = s.CODE_NAME WHEN NOT MATCHED THEN INSERT (COUNTRY_CODE) VALUES (s.CODE)',
  );
});

test('keywords, string literals, comments and whitespace survive byte-for-byte', () => {
  const input = "select /* COUNTRY_CD */ COUNTRY_CD -- OLD_COUNTRY\n  from   OLD_COUNTRY\twhere COUNTRY_NM = 'OLD_COUNTRY.COUNTRY_CD' || 'it''s'";
  assert.equal(
    sqlOf(input),
    "select /* COUNTRY_CD */ COUNTRY_CODE -- OLD_COUNTRY\n  from   COUNTRY\twhere COUNTRY_NAME = 'OLD_COUNTRY.COUNTRY_CD' || 'it''s'",
  );
});

test('SQL that touches no mapped table comes back identical, with no events', () => {
  const input = 'SELECT u.ID, COUNT(*) cnt FROM USERS u /*+ FULL(u) */ GROUP BY u.ID HAVING COUNT(*) > 1';
  const { sql, events } = converter.convert(input);
  assert.equal(sql, input);
  assert.deepEqual(events, []);
});

test('lookups are case-insensitive and quoted identifiers keep their quotes', () => {
  assert.equal(sqlOf('select c.country_cd from old_country c'), 'select c.COUNTRY_CODE from COUNTRY c');
  assert.equal(sqlOf('SELECT "COUNTRY_CD", `USE_YN` FROM "OLD_COUNTRY"'), 'SELECT "COUNTRY_CODE", `IS_ENABLED` FROM "COUNTRY"');
});

test('function arguments are columns, function names and CAST types are not', () => {
  assert.equal(
    sqlOf('SELECT MAX(COUNTRY_CD) mx, CAST(USE_YN AS CHAR), EXTRACT(YEAR FROM REG_DT) FROM OLD_COUNTRY'),
    'SELECT MAX(COUNTRY_CODE) mx, CAST(IS_ENABLED AS CHAR), EXTRACT(YEAR FROM REG_DT) FROM COUNTRY',
  );
});

test('an unknown qualifier on a mapped column name is left and flagged', () => {
  const { sql, events } = converter.convert('SELECT z.COUNTRY_CD FROM OLD_COUNTRY c');
  assert.equal(sql, 'SELECT z.COUNTRY_CD FROM COUNTRY c');
  assert.ok(codes(events).includes(SchemaMigrationCode.UNRESOLVED_QUALIFIER));
});

test('an optimizer hint naming a renamed table is flagged (hints are comments, never rewritten)', () => {
  const { sql, events } = converter.convert('SELECT /*+ INDEX(OLD_COUNTRY IDX_C) */ COUNTRY_NM FROM OLD_COUNTRY WHERE COUNTRY_CD = 1');
  assert.match(sql, /\/\*\+ INDEX\(OLD_COUNTRY IDX_C\) \*\//);
  assert.ok(codes(events).includes(SchemaMigrationCode.HINT_NOT_MIGRATED));
});

test('renaming a top-level SELECT item is a result-label change: WARNING, or an alias with preserveResultColumnNames', () => {
  const { events } = converter.convert('SELECT COUNTRY_CD FROM OLD_COUNTRY');
  assert.equal(events.find((e) => e.code === SchemaMigrationCode.RESULT_COLUMN_RENAMED).grade, SchemaMigrationGrade.WARNING);

  const preserving = new SqlSchemaMigrationConverter(MAPPING, { preserveResultColumnNames: true });
  assert.equal(
    preserving.convert('SELECT c.COUNTRY_CD, c.COUNTRY_NM AS nm FROM OLD_COUNTRY c WHERE c.COUNTRY_CD = 1').sql,
    'SELECT c.COUNTRY_CODE AS COUNTRY_CD, c.COUNTRY_NAME AS nm FROM COUNTRY c WHERE c.COUNTRY_CODE = 1',
  );
  // only the outermost result is relabelled; a subquery's items are not
  assert.equal(
    preserving.convert('SELECT t.CD FROM (SELECT CD FROM OLD_CODE_DETAIL) t').sql,
    'SELECT t.CODE AS CD FROM (SELECT CODE FROM CODE_DETAIL) t',
  );
});

test('MigrationMapping accepts a Map, normalises case and rejects malformed entries', () => {
  const mapping = new MigrationMapping(new Map([['old_t', { targetTable: 'T', columns: { a: 'B' } }]]));
  assert.equal(mapping.table('OLD_T').targetTable, 'T');
  assert.equal(mapping.table('Old_T').column('A'), 'B');
  assert.equal(mapping.table('NOPE'), null);
  assert.ok(mapping.isKnownColumn('a'));
  assert.throws(() => new MigrationMapping({ BAD: 'COUNTRY' }), /must be an object/);
});

test('Oracle (+) outer-join marker is part of a column reference, not a function call', () => {
  assert.equal(
    sqlOf('SELECT C.COUNTRY_NM FROM OLD_COUNTRY C, OLD_CODE_DETAIL D WHERE D.CD(+) = C.COUNTRY_CD'),
    'SELECT C.COUNTRY_NAME FROM COUNTRY C, CODE_DETAIL D WHERE D.CODE(+) = C.COUNTRY_CODE',
  );
});

test('a ${} glued to a legacy table name is a runtime-built name: MANUAL, never renamed', () => {
  const { sql, events } = converter.convert('SELECT COUNTRY_CD FROM OLD_COUNTRY_${yyyymm}');
  assert.equal(sql, 'SELECT COUNTRY_CD FROM OLD_COUNTRY_${yyyymm}');
  const dynamic = events.find((e) => e.code === SchemaMigrationCode.DYNAMIC_IDENTIFIER);
  assert.equal(dynamic.grade, SchemaMigrationGrade.MANUAL);
  assert.equal(dynamic.table, 'OLD_COUNTRY');
});

test('MERGE ... INSERT (columns) resolves against the INTO target only, not the USING source', () => {
  const { sql, events } = converter.convert(
    'MERGE INTO OLD_CODE_DETAIL T USING (SELECT #{cd} AS CD FROM DUAL) S ON (T.CD = S.CD) '
    + 'WHEN NOT MATCHED THEN INSERT (CD, CD_NM) VALUES (S.CD, #{nm})',
  );
  assert.equal(sql,
    'MERGE INTO CODE_DETAIL T USING (SELECT #{cd} AS CD FROM DUAL) S ON (T.CODE = S.CD) '
    + 'WHEN NOT MATCHED THEN INSERT (CODE, CODE_NAME) VALUES (S.CD, #{nm})');
  assert.ok(events.every((e) => e.grade === SchemaMigrationGrade.SAFE));
});

test('a subquery whose output columns are all named does not make other columns a guess', () => {
  const { sql, events } = converter.convert(
    'SELECT USE_YN FROM OLD_COUNTRY C JOIN (SELECT COUNT(*) AS CNT FROM OLD_CODE_DETAIL) X ON 1 = 1',
  );
  assert.equal(sql, 'SELECT IS_ENABLED FROM COUNTRY C JOIN (SELECT COUNT(*) AS CNT FROM CODE_DETAIL) X ON 1 = 1');
  assert.ok(!events.some((e) => e.code === SchemaMigrationCode.COLUMN_ASSUMED));
});

test('an iBATIS $x$ glued to a legacy table name is flagged too; Oracle V$ names stay one identifier', () => {
  const { sql, events } = converter.convert('SELECT COUNTRY_CD FROM OLD_COUNTRY_$yyyymm$ JOIN V$SESSION S ON 1 = 1');
  assert.equal(sql, 'SELECT COUNTRY_CD FROM OLD_COUNTRY_$yyyymm$ JOIN V$SESSION S ON 1 = 1');
  assert.equal(events.find((e) => e.code === SchemaMigrationCode.DYNAMIC_IDENTIFIER).grade, SchemaMigrationGrade.MANUAL);
});
