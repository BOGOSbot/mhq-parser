# Translation dictionaries

The parser treats these FR/EN variants as equivalent. All entries are
case-insensitive. Some French words aren't translated in the mini view
(unit names, detachment names, force-disposition labels are kept verbatim);
only role tags are normalised to English.

## Role tags (attached as: ...)

Applied in the mini formatter. The parser records the original string in
\\u.role; only the display layer translates.

| French | English |
|--------|---------|
| Meneur | Leader |
| Appui | Support |
| Gardes du Corps | Bodyguard |
| Transport | Transport |
| Assaut | Assault |
| Lourd | Heavy |
| Tir | Shooting |
| Recon | Recon |

Trailing parenthetical qualifiers are stripped before matching:
- \(Leader\) \(Personnage\)
- \(Character\) \(Battleline\) \(Ligne\)

Example: \\u.role = "Meneur (Personnage)" → \\u.role = "Meneur" → translate → "Leader".

## Force dispositions

These are the 9 valid Force Dispositions in 40k. The parser recognises both
languages and shows the source language verbatim in the mini view.

| English | French |
|---------|--------|
| Reconnaissance | Reconnaissance |
| Take and Hold | Prendre et Tenir |
| Priority Assets | Atouts Prioritaires |
| Purge the Foe | (varies) |
| Prey in Ambush | (varies) |
| Disruption | Disruption / Perturbation |

The FORCE_RE in the parser matches these exact strings on their own line:

```js
/^(?:Reconnaissance|Take and Hold|Prendre et Tenir|Priority Assets|Atouts Prioritaires|Purge the Foe|Prey in Ambush|Disruption|Perturbation)\s*$/im
```

## Force types (NOT dispositions)

These look like dispositions but are actually the Force *type* field on the
list form — they appear on the line AFTER the disposition and have a
points total in parens. The parser deliberately does NOT include these in
FORCE\_RE, so they aren't picked up as dispositions.

- Strike Force / Force de Frappe
- Force of Disruption / Force de Disruption
- Force of Reconnaissance / Force de Reconnaissance
- Hunt Force
- Contest Force
- Scouting Force

## Category headers (list-section labels)

Section labels in the bullet format. Both languages matched; the parser
records the source case in \\u.category.

| French | English |
|--------|---------|
| Personnages | Characters |
| Ligne | Battleline |
| Autres Fiches Techniques | Other Datasheets |
| Véhicules | Vehicles |
| Terrain | Terrain |
| Industrials | Industrials |
| Bâtiments | Buildings |

The parser's CATEGORY\_RE:

```js
/^(?:PERSONNAGES?|CHARACTERS?|CHARACTER|LIGNE|LINE|BATTLELINE|OTHER DATASHEETS|OTHERS?|OTHER|AUTRES FICHES TECHNIQUES|VEHICULES?|VEHICLES?|TERRAIN|INDUSTRIALS?|BUILDINGS?|UNIQUE|ATTACHED UNITS|UNITÉS? ATTACH)/i
```

## Attachment headers

The line that opens a new "Attached Unit N" block. Order matters:
ATTACHED\_RE is checked BEFORE CATEGORY\_RE because "Unités Attachées"
starts with "Unités" which the category regex also matches.

| Form | Example |
|------|---------|
| English | Attached Unit 1 |
| English reversed | Unit 1 Attached |
| French | Unité 1 Attachée |
| French plural | Unités Attachées |
| French plural singular | Unité Attachée 1 |

## Detachment markers

Used to extract the detachment name from the preamble.

| Form | Example |
|------|---------|
| French inline | Lions of the Emperor (3 Points de Détachement) |
| English inline | Lions of the Emperor (3 Detachment Points) |
| French colon form | Détachements : Nécrons - Dynastie Éveillée |
| English colon form | Detachments: Cursed Legion |

## Bullet keywords

Inline bullet lines that aren't model counts.

| Keyword | Meaning |
|---------|---------|
| Attached as: | Role declaration |
| Attachée en tant que | Role declaration (French) |
| Warlord | Warlord marker |
| Seigneur de Guerre | Warlord marker (French) |
| Enhancement: | Enhancement declaration |
| Optimisation: | Enhancement declaration (French) |

## Enhancement names

Known enhancement / upgrade names from the source lists. The ENHANCEMENT\_RE
in the parser captures these as \\u.enhancements; the mini formatter
strips the leading "Enhancement:" / "Optimisation:" prefix and the trailing
cost in parens.

English:
- Aggressive Deployment
- Murderous Onslaught
- Unleash Hell
- Fade to Darkness
- Sorrowsyphon
- Rejuvenating Swarm
- Murdermind
- Psychic Celerity
- Admonimortis
- Fierce Conqueror
- Deepening Madness
- Mark of the Nekrosor
- Leaping Shadows
- Gene-tailored Toxins
- Intoxicating Elixir
- Recon Hunter
- Nightforged Battery
- Supa-snazz Dakka
- Dreadherder
- Targetin' Gizmos

French:
- Lien dermique énaegique
- Voile des Ténèbres

## Enhancement prefixes & costs (stripped in display)

The mini formatter strips these from the enhancement string:

- Leading prefix: \\^Enhancement(?:s)?\s*:\s* or \\^Optimisation(?:s)?\s*:\s*
- Cost in parens: \s*\(\s*\+?\s*\d+\s*pts?\s*\), \s*\(\s*\d+\s*\)
- Upgrade marker: \s*\((?:upgrade|amélioration|amelioration)\)

Examples:

| Raw | Display |
|-----|---------|
| Aggressive Deployment (+20 pts) | Aggressive Deployment |
| Enhancement: Murdermind | Murdermind |
| Optimisation : Fade to Darkness | Fade to Darkness |
| Lien dermique énaegique (30) | Lien dermique énaegique |
| Deepening Madness (upgrade) | Deepening Madness |

## Multi-tweak WARLORD continuation

When a WARLORD has multiple ENHANCEMENTS, the \\+ header block uses \\&
continuation lines. These are merged into the previous key.

Raw:

```
+ WARLORD: Char1: Khârn the Betrayer
+ ENHANCEMENT: Aggressive Deployment (on Char3: Master of Executions)
& Murderous Onslaught (on Char4: Master of Executions)
& Unleash Hell (on Char5: Master of Executions)
```

Parsed \\u.header.enhancements:

```
Aggressive Deployment (on Char3: Master of Executions) & Murderous Onslaught (on Char4: Master of Executions) & Unleash Hell (on Char5: Master of Executions)
```

The per-unit enhancement bullets (\\u.enhancements on individual units)
are separate and come from the body bullets, not the header.
