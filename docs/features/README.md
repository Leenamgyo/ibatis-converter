# Features

One file per feature: what it does, the rules it follows, and the traps
worth not rediscovering. These describe the *current* behaviour — when a
feature changes, edit its file rather than appending to it.

| File | Feature |
|---|---|
| [lineage-graph.md](lineage-graph.md) | The SQL Lineage graph: what an object is, and the four rules the drawing follows |
| [lineage-dashboard.md](lineage-dashboard.md) | The dashboard around the graph — stat strip, XML tree, side panels, minimap, zoom |
| [navigation.md](navigation.md) | One screen, two views, the left-menu view switch, and accessibility |
| [sample-project.md](sample-project.md) | The "Load sample" project as the scenario matrix, and the SELECT-only rule |
| [analysis-coverage.md](analysis-coverage.md) | What the analyzer handles and the one shape it can't |
| [dev-loop.md](dev-loop.md) | `npm run dev`, watch paths, and why the UI is excluded |
| [schema-view.md](schema-view.md) | The 변환 view (column renames first, MyBatis syntax as a toggle, every change marked) and the 데이터셋 JSON editor |
| [refid-resolution.md](refid-resolution.md) | How refids are found: the project-wide metadata, the one lookup rule every component uses, and what was inaccurate before |
| [column-removal-guide.md](column-removal-guide.md) | 컬럼 삭제 가이드: trace one output column and list every place to edit (refid / resultMap included), without editing |
| [mybatis-input.md](mybatis-input.md) | MyBatis 3 `<mapper>` files read as input: parsed, analysed, schema-migrated (no syntax conversion) |
| [large-projects.md](large-projects.md) | Index first, load on demand: `ProjectSession`, sessions on the server, what the browser keeps, measurements |
| [schema-migration.md](schema-migration.md) | Old -> new table/column renames in mapper SQL (`converter/schema`), its grading and limits |

Backend architecture and the spec-section status live in
[../ARCHITECTURE.md](../ARCHITECTURE.md) and
[../SPEC_MAPPING.md](../SPEC_MAPPING.md); test layout and fixtures in
[../TESTING.md](../TESTING.md).
