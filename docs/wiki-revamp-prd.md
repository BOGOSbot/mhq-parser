# The wiki revamp - PRD

*Status: agreed with Mandal 2026-10-16. Slices 1-4 are landed (`1f52a5a` the bake, `1be92ff` the surface, `8a932a1` the findings, `c42e9ef` the polish, `fe09095` the flip); slice 5 is acceptance and Mandal's sign-off. Supersedes the wiki shell as it stood.*

## Why

Three complaints, one cause:

1. **The navigation is a sequence of drilled levels.** A tap can land on an empty pane, the path is printed three times over (the resting bar, the cascade head, the pills row), and you can never see two levels at once.
2. **Records are pages rather than fragments.** Every record costs a file, a URL and a full page load, so nothing can be blended - a finding and a wiki page are two renderings of the same record that drift apart.
3. **The rendering is raw.** A rule body is one `pre` of the stored text: legible on a desktop, a wall of monospace on a phone.

The corpus is not the problem this revamp addresses and was not touched by it: 7,311 records, 6,271 delivered at the time, the index and the ids unchanged. (A later parser fix - task-85 - rebuilt it to 7,283 / 6,245 without changing the payload shape.)

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

- **`index`** is the tree: branches with counts, then one payload per branch, fetched when the branch is opened. It is today's 284 node files (258 KB) folded into three.
- **`content/<book>`** is the records. `book` is `rules`, `missions`, `faction-aeldari`, ... The mass is the factions: measured at the source, a faction is 0.01-0.61 MB (faction-tl to faction-sm), before the tree hands each one its 1,213 stratagems, 818 enhancements and 270 detachments. So the boundary follows how people read - you are in the core rules or you are in your army - and slice 1 measures what the payloads actually weigh.
- **Measured, slice 1** (`1f52a5a`): 30 files, 9.17 MB raw, **1.30 MB gzipped** (7.1x), baked in **1.93 s** against the render's ~5 minutes and 6,275 pages. The biggest payload is `content/rules.json` at 1.41 MB raw / 243 KB on the wire; the biggest faction is space-marines at 997 KB / 116 KB. Uncompressed these look fat; on the wire a whole army is 50-120 KB and the core rules 243 KB, and a cold `#<slug>` fetches exactly one content file because the slug names its book.

- **No manifest.** A record's slug carries its book: `<book>--<readable>-<hash>`, e.g. `rules--random-characteristics-dfgrnr`. A cold `#<slug>` splits on `--`, fetches that book, and finds the record. This is what deletes `map.json` (481 KB) and `legacy.json` (536 KB) outright - they existed to answer a question the slug now answers itself.

**The interface is the test surface.** A test builds payloads from a fixture corpus and asserts the three shapes; nothing needs a browser.

## The surface

**One mode, always.** An ask box and a viewscreen. Asking runs the search and puts the findings on the viewscreen. There is no browse mode, no second input, no toggle to remember.

**The wiki is a drawer.** Always available, closed by default, remembered across actions, and it slides away when you ask. It reopens only when you tap the control - never by itself.

**The tree.** A tap always reveals records: a chapter shows its sub-chapters *and* its records, so no tap ever lands on an empty pane. A record is one line - its own number and title - that opens in place. The drawer has its own small filter - finding is a different act from asking, and the box keeps one meaning.

**An open record carries its own navigation.** A bar pinned to the top of the scrollport names the section, the one before it and the one after, so the next section is one tap however long the body is. This is the fix for a measured defect: the 2,534 px body of `2. Profiles` put its next sibling row 2,600 px down, ~3.6 drawer screens, and the tree's rails left the body 322 px wide of 390. So the bar walks the container's own row list (the row carries it, nothing re-derives the tree from the DOM), the body de-indents to the tree's edge (322 -> 366 px at depth 3), and only one record is open at a time - except an inline that *contains* the row, because a detachment's enhancements open inside it (removing that parent would append the child to a detached subtree). Two open bodies made a 4,909 px tree with the first one 2,155 px above the viewport. The bar is not a second screen: the reader never leaves the tree or loses its place.

**A link inside a record stays in the drawer.** A body link is a slug (`#ignore-modifiers-…`). Clicking one used to set the hash, and the hash route opened the record as a *page under the drawer*: the tree was buried and the back button said *Open the wiki*. The drawer catches those clicks now - the record the link points at opens over the tree with a back stack (`← Ignore Modifiers`, then `← Wiki`), and the tree keeps its own scroll position, so a chain of links reads like a path. The address does not change: browsing in the drawer is not an address. On a record *page* (opened from a finding) a link still replaces the page through the hash route, and back returns to the answer rather than the previous record - that needs the hash flow reworked and is not done.

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
- `src/wiki-surface.js` + `src/wiki-surface.css` - the client: the viewscreen, the drawer, the tree, the record component, the findings tiers. **Real source files, not a template literal.** This PRD first said one `.mjs` exporting a JS/CSS string pair like `TOC_JS`/`TOC_CSS`; that is exactly how the shell broke once - a regex written into a single-quoted string lost its backslashes and the whole page stopped parsing, and `node --check` could not see it. The client is the largest and most-edited surface in this revamp, so it gets an editor.
- `src/wiki-surface.mjs` - the server-side adapter: serves those two files and mounts the shell, so the flip has one place to wire the page in.

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
