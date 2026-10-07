# Analysis coverage

What the analyzer actually resolves, verified by running it — not by
reading the code. Section-by-section spec status is in
[../SPEC_MAPPING.md](../SPEC_MAPPING.md); this file is the shapes.

## Handled

| Shape | Result |
|---|---|
| Subquery in the SELECT list | its own scope, wired to the output column that names it |
| Derived table in `FROM` | its own scope, drawn as a table in the FROM column |
| Derived table joined | same, and it feeds the JOIN table like any other table |
| Subquery in `WHERE` / `HAVING` | its own scope, wired to that condition |
| Three-level nesting | each level a scope, parent/child kept |
| Dynamic `JOIN` inside `<isNotNull>` | the join happens, the tag hangs under the table it brings in |
| Dynamic inside a subquery | resolved at the subquery's own depth |
| Dynamic `UNION` branch | the branch appears inside the UNION box |
| `<iterate>` IN list | a dynamic object of its own |
| `include refid`, cross-mapper and nested | expanded to the fragment's SQL; circular references are a diagnostic |
| `resultMap extends` chains | flattened, with the chain shown in the JAVA 매핑 panel |

## The one shape it cannot do

**Two mutually exclusive branches supplying the same FROM table.**

```xml
<isEqual property="archived" compareValue="Y">FROM ARCHIVED_ORDERS O</isEqual>
<isNotEqual property="archived" compareValue="Y">FROM ORDERS O</isNotEqual>
```

`SqlFlattener` keeps every branch — that is what makes dynamic SQL
analyzable at all — so this flattens to `FROM ARCHIVED_ORDERS O ORDERS O`,
which is not parseable SQL. The statement gets a `SQL_PARSE_FAILED`
diagnostic and the graph says so instead of drawing something invented.

This is deliberately **not** "fixed" by picking a branch. Guessing which
FROM a runtime would take is how a migration tool silently produces a
mapper that reads the wrong table. Handling it properly means flattening
into one variant *per branch combination* and analyzing each — a real
feature, not a patch.

`test/integration/complexFixtures.test.js` pins the only statement in the
fixtures with this shape:

```js
parseFailedIds === ['advancedSearch.fullConditionMatrix']
```

so a regression that starts guessing shows up as a failing test.

## Attribution limits

- A column's source is attributed only when the expression reads exactly
  one column. `A.X + B.Y` is left unattributed rather than credited to
  whichever table happened to come first.
- The left side of a join is read off the ON clause — the alias that is
  not the table being joined in — falling back to the driving table when
  the ON clause names nothing recognisable.
