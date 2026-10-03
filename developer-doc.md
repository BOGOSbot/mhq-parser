# Developer documentation

How the parser works and why. Read this before modifying parse.mjs.

## CLI behavior

- **URL is required.** No default URL. If none is provided, the script exits with `Error: provide a link to an MHQ army list`.
- **URL validation.** The URL must match `URL_RE`: host `miniheadquarters.com`, path `/tournaments/<type>/...`, where `<type>` is `team`, `individual`, `2v2` or `side-by-side`, and the rest is one of `army-lists/<slug>`, `details/<slug>`, `administrate/<slug>/{army-lists,details}` or `administrate/army-lists/<id>`. Every arm requires its own slug, so a bare `/tournaments/team/army-lists` is rejected rather than defaulting to an `output/` directory. Invalid URLs exit with `Error: provide a valid link`.
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

**Why this needed code and not just docs.** An unauthenticated GET on an admin URL returns the login page with **HTTP 200**, not a 302. Left alone, `splitArticles` finds zero articles and the caller reports `no army lists found - this event has probably not published its lists yet`, which is the wrong diagnosis: the real cause, a missing session, is invisible. The same event parsed as six teams with `bodyRest: "No lists"` before the check existed. That output is not in the tree any more (the `cleanup` commit dropped the generated event folders), only in git history.

So the wall is detected explicitly:

- `isLoginPage(html)` matches `action="/users/login"` **and** `name="csrfmiddlewaretoken"`. Both together are distinctive and cheap; no `<title>` parsing.
- `parseAdmin()` checks it right after the fetch and throws `authError(url)`, which names the site, the endpoint, and the exact steps to get a cookie. server.mjs keys off the phrase `authentication required` to answer `401`. The check lives on the admin path only now: a public URL that returns the login form has no articles either way, and it fails as unpublished lists, which is what it is. with `{ auth: true }`, which is what makes the UI open the cookie field.
- `fetchHTML(url, { cookie })` adds the `Cookie` header. The second argument is now an options bag but a bare `hops` number is still accepted so older callers keep working.
- `URL_RE` now has one arm per shape and each arm requires its own slug, so a bare `/tournaments/team/army-lists` is rejected instead of falling back to an `output/` directory. `extractEventSlug()` pulls the slug from either shape: public form has it after `/army-lists/`, admin form has it after `/administrate/`.

**Where the admin URL comes from.** The sitemap contains no admin entries, so Browse cannot surface one from its index. Each row of `/users/my-organized-tournaments` carries a details link, and `parseOrganizedRows()` rebuilds the organiser form from it as `/tournaments/<type>/administrate/<slug>/army-lists`, putting that on the row's `url`. index.html never builds it; a row click just takes whichever `url` the source supplied, public or admin. `tests/test-auth.mjs` mirrors that builder and asserts the result passes `URL_RE`, recovers the slug through `extractEventSlug()` and is flagged by `isAdminUrl()`. Without that pin, a change to `URL_RE` would break the organiser view and the only symptom would be a bare `400`.

#### Logging in programmatically (`loginSession`)

There is no anonymous route to an admin page, so the only way to obtain a session is to authenticate. `loginSession(username, password)` in parse.mjs does exactly what a browser does:

1. `GET /users/login` — takes the `csrftoken` from `Set-Cookie` and the matching `csrfmiddlewaretoken` out of the form.
2. `POST /users/login` with `csrfmiddlewaretoken` + `username` + `password` and `Cookie: csrftoken=...`. The cookie has to be echoed back; without it Django answers 403 CSRF Failed.
3. **Success** is a `sessionid` cookie in the response. **Failure** is the form re-rendered with no `sessionid` and Django's stock message inside a red panel.

The red panel is the only red block on the login page and it is not a `<p class="error">` — it carries `border-red-500/20 bg-red-500/10 ... text-red-200` — so `loginFormError()` matches it by tint. The text is surfaced verbatim, so a wrong password reads as Django's own "Please enter a correct username and password. Note that both fields may be case-sensitive." rather than a generic failure.

The server is a login *proxy*, not a store. It performs the login, hands the resulting `sessionid` back to the browser, and keeps nothing: the password is used exactly once and then dropped, never written to disk, and is not retained in memory past the request. The browser keeps the session in its own `localStorage` and posts it in the `/parse` body. That gives two properties a disk store cannot have — no plaintext credential ever touches a file, and there is no single shared session, so two browsers against the same server cannot end up on one account. An expired session is simply a 401 that the UI turns into a re-login prompt. There is no stored password to re-authenticate with, and storing one is exactly the problem this arrangement exists to avoid. Signing in is the only way into the page: there is no field for pasting a session by hand, so `authError()`'s cookie instructions are advice the CLI still acts on and the UI never shows — on a 401 the page opens its own sign-in form and says so instead.

