# Lineage dashboard

The screen around the graph. `lineage.js` + `dashboard.css`. Everything
here reads the **original** mapper — nothing from the conversion appears
on this screen (see [schema-view.md](schema-view.md)).

Purpose: make a 3,000–5,000 line legacy mapper readable as a picture, with
the subquery hierarchy explicit rather than inferred from indentation.

## Layout

```
┌──────────────────────── stat strip ────────────────────────┐
│ XML 라인 수 · SELECT 구문 · INCLUDE/REFID · 테이블 ·        │
│ 조인 · 서브쿼리 · UNION · 분석 상태                          │
├───────────┬────────────────────────────────┬───────────────┤
│ view      │  breadcrumb + graph controls   │  SELECT 컬럼   │
│ switch    │                                │  매핑          │
│ ───────── │                                │  JAVA 매핑     │
│ XML 구조  │        lineage graph           │  조인 관계     │
│ (tree)    │                                │  서브쿼리/UNION│
│ + 검색    │                                │  선택한 노드   │
│ ───────── │                                │  미니맵        │
│ Include   │                                │               │
│ 사용 현황 │                                │               │
└───────────┴────────────────────────────────┴───────────────┘
```

## Left — XML tree

The mapper files as a tree: file → statement kind → statement, with a
per-file line count and a per-kind count. Rows are real `<button>`s with
`role="treeitem"`, `aria-level`, `aria-expanded` and `aria-current`.
Selecting a row is what drives the whole screen.

The search box highlights matching rows and graph nodes (statement, refid,
table and alias names) rather than filtering them out, so you keep your
place in the tree.

Below the tree, **Include 사용 현황** lists each `<sql>` fragment with how
many statements pull it in — the fastest way to see which fragment a
change would blast-radius into.

## Centre — graph controls

`전체 펼치기` / `서브쿼리 접기` expand or collapse every nested cluster;
`−` / `＋` / `전체 보기` zoom, with the current scale shown between them.
A new statement starts on "fit", because a wide statement at 100% is
cropped and looks broken until you find the zoom control. The viewport
pans by dragging.

The breadcrumb shows where a clicked node sits (`MAIN → S1 → TABLE`).

## Moving boxes and saving the arrangement

- **What moves.** Drag a **table object** to move it. A drag that starts on
  one of its condition / column chips moves the whole table: a box's own
  clauses never leave it. Drag a **lane** (SELECT scope, the refid group,
  a UNION group) by its header to move it with everything in it. A move
  under 4px is still a click (select / highlight). Dragging the empty
  background still pans.
- **How.** The browser keeps laying the graph out. A drag only adds an
  offset to that element (CSS `translate`, keyed `node:<id>` or
  `cluster:<selectId>`), so containment, the minimap and the edges keep
  working. Edges are re-measured live while dragging.
  - Edge sides are chosen from where the boxes now are: right/left,
    below/above, or by centres when they overlap. A box dragged above or
    left of its target still gets a clean line.
- **Edges.** Each line has a 12px invisible grab area (its own `<g
  class="edge-hits">`, so the highlight code's `#lineageEdges > path` never
  touches it).
  - **Drag** a line to bend it: both control points shift, scaled 4/3 so
    the curve's middle follows the mouse. The bend is stored like a box
    offset, keyed `edge:<kind>:<from>><to>`.
  - **Click** a line to highlight it and outline its two boxes; click again
    or click the background to clear.
  - **Double-click** a line to straighten it.
  - Dragging a line never pans.
- **Saving.** **배치 저장** (or Ctrl/⌘+S in this view) stores the offsets and
  the current zoom/pan for that statement on the server (`LayoutStore`,
  `data/layouts/` or `LAYOUT_DIR`; `GET/PUT/DELETE /api/v1/layouts/:id`).
  - Files are named by a hash of the statement id. A layout saved for a
    same-named statement in another file is ignored.
  - Reopening the statement restores the boxes and the saved view instead
    of fitting.
  - The status next to the buttons says `이동 n개 · 저장 안 됨` or
    `배치 저장됨`.
- **Unsaved moves** are kept per statement while the page is open, so
  switching statements never drops them silently. They are lost on reload.
- **배치 초기화** puts everything back. Saving after that deletes the saved
  layout (an empty layout is not stored).
- Only offsets are saved, never absolute positions. After the mapper
  changes, boxes that still exist keep their nudge and new ones sit where
  the browser puts them.

## Right — panels

| Panel | What it answers |
|---|---|
| SELECT 컬럼 매핑 | For each output column: the SQL expression, its alias, and the source table/column it resolves to |
| JAVA 매핑 | The resultMap class and each `property ← COLUMN` binding, or the `resultClass` when there is no resultMap |
| 조인 관계 | Every join: which scope, type, table, and ON clause (this is where the ON text lives, not on the graph) |
| 서브쿼리 / UNION 요약 | Each nested scope: id, kind, depth, tables |
| 선택한 노드 | Detail for whatever was last clicked in the graph |
| 미니맵 | The whole graph at a glance, for statements past one screen |

Clicking a column row lights that column's whole path across the graph
(`ORDERS.ORDER_DATE → S1.LAST_ORDER_DATE → MAIN.lastOrderDate`).

## Redraw timing

Edges are measured from laid-out boxes, so they can only be drawn once the
pane is actually visible — `redrawEdgesWhenVisible()` retries until the
layout settles. The same applies to the initial fit. Anything that changes
node geometry must redraw edges afterwards.

## Known limits

- The minimap re-measures every visible node on redraw; a genuinely huge
  statement will want caching.
- A statement whose SQL failed to flatten (`SQL_PARSE_FAILED`) has no
  lineage to draw and says so instead of rendering an empty graph.
