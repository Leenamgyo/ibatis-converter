#!/usr/bin/env node
/**
 * Command-line migration of a whole project folder:
 *
 *   npm run migrate -- <projectDir> [--out <dir>] [--mapping <mapping.json>]
 *                      [--preserve-result-columns] [--dialect mysql|oracle|...]
 *                      [--fail-on manual|warning]
 *
 * Finds every iBATIS mapper under <projectDir> (by root element, skipping
 * build output and non-mapper XML, decoding EUC-KR/MS949 when declared),
 * converts it file by file (see ProjectSession), and writes into <out> (default ./migration-output):
 *
 *   mybatis/<same relative path>          converted MyBatis 3 mappers
 *   mybatis-schema/<same relative path>   + old -> new table/column renames (with --mapping)
 *   report.md                             what a human has to look at, per file
 *   report.json                           everything, machine-readable
 *
 * The source tree is never written to.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ProjectSession, DirectorySource } from '../../application/ProjectSession.js';
import { XmlGenerator } from '../../generator/xml/XmlGenerator.js';
import { validateMappingDefinition } from '../../converter/schema/index.js';

const USAGE = `사용법: npm run migrate -- <프로젝트폴더> [옵션]

  --out <dir>                 결과 폴더 (기본 ./migration-output)
  --mapping <file.json>       레거시 -> 신규 스키마 매핑 (데이터셋 JSON 그대로)
  --preserve-result-columns   이름이 바뀐 SELECT 항목에 "AS 기존이름" 유지
  --dialect <name>            SQL 분석 방언 (기본 mysql)
  --fail-on manual|warning    해당 등급이 하나라도 있으면 종료 코드 2 (CI용)
  -h, --help`;

export function parseArgs(argv) {
  const options = { out: 'migration-output', mapping: null, preserveResultColumnNames: false, dialect: 'mysql', failOn: null, help: false, root: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} 다음에 값이 필요합니다`);
      return v;
    };
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--out') options.out = value();
    else if (arg === '--mapping') options.mapping = value();
    else if (arg === '--preserve-result-columns') options.preserveResultColumnNames = true;
    else if (arg === '--dialect') options.dialect = value();
    else if (arg === '--fail-on') {
      options.failOn = value().toUpperCase();
      if (!['MANUAL', 'WARNING'].includes(options.failOn)) throw new Error('--fail-on 은 manual 또는 warning');
    } else if (arg.startsWith('-')) throw new Error(`알 수 없는 옵션: ${arg}`);
    else if (!options.root) options.root = arg;
    else throw new Error(`프로젝트 폴더는 하나만: ${arg}`);
  }
  return options;
}

/** Writes `text` to out/<relative>, refusing anything that would land outside `out`. */
function writeInside(outDir, relative, text) {
  const target = path.resolve(outDir, relative);
  if (target !== outDir && !target.startsWith(outDir + path.sep)) throw new Error(`refusing to write outside ${outDir}: ${relative}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

/**
 * Runs the migration. Returns the report object (also written to disk).
 * @param {ReturnType<typeof parseArgs>} options
 */
export function migrateProject(options, log = () => {}) {
  const root = path.resolve(options.root);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`폴더가 아닙니다: ${root}`);
  const outDir = path.resolve(options.out);
  if (outDir === root) throw new Error('--out 은 프로젝트 폴더와 달라야 합니다');

  let mapping = null;
  if (options.mapping) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(options.mapping), 'utf8'));
    // a dataset exported from the UI ({ name, mapping, ... }) works as is
    mapping = raw && typeof raw === 'object' && raw.mapping && typeof raw.mapping === 'object' && !raw.targetTable ? raw.mapping : raw;
    const validation = validateMappingDefinition(mapping);
    if (!validation.valid) {
      throw new Error(`매핑이 올바르지 않습니다:\n${validation.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
    }
  }

  // A session indexes the project, then each file is converted and written in turn: only the
  // files one step needs are in memory (bounded caches), whatever the project's size.
  // Includer context for fragments is not sampled here (schemaSiteFiles: Infinity), so the
  // output is the same as migrating every mapper at once.
  const session = new ProjectSession(new DirectorySource(root), { dialect: options.dialect, schemaSiteFiles: Infinity }).open();
  try {
    log(`매퍼 ${session.files.length}개 발견 (XML ${session.files.length + session.skipped.length}개 중, 나머지는 건너뜀)`);
    fs.mkdirSync(outDir, { recursive: true });
    const schemaOptions = { preserveResultColumnNames: options.preserveResultColumnNames };
    const xml = new XmlGenerator();
    const files = session.files.map((entry) => {
      const { sourceFile } = entry;
      if (!entry.parsed) return fileReport(session, entry, [], null);
      const conversion = session.convertFile(sourceFile);
      writeInside(outDir, path.join('mybatis', sourceFile), conversion.xml);
      const conversionEvents = [...conversion.statements].flatMap(([id, c]) => c.events.map((e) => ({ ...e, statementId: id })));
      let schemaEvents = null;
      if (mapping) {
        const own = session.migrateForFile(sourceFile, mapping, schemaOptions).results.get(sourceFile).mybatis;
        writeInside(outDir, path.join('mybatis-schema', sourceFile), xml.generate(own.mapper));
        schemaEvents = own.events;
      }
      return fileReport(session, entry, conversionEvents, schemaEvents);
    });
    const report = buildReport(root, outDir, session, files, mapping);
    writeInside(outDir, 'report.json', `${JSON.stringify(report, null, 2)}\n`);
    writeInside(outDir, 'report.md', renderMarkdown(report));
    return report;
  } finally {
    session.close();
  }
}

