# The corpus audit of 2026-11-02, and what came of it

*A cheap reader model read the whole corpus and reported what looked wrong. This is the verdict on its findings: what was real, what was my own mistake, and what each fix changed.*

The sweep read 5,546 sections in three slices (rules books, factions twice) through SenseNova 6.8 Flash Lite, one batch at a time. 304 findings. About a fifth survived a check against the record, and the worth of the exercise was the *shape* it pointed at, not its answers.

## Withdrawn: three of its loudest claims were not defects

- **"43 bodies run one heading too far."** The numbered lines ending those bodies are the page's **SEE ALSO** widget: a list of related rules that the link builder turns into links. Content, kept on purpose.
- **"33 sections filed under the previous section's id."** The `#2` suffix is the **part** suffix (`sectionId` appends `#<part+1>`); those records are parts 2 to 4 of one long section, renamed from their own first line.
- **"143 datasheets carry a bare `Wargear` line."** There are 0. Those lines read `Wargear Chaff Launcher - The bearer has the SMOKE keyword.` — the item's own `ruleText` — and both the reader and an earlier count of mine matched the upgrade shape because it has no colon.

## Fixed

| what | records | where |
|---|---:|---|
| a body that is only the FAQ accordion's `Show` | 2 | `extractSections` |
| the event card toolbar stored as a rule (`WEC_LayTitle`) | 1 | `SOURCE_CHROME` |
| the heading printed again as the body's first line | 9 | echo strip |
| a field label used as a heading (`MAXIMUM DISTANCE: 3"`) | 2 | `deriveTitle` |
| an errata card losing the page's own title to its body | 1 | promoted-title rule |
| `Damaged: Damaged:` | 192 | `statsLines` |
| a base-size line naming every model in the unit | 22 | `statLine`/`baseFor` |
| an enhancement promising a weapon and printing none | 2 | `enhancement_wargear_item_profile` |
| a detachment ability ending on a dangling dash | 4 | `detachment_detail` |
| one unit size priced two ways | 17 | `unit_composition` conditions |

The last one was not a defect in the data at all: `unit_composition` holds one row per price, and `unit_composition_required_detachment` (the C'tan in Pantheon of Woe, the assassins in the Veiled Blade Elimination Force) or `unit_composition_required_faction_keyword` (the Inquisition units as Agents of the Imperium) says when the second applies. The output had simply dropped the condition.

## Still open

- The core stratagems that follow the `Tank Shock Stratagem` errata card nest under it (`> RAPID INGRESS`). It predates the errata-title fix, so it is the promoted heading's stack level, not the title.
- `tests/test-find.mjs` (11) and `tests/test-record-outline.mjs` (5) are red, as they were before this work: they assert on the CSV corpus's numeric ids and census.

## How to audit a corpus again

- Read a slice with a cheap model, then **measure every class** on the whole corpus yourself before touching code. The model's hit rate is low; its value is the pointer.
- Count coverage by **section id**, never by batch index: the same slice was 102 batches one run and 110 the next, and an index-keyed resume silently skips work.
- A flag of the form "the text is missing" usually means a table the builder never opened. Check the dump's tables before believing the text is gone.
