# Dev loop

```
npm start        # serve on :4000
npm run dev      # same, restarting on backend changes
npm test         # the whole suite (bare `node --test`)
npm run test:watch
```

## Why `dev` lists watch paths one by one

`node --watch` on the project root also watches
`src/interfaces/api/public`. Analyzed projects live in the **server's
memory**, so every keystroke in `app.js` or `lineage.js` restarted the
process and threw the analyzed project away — the page then sat on
"Loading…" against a `projectId` that no longer existed.

So `dev` enumerates the backend directories and the server entry point,
and deliberately leaves `public/` out:

```
--watch-path=src/analyzer --watch-path=src/application --watch-path=src/ast
--watch-path=src/converter --watch-path=src/generator --watch-path=src/parser
--watch-path=src/report --watch-path=src/resolver
--watch-path=src/interfaces/api/server.js
```

Static files need no restart anyway — `express.static` serves them from
disk, so a browser reload picks up UI edits immediately. That is the whole
hot-reload story for the front end: **there is no build step**, no bundler,
no framework.

Adding a new top-level directory under `src/` means adding a
`--watch-path` for it; forgetting to leaves it silently un-watched.

The page also survives a restart on its own: `selectStatement()` catches
the dead `projectId`, re-analyzes from the files still held client-side,
and retries once.

## Testing

- `npm test` only. **Not** `node --test test/` — on this project's Node
  version that path form fails with `MODULE_NOT_FOUND` instead of running
  anything, which reads exactly like a passing run if you skim.
- The UI has no automated coverage. Anything in
  `src/interfaces/api/public` is verified by opening it in a browser; a
  green `npm test` says nothing about the graph.
