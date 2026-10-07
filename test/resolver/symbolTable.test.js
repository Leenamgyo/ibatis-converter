import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIbatisMapperSource } from '../../src/parser/ibatis/IbatisMapperParser.js';
import { buildSymbolTable } from '../../src/resolver/symbol/ProjectScanner.js';
import { SymbolType } from '../../src/ast/ibatis/enums.js';
import { DiagnosticBag } from '../../src/parser/xml/ParserDiagnostics.js';

function mapper(source, file) {
  const { sqlMap } = parseIbatisMapperSource(source, file);
  return { sourceFile: file, sqlMap };
}

test('registers statements/fragments/resultMaps/parameterMaps with namespace-qualified ids', () => {
  const m = mapper(
    `<sqlMap namespace="user">
       <sql id="baseWhere">WHERE 1=1</sql>
       <resultMap id="UserResult" class="User"><result property="id" column="USER_ID"/></resultMap>
       <parameterMap id="userParam" class="User"><parameter property="id"/></parameterMap>
       <select id="getUser" resultClass="User">SELECT 1</select>
     </sqlMap>`,
    'user.xml',
  );

  const { symbolTable, diagnostics } = buildSymbolTable([m]);
  assert.equal(diagnostics.warnings.length, 0);

  assert.ok(symbolTable.has('user.getUser'));
  assert.equal(symbolTable.get('user.getUser').type, SymbolType.STATEMENT);
  assert.ok(symbolTable.has('user.baseWhere'));
  assert.equal(symbolTable.get('user.baseWhere').type, SymbolType.SQL_FRAGMENT);
  assert.ok(symbolTable.has('user.UserResult'));
  assert.equal(symbolTable.get('user.UserResult').type, SymbolType.RESULT_MAP);
  assert.ok(symbolTable.has('user.userParam'));
  assert.equal(symbolTable.get('user.userParam').type, SymbolType.PARAMETER_MAP);
});

test('flags duplicate qualifiedId registration as a conflict without crashing', () => {
  const m1 = mapper(`<sqlMap namespace="user"><sql id="baseWhere">A</sql></sqlMap>`, 'a.xml');
  const m2 = mapper(`<sqlMap namespace="user"><sql id="baseWhere">B</sql></sqlMap>`, 'b.xml');

  const diagnostics = new DiagnosticBag();
  const { symbolTable } = buildSymbolTable([m1, m2], diagnostics);

  const conflicts = symbolTable.getConflicts();
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].qualifiedId, 'user.baseWhere');
  assert.equal(conflicts[0].symbols.length, 2);

  assert.equal(diagnostics.warnings.length, 1);
  assert.equal(diagnostics.warnings[0].code, 'DUPLICATE_SYMBOL');

  // First registration wins for resolution.
  assert.equal(symbolTable.get('user.baseWhere').sourceFile, 'a.xml');
});

test('scans all files before resolving (2-pass): order of input does not matter for lookups', () => {
  const referencing = mapper(
    `<sqlMap namespace="order"><select id="getOrders">SELECT 1 <include refid="common.pagination"/></select></sqlMap>`,
    'order.xml',
  );
  const referenced = mapper(`<sqlMap namespace="common"><sql id="pagination">LIMIT 10</sql></sqlMap>`, 'common.xml');

  const { symbolTable } = buildSymbolTable([referencing, referenced]);
  assert.ok(symbolTable.has('common.pagination'));
  assert.ok(symbolTable.has('order.getOrders'));
});
