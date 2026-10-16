# The wiki revamp - PRD

*Status: agreed with Mandal 2026-10-16, not started. Supersedes the wiki shell as it stands.*

## Why

Three complaints, one cause:

1. **The navigation is a sequence of drilled levels.** A tap can land on an empty pane, the path is printed three times over (the resting bar, the cascade head, the pills row), and you can never see two levels at once.
2. **Records are pages rather than fragments.** Every record costs a file, a URL and a full page load, so nothing can be blended - a finding and a wiki page are two renderings of the same record that drift apart.
3. **The rendering is raw.** A rule body is one `pre` of the stored text: legible on a desktop, a wall of monospace on a phone.

The corpus is not the problem and is not touched: 7,311 records, 6,271 delivered, the index, the ids.

## What changes

| | before | after |
|---|---|---|
| loading | 6,275 baked HTML pages | index + per-book JSON payloads, rendered client-side |
| addresses | `/wiki/<slug>.html` | `/rules#<slug>` |
| surface | `/rules` and `/wiki` | one page: an ask box and a viewscreen |
| the wiki | a full-screen cascade of levels | a drawer, closed by default, remembered |
| a record | a card *or* a page | one component, three modes |
| findings | 10 judged | 10 judged + an unjudged tail |
| feedback | vote + pick, two controls | one variable icon, both channels still recorded |
| offline | 6,275 pages in a zip | dropped |

## The seam: the payloads

The bake is the one place the corpus becomes something a reader can fetch. One interface, three shapes, all static files written by `src/wiki-payload.mjs` into `workspace/wiki-data/`:

```
GET /rules/index              -> { branches: [{ n, c, b }] }
GET /rules/index/<branch>     -> { n, lvl, c, kids: [...], recs: [...], pages: [...] }
GET /rules/content/<book>     -> { book, records: { id: { id, slug, heading, kind, source,
                                                        ruleId, set, text, links, parent,
                                                        children, at } } }
```

- **`index`** is the tree: branches with counts, then one payload per branch, fetched when the branch is opened. It is today's 308 node files (357 KB) folded into a handful.
- **`content/<book>`** is the records. `book` is `rules`, `missions`, `faction-aeldari`, ... The mass is the factions, and a faction is 0.11-0.28 MB - so the boundary follows how people read: you are in the core rules or you are in your army.
- **No manifest.** A record's slug carries its book: `<book>--<readable>-<hash>`, e.g. `rules--random-characteristics-dfgrnr`. A cold `#<slug>` splits on `--`, fetches that book, and finds the record. This is what deletes `map.json` (481 KB) and `legacy.json` (536 KB) outright - they existed to answer a question the slug now answers itself.

**The interface is the test surface.** A test builds payloads from a fixture corpus and asserts the three shapes; nothing needs a browser.

## The surface

**One mode, always.** An ask box and a viewscreen. Asking runs the search and puts the findings on the viewscreen. There is no browse mode, no second input, no toggle to remember.

**The wiki is a drawer.** Always available, closed by default, remembered across actions, and it slides away when you ask. It reopens only when you tap the control - never by itself.

**The tree.** A tap always reveals records: a chapter shows its sub-chapters *and* its records, so no tap ever lands on an empty pane. A record is one line (title, source, first ~100 characters) that opens in place. The drawer has its own small filter - finding is a different act from asking, and the box keeps one meaning.

**One record component, three modes:**

| mode | where | shape |
|---|---|---|
| `finding` | in the answer | compact, numbered, the judge's `why`, the icon, tappable |
| `page` | on the viewscreen | full record, standalone |
| `inline` | inside the tree | one line, expands in place |

Three modes over one body (`recordBody`), not three renderers - they are the same record and must not drift.

**Findings, two tiers.** Ten judged (fast mode, 5 a side) - measured: per-side 5 beat per-side 10 at hit@1 while matching it everywhere else on the 29-question bank, with 13 passages to the judge instead of 23. Below them, **the tail**: further matched rules, retrieval-ranked, *unjudged*, one line each, headed plainly. It costs no extra retrieval - `grepNet 50 / jevMax 60` already holds 50-60 candidates before the cut - and it is where hit@10 (84.8%) becomes hit@20 (90.9%). The tail's size and heading are tuning, not a decision.

With a tail, `answered: false` reads as *"none of the top ten states the rule"* rather than *"we do not know"*, and the copy says so.

