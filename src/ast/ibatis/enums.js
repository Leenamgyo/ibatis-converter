/**
 * Enumerations shared by the iBATIS AST model.
 * Plain frozen objects are used instead of a language-level enum so the
 * values remain trivial to serialize to JSON for the report/API layers.
 */

export const StatementType = Object.freeze({
  SELECT: 'SELECT',
  INSERT: 'INSERT',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
  PROCEDURE: 'PROCEDURE',
});

export const ConditionType = Object.freeze({
  IS_NULL: 'IS_NULL',
  IS_NOT_NULL: 'IS_NOT_NULL',
  IS_EMPTY: 'IS_EMPTY',
  IS_NOT_EMPTY: 'IS_NOT_EMPTY',
  EQUAL: 'EQUAL',
  NOT_EQUAL: 'NOT_EQUAL',
  GREATER_THAN: 'GREATER_THAN',
  GREATER_EQUAL: 'GREATER_EQUAL',
  LESS_THAN: 'LESS_THAN',
  LESS_EQUAL: 'LESS_EQUAL',
  PROPERTY_AVAILABLE: 'PROPERTY_AVAILABLE',
  NOT_PROPERTY_AVAILABLE: 'NOT_PROPERTY_AVAILABLE',
  PARAMETER_PRESENT: 'PARAMETER_PRESENT',
  NOT_PARAMETER_PRESENT: 'NOT_PARAMETER_PRESENT',
  // MyBatis 3 input (parser/mybatis), analysed with the same model:
  /** `<if test>` */
  TEST: 'TEST',
  /** `<choose>`: exactly one of its WHEN / OTHERWISE children applies */
  CHOOSE: 'CHOOSE',
  WHEN: 'WHEN',
  OTHERWISE: 'OTHERWISE',
});

/** Maps an iBATIS `isXxx` tag name to its standardized ConditionType. */
export const CONDITION_TAG_MAP = Object.freeze({
  isNull: ConditionType.IS_NULL,
  isNotNull: ConditionType.IS_NOT_NULL,
  isEmpty: ConditionType.IS_EMPTY,
  isNotEmpty: ConditionType.IS_NOT_EMPTY,
  isEqual: ConditionType.EQUAL,
  isNotEqual: ConditionType.NOT_EQUAL,
  isGreaterThan: ConditionType.GREATER_THAN,
  isGreaterEqual: ConditionType.GREATER_EQUAL,
  isLessThan: ConditionType.LESS_THAN,
  isLessEqual: ConditionType.LESS_EQUAL,
  isPropertyAvailable: ConditionType.PROPERTY_AVAILABLE,
  isNotPropertyAvailable: ConditionType.NOT_PROPERTY_AVAILABLE,
  isParameterPresent: ConditionType.PARAMETER_PRESENT,
  isNotParameterPresent: ConditionType.NOT_PARAMETER_PRESENT,
});

/** Tags that map directly to a StatementNode. */
export const STATEMENT_TAG_MAP = Object.freeze({
  select: StatementType.SELECT,
  insert: StatementType.INSERT,
  update: StatementType.UPDATE,
  delete: StatementType.DELETE,
  procedure: StatementType.PROCEDURE,
});

export const SymbolType = Object.freeze({
  STATEMENT: 'STATEMENT',
  SQL_FRAGMENT: 'SQL_FRAGMENT',
  RESULT_MAP: 'RESULT_MAP',
  PARAMETER_MAP: 'PARAMETER_MAP',
  CACHE_MODEL: 'CACHE_MODEL',
});
