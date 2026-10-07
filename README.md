# Analyseur de listes d'armées MHQ

Récupère une page de listes d'armées sur [MiniHeadQuarters](https://miniheadquarters.com) et restitue les armées en JSON structuré ainsi qu'une vue « mini » compacte, une ligne par unité. Requiert Node 18 ou supérieur.

## Démarrage rapide

```powershell
node tools\\mhq-parser\\parse.mjs "https://miniheadquarters.com/tournaments/team/army-lists/<event-slug>"
```

L'argument est une URL MHQ **ou** le chemin d'un fichier de liste. Le répertoire de sortie par défaut est `<event-slug>/` relativement au script (le nom du fichier, pour une liste). Les deux fichiers y sont écrits :

- `<event-slug>\\mhq_army_lists.json`  (structuré : joueurs, unités, en-têtes)
- `<event-slug>\\mhq_army_lists.mini.md`  (vue Markdown compacte)

Remplacer le répertoire de sortie par défaut :

```powershell
node tools\\mhq-parser\\parse.mjs "https://miniheadquarters.com/tournaments/team/army-lists/<event-slug>" --out-dir data\\mhq\\<slug>
```

## Interface web

Un petit serveur local, sans aucune dependance, sert une page unique qui appelle le parseur :

```powershell
node tools\\mhq-parser\\server.mjs
```

Coller ensuite l'URL de l'evenement dans la page http://127.0.0.1:8787 puis lancer l'analyse. Le bouton **From file** ouvre l'explorateur et analyse directement une page MiniHeadQuarters deja enregistree sur le disque (Ctrl+S dans le navigateur) : aucune requete vers le site et aucune session, donc une page privee, non publiee ou hors ligne s'analyse comme les autres. Le meme bouton accepte une **liste d'armée** en `.txt` ou `.md`, **Paste** ouvre une fenêtre pour coller du texte, et un fichier lâché n'importe où sur la page est pris en charge. **Browse** reste la facon de choisir un tournoi. Les listes s'affichent groupees par equipe ; chaque armee indique son total de points (calcule vs declare), son detachement, ses dispositions de force et ses avertissements, suivis du tableau des unites. La recherche texte, le filtre par faction et l'affichage restreint aux avertissements filtrent a la volee ; `Copy mini` copie la vue Markdown et `Download JSON` telecharge l'equivalent du fichier du parseur.

L'analyse passe toujours par le serveur : le navigateur ne peut pas interroger miniheadquarters.com directement faute d'en-tete CORS. La page est relue a chaque requete, modifier index.html ne demande pas de redemarrage.

Options du serveur :

| Option | Valeur par defaut | Role |
|------|---------|---------|
| **--port <n>** | 8787 | Port d'ecoute (variable `PORT`) |
| **--host <h>** | 127.0.0.1 | Interface d'ecoute (variable `HOST`) |

Points de terminaison : `GET /` (la page), `GET /health`, `POST /parse` avec un corps JSON "{"url":"...", "cookie":"..."}" — la session vient de `POST /login` (ou de la variable `MHQ_COOKIE`) et est nécessaire pour les vues organisateur/admin — et `POST /parse-file?name=<fichier>`, dont le corps est la page HTML brute (32 Mo maximum) et qui repond comme `/parse`. Enfin `POST /parse-list?name=<fichier>`, dont le corps est le texte d'une liste et qui repond de la meme maniere. `POST /feedback`, dont le corps JSON `{"body":"..."}` (la première ligne devient le titre) crée directement une issue sur GitHub lorsque `GITHUB_TOKEN` est défini, et renvoie sinon un lien `github.com/<dépôt>/issues/new` prérempli — celui qu'ouvre le bouton **Feedback** du pied de page. `FEEDBACK_REPO` change le dépôt visé (`BOGOSbot/mhq-parser` par défaut). Un evenement present dans `archive/` est repondu par `/parse` depuis le disque, sans requete vers miniheadquarters.com ; `"live": true` dans le corps passe outre.

## Options