Pitfall on cookie plumbing: a browser **cannot** attach `miniheadquarters.com` cookies to a fetch of the local server (different origin), so the cookie has to be forwarded as text. That is why the UI keeps it in `localStorage` and posts it in the `/parse` body, and why the CLI takes `--cookie` / `MHQ_COOKIE`. The value is a Django session and expires (default two weeks), so it is not a permanent solution — it is the cheapest one, because it stores no password and adds no dependency.

### 2b. Parsing a page that is already on disk

The web UI can parse a page the user saved with Ctrl+S instead of fetching one. The browser reads the file and posts its bytes to `POST /parse-file`; the markup is the only input, so no session is involved and a private, unpublished or unreachable page parses exactly like a live one.

Everything after the fetch is shared through `articlesToOutput()`, so the file path and the URL path cannot drift: `parseUrl()` and `parseAdmin()` both end there, and `parseHtml()` is the file entry point. `tests/test-parse-file.mjs` pins that equivalence by parsing the same fixture both ways and comparing the players and the mini view.

A file has no URL, so two things degrade: the event **date** (read from the slug) is absent, and `event.url` is empty. The name still comes from the page `<title>`; when a saved page has none, `nameFromFile()` prettifies the file name in its place — stripping the extension first, otherwise `prettify()` cannot see the `-YYYY-MM-DD` tail it drops.

A saved **per-army admin page** has no article cards at all — its body is a single `whitespace-pre-line` paragraph — so `parseHtml()` falls through to `adminListContent()`/`oneAdminArticle()` when `splitArticles()` finds nothing. Without that, a saved organiser page would report "no army lists found" and look broken.

The endpoint is not JSON: the markup is the raw request body and the file name rides in the query string. An MHQ page is about a megabyte of quotes and backslashes, and a JSON envelope would inflate it for nothing. Its limit is 32 MB, separate from the 64 KB one the JSON control messages keep.

### 2c. Raw list text: a pasted or dropped army list

The third entry point takes list text rather than markup. Nothing is fetched and no session is used: the browser already holds the text, so it posts the bytes to `POST /parse-list` with the file name in the query string, exactly as `/parse-file` takes a saved page. The answer is the same shape `/parse` gives, so a paste, a drop and a fetched event render through one code path in the page.

Everything downstream is shared. `parseListText()` builds the same fake-article shape `adminArticle()` builds for a submitted list — an `<h2>Name : Faction</h2>` followed by the raw body — and hands it to `articlesToOutput()` via `buildPlayers()`. That is the seam that made this cheap: the structuring, the mini view and the warnings were already written for exactly this input and had never been told.

#### Where a list starts

A blob of pasted text holds one list or several, and nothing in the format says which, so the boundaries are read off the lists themselves. `listStartIndexes()` uses three signals, each of which only ever appears at the top of an army:

1. **A `+++` run opening a header block.** Requires both a closing delimiter further down *and* `+ KEY: value` lines between. That guard is not decoration: players also use long `+` rules between sections, and one of those sitting mid-preamble used to read as a list start. It was the single worst bug in this feature — a pasted list came apart into eleven pieces.
2. **A player-name key** (`PLAYER NAME`, `PLAYER`, `PSEUDO`, `NOM DU JOUEUR`, `JOUEUR`, `JOUEURS`), with or without the leading `+`. The list is freeform enough that `joueurs : Agabdir` and `Nom du joueur : Arutho` both turn up outside any header block.
3. **An army-sized total** — `Duck Fifiler (1990 points)`. A unit never costs a thousand points or more, so a line carrying one cannot be a unit declaration. This is the only signal a headerless list has.

A banner is held back until a list is already under way (`seenUnit`). A preamble carries several army-sized lines — the banner, a total, and a `Force de Frappe (2 000 Points)` eight lines below — and without that guard one army came apart into three.

**Candidates within ten lines of each other are one boundary**, merged to the earliest. Two signals routinely fire on the same list.

#### What is not a signal: a blank line

