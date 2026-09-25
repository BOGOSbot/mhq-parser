# Developer documentation

How the parser works and why. Read this before modifying parse.mjs.

## CLI behavior

- **URL is required.** No default URL. If none is provided, the script exits with `Error: provide a link to an MHQ army list`.
- **URL validation.** The URL must match one of: `https://miniheadquarters.com/tournaments/team/army-lists/<slug>`, `https://miniheadquarters.com/tournaments/individual/army-lists/<slug>`, or `https://miniheadquarters.com/tournaments/side-by-side/army-lists/<slug>`. Invalid URLs exit with `Error: provide a valid link`.
- **Default output dir.** `<event-slug>/` relative to the script's directory (`tools/mhq-parser/`). Both files (`mhq_army_lists.json`, `mhq_army_lists.mini.md`) go there. Override with `--out-dir <dir>`.
- **Path resolution.** Uses `fileURLToPath(import.meta.url)` from the `url` module to get the script's directory. This handles Windows paths correctly (unlike `new URL(import.meta.url).pathname`, which produces a leading-slash path that breaks `path.join`).

## Step-by-step walkthrough

### 1. Find the army-lists URL from an event page

MHQ has two relevant URLs per event: the event "details" page and the "army-lists" page. The details page has the tournament name, date, and organizers. The army-lists page has the actual lists.

If you only have the details URL, look for a link labeled "Click to see army lists" in the "Army lists" section. The URL shape is:

```
https://miniheadquarters.com/tournaments/team/army-lists/<event-slug>-<YYYY-MM-DD>
```

The slug is lowercased, spaces become hyphens, and the event date is appended.

Example:

- Event name: "La Croisade des Canuts 2"
- Date: 2026-09-19
- URL: https://miniheadquarters.com/tournaments/team/army-lists/la-croisade-des-canuts-2-2026-09-19

### 2. Fetch the page (no JS execution needed)

The page is server-rendered. A plain GET with a browser User-Agent returns the full HTML. Cloudflare is only in front of email addresses (the (protect) tags), so you do not need a headless browser.

Pitfall on Windows: [Net.HttpWebRequest] and curl.exe both fail against this site with "The underlying connection was closed" / "SEC_E_NO_CREDENTIALS". Node's .get() works out of the box. That is why the script uses Node.


#### The auth wall (organiser/admin URLs)

A third URL shape exists: `/tournaments/<type>/administrate/<slug>/army-lists`. It is the organiser's view and shows lists before they are published. It requires a logged-in session.

Two facts about the site's auth:

- It is **Django**. Evidence: `csrfmiddlewaretoken` hidden input, `id_username` / `id_password` id prefixes, `gunicorn` origin header. The first `GET` returns `Set-Cookie: csrftoken=...` (no `HttpOnly`, `SameSite=Lax`), and the value equals the form's hidden `csrfmiddlewaretoken` (Django's double-submit).
- Login is a plain `POST /users/login` with `csrfmiddlewaretoken` + `username` + `password`. No SSO button, no captcha, no MFA. Password reset lives at `/users/reset-password`.

**Why this needed code and not just docs.** An unauthenticated GET on an admin URL returns the login page with **HTTP 200**, not a 302. `splitArticles` then finds zero articles and `parseUrl` threw `no army lists found - this event has probably not published its lists yet` — the wrong diagnosis, and a misleading one because the real cause (no session) is invisible. That is exactly the state of `bogos-team-6-des-sous-terre-2026-10-10/mhq_army_lists.json` in the repo: six teams, all `bodyRest: "No lists"`, because the public page really has nothing published yet.

So the wall is detected explicitly:

- `isLoginPage(html)` matches `action="/users/login"` **and** `name="csrfmiddlewaretoken"`. Both together are distinctive and cheap; no `<title>` parsing.
- `parseUrl` checks it before `splitArticles` and throws `authError(url)`, which names the site, the endpoint, and the exact steps to get a cookie. server.mjs keys off the phrase `authentication required` to answer `401` with `{ auth: true }`, which is what makes the UI open the cookie field.
- `fetchHTML(url, { cookie })` adds the `Cookie` header. The second argument is now an options bag but a bare `hops` number is still accepted so older callers keep working.
- `URL_RE` now has one arm per shape and each arm requires its own slug, so a bare `/tournaments/team/army-lists` is rejected instead of falling back to an `output/` directory. `extractEventSlug()` pulls the slug from either shape: public form has it after `/army-lists/`, admin form has it after `/administrate/`.

**Where the admin URL comes from.** The sitemap contains no admin entries at all — zero occurrences of `administrate` across ~2 MB — so Browse cannot surface one from its index. Every event does carry `type` and `slug`, so `adminUrlOf()` in index.html rebuilds the path as `/tournaments/<type>/administrate/<slug>/army-lists`, and the Browse 'organiser view' checkbox switches a row click between the public `e.url` and that rebuilt form. `tests/test-auth.mjs` mirrors the builder and asserts the result passes `URL_RE`, recovers the slug through `extractEventSlug()`, and is flagged by `isAdminUrl()`. Without that pin, a change to `URL_RE` would break the checkbox and the only symptom would be a bare `400`.

#### Logging in programmatically (`loginSession`)

There is no anonymous route to an admin page, so the only way to obtain a session is to authenticate. `loginSession(username, password)` in parse.mjs does exactly what a browser does:

1. `GET /users/login` — takes the `csrftoken` from `Set-Cookie` and the matching `csrfmiddlewaretoken` out of the form.
2. `POST /users/login` with `csrfmiddlewaretoken` + `username` + `password` and `Cookie: csrftoken=...`. The cookie has to be echoed back; without it Django answers 403 CSRF Failed.
3. **Success** is a `sessionid` cookie in the response. **Failure** is the form re-rendered with no `sessionid` and Django's stock message inside a red panel.

The red panel is the only red block on the login page and it is not a `<p class="error">` — it carries `border-red-500/20 bg-red-500/10 ... text-red-200` — so `loginFormError()` matches it by tint. The text is surfaced verbatim, so a wrong password reads as Django's own "Please enter a correct username and password. Note that both fields may be case-sensitive." rather than a generic failure.

The server keeps the result in memory and in `.secrets/mhq-auth.json` (gitignored), never in the browser: a miniheadquarters.com cookie is cross-origin junk to the UI anyway, and the browser would otherwise hold the session in localStorage. Passwords are written only when the user ticks "remember", and `parseWithSession()` re-authenticates transparently once when a stored session hits the login wall. `authGitIgnored()` runs `git check-ignore` before saving so the UI can warn if `.secrets` is not excluded — the alternative, committing credentials, is precisely what the cookie route existed to avoid.

Pitfall on cookie plumbing: a browser **cannot** attach `miniheadquarters.com` cookies to a fetch of the local server (different origin), so the cookie has to be forwarded as text. That is why the UI keeps it in `localStorage` and posts it in the `/parse` body, and why the CLI takes `--cookie` / `MHQ_COOKIE`. The value is a Django session and expires (default two weeks), so it is not a permanent solution — it is the cheapest one, because it stores no password and adds no dependency.

### 3. Split the page into player blocks

The page has two formats depending on the event type:

**Team events** (team/): nested <article> elements. A team card wraps a region of player armies:

```html
<article class="overflow-hidden rounded-3xl ...">   <!-- TEAM CARD -->
  <button ...>
    <span class="text-base font-semibold ...">Cartel de Trollito</span>
    ...chevron svg...
  </button>
  <div role="region" aria-labelledby="team-button-0">
    <div class="space-y-6">
      <article class="rounded-2xl ...">               <!-- PLAYER ARMY -->
        <h2>PlayerName : Faction</h2>
        <div class="mt-4">...list body...</div>
      </article>
      <article class="rounded-2xl ...">               <!-- next player -->
        ...
      </article>
    </div>
  </div>
</article>
```