| Option | Valeur par défaut | Rôle |
|------|---------|---------|
| \ <url> | obligatoire | URL de listes d'armées : `…/tournaments/{team\|individual\|side-by-side}/{army-lists\|details}/<slug>`, ou la vue organisateur `…/administrate/<slug>/{army-lists\|details}` |
| \ <fichier> | obligatoire | Chemin d'une liste : `.txt` / `.md` (texte), ou `.html` (page MiniHeadQuarters enregistrée) |
| **--out-dir <dir>** | `<event-slug>/` | Où écrire les deux fichiers |
| **--json <name>** | mhq_army_lists.json | Nom du fichier JSON |
| **--mini <name>** | mhq_army_lists.mini.md | Nom du fichier mini |
| **--cookie <val>** | `MHQ_COOKIE` (env.) | En-tête `Cookie` pour les vues organisateur/admin |

## Une liste en texte

Une liste d'armée peut être passée directement, sans passer par MHQ : **From file** pour un `.txt` ou `.md`, **Paste** pour du texte collé, ou un fichier lâché n'importe où sur la page. Aucune requête, aucune session.

Un fichier peut contenir **une seule liste ou plusieurs**, sans aucun séparateur : le corpus de test en compte 42, collées les unes aux autres. L'analyseur trouve les frontières lui-même, à partir de trois signaux qui n'apparaissent qu'en tête d'armée :

1. un bloc `+++` ouvrant un en-tête ;
2. une clé de nom de joueur (`+ PLAYER NAME:`, `+ PLAYER`, `+ PSEUDO:`, `Nom du joueur :`) ;
3. un total de valeur armée — `Duck Fifiler (1990 points)`. Une unité ne coûte jamais 1000 points, donc cette ligne n'en est pas une.

Une ligne à vide **n'est pas** un signal : les 233 listes du corpus en contiennent toutes, par séries de deux à quatre. Tout seuil assez bas pour attraper un fichier collé coupe aussi une armée par la moitié.

Les frontières ne sont coupées qu'à ces endroits. Sur 42 listes réelles concaténées, l'analyseur en retrouve 39 intactes et laisse 3 listes sans repère absorbées par leur voisine — jamais l'inverse : une liste n'est jamais coupée en deux.

Le format est détecté liste par liste. Un texte qui ne porte aucun des deux familles de marqueurs, ou qui rend moins de deux unités, affiche l'avertissement **Unrecognized format** — sur une page MHQ comme sur du texte collé. Deux listes sur 233 le déclenchent : des exports « Ironbuilt », que l'analyseur ne sait pas structurer.

L'identité vient d'une chaîne : `PLAYER NAME` → `PLAYER` → `PSEUDO` → la bannière d'armée (`Duck Fifiler (1990 points)`) → `Not found`. La bannière est ignorée quand elle dit `Unnamed list` ou `Strike Force`.

## Vues organisateur/admin

Les URLs `…/tournaments/<type>/administrate/<slug>/army-lists` sont la vue organisateur : elles affichent les listes avant publication. Elles demandent une session connectée.

Interrogées sans connexion, elles renvoient la page de connexion avec le code **200** (pas de redirection 302). Sans gestion explicite l'analyseur ne trouve aucune armée et affiche l'erreur trompeuse « listes pas encore publiées ». Il détecte maintenant la page de connexion et renvoie un message explicite avec la marche à suivre.

Le site tourne sous Django : une `GET` pose un cookie `csrftoken`, et la connexion est un `POST /users/login` avec `csrfmiddlewaretoken` + `username` + `password` (pas de SSO, pas de captcha).

Sans stocker de mot de passe :

```powershell
node parse.mjs "https://miniheadquarters.com/tournaments/team/administrate/<slug>/army-lists" --cookie "sessionid=...; csrftoken=..."
```