The obvious fourth candidate, and the corpus rules it out outright. All 233 lists harvested for this work contain blank lines internally, in runs of one to four (4312 singles, 465 doubles, 146 triples, 141 quads). Any threshold low enough to catch a pasted-together file also cuts a real army in half, so there is no safe one and there is not one here.

#### What it costs, measured

The corpus is 233 lists from eight events, harvested 2026-10. It is not in the tree — the `cleanup` commit deleted the generated event folders — so it was rebuilt from the live site to design this, and 42 format-diverse lists from it are now a fixture.

- **233 / 233** single lists are left whole. This is the property that matters: pasting one list is the common case, and a list that comes apart destroys data rather than merely mislabeling it.
- **250 random groups of 2–5 concatenated lists**: 199 exact, 17 right count with different units, 34 under-split, **0 over-split**. The bias is deliberate — under-splitting shows one card with a total that does not match, which the existing warning already catches; over-splitting silently truncates real armies.
- **42-list corpus**: 40 slices, 39 of them exactly one list, 3 lists absorbed by a neighbour (two Ironbuilt exports, one keyed only on `BTP:`). Pinned in the test, because it is a trade and not an accident.

Admitting `=` as a rule character was tried and reverted: Ironbuilt exports use it and carry no other start marker, but it made the corpus split 42 lists into 20 instead of 39, because `=` rules turn up inside lists too. Two lists that do not get their own slice beats twenty that do not get the right one.

#### Identity

`PLAYER NAME` → `PLAYER` → `PSEUDO` → the army banner → `Not found`. The banner matters because 140 of the 233 corpus lists carry no header at all, and it is often the only thing naming the player. It is skipped when it reads `Unnamed list` / `sans nom` / `liste test`, and when it names the force layout (`Strike Force`, `Force de Frappe`) — `isPreamble()` drops those names from unit lists, so they cannot stand in as an identity either. Team is left to `getTeamName()`, which already falls back to the banner.

#### Unrecognized format

`isUnrecognizedFormat()` fires when the text carries neither marker family, or when it parses to fewer than two units. Both used to pass silently: the second rendered as an army with nothing in it, which reads as an empty submission rather than as a list in an unknown shape. It is a warning chip, on **both** the list-text and the MHQ page path, so the tool says the same thing wherever the list came from. Two of 233 trip it — the Ironbuilt exports, which are kept in the fixture as the evidence for adding them later.

#### A latent off-by-one, fixed

`buildPlayers()` read the body as `a.slice(a.indexOf('</h2>') + 6)`. `</h2>` is **five** characters. On an MHQ page the bug was invisible, because markup or a newline always follows the heading and the lazy trim eats leading whitespace either way. A pasted list abuts the heading directly, and the first unit lost its first character every time. It is 5 now, and 121 / 121 real page parses are byte-identical before and after.

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

To reuse the whole public pipeline, `adminArticle()` turns a row into a fake article: an `<h2>Name : Faction</h2>` - which `buildPlayers()` already reads - plus the raw body. `parseNewRecruit`, `parseBullets` and `findPlusBlock` therefore need no changes, which the fixture round-trip test in `tests/test-auth.mjs` proves on a real submitted list. `parseAdmin()` is dispatched from `parseUrl()` on `isAdminUrl()`.

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
   - **Missing total points** — no declared total anywhere: not a `totalPoints` key in the `+++` header and nothing readable in the body: `> ⚠ missing total points`
   
   The declared total is read from the `+++` header when it has a `totalPoints` key (any alias in `HEADER_ALIAS`). Otherwise the body is searched: first the banner line the app export prints — `<list name> (1995 points)`, `(1995 points)`, `[2000 pts]` — then a labelled total (`Strike Force (2000 Point limit)`, `Force de Frappe (2 000 Points)`, `Points d'armée : 2000`, `2000 / 2000 pts`). Only values between 1000 and 3000 qualify, so a unit cost can never be mistaken for a total. Thousands separators are accepted: comma, period, apostrophe, narrow and non-breaking spaces.

   Measured across the 240 lists with units from 11 events, the warning ratio was 14.6% (35 warnings: 24 points mismatch, 17 force disposition not found, 2 detachment not found, 2 missing total points). That was one snapshot of the outputs the parser had produced at the time, not a live measurement: the `cleanup` commit removed the generated event folders, so nothing in the tree can reproduce the number now. Most mismatches are small (≤100 pts) and indicate player-side data issues or enhancement points not included in unit points.
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
  - the same two without the accent on Détachement, which players type both ways
  - `^Détachements\s*:\s*<name>\s*$` (newrecruit.eu French)
  - `^DETACHMENT\s*:?\s*<name>$`, for a freeform header with no `+++` block around it
  - `^<Disposition>\s*$` where Disposition is in {Reconnaissance, Take and Hold, Prendre et Tenir, Priority Assets, Atouts Prioritaires, Purge the Foe, Prey in Ambush, Disruption, Perturbation}
