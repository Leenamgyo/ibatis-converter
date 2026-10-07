/**
 * Checks a mapping *definition* — the JSON a person types into the dataset
 * editor — before it becomes a MigrationMapping. MigrationMapping itself
 * only throws on the first malformed entry; an editor needs every problem
 * at once, each with the path it is at, plus a summary of what parsed.
 *
 *   errors   — the mapping can't be used as is
 *   warnings — it can, but probably isn't what was meant
 *
 * Expected shape:
 *   { "<LEGACY_TABLE or SCHEMA.TABLE>": { "targetTable": "<NEW>", "columns": { "<OLD>": "<NEW>" } } }
 */

const IDENTIFIER = /^[A-Za-z_À-￿][A-Za-z0-9_$#À-￿]*(\.[A-Za-z_À-￿][A-Za-z0-9_$#À-￿]*)?$/;
const KNOWN_KEYS = new Set(['targetTable', 'columns']);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {unknown} definition parsed JSON
 * @returns {{ valid: boolean, errors: {path:string,message:string}[], warnings: {path:string,message:string}[],
 *             summary: { tables: number, renamedTables: number, columns: number } }}
 */
export function validateMappingDefinition(definition) {
  const errors = [];
  const warnings = [];
  const summary = { tables: 0, renamedTables: 0, columns: 0 };
  const error = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });

  if (!isPlainObject(definition)) {
    error('$', '매핑은 JSON 객체여야 합니다: { "레거시테이블": { "targetTable": "신규테이블", "columns": { ... } } }');
    return { valid: false, errors, warnings, summary };
  }

  const seenTables = new Map();
  for (const [table, entry] of Object.entries(definition)) {
    const path = `$["${table}"]`;
    if (!IDENTIFIER.test(table)) error(path, `"${table}"은(는) 테이블 이름이 아닙니다 (TABLE 또는 SCHEMA.TABLE)`);
    const upper = table.toUpperCase();
    if (seenTables.has(upper)) error(path, `"${table}"이(가) "${seenTables.get(upper)}"와 중복됩니다 (테이블명은 대소문자 구분 없음)`);
    seenTables.set(upper, table);

    if (!isPlainObject(entry)) {
      error(path, '"targetTable" 또는 "columns"를 가진 객체여야 합니다');
      continue;
    }
    summary.tables++;
    for (const key of Object.keys(entry)) {
      if (!KNOWN_KEYS.has(key)) warn(`${path}.${key}`, `알 수 없는 키 "${key}"는 무시됩니다 (targetTable / columns만 사용)`);
    }

    const { targetTable, columns } = entry;
    if (targetTable !== undefined && targetTable !== null) {
      if (typeof targetTable !== 'string' || !IDENTIFIER.test(targetTable)) {
        error(`${path}.targetTable`, '테이블 이름 문자열이어야 합니다 (TABLE 또는 SCHEMA.TABLE)');
      } else if (targetTable.toUpperCase() !== upper) {
        summary.renamedTables++;
      }
    }

    if (columns === undefined || columns === null) {
      if (targetTable === undefined || targetTable === null) warn(path, 'targetTable도 columns도 없어서 아무것도 바꾸지 않습니다');
      continue;
    }
    if (!isPlainObject(columns)) {
      error(`${path}.columns`, '{ "레거시컬럼": "신규컬럼" } 형태의 객체여야 합니다');
      continue;
    }
    const seenColumns = new Map();
    const targets = new Map();
    for (const [from, to] of Object.entries(columns)) {
      const columnPath = `${path}.columns["${from}"]`;
      if (!IDENTIFIER.test(from) || from.includes('.')) error(columnPath, `"${from}"은(는) 컬럼 이름이 아닙니다`);
      const fromUpper = from.toUpperCase();
      if (seenColumns.has(fromUpper)) error(columnPath, `"${from}"이(가) "${seenColumns.get(fromUpper)}"와 중복됩니다 (컬럼명은 대소문자 구분 없음)`);
      seenColumns.set(fromUpper, from);
      if (typeof to !== 'string' || !IDENTIFIER.test(to) || to.includes('.')) {
        error(columnPath, '신규 이름은 컬럼 이름 문자열이어야 합니다');
        continue;
      }
      summary.columns++;
      const toUpper = to.toUpperCase();
      if (targets.has(toUpper)) warn(columnPath, `"${from}"과(와) "${targets.get(toUpper)}"이(가) 모두 "${to}"(으)로 바뀝니다`);
      targets.set(toUpper, from);
      if (toUpper === fromUpper) warn(columnPath, `"${from}"이(가) 자기 자신으로 매핑됩니다`);
    }
  }
  if (!summary.tables) warn('$', '매핑이 비어 있습니다');
  return { valid: errors.length === 0, errors, warnings, summary };
}