Le cookie se copie dans DevTools -> Network (en-tête `Cookie` d'une requête authentifiée) ou DevTools -> Application -> Cookies -> miniheadquarters.com. La variable `MHQ_COOKIE` fonctionne aussi.

**Connexion depuis l'interface web (recommandé).** Il n'existe pas de voie anonyme pour obtenir une session, donc l'interface se connecte à votre place. La demande n'apparaît que là où une session est réellement nécessaire : coller une URL organisateur, ou voir une analyse refusée en 401. Les champs identifiant et mot de passe sont alors affichés à côté ; il suffit de saisir le mot de passe et de valider avec **Sign in** (Entrée fonctionne aussi). Le nom d'utilisateur est mémorisé, donc une session expirée ne coûte qu'un champ. Le serveur n'est qu'un intermédiaire : il effectue la connexion Django une fois et renvoie la session au navigateur, où elle est conservée dans `localStorage` et envoyée à chaque analyse. Le mot de passe n'est utilisé qu'une fois puis jeté ; il n'est jamais écrit sur le disque du serveur, et il n'y a pas de session commune, donc deux navigateurs ne peuvent pas se retrouver sur le même compte. Une session expirée renvoie une 401 et rouvre la connexion ; l'URL qui a échoué est rejouée automatiquement une fois la session obtenue.

### Mise en page admin et statut

La vue admin n'est pas la vue publique. La page d'événement est un **tableau** d'une ligne par armée soumise (utilisateur, équipe, faction, dates, statut, lien) ; le texte de la liste n'y figure pas, il est sur une page propre à chaque armée. L'analyse passe donc par l'index puis par chaque page d'armée, soit un appel HTTP par armée. Une URL d'armée seule fonctionne aussi :

`https://miniheadquarters.com/tournaments/<type>/administrate/army-lists/<id>`

Chaque armée porte le statut de sa ligne — `Pending validation`, `Accepted` ou `Rejected` — en pastille sur la carte (ambre, vert, rouge) et filtrable via « All statuses » dans la barre. Le mini Markdown l'inscrit entre crochets après la faction. Le JSON embarque aussi `adminId`, `adminUrl`, `lastModified`, `firstSubmission` et `lastReviewBy`.

## Les événements fermés sont archivés

Un tournoi déjà passé ne change plus : ses listes sont publiées, sa date est derrière nous, et MHQ garde la page des années. C'est le seul élément du projet qui mérite d'être **gardé** plutôt que récupéré. L'archive vit dans le dépôt :

- `archive/index.json` - le catalogue, une entrée par événement archivé ;
- `archive/events/<type>--<slug>.json` - l'analyse complète, exactement ce que `/parse` renvoie.

```powershell
node tools\\mhq-parser\\archive.mjs --plan          # ce qu'une récolte considérerait, sans rien récupérer
node tools\\mhq-parser\\archive.mjs --months 12     # récolter les 12 derniers mois
node tools\\mhq-parser\\archive.mjs --list          # ce qu'il y a dedans
node tools\\mhq-parser\\archive.mjs --verify        # chaque entrée pointe encore vers un fichier lisible
node tools\\mhq-parser\\archive.mjs --reindex       # reconstruire l'index depuis les fichiers
```

Récolter est reprenable : ce qui est déjà dans l'index n'est pas récupéré une seconde fois, donc une récolte interrompue se relance sans dommage. Un échec n'est jamais enregistré comme un verdict : un délai dépassé ne dit rien du jeu ni des listes, l'événement reste donc à récolter.

**Le site s'en sert comme cache.** `/parse` sur un événement archivé répond depuis le fichier : aucune requête vers MHQ, aucune session, aucun délai à attendre (60 armées en moins de 100 ms, contre une demi-seconde en direct). `{"live": true}` dans le corps de la requête passe outre et va chercher la page. `/events` liste les événements archivés sans les vérifier et **le scan les saute** : leur jeu et leur nombre de listes sont déjà connus.

Une URL organisateur n'est **jamais** servie depuis l'archive. C'est une autre page du même événement, avec des listes soumises et jamais publiées : y répondre montrerait les mauvaises armées. Elle demande toujours une session.

Ce qui est archivé n'est pas une approximation d'une réponse en direct : pour un même événement, les deux renvoient des joueurs et un mini texte identiques, l'octet près. La copie ne peut dater que d'avant la fermeture ; chaque entrée porte sa date (`archivedAt`), `--refresh` en reprend une, et `live: true` l'emporte sur le cache quand c'est le cache qu'on doute.

L'archive garde **un an** d'événements fermés, et l'index tient aussi la liste des événements **refusés** — un autre jeu, ou des listes jamais publiées. Un refus a coûté une requête : le retenir évite de la refaire, y compris au démarrage à froid d'une instance. Un événement **qui n'a pas encore eu lieu** n'est jamais servi depuis le disque, car ses listes arrivent encore, et le bouton **Refresh** de la barre de résultats force une relecture depuis MHQ pour l'événement affiché.

Une récolte des 12 mois : 1 201 tournois fermés dans le sitemap, 328 vérifiés, **245 gardés** (les autres sont un autre jeu, ou des listes jamais publiées), **57.6 Mo** de JSON pour 256 événements. Tout l'historique depuis 2021 pèserait environ 210 Mo, ce qui explique que la récolte soit bornée par défaut plutôt qu'absolue.

Dans l'interface, une ligne archivée est marquée d'un liseré bleu et son nombre de listes s'affiche en bleu ; après l'avoir ouverte, la ligne d'état dit d'où elle vient.

## Sortie

### JSON

Le fichier JSON contient trois clés de premier niveau :

- event : { name, date, url }
- count : nombre d'armées
- players : tableau d'objets joueur

Chaque objet joueur contient :

- name, faction, teamName, format
- header : le bloc clé-valeur délimité par `+++` (null s'il est absent)
- units : tableau d'unités analysées
- bodyRest : texte brut pour inspection de repli

`bodyRest` est conservé à l'identique pour chaque joueur. Tout ce que l'analyseur n'a pas structuré reste récupérable depuis ce champ.

### Mini Markdown

- `Unrecognized format` signale une liste que l'analyseur n'a pas reconnue comme un format connu : aucun des deux marqueurs, ou moins de deux unités.
- `⚠ points mismatch` signale une divergence entre le total calculé et le total déclaré.
- `⚠ over points limit` signale que la seule valeur lisible est la taille de partie (`Strike Force (2000 points)`) et que l'armée la dépasse ; rester en dessous est normal et ne produit aucun avertissement.
- `⚠ missing total points` signale qu'aucun total déclaré n'est lisible, ni dans l'en-tête `+++`, ni dans le corps de la liste (bannière `<nom> (1995 points)` comprise).
- Les avertissements apparaissent sous l'en-tête du joueur.
- `+` sépare les unités à l'intérieur d'un groupe attaché.
- Préfixe `Nx` = N copies identiques regroupées.
- Préfixe `N` (sans x) = nombre de figurines dans l'unité.
- `[nom]` = amélioration appliquée à cette unité.
- **Équipe :** provient de la carte d'équipe englobante sur la page MHQ.

## Formats pris en charge

Deux formats principaux sont reconnus automatiquement, avec plusieurs sous-variantes :

| Format | Marqueur |
|--------|--------|
| **bullets** | Déclarations d'unité ` (N pts) ` , sous-figurines à puces |
| **newrecruit** | Déclarations d'unité `[Npts]`, préfixe à la française `Catégorie N :` |

Formats supplémentaires de déclaration d'unité :
- `+ NOM D'UNITÉ (count)` — unité dont les points sont à la ligne suivante
- `Nom d'unité : N pts` — style français avec deux-points
- `1x Nom d'unité N pts` — format simple sans parenthèses
- `• 1x Nom d'unité (N pts)` — puce avec points sur la même ligne

Séparateurs de section : en-têtes Markdown `##`/`###`, onglets à la française `\t--- Section ---`, en-têtes de catégorie (PERSONNAGES, LIGNE, BATTLELINE, Héros épiques, etc.).

Les en-têtes peuvent s'étendre sur plusieurs sections délimitées par `+++`. L'analyseur fusionne les sections consécutives en un seul bloc d'en-tête.

## Format source (exporter)

`format` dit quel lecteur a structuré la liste (`bullets`, `newrecruit`) ; `exporter` dit quel outil a écrit le texte, ce qui est la vraie information sur le corpus. Chaque liste porte `exporter` et, quand l'outil l'imprime, `exporterVersion`.

| exporter | part du corpus | signature |
|----------|---------------|-----------|
| `app` | 90 % | en-tête `+ FACTION KEYWORD:`, lignes `Char1: 1x … (N pts):`, ou catégories en majuscules ; `Exported with App Version:` / `Exporté avec la Version de l'Appli :` / `END OF ROSTER` |
| `newrecruit` | 7,5 % | points entre crochets `[Npts]` ; `Created with newrecruit.eu` |
| `legacy` | 0,1 % | exports 9e édition : `== DETACHEMENT … ==`, `QG 1 :`, `[8PP, 175pts]` |
| `armylistnetwork` | 0,8 % | `### Détachements :`, `Total : N points - N figurines - N unités`, URL `40k.armylistnetwork.com` |
| `warorgan`, `battlebase`, `ironbuilt` | < 0,2 % | `Created with WarOrgan`, `Exported with BattleBase`, `https://ironbuilt.app/?s=…` |
| `unknown` | 1,2 % | rien de tout cela — notes libres, brouillons, Kill Team |

La dernière ligne est la signature la plus fiable, mais **18 % seulement** des 7 128 listes de l'année en cours en portent une : l'essentiel se reconnaît à la structure. `node formats.mjs` rejoue l'analyse sur l'archive ; le détail est dans [formats.md](./formats.md).

## Taux d'avertissements

Sur les 240 listes avec unités présentes dans ce dépôt (11 événements), l'analyseur produit 35 avertissements (14,6 %).

| Avertissement | Nombre | Cause |
|---------|-------|-------|
| Points mismatch | 24 | Total déclaré ≠ total calculé |
| Force disposition not found | 17 | Disposition de la force introuvable |
| Detachment not found | 2 | Détachement introuvable |
| Missing total points | 2 | Aucun total déclaré lisible dans l'en-tête ni dans le corps |

## Prérequis

- Node.js 18 ou supérieur (pour `https.get()` et `URL`).
- Aucune dépendance npm. Standard library uniquement.

## Fichiers

- `.mjs` - l'analyseur + le formatteur
- **archive.mjs** - la recolte des evenements fermes, et le magasin que le site relit
- **archive/** - les evenements fermes deja recoltes, un fichier JSON par tournoi
- **README.md** - ce fichier
- **developer-doc.md** - comment fonctionne l'analyseur et pourquoi
- **translate.md** - dictionnaire FR/EN utilisé par l'analyseur (balises de rôle, dispositions, en-têtes de catégorie, mots-clés de puces, noms d'améliorations)
- `tests/fixtures/lists.json` - corpus de 42 listes réelles, avec pour chacune ce qu'elle doit produire
- `tests/test-list-text.mjs` - listes collées : découpage, identité, format non reconnu

---

# MHQ Army-List Parser (English)

Pull a [MiniHeadQuarters](https://miniheadquarters.com) army-lists page and dump the armies as structured JSON plus a compact "one line per unit" mini view. Node 18 or higher.

## Quick start

```powershell
node tools\\mhq-parser\\parse.mjs "https://miniheadquarters.com/tournaments/team/army-lists/<event-slug>"
```

The argument is an MHQ URL **or** the path to a list file. The default output directory is `<event-slug>/` relative to the script - the file's own name, for a list. Both files go there:

- `<event-slug>\\mhq_army_lists.json`  (structured: players, units, headers)
- `<event-slug>\\mhq_army_lists.mini.md`  (compact Markdown view)

Override the output directory:

```powershell
node tools\\mhq-parser\\parse.mjs "https://miniheadquarters.com/tournaments/team/army-lists/<event-slug>" --out-dir data\\mhq\\<slug>
```

## Web UI

A small local server, with no dependencies at all, serves a single page that calls the parser:

```powershell
node tools\\mhq-parser\\server.mjs
```

Paste the event URL into http://127.0.0.1:8787 and press **Parse**. **Browse** opens a picker of recent tournaments, and **From file** opens the file explorer to parse a MiniHeadQuarters page you already saved (Ctrl+S in your browser): the markup is the whole input, so no request goes to the site and no session is used — a private, unpublished or offline page parses like any other. The lists are grouped by team; each army shows its points total (parsed vs declared), its detachment, its force dispositions and its warnings, followed by the unit table. Text search, the faction filter and the warnings-only view filter as you type; `Copy mini` copies the Markdown view and `Download JSON` downloads what the parser would have written.

Parsing always goes through the server: the browser cannot fetch miniheadquarters.com directly, there being no CORS header. The page is re-read on every request, so editing index.html needs no restart.

| Flag | Default | Purpose |
|------|---------|---------|
| **--port <n>** | 8787 | Listening port (`PORT`) |
| **--host <h>** | 127.0.0.1 | Listening interface (`HOST`) |

Endpoints: `GET /` (the page), `GET /health`, `POST /parse` with a JSON body "{"url":"...", "cookie":"..."}" — the session comes from `POST /login` (or the `MHQ_COOKIE` variable) and is needed for organiser/admin views — `POST /parse-file?name=<file>`, whose body is the raw HTML page (32 MB limit) and which answers like `/parse`, and `POST /parse-list?name=<file>`, whose body is pasted list text and which answers the same way. `POST /feedback`, whose JSON body `{"body":"..."}` (the first line becomes the title) files an issue on GitHub when `GITHUB_TOKEN` is set, and otherwise returns a prefilled `github.com/<repo>/issues/new` link — the one the footer's **Feedback** button opens. `FEEDBACK_REPO` overrides the target repository (`BOGOSbot/mhq-parser` by default). An event held in `archive/` is answered by `/parse` straight off disk, with no request to miniheadquarters.com; `"live": true` in the body declines the cache.

## Flags

| Flag | Default | Purpose |
|------|---------|---------|
| \ <url> | required | Army-lists URL: `…/tournaments/{team\|individual\|side-by-side}/{army-lists\|details}/<slug>`, or the organiser view `…/administrate/<slug>/{army-lists\|details}` |
| \ <file> | required | Path to a list: `.txt` / `.md` (text), or `.html` (a saved MiniHeadQuarters page) |
| **--out-dir <dir>** | `<event-slug>/` | Where to write both files |
| **--json <name>** | mhq_army_lists.json | JSON filename |
| **--mini <name>** | mhq_army_lists.mini.md | Mini filename |
| **--cookie <val>** | `MHQ_COOKIE` (env.) | `Cookie` header for organiser/admin views |

## A list as text

An army list can go straight in, without MHQ: **From file** for a `.txt` or `.md`, **Paste** for pasted text, or a file dropped anywhere on the page. No request, no session.

A file can hold **one list or several**, with no separator at all: the test corpus is 42 of them, concatenated. The parser finds the boundaries itself, off three signals that only ever appear at the top of an army:

1. a `+++` block opening a header;
2. a player-name key (`+ PLAYER NAME:`, `+ PLAYER`, `+ PSEUDO:`, `Nom du joueur :`);
3. an army-sized total — `Duck Fifiler (1990 points)`. A unit never costs a thousand points, so that line is not a unit.

A blank line is **not** a signal: all 233 lists in the corpus contain blank lines, in runs of two to four. Any threshold low enough to catch a pasted-together file also cuts a real army in half.

Lists are only cut at those places. Of 42 real lists concatenated, the parser recovers 39 intact and lets 3 marker-less lists be absorbed by a neighbour — never the reverse: a list is never cut in two.

The format is detected per list. Text carrying neither marker family, or parsing to fewer than two units, gets an **Unrecognized format** warning — on an MHQ page as much as on pasted text. Two lists in 233 trip it: "Ironbuilt" exports, which the parser cannot structure.

Identity comes off a chain: `PLAYER NAME` → `PLAYER` → `PSEUDO` → the army banner (`Duck Fifiler (1990 points)`) → `Not found`. The banner is skipped when it reads `Unnamed list` or `Strike Force`.

## Organiser / admin views

The `…/tournaments/<type>/administrate/<slug>/army-lists` URL is the organiser's view: it shows lists before they are published, and it requires a logged-in session.

Fetched unauthenticated it returns the login page with status **200** (not a 302). Left unhandled the parser finds no armies and reports the misleading 'lists not published yet'. It now detects the login page and says so, with the steps to unblock.

The site is Django: a `GET` sets a `csrftoken` cookie and login is a `POST /users/login` with `csrfmiddlewaretoken` + `username` + `password` (no SSO, no captcha).

The simplest option, storing no password:

```powershell
node parse.mjs "https://miniheadquarters.com/tournaments/team/administrate/<slug>/army-lists" --cookie "sessionid=...; csrftoken=..."
```

Copy the cookie from DevTools -> Network (the `Cookie` request header of any authenticated request) or DevTools -> Application -> Cookies -> miniheadquarters.com. The `MHQ_COOKIE` environment variable works too.

**Logging in from the web UI (recommended).** There is no anonymous way to obtain a session, so the UI logs in for you. The ask appears only where a session is actually needed: paste an organiser URL, or get a 401 back from a parse. The username and password fields are then sitting right there — type the password and press **Sign in** (Enter works too). The username is remembered, so an expired session costs one field rather than both. The server is only a proxy — it performs the Django login once and hands the session back to your browser, where it is kept in `localStorage` and sent with every parse. Your password is used once and then discarded; it is never written to the server's disk, and there is no shared session, so two browsers cannot end up on the same account. An expired session is a 401 and a re-login prompt (about two weeks of life).

### Admin layout and status

The admin view is not the public view. The event page is a **table** with one row per submitted army (user, team, faction, dates, status, link); the list body is not on it, it lives on a per-army page. A parse therefore walks the index and then each army page, one HTTP request per army. A single army's URL also works on its own:

`https://miniheadquarters.com/tournaments/<type>/administrate/army-lists/<id>`

Each army carries the status of its row — `Pending validation`, `Accepted` or `Rejected` — as a badge on the card (amber, green, red) and filterable via "All statuses" in the bar. The mini Markdown appends it in brackets after the faction. The JSON also carries `adminId`, `adminUrl`, `lastModified`, `firstSubmission` and `lastReviewBy`.

## Closed events are kept in this repository

A tournament that has already happened cannot change: its lists are out, its date is behind us, and MHQ keeps the page for years. That makes it the one thing here worth **keeping** rather than fetching, so the archive lives in the repository:

- `archive/index.json` - the catalogue, one entry per archived event;
- `archive/events/<type>--<slug>.json` - the full parse, exactly what `/parse` returns.

```powershell
node tools\\mhq-parser\\archive.mjs --plan          # what a harvest would consider, fetching nothing
node tools\\mhq-parser\\archive.mjs --months 12     # harvest the last 12 months of closed events
node tools\\mhq-parser\\archive.mjs --list          # what is in there
node tools\\mhq-parser\\archive.mjs --verify        # every entry still resolves to a readable file
node tools\\mhq-parser\\archive.mjs --reindex       # rebuild the index from the files on disk
```

A harvest is resumable: anything already indexed is not fetched again, so a run that dies halfway costs a rerun rather than the whole job. A failure is never recorded as a verdict either - a timeout says nothing about the game or the lists - so that event is left for the next run.

**The site reads it as a cache.** `/parse` on an archived event answers from the file: no request to MHQ, no session, no timeout to wait out (60 armies in under 100 ms, against about half a second live). `{"live": true}` in the request body declines the cache and fetches the page. `/events` lists the archived ones without checking them, and the scan skips them outright: their game and their list count are already known.

An organiser URL is **never** served from the archive. It is a different page of the same event, carrying submitted lists that were never published, so answering one would show the wrong armies; it still asks for a session.

What is archived is not an approximation of a live answer: for the same event both return identical players and identical mini text, byte for byte. A copy can only predate the event closing, every entry carries its date (`archivedAt`), `--refresh` re-takes one, and `live: true` wins over the cache whenever the cache is what you doubt.

The archive keeps **one year** of closed events, and the index also holds the events it **refused** — another game, or lists never published. A refusal cost a request, so remembering it saves the next one, including on a cold serverless start. An event that **has not happened yet** is never answered from disk, because its lists are still arriving, and the **Refresh** button in the result toolbar forces a re-read from MHQ for the event on screen.

One harvest of the last 12 months: 1,201 closed tournaments in the sitemap, 328 checked, **245 kept** (the rest are another game, or lists never published), **57.6 MB** of JSON for 256 events. The whole history back to 2021 would come to roughly 210 MB, which is why the harvest is bounded by default rather than absolute.

In the UI an archived row is marked with a blue edge and its list count in blue, and after opening one the status line says where it came from.

## Output

### JSON

The JSON file has three top-level keys:

- event: { name, date, url }
- count: number of armies
- players: array of player objects

Each player object has:

- name, faction, teamName, format
- header: the `+++` key-value block (null if absent)
- units: array of parsed units
- bodyRest: raw text for fallback inspection

`bodyRest` is preserved verbatim per player. Anything the parser did not structure is still recoverable from there.

### Mini Markdown

- `Unrecognized format` marks a list the parser did not recognise as a known format: neither marker family, or fewer than two units.
- `⚠ points mismatch` warns when the parsed total differs from the declared total.
- `⚠ over points limit` warns when the only readable figure is the battle size (`Strike Force (2000 points)`) and the army exceeds it; being under it is normal and warns nothing.
- `⚠ missing total points` warns when no declared total is readable, neither in the `+++` header nor in the body (banner `<name> (1995 points)` included).
- Warnings appear under the player header.
- `+` separates units inside an attached group.
- `Nx` prefix = N identical copies collapsed.
- `N` prefix (no x) = model count within the unit.
- `[name]` = enhancement applied to that unit.
- **Team:** comes from the enclosing team card on the MHQ page.

## Supported formats

Two primary formats are recognised automatically, with several sub-variantes:

| Format | Marker |
|--------|--------|
| **bullets** | ` (N pts) ` unit declarations, bullet sub-models |
| **newrecruit** | `[Npts]` unit declarations, French-style `Category N :` prefix |

Additional unit declaration formats:
- `+ UNIT NAME (count)` — unit with points on next line
- `Unit Name : N pts` — French-style with colon
- `1x Unit Name N pts` — simple format without parentheses
- `• 1x Unit Name (N pts)` — bullet with points on same line

Section separators: `##`/`###` markdown headers, `\t--- Section ---` French-style tabs, category headers (PERSONNAGES, LIGNE, BATTLELINE, Héros épiques, etc.).

Headers may span multiple `+++`-delimited sections. The parser merges consecutive sections into a single header block.

## Source format (exporter)

`format` says which reader structured a list (`bullets`, `newrecruit`); `exporter` says which tool wrote the text, which is the real fact about the corpus. Every list carries `exporter` and, when the tool prints one, `exporterVersion`.

| exporter | share of corpus | signature |
|----------|----------------|-----------|
| `app` | 90% | `+ FACTION KEYWORD:` header, `Char1: 1x … (N pts):` lines, or ALL-CAPS categories; `Exported with App Version:` / `Exporté avec la Version de l'Appli :` / `END OF ROSTER` |
| `newrecruit` | 7.5% | bracketed points `[Npts]`; `Created with newrecruit.eu` |
| `legacy` | 0.1% | 9th-edition exports: `== DETACHEMENT … ==`, `QG 1 :`, `[8PP, 175pts]` |
| `armylistnetwork` | 0.8% | `### Détachements :`, `Total : N points - N figurines - N unités`, `40k.armylistnetwork.com` URL |
| `warorgan`, `battlebase`, `ironbuilt` | < 0.2% | `Created with WarOrgan`, `Exported with BattleBase`, `https://ironbuilt.app/?s=…` |
| `unknown` | 1.2% | none of the above — freeform notes, drafts, Kill Team |

The last line is the strongest signature, but **only 18%** of the 7,128 lists in the current window carry one: the rest are recognised by shape. `node formats.mjs` replays the analysis over the archive; the full write-up is in [formats.md](./formats.md).

## Warning ratio

Across the 240 lists with units in this repository (11 events), the parser produces 35 warnings (14.6%).

| Warning | Count | Cause |
|---------|-------|-------|
| Points mismatch | 24 | Declared total ≠ parsed total |
| Force disposition not found | 17 | Force disposition not found in the preamble |
| Detachment not found | 2 | Detachment not found in the preamble |
| Missing total points | 2 | No declared total in the header or anywhere in the body |

## Requirements

- Node.js 18 or higher (for `https.get()` and `URL`).
- No npm dependencies. stdlib only.

## Files

- `.mjs` - the parser + formatter
- **archive.mjs** - the closed-event harvest, and the store the site reads back
- **archive/** - the closed events harvested so far, one JSON file per tournament
- **README.md** - this file
- **developer-doc.md** - how the parser works and why
- **translate.md** - FR/EN dictionary used by the parser (role tags, dispositions, category headers, bullet keywords, enhancement names)
- **tests/fixtures/lists.json** - 42 real lists, each with what it should parse to
- **tests/test-list-text.mjs** - concatenated lists: splitting, identity, unrecognised format