Pitfall: a naive split on <article> picks up both outer and inner tags. The first outer tag's closing tag is actually the first inner tag's closing tag (because the inner articles are nested inside), so the extracted chunk is "outer start -> first inner end" and the parser silently skips it (no <h2>) or mis-parses it. The fix is to split on <article class="rounded-2xl> only, then walk backwards from each inner article to find the enclosing outer card and pull the team name out of its <button><span>.

**Individual events** (individual/, 2v2/): flat <article> elements. Each player is directly inside an outer card:

```html
<article class="overflow-hidden rounded-3xl ...">   <!-- PLAYER CARD -->
  <button ...>
    <span class="text-base font-semibold ...">PlayerName - Faction</span>
    ...chevron svg...
  </button>
  <div role="region" aria-labelledby="solo-button-0">
    <div class="rounded-2xl ...">
      <div class="whitespace-pre-line ...">
        ...list body...
      </div>
    </div>
  </div>
</article>
```

The parser detects the format by checking for `<article class="rounded-2xl` (team) vs. `<article class="overflow-hidden` (individual). For individual events, the player name comes from the button span instead of an <h2> tag, and is split on " - " to extract the faction. The body is extracted from the <div class="whitespace-pre-line"> element rather than after </h2>, since individual cards have no <h2>.

### 3b. Organiser/admin pages: a table, not articles

An admin URL (`/administrate/...`) does not use the article layout at all, and it does not contain the list bodies. The event page is a `<table>` with one `<tr class="transition hover:bg-white/5">` per submitted army and a fixed cell order: subscription checkbox, username, team, faction, last modified, first submission, last review by, status badge, link.

```html
<tr class="transition hover:bg-white/5">
  <td><input type="checkbox" name="subscription_47377" ...></td>
  <td>...<span>Blork</span></td>
  <td>Random Wargame Club</td>
  <td>Chaos - Chaos Knights</td>
  <td>09/21/2026 10:41 a.m.</td>
  <td>09/21/2026 10:41 a.m.</td>
  <td>-</td>
  <td><span class="... bg-amber-500/10 text-amber-300">
        <em class="fas fa-clock"></em>
        <span>Pending validation</span></span></td>
  <td><a href="/tournaments/team/administrate/army-lists/47377" ...></td>
</tr>
```

The body lives on a separate per-army page. That route is **not** under the event slug - it is `/tournaments/<type>/administrate/army-lists/<id>`, so it is its own arm of `URL_RE` and is detected by `ADMIN_LIST_RE`. It costs a second fetch per army, so an admin parse makes `1 + N` requests for `N` armies.

The two routes are told apart safely: the index ends in `/army-lists` with nothing after it, while the per-army route requires digits after it. `tests/test-auth.mjs` pins this, because a false match would silently parse a single army instead of the whole event.

The status is matched on the badge **text** (`Pending validation`, `Accepted`, `Rejected`), never on the colour class (`bg-amber-*`, ...), so a recolor by the site does not break it. `adminStatusOf()` reads the short form ("Pending") off the per-army page as a fallback for a bare army URL, which has no table.

To reuse the whole public pipeline, `adminArticle()` turns a row into a fake article: an `<h2>Name : Faction</h2>` - which `buildPlayers()` already reads - plus the raw body. `parseNewRecruit`, `parseBullets` and `findPlusBlock` therefore need no changes, which the fixture round-trip test (`82` checks) proves on a real submitted list. `parseAdmin()` is dispatched from `parseUrl()` on `isAdminUrl()`.

An empty submission is a legitimate state, so `fetchAdminList()` never throws and `adminArticle()` tolerates a null body: the army still appears, with zero units, instead of failing the whole event.

Pitfall found here: the site emits a literal non-breaking space (U+00A0) inside fields such as "Houndpack&nbsp;Lance". `decodeEntities()` only handled the `&nbsp;` entity, so a literal NBSP survived into the output and made substring search for "Houndpack Lance" fail. It is now normalised to a plain space in `decodeEntities()`, which fixes public and admin parsing alike.
### 4. Recognise which list format each player used

