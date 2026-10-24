# MHQ parser and /rules

*Army-list parser for MiniHeadQuarters, plus the /rules page and rules wiki that grew out of it. Node 18 or higher, no dependencies, no package.json.*

## What is here

Two products share one repository and one HTTP server.

- **The army-list parser** reads a MiniHeadQuarters event page and writes structured JSON plus a compact one-line-per-unit Markdown view. It also absorbs closed events into `archive/`, so a tournament can be parsed again offline.
- **The /rules page** answers a Warhammer 40,000 rules question by citing the corpus rather than by trusting a model, and carries the browsable wiki of that same corpus. The corpus is tournament-only: Legends, lore and navigation stubs are excluded.

## Quick start

```powershell
node src/parse.mjs "https://miniheadquarters.com/tournaments/team/army-lists/<event-slug>"
node src/server.mjs            # the web UI and /rules on http://127.0.0.1:8787
```

The argument is an MHQ URL or the path to a saved list file. The output directory defaults to the event slug; `--out-dir` overrides it. The parser writes `mhq_army_lists.json` and `mhq_army_lists.mini.md`.

## The server

| Flag | Default | Purpose |
| --- | --- | --- |
| `--port <n>` | 8787 | Listening port (`PORT`) |
| `--host <h>` | 127.0.0.1 | Listening interface (`HOST`) |

Routes: `GET /` the parser page, `POST /parse` a URL, `POST /parse-file` a saved page, `POST /parse-list` pasted text, `GET /health` the running build and its corpus stamp. The rules side: `GET /rules` the page, `POST /rules/ask` a question, `GET /rules/find?q=` the drawer search, `GET /rules/record?id=` one record body as HTML. `POST /feedback` files an issue or answers a prefilled link, and `GET /web-bundle.zip` is the one download the Android WebView app makes.

## The pipeline in one line

scrape (`src/rules-corpus.mjs`) to shape (`src/wiki-build.mjs`) to payload (`src/wiki-payload.mjs`) to bundles (`src/web-bundle.mjs`, `src/app-bundle.mjs`) to the Box (`docs/deploy.md`). Each step is a file on disk, so any step can be rerun alone.

## Tests

One file per topic, no runner, no dependencies: `node tests/test-<name>.mjs`. A full pass is a loop over `tests/test-*.mjs` and reads the exit code of each. Two files are slow by design (`test-ability-resolution`, `test-slow-request`) and need a cap.

## Docs

The router is [`docs/README.md`](docs/README.md), one line per topic. Start there.

## Working agreement

See [AGENTS.md](AGENTS.md) for the five rules a session follows in this repo, and [STATUS.md](STATUS.md) for what is in flight.