- **Post-header path** — when a `+++` header exists, the remaining text after the header is also checked for preamble content before unit parsing begins.

Pitfall: the army banner "<ArmyName> (2000 points)" matches the naive detachment regex. The parser requires "Points de Détachement" or "Detachment Points" explicitly, so the banner never gets captured.

## The archive: closed events, kept in the repository

A tournament that has already happened is the one thing in this project that
cannot change. Its lists are published, its date is behind us, and MHQ keeps
the page up for years. So it is the one thing worth storing instead of
fetching, and the archive is that store:

```
archive/index.json              the catalogue, one entry per archived event
archive/events/<type>--<slug>.json   the parse output, exactly what /parse returns
```

```powershell
node archive.mjs --plan          # what a harvest would consider, fetching nothing
node archive.mjs --months 12     # harvest the last 12 months of closed events
node archive.mjs --list          # what is in there
node archive.mjs --verify        # every entry still resolves to a readable file
node archive.mjs --reindex       # rebuild the index from the files on disk
```

The files are committed. That is the point: the site reads them off disk, with
no network and no CORS, exactly as it reads `index.html` on every request.

### What the site does with it

- `/parse` answers from the file. No request to MHQ, no session, no timeout to
  wait out: a 60-army event that takes about half a second live comes back in
  under 100 ms. `{"live": true}` in the body declines the cache and goes to MHQ.
- `/events` lists the archived ones without checking them, and the scan skips
  them entirely. A closed event's game and its list count are already known,
  so listing it costs nothing - which is also why the harvest, not just the
  site, stops at each event after one visit.
- Both URL shapes (`/army-lists/<slug>` and `/details/<slug>`) resolve to the
  same key, so pasting either one hits the cache.

What it must never answer: an organiser URL. It is a different page of the
same event, carrying submitted lists that were never published, so a cached
public parse in answer to one would show the wrong armies. `keyOfUrl()`
therefore matches only the plain public form, and an organiser URL still gets
a 401 asking for a session.

It is a cache, so it is allowed to be incomplete and it is allowed to be
stale. `archivedAt` says when each copy was taken, `--refresh` re-takes one,
and `live: true` wins over the cache whenever the cache is what you doubt.

### Numbers

One harvest of the 12 months before 2026-10-04: **1,201** closed tournaments in
the sitemap, **328** checked, **245** kept - a 75% hit rate, the rest being
another game or lists never published - and **57.6 MB** of committed JSON for
256 events. The whole closed catalogue, back to 2021, would be roughly 210 MB,
which is why the default harvest is bounded rather than absolute.

Each event file is compact, not indented: on a 60-list event that is 580 KB
against 837 KB pretty-printed, and pretty-printing buys nothing here. Nothing
reads these by eye, and a commit in this directory is a bulk import rather than
a reviewable diff.

### Two things the harvest gets wrong if it is not careful

**A failure is not a verdict.** A timeout says nothing about whether an event is
40k or whether its lists are out, so a failed check is never recorded as either
and the event is left unarchived for the next run. Caching a failure as
"checked, no lists" would drop the event from the picker and keep it dropped
for good. Same reason as `runScan` leaving a failed event uncached.

**The index is derived, and flushing it is where the bug was.** The index is
written every 25 events so a Ctrl-C does not throw away the run, and the first
version folded each batch in with `index.events.concat(batch)`. `concat` returns
a *new* array, so the loaded index never grew and every flush overwrote the
file with its own batch: 256 events on disk, 31 in the index, and a rerun that
would have fetched all 256 again. The fix keeps the merged array in its own
variable. `--reindex` exists because the files are the data - rebuilding the
index off them is always possible, and `--verify` checks that each entry still
resolves to a file whose `count` agrees with the entry.

### The guarantee

An archived answer is not an approximation of a live one. For the same event,
`live: true` and the cached path return byte-identical players and mini text:
the view, totals and warnings are all derived at serve time by the same code
(`viewPlayer`, `renderMini`), so the cache stores the parse output and nothing
else. `tests/test-archive.mjs` pins that round trip against the real public
fixture.

