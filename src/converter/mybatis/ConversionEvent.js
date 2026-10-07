/**
 * One graded decision made while converting iBATIS AST to MyBatis AST.
 * Every converter in this package returns a list of these instead of a
 * bare "warnings" array, because `report/migration/MigrationSafetyAnalyzer`
 * (spec section 18) needs the SAFE decisions counted too, not just the
 * risky ones — see its own doc comment for the exact summary shape.
 */
export const MigrationGrade = Object.freeze({
  SAFE: 'SAFE',
  WARNING: 'WARNING',
  MANUAL: 'MANUAL',
  ERROR: 'ERROR',
});

export class ConversionEvent {
  constructor({ grade, code, message, sourceFile = null, sourceLine = null }) {
    this.grade = grade;
    this.code = code;
    this.message = message;
    this.sourceFile = sourceFile;
    this.sourceLine = sourceLine;
  }
}