function tally(events) {
  const t = { SAFE: 0, WARNING: 0, MANUAL: 0, ERROR: 0 };
  for (const e of events) t[e.grade] = (t[e.grade] ?? 0) + 1;
  return t;
}

/** one file's report row: kept for the report, everything else about the file is dropped */
function fileReport(session, entry, conversion, schemaEvents) {
  const { sourceFile, namespace } = entry;
  // schema events name the statement by its local id; report every id namespace-qualified
  const qualify = (id) => (namespace && id && !id.includes('.') ? `${namespace}.${id}` : id);
  const schema = (schemaEvents ?? []).map(({ tokenIndex, ...e }) => ({ ...e, statementId: qualify(e.statementId) }));
  const review = [
    ...conversion.filter((e) => e.grade !== 'SAFE').map((e) => ({ source: '문법', statementId: e.statementId, grade: e.grade, code: e.code, message: e.message, line: e.sourceLine })),
    ...schema.filter((e) => e.grade !== 'SAFE').map((e) => ({ source: '컬럼명', statementId: e.statementId, grade: e.grade, code: e.code, message: e.message })),
  ];
  const diagnostics = [...session.diagnostics.errors, ...session.diagnostics.warnings]
    .filter((d) => d.sourceFile === sourceFile)
    .map((d) => ({ severity: d.severity, code: d.code, line: d.sourceLine, message: d.message }));
  return {
    sourceFile,
    encoding: entry.encoding,
    namespace,
    statements: entry.statements.length,
    conversion: tally(conversion),
    schema: schemaEvents ? {
      ...tally(schema),
      tables: schema.filter((e) => e.code === 'TABLE_RENAMED').length,
      columns: schema.filter((e) => e.code === 'COLUMN_RENAMED' || e.code === 'COLUMN_ASSUMED').length,
    } : null,
    diagnostics,
    review,
  };
}

function buildReport(root, outDir, session, files, mapping) {
  const sum = (pick) => files.reduce((n, f) => n + pick(f), 0);
  return {
    project: root,
    output: outDir,
    generatedAt: new Date().toISOString(),
    totals: {
      mappers: files.length,
      statements: sum((f) => f.statements),
      skippedXml: session.skipped.length,
      errors: sum((f) => f.diagnostics.filter((d) => d.severity === 'ERROR').length),
      WARNING: sum((f) => f.review.filter((r) => r.grade === 'WARNING').length),
      MANUAL: sum((f) => f.review.filter((r) => r.grade === 'MANUAL' || r.grade === 'ERROR').length),
      ...(mapping ? { tables: sum((f) => f.schema.tables), columns: sum((f) => f.schema.columns) } : {}),
    },
    files,
    skipped: session.skipped,
  };
}

