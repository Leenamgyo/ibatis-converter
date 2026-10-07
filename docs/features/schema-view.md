# 변환 view + 데이터셋 screen

`src/interfaces/api/public/{schema.js,datasets.js,schema.css}`. This is the UI
on top of [schema-migration.md](schema-migration.md) (`converter/schema`) and
the iBATIS -> MyBatis converter (`converter/mybatis`).

## 변환 — the second view of the selected statement

The left menu has two tabs: **리니지** and **변환**. 변환 follows the shared
tree selection like the lineage view does. It replaced the old "MyBatis 변환"
and "스키마 변환" tabs. The user's ask was to put the column renames first
and make the MyBatis syntax conversion a toggle.

The subject is the **old -> new schema migration** (table and column
renames), using the dataset chosen in the toolbar. The **MyBatis 문법 변환**
switch (`role="switch"`, remembered per browser) decides what the right-hand
side is:

| Switch | Left | Right |
|---|---|---|
| off (default) | original iBATIS | iBATIS with the renames, iBATIS syntax kept (`#x:VARCHAR#`, `<isNotEmpty>`) |
| on | original iBATIS | MyBatis 3 with the renames |

Only the selected statement is shown on the left, never the whole file.
That was the old MyBatis tab's bug.

### How every change is marked

The server sends four texts per statement and per `<sql>` fragment:
`ibatisBefore`, `ibatisAfter`, `mybatisBefore` and `mybatisAfter`. All four
are generated from ASTs (`IbatisXmlGenerator` / `XmlGenerator#generateNode`)
in the same layout, so they line up line by line. Every mark comes from a
token diff between two texts that differ in one kind of change only:

- **Renames.** These are red strike-through on the left and green on the
  right. Left: `ibatisBefore` vs `ibatisAfter`. Right: `mybatisBefore` vs
  `mybatisAfter` (or the iBATIS pair when the switch is off).
- **MyBatis syntax** (switch on). This is violet. Left: `ibatisBefore` vs
  `mybatisBefore`, which is what MyBatis replaced. Right: `ibatisAfter` vs
  `mybatisAfter`, which is what MyBatis introduced.

So a rename is only marked where the converter actually renamed something,
and a syntax change is never shown in rename colours. Rows get a coloured
edge per kind. Rows that are blank on both sides are hidden.

iBATIS and MyBatis lines are paired by `alignLines`: an LCS over a
structural key per line (`lineKey`). Tags map across (isXxx/if,
dynamic/where/set/trim, iterate/foreach), and text compares without
parameters or connectors. Lines only MyBatis has, such as a `<trim>` or an
`AND (` from an `open`, show as right-only violet rows. On 5,128 statements
(fuzz + every sample) every iBATIS line got its partner. Only a node too
large to align (over 6M line pairs) falls back to unpaired panes with
renames only.

### Around the diff

- **Summary cards.** 테이블명 변경, 컬럼명 변경, (switch on) 문법 변환,
  WARNING and MANUAL, from both conversions. Project totals are shown
  underneath.
- **검토 필요.** Every WARNING / MANUAL decision, MANUAL first, each tagged
  with its source: **컬럼명** (schema migration) or **문법** (MyBatis
  conversion, switch on). Labels are in Korean (`SCHEMA_CODE_LABEL`).
- **포함된 `<sql>` fragment.** The same pair view for each included fragment
  that changes.
- **컬럼·테이블명 변경 목록.** One row per distinct rename. Clicking a row
  flashes those green tokens.
- **MyBatis 문법 변환 내역** (switch on). Every syntax decision with its
  grade and location.
- **Scopes.** **이 statement**, or **파일 전체**, which lists every fragment
  and statement of the file as its own collapsible pair view (changed ones
  open). **변경 줄만** keeps two lines of context around each change.
- **Tree badges.** While this view is open, each statement gets `Δn` (green;
  WARNING orange; MANUAL blue; `!` when there is nothing renamed but
  something to review). The lineage view never shows them.
- **No dataset.** The view still works and shows the syntax conversion
  alone. An inline bar offers the sample dataset or the editor. When a demo
  project is loaded, the toolbar offers its matching dataset ("이 프로젝트용 …
  적용").

## 데이터셋 — top-level screen

Header tabs: **분석** | **데이터셋 n**. A dataset is a named mapping,
stored server-side as one JSON file (`data/datasets/<id>.json`, or
`DATASET_DIR`). The screen has:

- **List.** All datasets, newest first. The one the schema view uses is
  marked "사용 중"; a dataset being written is marked "작성 중".
- **Editor.** Name, ID (a slug, fixed once saved) and description, plus a
  JSON textarea with line numbers. Tab indents and ⌘/Ctrl+S saves. Tools:
  포맷 정리, 예시 넣기, JSON 다운로드. Pasting or importing a whole exported
  dataset (`{ name, mapping, ... }`) is also accepted; it is unwrapped.
- **Validation.** A JSON syntax error shows its line and column (the line
  number turns red, and "위치로 이동" jumps there). After that, the
  server's `validateMappingDefinition` lists every error and warning with
  its JSON path. Save goes through the same validator, so the editor and
  the API cannot disagree.
- **Preview.** One card per table, `OLD -> NEW`, with column chips.
- **Actions.** 저장, 저장하고 변환 보기 →, and 삭제 (press twice; no
  browser dialog). Leaving with unsaved edits shows an inline
  "버리고 이동 / 계속 편집" bar.
- **샘플 데이터셋 불러오기.** Loads `public/samples/schema-mapping.json`,
  which maps the Load-sample project's tables, so the demo works end to end.
  The schema view's empty state offers the same thing in one click.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/v1/datasets` | summaries (`tables`, `renamedTables`, `columns`) |
| GET / PUT / DELETE | `/api/v1/datasets/:id` | PUT validates; 400 with `validation` on errors |
| POST | `/api/v1/datasets/validate` | `{ mapping }` -> `{ valid, errors, warnings, summary }` |
| POST | `/api/v1/schema-migration?projectId=` | `{ datasetId \| mapping, preserveResultColumnNames }` -> `statements`, `fragments`, `files` (before/after/events/summary) and `summary` |

Tested in `test/interfaces/schemaMigrationApi.test.js`. Like the rest of
`public/`, the UI itself was verified by hand in Chrome. Steps: Load sample
-> Analyze -> 변환 -> 샘플 데이터셋 적용 -> MyBatis 문법 변환 on/off -> 변경 줄만 /
change-row click / 파일 전체; Load advanced -> the 2000-line statement -> 데이터셋 tab: broken JSON, invalid mapping,
save, switch dataset, delete.
