# Analyseur de listes d'armées MHQ

Récupère une page de listes d'armées sur [MiniHeadQuarters](https://miniheadquarters.com) et restitue les armées en JSON structuré ainsi qu'une vue « mini » compacte, une ligne par unité. Requiert Node 18 ou supérieur.

## Démarrage rapide

```powershell
node tools\\mhq-parser\\parse.mjs "https://miniheadquarters.com/tournaments/team/army-lists/<event-slug>"
```

L'URL est obligatoire. Le répertoire de sortie par défaut est `<event-slug>/` relativement au script. Les deux fichiers y sont écrits :

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

Coller ensuite l'URL de l'evenement dans la page http://127.0.0.1:8787 puis lancer l'analyse. Les listes s'affichent groupees par equipe ; chaque armee indique son total de points (calcule vs declare), son detachement, ses dispositions de force et ses avertissements, suivis du tableau des unites. La recherche texte, le filtre par faction et l'affichage restreint aux avertissements filtrent a la volee ; `Copy mini` copie la vue Markdown et `Download JSON` telecharge l'equivalent du fichier du parseur.

L'analyse passe toujours par le serveur : le navigateur ne peut pas interroger miniheadquarters.com directement faute d'en-tete CORS. La page est relue a chaque requete, modifier index.html ne demande pas de redemarrage.

Options du serveur :

| Option | Valeur par defaut | Role |
|------|---------|---------|
| **--port <n>** | 8787 | Port d'ecoute (variable `PORT`) |
| **--host <h>** | 127.0.0.1 | Interface d'ecoute (variable `HOST`) |

Points de terminaison : `GET /` (la page), `GET /health` et `POST /parse` avec un corps JSON "{"url":"...", "cookie":"..."}" — le champ `cookie` (ou la variable `MHQ_COOKIE`) est nécessaire pour les vues organisateur/admin.

## Options

| Option | Valeur par défaut | Rôle |
|------|---------|---------|
| \ <url> | obligatoire | URL de listes d'armées : `…/tournaments/{team\|individual\|side-by-side}/{army-lists\|details}/<slug>`, ou la vue organisateur `…/administrate/<slug>/{army-lists\|details}` |
| **--out-dir <dir>** | `<event-slug>/` | Où écrire les deux fichiers |
| **--json <name>** | mhq_army_lists.json | Nom du fichier JSON |
| **--mini <name>** | mhq_army_lists.mini.md | Nom du fichier mini |
| **--cookie <val>** | `MHQ_COOKIE` (env.) | En-tête `Cookie` pour les vues organisateur/admin |

## Vues organisateur/admin

Les URLs `…/tournaments/<type>/administrate/<slug>/army-lists` sont la vue organisateur : elles affichent les listes avant publication. Elles demandent une session connectée.

Interrogées sans connexion, elles renvoient la page de connexion avec le code **200** (pas de redirection 302). Sans gestion explicite l'analyseur ne trouve aucune armée et affiche l'erreur trompeuse « listes pas encore publiées ». Il détecte maintenant la page de connexion et renvoie un message explicite avec la marche à suivre.

Le site tourne sous Django : une `GET` pose un cookie `csrftoken`, et la connexion est un `POST /users/login` avec `csrfmiddlewaretoken` + `username` + `password` (pas de SSO, pas de captcha).

Sans stocker de mot de passe :

```powershell
node parse.mjs "https://miniheadquarters.com/tournaments/team/administrate/<slug>/army-lists" --cookie "sessionid=...; csrftoken=..."
```

Le cookie se copie dans DevTools -> Network (en-tête `Cookie` d'une requête authentifiée) ou DevTools -> Application -> Cookies -> miniheadquarters.com. La variable `MHQ_COOKIE` fonctionne aussi.

**Connexion depuis l'interface web (recommandé).** Il n'existe pas de voie anonyme pour obtenir une session, donc l'interface se connecte à votre place : déplier le panneau **Account**, saisir votre nom d'utilisateur et votre mot de passe MHQ, puis **Log in**. Le serveur effectue la connexion Django et conserve la session lui-même, inutile de copier un cookie depuis DevTools. Avec « remember » coché, le mot de passe est conservé aussi et une session expirée est rafraîchie automatiquement à l'analyse suivante. Session et mot de passe sont écrits dans `.secrets/mhq-auth.json` sur cette machine, ignoré par git ; le navigateur n'y est pas impliqué. **Log out** les efface.

Un cookie brut reste accepté en secours : « or paste a session cookie instead » dans le panneau Account. Il prime sur un compte connecté et est mémorisé dans le navigateur. Sans l'un ni l'autre, une analyse admin échoue en 401 et ouvre le panneau, focus sur le champ mot de passe.

Dans le panneau Browse, la case « organiser view » remplit l'URL admin plutôt que publique. Le sitemap ne contient que des URLs publiques (zéro occurrence de `administrate`), donc l'URL admin est reconstruite à partir du type et du slug de l'événement.

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

- `⚠ points mismatch` signale une divergence entre le total calculé et le total déclaré.
- `⚠ missing total points` signale l'absence de la clé `TOTAL ARMY POINTS` dans l'en-tête.
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

## Taux d'avertissements

Sur 280 listes issues de 11 événements (août–septembre 2026), l'analyseur produit 21 avertissements (7,5 %).

| Avertissement | Nombre | Cause |
|---------|-------|-------|
| Points mismatch | 18 | Total déclaré ≠ total calculé |
| Missing total points | 3 | Aucune clé `TOTAL ARMY POINTS` dans l'en-tête |

## Prérequis

- Node.js 18 ou supérieur (pour `https.get()` et `URL`).
- Aucune dépendance npm. Standard library uniquement.

## Fichiers

- `.mjs` - l'analyseur + le formatteur
- **README.md** - ce fichier
- **developer-doc.md** - comment fonctionne l'analyseur et pourquoi
- **translate.md** - dictionnaire FR/EN utilisé par l'analyseur (balises de rôle, dispositions, en-têtes de catégorie, mots-clés de puces, noms d'améliorations)

