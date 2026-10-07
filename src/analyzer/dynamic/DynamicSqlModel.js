/**
 * Standardized, report/API-friendly model produced by DynamicSqlAnalyzer.
 * Mirrors the nesting of the source `DynamicNode`/`ConditionalNode`/
 * `IterateNode` tree exactly (nested dynamic stays nested — spec section
 * 5), but strips iBATIS-tag vocabulary in favor of the standardized
 * `ConditionType` operator already assigned by the parser.
 */

export class DynamicGroup {
  constructor({ prepend, sql, children, sourceFile, sourceLine }) {
    this.kind = 'DYNAMIC_GROUP';
    this.prepend = prepend;
    this.sql = sql;
    /** @type {(DynamicGroup|DynamicCondition|DynamicIterate)[]} */
    this.children = children;
    this.sourceFile = sourceFile;
    this.sourceLine = sourceLine;
  }
}

export class DynamicCondition {
  constructor({ property, operator, compareValue, prepend, sql, children, sourceFile, sourceLine }) {
    this.kind = 'CONDITION';
    this.property = property;
    this.operator = operator;
    this.compareValue = compareValue;
    this.prepend = prepend;
    this.sql = sql;
    /** @type {(DynamicGroup|DynamicCondition|DynamicIterate)[]} */
    this.children = children;
    this.sourceFile = sourceFile;
    this.sourceLine = sourceLine;
  }
}

export class DynamicIterate {
  constructor({ property, open, close, conjunction, prepend, sql, children, sourceFile, sourceLine }) {
    this.kind = 'ITERATE';
    this.property = property;
    this.open = open;
    this.close = close;
    this.conjunction = conjunction;
    this.prepend = prepend;
    this.sql = sql;
    /** @type {(DynamicGroup|DynamicCondition|DynamicIterate)[]} */
    this.children = children;
    this.sourceFile = sourceFile;
    this.sourceLine = sourceLine;
  }
}
