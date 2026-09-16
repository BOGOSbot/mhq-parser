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

## Options

| Option | Valeur par défaut | Rôle |
|------|---------|---------|
| \ <url> | obligatoire | URL de la page de listes d'armées (doit correspondre à `https://miniheadquarters.com/tournaments/{team|individual|side-by-side}/army-lists/<slug>`) |
| **--out-dir <dir>** | `<event-slug>/` | Où écrire les deux fichiers |
| **--json <name>** | mhq_army_lists.json | Nom du fichier JSON |
| **--mini <name>** | mhq_army_lists.mini.md | Nom du fichier mini |

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
- Les avertissements apparaissent sous l'en-tête du joueur. Sur 280 listes, le taux d'avertissement est de 7,5 %.
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
| \ <url> | required | Army-lists page URL (must match `https://miniheadquarters.com/tournaments/{team|individual|side-by-side}/army-lists/<slug>`) |
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
- header: the `+++` key-value block (null if absent)
- units: array of parsed units
- bodyRest: raw text for fallback inspection

`bodyRest` is preserved verbatim per player. Anything the parser did not structure is still recoverable from there.

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
