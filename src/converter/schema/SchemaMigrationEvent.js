/**
 * One graded decision made while migrating SQL to the new schema. Same
 * `{ grade, code, message }` shape and SAFE/WARNING/MANUAL vocabulary as
 * `converter/mybatis`'s ConversionEvent, so `MigrationSafetyAnalyzer` can
 * count these too — but defined here, so this package never imports the
 * iBATIS -> MyBatis syntax converter (the two conversions stay
 * independent modules).
 */
export const SchemaMigrationGrade = Object.freeze({
  SAFE: 'SAFE',
  WARNING: 'WARNING',
  MANUAL: 'MANUAL',
  ERROR: 'ERROR',
});

export const SchemaMigrationCode = Object.freeze({
  TABLE_RENAMED: 'TABLE_RENAMED',
  COLUMN_RENAMED: 'COLUMN_RENAMED',
  /** renamed, but an unmapped table/CTE/subquery in the same scope could also own this column */
  COLUMN_ASSUMED: 'COLUMN_ASSUMED',
  /** an unqualified column two mapped tables in scope map to different new names */
  COLUMN_AMBIGUOUS: 'COLUMN_AMBIGUOUS',
  /** a top-level SELECT item was renamed, so the result column label changed (resultMap column= / auto-mapping) */
  RESULT_COLUMN_RENAMED: 'RESULT_COLUMN_RENAMED',
  /** preserveResultColumnNames: a renamed top-level SELECT item got `AS <old name>` so the result label is unchanged */
  RESULT_COLUMN_ALIASED: 'RESULT_COLUMN_ALIASED',
  /** `x.COL` where `x` is no table/alias in scope, and COL is a mapped legacy column somewhere */
  UNRESOLVED_QUALIFIER: 'UNRESOLVED_QUALIFIER',
  /** unqualified legacy column name with no table anywhere in scope (an un-included `<sql>` fragment, or convert() without contextTable) */
  NO_TABLE_CONTEXT: 'NO_TABLE_CONTEXT',
  /** `${...}` / `$x$`: substituted at runtime, so any table/column name inside it is not migrated */
  RUNTIME_SUBSTITUTION: 'RUNTIME_SUBSTITUTION',
  /** `${}` glued to an identifier (`TB_ORD_H_${yyyymm}`): a name built at runtime; MANUAL when it is a mapped legacy table's */
  DYNAMIC_IDENTIFIER: 'DYNAMIC_IDENTIFIER',
  /** an optimizer hint comment mentions a renamed table */
  HINT_NOT_MIGRATED: 'HINT_NOT_MIGRATED',
  /** a fragment's tables were taken from the statements that include it */
  FRAGMENT_CONTEXT_INFERRED: 'FRAGMENT_CONTEXT_INFERRED',
  /** a fragment's include sites disagree about what its columns mean */
  FRAGMENT_CONTEXT_CONFLICT: 'FRAGMENT_CONTEXT_CONFLICT',
});

export class SchemaMigrationEvent {
  constructor({ grade, code, message, original = null, replacement = null, statementId = null, tokenIndex = null, table = null, column = null }) {
    this.grade = grade;
    this.code = code;
    this.message = message;
    this.original = original;
    this.replacement = replacement;
    /** the ORIGINAL (legacy) table the decision is about, when there is one */
    this.table = table;
    /** the ORIGINAL column name, for column decisions */
    this.column = column;
    /** set by convertMapper(): the statement / fragment id the event belongs to */
    this.statementId = statementId;
    /** index into the token stream the event was raised on (null for statement-level events) */
    this.tokenIndex = tokenIndex;
  }
}
