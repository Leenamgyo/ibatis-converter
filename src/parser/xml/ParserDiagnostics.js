/**
 * Diagnostics collected during parsing/resolving instead of throwing and
 * aborting the whole run. Every stage of the pipeline accumulates these into
 * a shared list so a project with a handful of broken mappers still yields
 * a usable analysis + report for everything else.
 */

export class ParserWarning {
  constructor({ message, sourceFile = null, sourceLine = null, code = 'PARSER_WARNING' }) {
    this.severity = 'WARNING';
    this.code = code;
    this.message = message;
    this.sourceFile = sourceFile;
    this.sourceLine = sourceLine;
  }
}

export class ParserError {
  constructor({ message, sourceFile = null, sourceLine = null, code = 'PARSER_ERROR' }) {
    this.severity = 'ERROR';
    this.code = code;
    this.message = message;
    this.sourceFile = sourceFile;
    this.sourceLine = sourceLine;
  }
}

/** Small mutable collector shared by parser/resolver/analyzer stages. */
export class DiagnosticBag {
  constructor() {
    /** @type {ParserWarning[]} */
    this.warnings = [];
    /** @type {ParserError[]} */
    this.errors = [];
  }

  warn(message, sourceFile = null, sourceLine = null, code = 'PARSER_WARNING') {
    this.warnings.push(new ParserWarning({ message, sourceFile, sourceLine, code }));
  }

  error(message, sourceFile = null, sourceLine = null, code = 'PARSER_ERROR') {
    this.errors.push(new ParserError({ message, sourceFile, sourceLine, code }));
  }

  merge(other) {
    this.warnings.push(...other.warnings);
    this.errors.push(...other.errors);
  }

  get hasErrors() {
    return this.errors.length > 0;
  }
}
