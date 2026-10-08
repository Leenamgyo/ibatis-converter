# SQL Lineage graph

`src/interfaces/api/public/lineage.js` (drawing) + `src/analyzer/lineage`
(the model it draws). Nested DOM for containment, one measured SVG layer
for edges — no diagram library.

## The unit is the table object

**Every box is a table object**, and its inside is that table's own
clauses:

```
┌ TABLE  CUSTOMER (C) ────────────┐
│ FROM    CUSTOMER C              │
│ WHERE   [ WHERE C.STATUS = ? ]  │
│ SELECT  [CUSTOMER_ID] [NAME]    │
└─────────────────────────────────┘
```

The only things allowed inside a box are its clauses — condition objects,
dynamic tags, columns. **Never another table**, and **never a join**: a
join is not a property of a table.

A SELECT scope is **not a box** — it is a *lane*: a header chip
(`SELECT · MAIN 쿼리`, `SELECT · S1 · Inline View`) with the table objects
laid out under it and no outline of its own. An outline there is what
makes one box look like it holds several tables.

## The four rules

**1 — The unit is the table object.** Table A and table B are two objects,
each with its own FROM / SELECT. Never one box holding both.

**2 — A join is a line, and a join only ever makes another table.** The
result is a table object like any other, `JOIN 테이블` —

```
[ TABLE PRODUCT (P) ]  ──┐        ┌ TABLE  JOIN 테이블 ─────────┐
                         ├───────▶│ FROM    PRODUCT P           │
[ TABLE CATEGORY (CAT) ] ─┘       │         RIGHT JOIN CATEGORY │
                                  │ WHERE   [ ... ]             │
                                  │ SELECT  [PRODUCT_ID] [...]  │
                                  └─────────────────────────────┘
```

The join type lives in the JOIN table's own `FROM`, because that is whose
property it is. A source table box carries no join chip at all. An n-way
join is n objects feeding one JOIN table. The ON clause stays out of every
box — the right panel's 조인 관계 table has it.

A scope's WHERE / GROUP BY / HAVING / SELECT belong to the table that
scope *produces*: the JOIN table when there are joins, otherwise the
single source table object itself (one source and no join means one box,
not two).

**3 — Every WHERE condition is its own object, and the dynamic tag that
guards it is another object one depth below it**, indented under it, in
the WHERE section of the table object that owns the condition. A guard
whose body is a JOIN belongs to the join, so it hangs under that join line
in the JOIN table's FROM — never in a source table, and never in WHERE.

Terms are split on top-level `AND`/`OR`, with parentheses, string literals
and `#binding#` / `$substitution$` tokens respected. A guard is matched to
its term by normalising `#prop#` / `$prop$` to `?` and comparing against
the flattened SQL. A tag that guards something other than a WHERE term —
an `<iterate>` feeding an IN list — still renders as a dynamic object of
its own, so nothing is silently dropped.

**4 — A subquery is never drawn inside the query that reads it.** Every
subquery scope becomes a lane of its own **outside** the parent, drawn
after it, and a line runs from there back *into* the exact thing that
reads it:

| Where the subquery sits | Wired into |
|---|---|
| `FROM` / `JOIN` (inline view) | a dashed **slot** table object in the parent lane, which then feeds the JOIN table like any other table |
| SELECT list (scalar) | the output column that names it |
| `WHERE` | that specific condition object |
| `HAVING` | the HAVING box |

Nesting is expressed by the lines, not by boxes inside boxes — a
three-level query is three lanes, each wired to the one above it.
`renderGraph()` does this by queueing children while a scope is built
(`lineageState.scopeQueue`) and draining the queue at top level.

## Where the lanes go

`placeLanes()` positions the lanes absolutely after they are built; there is
no layout library.

- A subquery lane sits in the **column to the right of the query that reads
  it**: depth 1 one column right of MAIN, depth 2 one more. Each line
  between lanes is then one short step sideways.
- A column is as wide as its widest lane.
- The children of one lane are stacked **in the order of what they point at
  inside it**, top to bottom. Each child starts level with its target,
  below its previous sibling, so the lines never cross.
- Roots (MAIN, a UNION group, a write statement) stack top to bottom in
  column 0.

The graph therefore grows sideways, which suits a landscape screen, instead
of piling up into one column that only fits at 25%.

Inside a lane the browser still lays out the boxes (flex), as before.

Inside the result table:
- When a result has more than 3 WHERE objects or more than 6 columns, its
  table object is `wide`. The conditions (each with its guard under it)
  then form a grid of cards, not one tall column.
- The SELECT columns are always chips that wrap.

## UNION

A UNION is **one box around its branches** (`UNION ALL · 3개 브랜치가 하나의
결과로`), not sibling clusters tied together by reference arrows.

## Arrows are for relationships between objects

Nothing inside an object is drawn with an arrow. The clause columns say
what the object contains; a line would only restate it. Only two kinds
of edge exist:

- table → JOIN table, for a join (rule 2)
- subquery lane → the slot / condition / column / HAVING that reads it (rule 4)

**Where a line ends.** A line never runs under a box to reach something
inside it. It ends at the **border of the table object holding its
target**, level with the target:
- a join line: at its own FROM row of the JOIN 테이블 (`edge(..., { toAnchor })`);
- a subquery line: at the condition, column or HAVING it feeds.

So five joins arrive as five arrows at five FROM rows, not one bundle at
the box's middle.

**Routing.** Boxes side by side get one S-curve between their facing sides.
If another table object sits between them, the line goes round it as an
orthogonal path with rounded corners. It goes over or under the box,
whichever is the shorter detour (`drawEdges`). Stacked boxes get a
vertical curve. A line the user bent keeps its bend.

There is no refid box or edge: the graph is drawn from the statement **with
its refids spliced in** (see [lineage-dashboard.md](lineage-dashboard.md),
"refid: the inlined statement"), so a fragment's SQL is simply part of the
query it lands in.

## Edge layering — the trap

Edges must paint **above the cluster background but below the node
boxes**:

- `.graph-edges` → `z-index: 1`
- `.gnode`, `.cluster-head`, `.col-head` → `z-index: 2`
- the cluster background stays unpositioned, below both

`.graph-nodes` must keep `z-index: auto`. Give it one and it becomes a
stacking context, trapping every node under the edges again — and because
`.graph-nodes` is a positioned sibling that comes *after* `.graph-edges`
in the DOM, the cluster's opaque background otherwise buries every
intra-cluster line.

Edges carry a `marker-end` arrowhead; SVG markers do not inherit `stroke`,
so there is one marker per edge colour (flow / join / ref).

## Labels never ride on connectors

A label pinned to a line's midpoint lands on top of whatever box the line
happens to cross. Anything that needs naming goes on a node instead — the
join chip on the joined table, the guard as its own object.

## Known limits

- Obstacle avoidance looks at table objects only, and at one detour (over
  or under). Two lines can still share a stretch, and a heavily rearranged
  graph can still cross a box.
- Columns cap at 12 entries and then show "+N more"; there is no
  drill-down for the remainder.
- `LineageAnalyzer` attributes a column's source only when the expression
  reads exactly one column; multi-source expressions (`A.X + B.Y`) are
  left unattributed rather than guessed.
