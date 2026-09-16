# MHQ Army-List Parser

Pull a [MiniHeadQuarters](https://miniheadquarters.com) army-lists page and dump the armies as structured JSON plus a compact "one line per unit" mini view. Self-contained: no npm install, only Node 18 or higher.

## Quick start

```powershell
node tools\\mhq-parser\\parse.mjs "https://miniheadquarters.com/tournaments/team/army-lists/<event-slug>"
```

The URL is required. The default output directory is `<event-slug>/` relative to the script. Both files go there:

- `<event-slug>\\mhq_army_lists.json`  (structured: players, units, headers)
- `<event-slug>\\mhq_army_lists.mini.md`  (compact Markdown view)

Override the output directory:

```powershell
node tools\\mhq-parser\\parse.mjs "https://miniheadquarters.com/tournaments/team/army-lists/<event-slug>" --out-dir data\\mhq\\<slug>
```

## Flags

| Flag | Default | Purpose |
|------|---------|---------|
| \\ <url> | required | Army-lists page URL (must match `https://miniheadquarters.com/tournaments/{team|individual|side-by-side}/army-lists/<slug>`) |
| **--out-dir <dir>** | `<event-slug>/` | Where to write both files |
| **--json <name>** | mhq_army_lists.json | JSON filename |
| **--mini <name>** | mhq_army_lists.mini.md | Mini filename |

## Output

### JSON

The JSON file has three top-level keys:

- event: { name, date, url }
- count: number of armies
- players: array of player objects

Each player object has:

- name, faction, teamName, format
- header: the +++ key-value block (null if absent)
- units: array of parsed units
- bodyRest: raw text for fallback inspection

bodyRest is preserved verbatim per player. Anything the parser did not structure is still recoverable from there.

### Mini Markdown

- `⚠ points mismatch` warns when the parsed total differs from the declared total.
- `⚠ missing total points` warns when the header has no `TOTAL ARMY POINTS` key.
- Warnings appear under the player header. Across 280 lists, the warning ratio is 7.5%.
- `+` separates units inside an attached group.
- `Nx` prefix = N identical copies collapsed.
- `N` prefix (no x) = model count within the unit.
- `[name]` = enhancement applied to that unit.
- **Team:** comes from the enclosing team card on the MHQ page.

## Supported formats

Two primary formats are recognised automatically, with several sub-variants:

| Format | Marker |
|--------|--------|
| **bullets** | `(N pts)` unit declarations, bullet sub-models |
| **newrecruit** | `[Npts]` unit declarations, French-style `Category N :` prefix |

Additional unit declaration formats:
- `+ UNIT NAME (count)` — unit with points on next line
- `Unit Name : N pts` — French-style with colon
- `1x Unit Name N pts` — simple format without parentheses
- `• 1x Unit Name (N pts)` — bullet with points on same line

Section separators: `##`/`###` markdown headers, `\t--- Section ---` French-style tabs, category headers (PERSONNAGES, LIGNE, BATTLELINE, Héros épiques, etc.).

Headers may span multiple `+++`-delimited sections. The parser merges consecutive sections into a single header block.

## Warning ratio

Across 280 lists from 11 events (Aug–Sep 2026), the parser produces 21 warnings (7.5%).

| Warning | Count | Cause |
|---------|-------|-------|
| Points mismatch | 18 | Declared total ≠ parsed total |
| Missing total points | 3 | No `TOTAL ARMY POINTS` key in header |

## Requirements

- Node.js 18 or higher (for https.get() and URL).
- No npm dependencies. stdlib only.

## Files

- \.mjs - the parser + formatter
- **README.md** - this file
- **developer-doc.md** - how the parser works and why
- **translate.md** - FR/EN dictionary used by the parser (role tags, dispositions, category headers, bullet keywords, enhancement names)