MHQ is a free-text upload. Every player pastes their own list in whatever format their list-builder produced. Two primary formats appear, with several sub-variants:

| Format | Marker |
|--------|--------|
| **bullets** | `(N pts)` unit declarations, bullet sub-models |
| **newrecruit** | `[Npts]` unit declarations, `--- Optimisations :` enhancements |

The parser picks the format by detecting `[Npts]` (newrecruit) vs. `(N pts)` (bullets). Lists without a `+++` header use preamble stripping to find where units begin.

### Hybrid format detection

Some lists mix formats (e.g. `[N pts]` with `•` bullets). The parser detects hybrid formats and uses `parseBullets` when both newrecruit markers and bullets/markdown headers are present. This handles:
- Alvi's T'au list: `CharN: Unit [N pts]:` with `•` bullets and `##` markdown headers
- Billou's Custodes list: `[Npts]` units with `•` sub-models

### Additional unit declaration formats

Beyond the standard `(N pts)` and `[Npts]` formats, the parser recognises:

- **`+ UNIT NAME (count)`** — Looping's Ork format: unit name with count, points on next line
- **`Unit Name : N pts`** — Taal's Votann format: French-style with colon before points
- **`1x Unit Name N pts`** — yomgui21's format: simple format without parentheses
- **`• 1x Unit Name (N pts)`** — Revvvenge's format: bullet with points on same line

### Section separators

The parser recognises multiple section separator formats:

- **Markdown headers** (`##`, `###`) — Alvi's format
- **French-style tabs** (`\t--- Section ---`) — Taal's format
- **Category headers** (`PERSONNAGES`, `LIGNE`, `BATTLELINE`, etc.) — standard format

### Preamble stripping

Lists without a `+++` header often start with metadata (army name, faction, detachment) before the unit list. The `findPreambleEnd()` function finds where units begin by scanning for:
- Category headers (`CAT_HDR`: PERSONNAGES, LIGNE, BATTLELINE, Héros épiques, Bêtes, Montés, Infanterie, Véhicules, etc.)
- Bullet lines (`•`, `◦`)
- Character lines (`Char1:`, `Char2:`, etc.)

If no stop condition is found, all lines are treated as units (no stripping). The stripped preamble is used to extract detachment and force disposition.

### Attachment patterns

Beyond `Attached as:` / `Attachée en tant que:`, the parser recognises two additional attachment patterns:

- **`Leading <name>`** — character leads a unit (e.g. `Leading Incubi[1]`)
- **`Attached to <name>`** — unit is attached to a character (e.g. `Attached to Archon[2]`)

These are non-bullet lines that appear after a unit declaration and before the next unit.

### 5. Parse the +++ header (when present)

Bullet-format lists often start with a + delimiter block:

```
+++++++++++++++++++++++++++++++++++++++++++++++
+ PLAYER NAME: PlayerName
+ TEAM NAME: Cartel de Trolls
+ FACTION KEYWORD: Chaos - World Eaters
+ DETACHMENT: Goretrack Onslaught, Vessels of Wrath
+ FORCE DISPOSITION: Priority Assets
+ TOTAL ARMY POINTS: 2000pts
+ WARLORD: Char1: Kharn the Betrayer
+ ENHANCEMENT: Aggressive Deployment (on Char3: Master of Executions)
& Murderous Onslaught (on Char4: Master of Executions)
& Unleash Hell (on Char5: Master of Executions)
+++++++++++++++++++++++++++++++++++++++++++++++
```

Pitfalls baked in:

