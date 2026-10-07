/**
 * iBATIS 2.x inline parameter syntax.
 *
 * A `#...#` token is not always a bare property name: iBATIS also accepts
 * `#property:jdbcType#` and `#property:jdbcType:nullValue#` (the same
 * three fields a `<parameterMap>` entry carries, written inline). Legacy
 * mappers use the two-part form constantly, usually to pin a NULL's type
 * for the driver.
 *
 * Treating the whole token as the property name is silently wrong in two
 * places at once — the parameter is reported under the name
 * `"customerId:NUMERIC"`, and the converter emits
 * `#{customerId:NUMERIC}`, which is not valid MyBatis and only fails at
 * runtime. So the token is parsed once, here, and both
 * `analyzer/parameter` and `converter/mybatis` read the same three fields
 * off it.
 *
 * `$...$` substitution tokens have no such syntax and are never parsed
 * this way.
 *
 * @param {string} expression the text between the `#` delimiters
 * @returns {{ property: string, jdbcType: string|null, nullValue: string|null }}
 */
export function parseInlineParameter(expression) {
  const text = String(expression);
  const [property, jdbcType, ...rest] = text.split(':');
  return {
    property: property.trim(),
    jdbcType: jdbcType === undefined || jdbcType.trim() === '' ? null : jdbcType.trim(),
    // A nullValue may itself contain a colon (a formatted date default,
    // say), so everything after the second colon is kept verbatim.
    nullValue: rest.length ? rest.join(':').trim() : null,
  };
}
