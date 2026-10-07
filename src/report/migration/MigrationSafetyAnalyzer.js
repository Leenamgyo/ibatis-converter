import { MigrationGrade } from '../../converter/mybatis/ConversionEvent.js';

/**
 * Section 18 — rolls up the `ConversionEvent[]` produced by
 * `converter/mybatis` (plus, optionally, resolver-level errors like
 * missing/circular `<include refid>`, which are ERROR-grade migration
 * blockers even though they're detected before conversion ever runs) into
 * the per-statement `SAFE n / WARNING n / MANUAL n / ERROR n` summary the
 * spec asks for.
 */
export class MigrationSafetyAnalyzer {
  /**
   * @param {{ grade: 'SAFE'|'WARNING'|'MANUAL'|'ERROR' }[]} conversionEvents
   * @returns {{ SAFE: number, WARNING: number, MANUAL: number, ERROR: number }}
   */
  summarize(conversionEvents) {
    const summary = { [MigrationGrade.SAFE]: 0, [MigrationGrade.WARNING]: 0, [MigrationGrade.MANUAL]: 0, [MigrationGrade.ERROR]: 0 };
    for (const event of conversionEvents) {
      summary[event.grade] = (summary[event.grade] ?? 0) + 1;
    }
    return summary;
  }
}