- **+ is not always required on the value lines.** Some French lists put the delimiter ++++... lines but leave the content lines without a leading +. The parser strips an optional leading +.
- **The & continuation.** When a WARLORD has multiple ENHANCEMENTS, the second and later tweaks are prefixed with & on their own line. The parser merges those into the previous key instead of treating them as junk keys.
- **+ is also used as a unit bullet in some lists.** The parser only treats + lines as delimiters when the line consists of 20 or more consecutive + characters.
- **Some headers are missing the opening delimiter.** The parser falls back to looking for a block of + KEY: VALUE lines followed by a closing delimiter.
- **Multiple header blocks are merged.** The parser scans through consecutive +++-delimited sections and merges them into a single header. A block ends only when unit content appears: (N pts), [Npts], Char1:, bullets (• . ◦), or newrecruit attachment (|). Lines starting with + are always header content, never unit content (fixes false breaks from (30pts) inside enhancement text).

### 6. Parse the body

#### Bullet format

Unit declarations end in (N pts) or (N points):

```
Khorne Berzerkers (160 pts)
. Attached as: Bodyguard
. 1x Khorne Berzerker Champion
    . 1x Chainblade
    . 1x Plasma pistol
. 9x Khorne Berzerker
    . 7x Chainblade & Bolt pistol
    . 2x Khornate eviscerator & Plasma pistol
```

Pitfalls:

- **Empty lines** are skipped silently and do not split units from their bullets.
- **Category headers can masquerade as attachment headers.** "Unites Attachees" (French) starts with "Unites", which the CATEGORY regex also matches. The parser checks ATTACHED_RE first, before CATEGORY_RE.
- **Some players paste inline bullets** ("A . B . C" all on one line). The parser splits on \s+.\s+ and re-prefixes continuation pieces with .
- **Bullet model counts** are read as \d+x Name. Lines with a colon ("1x Chosen Champion: Plasma pistol, ...") are truncated at the first colon so only "1x Chosen Champion" is recorded as the model entry.
- **Some players put the points on a separate line** from the unit name. A pre-merge pass joins them: "3x Name" + "(100 pts)" -> "3x Name (100 pts)".
- **Empty "(unknown)" units are filtered out** with model transfer. When a bullet line appears before any unit (e.g. `• Attached as: Leader`), it creates an `(unknown)` unit. Post-processing transfers its models to the next unit and discards it if it has no points.
- **Equipment lines with multiple "Nx" patterns** are detected as equipment for the current unit, not as new units. This prevents Revvvenge's `1x Leman Russ battle cannon, 1x lascannon (5 pts)` from being parsed as a unit.
- **Bullet lines with points** (e.g. `• 1x Unit (130 pts)`) are treated as unit declarations, not model entries. This handles Revvvenge's bullet format.

#### newrecruit.eu format

```
Infanterie 2 : 5 Depeceurs [55pts] 5 Griffes de Depeceur (0)
|   Personnages 1 : [Meneur] Seigneur Skorpekh [125pts] Annihilateur d'hostiles (0), ...
|   --- Optimisations : Lien dermique enaegique (30)
```

French newrecruit export format:

```
Personnages 1 : Buveur de Sang [335pts] Souffle de feu d'Enfer (0), Grande hache de Khorne (0)
--- Optimisations : Gueule d'Airain (15)
Héros épiques 1 : Be'Lakor [390pts] Ombres traitresses (0), La Lame des Ombres (0)
Unité mené : Ligne 1 : 10 Sanguinaires [110pts] 10 Lame Infernale (0), ...
```

- The `|` prefix marks a line as attached to the previous unit.
- `--- Optimisations :` is an enhancement line. The enhancement text (including the `(N)` cost) is stored in `u.enhancements`. The unit's points field is NOT modified — `[Npts]` already includes enhancement costs.
- `( Seigneur de Guerre )` on its own line marks the warlord.
- The leading `|` and `---` must be stripped before matching the enhancement regex.
- **Category headers** include French variants: `Personnages`, `Héros épiques`, `Bêtes`, `Montés`, `Infanterie`, `Véhicules`, `Unité mené`.

**Enhancement points are included in unit points for all formats.** The parser never adds enhancement points to `u.points`. This was verified across 280 lists — adding them caused double-counting.

