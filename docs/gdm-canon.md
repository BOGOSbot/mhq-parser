# gdmissions.app is the canon for "is the corpus current"

_`--check` and `--update` ask gdmissions.app's two data changelogs first, Core Rules and Faction. The Wahapedia markers are the fallback._

## The sources

```
https://gdmissions.app/11th/rules/changelog           Core Rules changes per data version
https://gdmissions.app/11th/rules/faction-changelog   every faction's changes per data version
```

Each page lists one row per **data version** of the official app export: the same export the faction half and the missions are built from ([mfm-source.md](mfm-source.md)). The number it lists and the dump's `metadata.data_version` are the same counter, so the check compares two integers and no dates.

The site is a Next.js app. The per-version details (rule ids, before and after text) render in the browser, but the server HTML carries the version picker:

```html
<option value="995">Data version 995 · 16 Oct 2026 · 1 change</option>
<option value="981">Data version 981 · 14 Oct 2026 · 16 changes</option>
...
<option value="PDF">The Core Rules PDF · 18 Jun 2026 · 5 notes</option>
```

Both pages carry the same picker; only the counts differ (995 is 1 Core Rules change and 24 faction changes). `src/gdm-changelog.mjs` reads the pickers and merges them into one row per version with both counts. If a page carries no such option, its parse throws: a layout change must never read as "current". Either page alone is enough for a verdict, and the canon is "unreachable" only when neither can be read.

The faction page also server-renders the newest version's per-faction headers (`<section id="v-995-blood-angels">`, an `<h2>` name, "2 changes · 1 unit"). `parseFactionBreakdown` reads them, so a BEHIND verdict names the factions the newest version touched.

The captured pages are the test fixtures (`tests/fixtures/gdm-changelog-2026-10-28.html`, `tests/fixtures/gdm-faction-changelog-2026-10-28.html`).

The site's [Version History](https://gdmissions.app/version-history) is the app's own changelog (art refreshes, tracker features). It is not read: the data changelog is the one that tracks rules data.

## Why not the Wahapedia markers

On 2026-10-28 the Wahapedia core-rules page's book table read "June 2026", but the page text already carried the 2026-10-14 changes (data version 981). The marker dates the book, not the copy, so it cannot say whether the copy is behind. It is kept as the fallback because it is all there is when gdmissions cannot be reached, and because the core rules are still scraped from Wahapedia.

## Commands

```
node src/rules-corpus.mjs --check               # canon first, then the Wahapedia markers
node src/rules-corpus.mjs --update              # pull the dump and rebuild when gdmissions lists a newer version
node src/rules-corpus.mjs --update --dry-run    # say what --update would do
node src/rules-corpus.mjs --update --force      # pull and rebuild even when current
```

`--check` prints each changelog's latest version, the version the corpus was built from, the verdict, and, when behind, the factions the newest version touched. It exits **2** when the corpus is behind, so a scheduler can act on the exit code. It also flags a dump on disk that is newer than the corpus built from it, which means a download happened and the rebuild did not.

`--update`, in order:

1. Reads the changelog. If the corpus is current or ahead, it stops (`--force` overrides).
2. Downloads the dump to `mfm-dump.json.part`. The file is swapped in only when it parses and carries a `data_version`. The old dump is kept as `mfm-dump.prev.json`.
3. If the downloaded export is no newer than the corpus, it stops. gdmissions can list a version before the dump URL serves it; the next run picks it up.
4. Rebuilds with the same steps as the manual recipe, each in its own process: `--scrape --set factions --cached` (which takes the corpus snapshot), then `--scrape --set missions`, then the wiki shape.
5. Prints the follow-up: `wiki-payload.mjs`, `--ingest`, `--prune`. The index is never touched by `--update`, because embedding is metered and the mass-delete rail wants a person.

When gdmissions is unreachable, `--update` falls back to the dump's own `data_version`: a download that is newer than the corpus is rebuilt from either way.

`GET /health` carries `corpus.dataVersion`, so the deployed version can be read against the changelog without a shell.

## What was verified on 2026-10-28

Corpus built from data version **995**. gdmissions lists **995** (16 Oct 2026, translation-only) as the latest. The faction half and the missions come from that dump, so they are current by construction.

The core rules are still Wahapedia's page, so they were checked change by change: one distinctive phrase from every Core Rules change in data versions 886 to 981 (36 probes: rules, errata, FAQ answers), and five phrases each change replaced.

| | result |
|---|---|
| Core Rules rule and errata changes, 886 to 981 | all present |
| replaced wordings (Deadly Demise, Gone to Ground, Consolidation, EPIC HEROES, attached units) | all gone |
| official Core Rules FAQ and errata in the dump | **75 of 84** present |
| official faction FAQ and errata in the dump | **1 of 591** present |
| faction changes in 995 (24, across 8 factions) | present, except one that is a wargear option |

The faction changes in 995 were spot-checked unit by unit: Kayvaan Shrike's and the Victrix Honour Guard's Epic Hero keyword, Ravenwing Champion's Character keyword, Dainal Komelius's Psyker keyword, the Wolf Guard Headtakers' Beasts keyword, and Atalan Jackals at 150 points are all in the corpus. The Death Company Captain's Power Fist (A 3 to 6, WS 3+ to 2+) is in the dump (the only A6 WS2+ Power Fist profile) but not in the corpus, because the Power Fist is a wargear option and the corpus emits only the base loadout. That is the open wargear-options slice in [mfm-source.md](mfm-source.md), not a version lag.

The nine missing Core Rules entries are the newest ones (mostly the 981 FAQ answers: Grot Shields and TORRENT, Ride the Wind, Seed Spore Mines, Arkanyst Evaluator, Icon of War, plus the Desperate Escape errata note and three older questions). Wahapedia's page has not picked them up. The 591 faction FAQs were never in the corpus; `docs/mfm-source.md` already lists the dump's FAQs as untouched.

## Still open

- **Core rules from the dump.** The dump carries the full Core Rules (`rule_section` / `rule_container` / `rule_container_component`, sections 01 to 25 plus Universal Rules Updates), the Chapter Approved pack and the event companions: the text gdmissions renders. Building the core rules from it would put every corpus half on the canon's version number and retire the Wahapedia scrape. It is a slice of its own: the anchors, the wiki tree and the appendix split all key on Wahapedia's page shape.
- **Wargear options.** A faction changelog entry can land on an optional weapon (995's Death Company Captain Power Fist), which the corpus does not carry yet; see mfm-source.md.
- **FAQs from the dump.** 675 rows (84 Core Rules, 591 faction), each tied by `faq_config` to its datasheet, detachment, stratagem, enhancement or rule. That closes both gaps in the table above.
- **A schedule.** Nothing runs `--update` on a timer yet. The exit codes are there for one (0 current or done, 1 failed, 2 behind on `--check`).