function renderMarkdown(report) {
  const t = report.totals;
  const lines = [
    '# iBATIS → MyBatis 마이그레이션 리포트',
    '',
    `- 프로젝트: \`${report.project}\``,
    `- 생성: ${report.generatedAt}`,
    `- 매퍼 ${t.mappers}개 · statement ${t.statements}개 · 건너뛴 XML ${t.skippedXml}개`,
    `- 검토 필요: **MANUAL ${t.MANUAL}** · WARNING ${t.WARNING} · 파싱/참조 오류 ${t.errors}`,
    ...(t.tables !== undefined ? [`- 스키마 변환: 테이블 ${t.tables}건 · 컬럼 ${t.columns}건`] : []),
    '',
    '결과: `mybatis/` (문법 변환)' + (t.tables !== undefined ? ', `mybatis-schema/` (문법 + 컬럼·테이블명 변환)' : '') + ', `report.json`',
    '',
    '## 파일별',
    '',
    '| 파일 | statement | MANUAL | WARNING | 오류 |' + (t.tables !== undefined ? ' 테이블 | 컬럼 |' : ''),
    '|---|---|---|---|---|' + (t.tables !== undefined ? '---|---|' : ''),
    ...report.files.map((f) => `| ${f.sourceFile}${f.encoding && f.encoding !== 'utf-8' ? ` (${f.encoding})` : ''} | ${f.statements} | ${f.review.filter((r) => r.grade !== 'WARNING').length} | ${f.review.filter((r) => r.grade === 'WARNING').length} | ${f.diagnostics.filter((d) => d.severity === 'ERROR').length} |${f.schema ? ` ${f.schema.tables} | ${f.schema.columns} |` : ''}`),
    '',
  ];
  const needsLook = report.files.filter((f) => f.review.length || f.diagnostics.length);
  if (needsLook.length) {
    lines.push('## 검토 필요', '');
    for (const f of needsLook) {
      lines.push(`### ${f.sourceFile}`, '');
      for (const d of f.diagnostics) lines.push(`- **${d.severity}** \`${d.code}\`${d.line ? ` (line ${d.line})` : ''}: ${d.message}`);
      const order = { ERROR: 0, MANUAL: 0, WARNING: 1 };
      for (const r of [...f.review].sort((a, b) => order[a.grade] - order[b.grade])) {
        lines.push(`- **${r.grade}** [${r.source}] \`${r.statementId ?? ''}\` ${r.code}: ${r.message}`);
      }
      lines.push('');
    }
  }
  if (report.skipped.length) {
    lines.push('## 건너뛴 XML', '', ...report.skipped.map((s) => `- ${s.sourceFile} — ${s.reason}`), '');
  }
  return `${lines.join('\n')}\n`;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (e) {
    console.error(`${e.message}\n\n${USAGE}`);
    return 1;
  }
  if (options.help || !options.root) {
    console.log(USAGE);
    return options.help ? 0 : 1;
  }
  try {
    const report = migrateProject(options, (msg) => console.log(msg));
    const t = report.totals;
    console.log(`statement ${t.statements}개 변환 · MANUAL ${t.MANUAL} · WARNING ${t.WARNING} · 오류 ${t.errors}${t.tables !== undefined ? ` · 테이블 ${t.tables}건 · 컬럼 ${t.columns}건 변경` : ''}`);
    console.log(`결과: ${report.output} (report.md 부터 보세요)`);
    if (options.failOn === 'MANUAL' && (t.MANUAL || t.errors)) return 2;
    if (options.failOn === 'WARNING' && (t.MANUAL || t.WARNING || t.errors)) return 2;
    return 0;
  } catch (e) {
    console.error(e.message);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) process.exitCode = main(process.argv.slice(2));