### 7. Build the mini Markdown view

The mini output is Markdown (`.md`). Players are grouped by team with `## Team: <name>` headers. The header line shows both team count and army count: `7 teams, 42 armies`.

Rules, in order:

1. **Team grouping** - players are grouped by `p.teamName` (extracted from the outer team card on the MHQ page). Players without a teamName go into an `Unknown` group.
2. **Player header** - each player gets a `### <name> — <faction>` header. Meta lines (Detachment, Disposition) appear as bullet points under the header.
3. **Warning blockquote** - printed under the player header when:
   - **Points mismatch** — parsed total ≠ declared total: `> ⚠ points mismatch: declared N, parsed M (±diff)`
   - **Missing total points** — header exists but no `totalPoints` key: `> ⚠ missing total points in header`
   
   Across 280 lists (11 events), the warning ratio is 7.5% (21 warnings). Most mismatches are small (≤100 pts) and indicate player-side data issues or enhancement points not included in unit points.
4. **Skip preamble "units"** - anything with 1000+ pts (army banner, force line) or a name matching Strike Force / Force de Frappe / Reconnaissance / Take and Hold / Priority Assets / Purge the Foe / Disruption / etc.
5. **Model count** - take the largest "Nx Name" bullet count for the unit. Characters (single model) get no prefix.
6. **Attached grouping** - units sharing an attachedUnit id are joined with " + ". For newrecruit.eu, a |-prefixed line attaches to the line above.
7. **Enhancement tag** - [name1, name2] after the unit name. Prefixes "Optimisation :" / "Enhancement :" are stripped, along with costs (+N pts) / (N pts) / (N) / (upgrade).
8. **Collapse duplicates** - consecutive identical lines become "Nx line".

### 8. Extract Detachment / Disposition

Three paths:

- **Header path** — when the `+++` block has DETACHMENT / DISPOSITION keys. The HEADER_ALIAS map covers English and French variants (DETACHMENT, DETACHMENT USED, DETACHMENT RULES, RÈGLE DE DÉTACHEMENT, etc.).
- **Preamble path** — when no header exists, `findPreambleEnd()` finds where units begin (first CAT_HDR, bullet, or `Char1:` line). The text before that point is scanned for:
  - `^<name>\s*\(\d+ Points de Détachement\)\s*$` (French)
  - `^<name>\s*\(\d+ Detachment Points\)\s*$` (English)
  - `^Détachements\s*:\s*<name>\s*$` (newrecruit.eu French)
  - `^<Disposition>\s*$` where Disposition is in {Reconnaissance, Take and Hold, Prendre et Tenir, Priority Assets, Atouts Prioritaires, Purge the Foe, Prey in Ambush, Disruption, Perturbation}
- **Post-header path** — when a `+++` header exists, the remaining text after the header is also checked for preamble content before unit parsing begins.

Pitfall: the army banner "<ArmyName> (2000 points)" matches the naive detachment regex. The parser requires "Points de Détachement" or "Detachment Points" explicitly, so the banner never gets captured.

## Extending the parser

Common tweaks:

- **Add a new list format** - add a new parseXxx() function, extend the format-detection in buildPlayers(), and add a new renderXxx().
- **Translate more roles** - edit the HEADER_ALIAS and the role translation in the mini formatter. The mapping table is in **translate.md**.
- **Show enhancements differently** - tweak enhancementTag() / cleanEnhancement() in the mini formatter section.
- **Change the meta-line label** - edit getMeta() and the output loop at the bottom of main().

## Enhancement points

Enhancement points are already included in unit points for all supported formats. The parser stores enhancement text in `u.enhancements` but does not modify `u.points`.

## Reproducibility

- Deterministic: same URL gives the same output, modulo upstream page changes.
- The HTML is not cached. Each run re-fetches. To diff two runs, save the HTML separately.
- To cache the HTML for debugging, replace fetchHTML() with a function that reads a local .html file. The rest of the pipeline is pure.