---

# MHQ Army-List Parser (English)

Pull a [MiniHeadQuarters](https://miniheadquarters.com) army-lists page and dump the armies as structured JSON plus a compact "one line per unit" mini view. Node 18 or higher.

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
| \ <url> | required | Army-lists URL: `…/tournaments/{team\|individual\|side-by-side}/{army-lists\|details}/<slug>`, or the organiser view `…/administrate/<slug>/{army-lists\|details}` |
| **--out-dir <dir>** | `<event-slug>/` | Where to write both files |
| **--json <name>** | mhq_army_lists.json | JSON filename |
| **--mini <name>** | mhq_army_lists.mini.md | Mini filename |
| **--cookie <val>** | `MHQ_COOKIE` (env.) | `Cookie` header for organiser/admin views |

## Organiser / admin views

The `…/tournaments/<type>/administrate/<slug>/army-lists` URL is the organiser's view: it shows lists before they are published, and it requires a logged-in session.

Fetched unauthenticated it returns the login page with status **200** (not a 302). Left unhandled the parser finds no armies and reports the misleading 'lists not published yet'. It now detects the login page and says so, with the steps to unblock.

The site is Django: a `GET` sets a `csrftoken` cookie and login is a `POST /users/login` with `csrfmiddlewaretoken` + `username` + `password` (no SSO, no captcha).

The simplest option, storing no password:

```powershell
node parse.mjs "https://miniheadquarters.com/tournaments/team/administrate/<slug>/army-lists" --cookie "sessionid=...; csrftoken=..."
```

Copy the cookie from DevTools -> Network (the `Cookie` request header of any authenticated request) or DevTools -> Application -> Cookies -> miniheadquarters.com. The `MHQ_COOKIE` environment variable works too.

**Logging in from the web UI (recommended).** There is no anonymous way to obtain a session, so the UI can log in for you: expand the **Account** panel, enter your MHQ username and password, and press **Log in**. The server performs the Django login and keeps the session itself, so you never have to copy a cookie out of DevTools. With **remember** ticked the password is kept too and an expired session is refreshed automatically on the next parse. Session and password are stored in `.secrets/mhq-auth.json` on this machine, which is gitignored; the browser is not involved. **Log out** clears them.

A raw cookie is still accepted as an override: expand *or paste a session cookie instead* in the Account panel. It wins over a logged-in account and is remembered in the browser. Without either, an admin parse fails with 401 and the panel opens itself, focused on the password field.

In the Browse panel, the 'organiser view' checkbox fills the admin URL instead of the public one. The sitemap only ever carries public URLs (zero occurrences of `administrate`), so the admin path is rebuilt from the event's type and slug.

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

- `⚠ points mismatch` warns when the parsed total differs from the declared total.
- `⚠ missing total points` warns when the header has no `TOTAL ARMY POINTS` key.
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

## Warning ratio

Across 280 lists from 11 events (Aug–Sep 2026), the parser produces 21 warnings (7.5%).

| Warning | Count | Cause |
|---------|-------|-------|
| Points mismatch | 18 | Declared total ≠ parsed total |
| Missing total points | 3 | No `TOTAL ARMY POINTS` key in header |

## Requirements

- Node.js 18 or higher (for `https.get()` and `URL`).
- No npm dependencies. stdlib only.

## Files

- `.mjs` - the parser + formatter
- **README.md** - this file
- **developer-doc.md** - how the parser works and why
- **translate.md** - FR/EN dictionary used by the parser (role tags, dispositions, category headers, bullet keywords, enhancement names)
