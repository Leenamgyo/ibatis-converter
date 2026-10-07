export const ParameterBindingType = Object.freeze({
  HASH: 'HASH', // #prop#
  DOLLAR: 'DOLLAR', // $prop$
});

export const ParameterUsedIn = Object.freeze({
  SELECT: 'SELECT',
  WHERE: 'WHERE',
  JOIN: 'JOIN',
  ORDER_BY: 'ORDER_BY',
  GROUP_BY: 'GROUP_BY',
  HAVING: 'HAVING',
  INSERT_VALUE: 'INSERT_VALUE',
  UPDATE_SET: 'UPDATE_SET',
  OTHER: 'OTHER',
});

/** One `#prop#` / `$prop$` (or `#ids[]#` iterate item) usage found in a statement. */
export class ParameterUsage {
  constructor({
    name,
    expression,
    bindingType,
    usedIn,
    jdbcType = null,
    nullValue = null,
    dynamicCondition = null,
    sourceFragment = null,
    sourceFile = null,
    sourceLine = null,
  }) {
    this.name = name;
    this.expression = expression;
    this.bindingType = bindingType;
    this.usedIn = usedIn;
    /** From the inline `#property:jdbcType[:nullValue]#` form, or null. */
    this.jdbcType = jdbcType;
    this.nullValue = nullValue;
    /** Nearest enclosing standardized condition, or null: `{ property, operator, compareValue, prepend }`. */
    this.dynamicCondition = dynamicCondition;
    this.sourceFragment = sourceFragment;
    this.sourceFile = sourceFile;
    this.sourceLine = sourceLine;
  }
}