## Hosting on Vercel

One file is the deployment. `server.mjs` listens at import time and answers every route, including `/`, which it serves by reading `index.html` off disk on each request. No build step, no bundler, no dependencies. Nothing is compiled, so "static" describes `index.html` and nothing else: the function has to stay live for any part of the page to work.

Vercel picks a root entrypoint file and sends every request to it. That fact decided the shape of this deployment, and the project's own history is the record of finding it out.

- `612a374` added `api/index.js`, `vercel.json` and rewrites, and made `server.mjs` stop calling `listen()`. Every route failed.
- `a650027` put `listen()` back unconditionally after an `IS_MAIN` gate left the module loading without binding a port. Same failure, quieter.
- `7b5b27f` closed it. The build log said `✓ Build complete — Using app.mjs as the root entrypoint`, so `api/` had never been called at all. `api/`, `serve.mjs` and `vercel.json` were deleted and `app.mjs` went back to being `server.mjs`.

A handler export cannot work in this model, and rewrites cannot rescue one. There is nothing listening for a rewrite to land on.

So the entrypoint has to hold to four rules. Three of them fail silently, as a connection refused that reads like a broken deployment rather than a bug.

1. Call `listen()` unconditionally at module scope.
2. Bind `0.0.0.0`, not loopback, whenever the platform sets `PORT`. A container bound to `127.0.0.1` answers nothing at all.
3. Never call `process.exit()`. A non-zero exit is a dead function, so one bad environment variable would take down every request instead of one.
4. Assume there is no disk. `eventCache` and `filterCache` are process memory: a warm instance keeps the catalogue and every event it has checked, a cold start knows nothing.

Rules 2 and 3 had been in the tree since `678a91c`, and `bea4152` lost them, because that revert took `server.mjs` back further than it meant to. They are back as of the current `server.mjs`.

### Limits that shape the code

- **Request body.** Vercel caps request and response bodies at 4.5 MB and answers `FUNCTION_PAYLOAD_TOO_LARGE` above that. `MAX_FILE_BODY` allows 32 MB, so on a hosted instance the smaller number is the one that bites. A saved MHQ page runs about a megabyte and fits comfortably; the same page saved with every asset inlined does not.
- **Duration.** 300 s by default on Hobby, which is also the ceiling there, and 800 s on Pro. `/parse` is the slow route, one request per army on the admin views.
- **The catalogue scan.** `/events` is the expensive one. The sitemap fetch is the single slowest step, which server.mjs puts at about 9 s, and checking every event cannot happen inside one invocation. `FILTER_BATCH` (40) and `FILTER_CONCURRENCY` (16) exist for that reason: a bounded scan returns what it managed to check and the page polls for the rest, while an unbounded one gets killed mid-flight and returns nothing at all.
- **Disk.** Rule 4 above is about caching, not about the filesystem: the deployment can read its own files, which is how `index.html` is served per request and how the archive is read. The archive adds 57.6 MB of JSON to what gets deployed. It is read on demand, one file per `/parse`, so it costs function memory only for the event being shown, but it does have to be inside the deployment for the cache to mean anything.

### Where the checkout stands

There is no `package.json` and no `vercel.json`, and `.vercel/project.json` holds placeholder ids, so this tree is not linked to a real project. `vercel link` is the first step of a deploy. The parser needs Node 18 or newer and nothing else, so Vercel's default runtime is enough.

Tests are plain `node`. There is no runner to install:

```
node tests/test-auth.mjs
node tests/test-parse-file.mjs
node tests/test-list-text.mjs
node tests/test-archive.mjs
```

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
- Army-list HTML is not cached. Every parse re-fetches, so two runs of the same URL can differ if the organiser edits a list in between. The catalogue behind `/events` is the exception: `listEvents()` holds the sitemap in memory for hours and the per-event check results in `filterCache` for an hour.
- The same applies to list text: `parseListText()` is deterministic, and `tests/fixtures/lists.json` is the offline corpus to diff against. The full 233-list corpus is not in the tree - `cleanup` removed the generated event folders - so `lists.json` holds the 42 format-diverse lists selected from it, each with the body and what it should parse to.
- To diff two runs, save the HTML and feed both copies to `parseHtml()`. Do not patch `fetchHTML()` to read a file: `parseHtml()` already takes markup you have, and the **From file** button in the page calls it through `POST /parse-file`.