# Navigation and accessibility

`src/interfaces/api/public/index.html` + `app.js`.

## Two screens; the analysis screen has three views

The header has two top-level tabs (`showScreen()` in `app.js`): **분석**
(the dashboard below) and **데이터셋** (the schema-mapping editor, see
[schema-view.md](schema-view.md)).

The analysis screen has a **tablist at the top of the left menu**:

- **리니지** — the lineage graph (`lineagePane`)
- **변환** — column/table renames, with the MyBatis syntax conversion as a
  toggle (`schemaPane`, see [schema-view.md](schema-view.md))

Both views render whichever statement the **shared left tree** has
selected, so switching view never moves the tree, loses its scroll
position, or clears the selection. `selectLineageStatement()` refreshes
the MyBatis view too when that is the open one.

There is exactly one selected statement in the app. An earlier design gave
the converted side its own screen *and its own statement list*, which
meant every switch threw the selection away and you had to find the same
statement again — that is the problem this layout exists to solve.

`showView()` in `app.js` owns the switch: it flips `aria-selected`, the
roving `tabindex`, the pane `hidden` flags, and hides the graph toolbar
(which is inert over the XML).

## Accessibility

- The view switch is a real `role="tablist"` with `aria-selected`,
  `aria-controls`, roving `tabindex`, and Left/Right/Home/End keys.
- Tree rows are `<button role="treeitem">` with `aria-level`,
  `aria-expanded` and `aria-current`.
- Every interactive control has a `:focus-visible` outline.

## The `[hidden]` cascade trap

A class selector that sets `display` beats the browser's default
`[hidden] { display: none }` — same specificity, author stylesheet wins.
Anything hideable therefore needs its own `[hidden]` rule:

```css
.screen[hidden]        { display: none; }
.view-pane[hidden]     { display: none; }
.dash-toolbar[hidden]  { display: none; }
```

This has bitten three times: two screens rendering at once, and the graph
toolbar floating over the MyBatis view. If something refuses to hide,
check this first.

## Recovering from a dead project

Projects are server sessions (see large-projects.md). A session closes
after 30 idle minutes, and a server restart loses all of them, so the
`projectId` the page holds can die. When opening a statement gets a 404,
`selectLineageStatement()` reacts by how the project was opened:

- **Opened by path:** it reopens the folder in place (`reopenProject()`)
  and retries once.
- **Uploaded:** it says the project was closed and has to be opened again,
  because the browser deliberately keeps no copy of uploaded files.

## A tab older than the code

A tab left open across an update keeps running the old script. That is
how the old folder picker's "시스템 파일이 포함되어 있으므로 … 열 수 없습니다"
kept appearing after it was replaced. `GET /api/v1/version` returns the
newest mtime of `public/*.{js,css,html}`, uncached. The page reads it on
load and again on focus / visibility. When it differs, a bar says
"화면이 업데이트되었습니다" with a **새로고침** button.

## Removed screens

The **Statements** and **Tables** tabs were removed, and every mermaid
diagram with them; the UI loads no diagram library at all. Their API
endpoints (`/statements/:id`, `/statements/:id/dependencies`,
`/tables/:name`) are untouched and still tested, so bringing either screen
back is UI work, not analysis work. See `../SPEC_MAPPING.md` sections
24–25.
