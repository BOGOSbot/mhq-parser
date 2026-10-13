---
tags:
  - mhq
  - corpus
updated: 2026-10-14
---

*A static, offline render of the rules corpus - the way to LOOK at it, and the record-page
layout the findings cards will reuse.*

# Wiki render

`node src/wiki-render.mjs` writes `workspace/wiki-render/` (`WIKI_RENDER_DIR` moves it).
Open `index.html` from the folder: no server, no CDN, no external asset, no build step
beyond node, readable on a phone. It is regenerable - delete the directory and run it
again.

**It is a render, not a source.** Nothing it writes is read back into the corpus, and
nothing it writes is committed: the corpus is third-party rules material and the render
is a copy of it, so both live under `workspace/` and never in git. It ships to the
closed circle as a folder.

## What is in it

- one page per record: the heading path as breadcrumbs, the record's own text, the
  corpus's `links` array as chips, and the `renderLinks` block beside them, so the array
  and the text can be compared by eye; parent and 'linked from' navigation;
- `search.html`: every heading, filtered in the browser by an inline script;
- `index.html`: the corpus by kind and by source;
- `anomalies.html`: the reading aids - records still carrying another rule's text, links
  that point nowhere, records whose text and link array disagree, bodies that are mostly
  someone else's rule, biggest and emptiest, islands with no links and no parent.

## What looking at it found (2026-10-14, right after task 30)

1. **The link array is stale on 1,491 records (22%).** 1,452 name links in their TEXT
   that the array does not hold (task-30's ability lines went into the text only, and
   the build re-derived the array from its own logic), and 40 hold links the text does
   not. The settled contract is that a finding exposes `links` and the page renders from
   the array without parsing text - on those records the reader would show one link
   where the page shows seven.
2. **The kept segments are one rule wearing 33 names.** 34 kept segments: Super-heavy
   Walker 14 records (genuinely different, overlap 0.00), Stealth 9 and Hover 2 (both
   alignment artifacts: best-aligned overlap 1.00 against the canonical, scored 0.50 on
   the fixed 100-char grid), Dark Pacts 9 (borderline, 0.75).
3. **Hover exposed why.** The extractor's segment markers know only
   `Ability (Core|Faction|Datasheet)`, while the corpus also writes
   `Ability (Wargear):` and `Ability (Psychic):`. A segment therefore runs on into the
   next ability's text (Hover measured 495c against a 288c canonical instead of 282c),
   and the containment test compares a blob. Fix the marker set, then the grid.

## Invariants it checks

- debris: a segment label with no text after it must be 0;
- the text's link lines and the `links` array must name the same links, both directions;
- every link target must exist as a record;
- the render never writes to `CORPUS_DIR`.