**Feedback: one variable icon** per finding, three states - neutral, **yes** (*this is the one*), **no** (*wrong or irrelevant*). It replaces the vote and the pick controls, which fed two channels: `yes` writes vote-up + pick(this), `no` writes vote-down + no pick. Both channels stay recorded and are still aggregated separately; what is lost is only "right rule, badly presented". **"None of these" moves to the foot of the answer** - it is a judgement about the set, not about a finding.

**Back is one stack.** A record opened from the findings returns to the findings; from the tree, to the tree. The browser's own back button agrees, because the address is the hash.

## Modules: kept, cut, written

**Kept, and this is the point of a cut rather than a scrap.** `wiki-toc.mjs` is 1,300 lines but only ~375 are UI; the rest is the index model - 116 measured cut levels, the five books under Rules, faction to area assignment, page naming, the annotation rules. That model is correct and nothing about these complaints is about it. It stays behind the same interface and keeps the tests that read it.

Also kept: `wiki-cards.mjs` (the card, `recordBody`, `proseHtml` - the ask dialog and `/rules/record` use it today), `unit-card.mjs`, `wikilinks.mjs`, `wiki-plan.mjs`'s `stripBuiltBlock` (the corpus stores its link block in the text on purpose - it is what the vector sees - so this is load-bearing for *display*).

**Cut:** `TOC_JS`, `TOC_CSS`, `wiki-shell.mjs`, the page templates in `wiki-render.mjs`, `wiki-archive.mjs`, `map.json`, `legacy.json`, `/wiki/*` and `/wiki/all.zip`, the banner's Offline link, and the instant lookup (type-as-you-go - it was never intended, and it competed with the ask box).

**Written:**

- `src/wiki-payload.mjs` - corpus to payloads. One entry point, `buildPayloads(corpus, outDir)`, returning the stats the tests read.
- `src/wiki-surface.mjs` - the client, one JS/CSS pair like today's `TOC_JS`/`TOC_CSS`: the viewscreen, the drawer, the tree, the record component, the findings tiers.

`node src/wiki-render.mjs` (~5 min, 6,275 files) is replaced by the payload bake (~seconds, ~30 files). The running product stays reproducible: what is tested is what was built.

## Slices

1. **The bake.** `wiki-payload.mjs` and its tests, writing beside the current render. Nothing user-visible changes.
2. **The surface.** Tree, drawer, record modes, reading the payloads behind a dev route. The old wiki still serves.
3. **The findings.** Two tiers, the icon, the drawer's ask interaction, the copy.
4. **The flip.** One commit: the server serves the new surface, deletes `/wiki/*`, `map.json`, `legacy.json`, the zip and the Offline link, and re-points the finding deep-link at the slug.
5. **Acceptance, then your sign-off.**

Slices 1-3 run beside the old surface *in the repo*. Only slice 4 deletes, and it deletes everything at once - two live surfaces is how the drift started.

## Acceptance gate

- every delivered record is reachable from `/rules` and by a cold `#<slug>`;
- the ask flow is unchanged in behaviour: same retrieval, same judge, same verdicts on a fixed question set;
- `/wiki/*` returns 404 and nothing in the product references it;
- the suite is green;
- your visual sign-off.

Taps from `/rules` to a nominated rule will be counted and reported, not gated. Inventing a metric to flatter the work is worse than having none.

## Follow-ups

- **`/r/<slug>`**: the same shell, with the record's `title` and OG tags filled server-side, so a shared link previews *Emergency Disembark - Core Rules* instead of a bare URL. ~20 lines in the route, no second renderer. Dropped from scope because hash links are good enough to start.
- **The tail's size and heading** - tuning.
- **Offline** - parked deliberately. We depend on Jev anyway; a fully local stack (Laya) will need installing, so offline belongs in an app bundle that updates itself, not in a zip.

## What we are giving up

- **The offline artifact.** `/wiki/all.zip` and the Offline link are deleted, not parked: with `/wiki/*` gone its manifest is gone too, and half an artifact that cannot be regenerated is worse than none. It is regenerable from the corpus, which is what the new data shape is for.
- **Link previews** until the follow-up lands.
- **No-JS reading.** Records are client-rendered. The ask page already required JS.
- **The instant lookup**, which was accidental and competed with the ask.

## Open risks

- The flip is one large commit. The rollback is git, and the old render stays readable in history; there is no deploy and no traffic, so the window is a page refresh.
- The drawer filter is new behaviour and the tree must stay lazy: expanding a chapter of 39 abilities must not fetch 39 records.
- `wiki-toc.mjs` must be split at the `TOC_JS` boundary without dragging UI guesses into the index model. The tests that read the model are the guard.
