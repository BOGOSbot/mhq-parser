# Analyseur de listes d'armées MHQ

Récupère une page de listes d'armées sur [MiniHeadQuarters](https://miniheadquarters.com) et restitue les armées en JSON structuré ainsi qu'une vue « mini » compacte, une ligne par unité. Requiert Node 18 ou supérieur.

## Démarrage rapide

```powershell
node tools\\mhq-parser\\src\\parse.mjs "https://miniheadquarters.com/tournaments/team/army-lists/<event-slug>"
```

L'argument est une URL MHQ **ou** le chemin d'un fichier de liste. Le répertoire de sortie par défaut est `<event-slug>/` relativement au script (le nom du fichier, pour une liste). Les deux fichiers y sont écrits :

- `<event-slug>\\mhq_army_lists.json`  (structuré : joueurs, unités, en-têtes)
- `<event-slug>\\mhq_army_lists.mini.md`  (vue Markdown compacte)

Remplacer le répertoire de sortie par défaut :

```powershell
node tools\\mhq-parser\\src\\parse.mjs "https://miniheadquarters.com/tournaments/team/army-lists/<event-slug>" --out-dir data\\mhq\\<slug>
```

## Interface web

Un petit serveur local, sans aucune dependance, sert une page unique qui appelle le parseur :

```powershell
node tools\\mhq-parser\\src\\server.mjs
```

Coller ensuite l'URL de l'evenement dans la page http://127.0.0.1:8787 puis lancer l'analyse. Le bouton **From file** ouvre l'explorateur et analyse directement une page MiniHeadQuarters deja enregistree sur le disque (Ctrl+S dans le navigateur) : aucune requete vers le site et aucune session, donc une page privee, non publiee ou hors ligne s'analyse comme les autres. Le meme bouton accepte une **liste d'armée** en `.txt` ou `.md`, **Paste** ouvre une fenêtre pour coller du texte, et un fichier lâché n'importe où sur la page est pris en charge. **Browse** reste la facon de choisir un tournoi. Les listes s'affichent groupees par equipe ; chaque armee indique son total de points (calcule vs declare), son detachement, ses dispositions de force et ses avertissements, suivis du tableau des unites. La recherche texte, le filtre par faction et l'affichage restreint aux avertissements filtrent a la volee ; `Copy mini` copie la vue Markdown et `Download JSON` telecharge l'equivalent du fichier du parseur.

L'analyse passe toujours par le serveur : le navigateur ne peut pas interroger miniheadquarters.com directement faute d'en-tete CORS. La page est relue a chaque requete, modifier index.html ne demande pas de redemarrage.

Options du serveur :

| Option | Valeur par defaut | Role |
|------|---------|---------|
| **--port <n>** | 8787 | Port d'ecoute (variable `PORT`) |
| **--host <h>** | 127.0.0.1 | Interface d'ecoute (variable `HOST`) |

Points de terminaison : `GET /` (la page), `GET /health`, `POST /parse` avec un corps JSON "{"url":"...", "cookie":"..."}" — la session vient de `POST /login` (ou de la variable `MHQ_COOKIE`) et est nécessaire pour les vues organisateur/admin — et `POST /parse-file?name=<fichier>`, dont le corps est la page HTML brute (32 Mo maximum) et qui repond comme `/parse`. Enfin `POST /parse-list?name=<fichier>`, dont le corps est le texte d'une liste et qui repond de la meme maniere. `POST /feedback`, dont le corps JSON `{"body":"..."}` (la première ligne devient le titre) crée directement une issue sur GitHub lorsque `GITHUB_TOKEN` est défini, et renvoie sinon un lien `github.com/<dépôt>/issues/new` prérempli — celui qu'ouvre le bouton **Feedback** du pied de page. `FEEDBACK_REPO` change le dépôt visé (`BOGOSbot/mhq-parser` par défaut). Un evenement present dans `archive/` est repondu par `/parse` depuis le disque, sans requete vers miniheadquarters.com ; `"live": true` dans le corps passe outre. La page de règles vit sur `GET /rules` et répond par `POST /rules/ask`.

## Page /rules

À côté de l'analyseur de listes, `GET /rules` sert une page qui répond à une **question de règles** — « une unité peut-elle tirer après avoir battu en retraite ? » — en citant les règles plutôt qu'en se fiant à ce qu'un modèle croit savoir — la même question peut être posée en français. Elle part vers `POST /rules/ask` (`{"question":"...", "lang":"fr|en"}`) et la réponse revient avec ses sources.

Les règles sont **lues et indexées à l'avance**, pas relues à chaque question. Le corpus a deux moitiés, dans deux namespaces d'un même index vectoriel Upstash :

| moitié | contenu | source |
|--------|---------|--------|
| `rules` | règles de base, appendices, compagnon d'événement, stratagèmes cœur | pages Wahapedia 11e édition + l'export CSV |
| `factions` | 1 548 fiches (valeurs) + 2 385 fiches (mots-clés et aptitudes), 1 449 stratagèmes, 329 détachements, 935 améliorations | export CSV officiel de Wahapedia |

Une fiche technique est **deux enregistrements**, pas un : « quelle est l'Endurance d'un Tyrannofex ? » et « a-t-il le mot-clé FRAME ? » n'ont rien à voir, et dans un seul enregistrement chacun est à moitié du bruit pour l'autre. Les valeurs (M, T, Sv, profils d'armes, points) d'un côté, les mots-clés et aptitudes de l'autre, même citation. Le découpage est structurel : une section d'abord, ses paragraphes ensuite, ses phrases en dernier recours — et chaque morceau porte le titre de ses sections parentes, qui part dans l'index avec lui (`Battle-shock Rolls > Datasheets`).

L'export CSV sert aux factions parce que les pages de faction ne portent **aucune fiche technique** — précisément ce sur quoi les joueurs posent des questions — et parce que c'est la donnée du site plutôt que notre lecture de son HTML : rien à nettoyer, aucun titre à mal attribuer.

Quatre étapes, chacune chronométrée dans la barre de progression :

1. **translate** — une question française est d'abord convertie en termes de recherche anglais : le corpus est anglais et `grep` ne peut pas trouver un mot absent. Le glossaire FR/EN (`glossary-fr-en.json`, lu du Munitorum Field Manual publié dans les deux langues) tranche ce qu'il connaît, le modèle porte le reste. Ces termes sont **une entrée de recherche, jamais une traduction montrée comme un fait**.
2. **retrieve** — chaque moitié est cherchée séparément : vecteurs (bge-m3) et `grep` en union, fusion par rang réciproque, puis **Jev** (`jev-1.13-free`) réordonne. Jev est la moitié gratuite : il décide, il n'écrit pas. Les termes se comparent au **début d'un mot** — `embark` atteint `Embarking` et `embarked` sans lire le mot dans `disembark` — et le filet donné à Jev est bien plus large que la coupe qu'il remplit.
3. **judge** — un juge séparé dit si les constats répondent à la question, et **toujours avec un niveau de confiance** (`low` / `med` / `high`).
4. **answer** — l'écrivain (SenseNova par défaut, `RULES_MODEL`) rédige à partir des seuls constats retenus.

**Le juge revoit sa copie après l'élargissement.** Le second verdict est un second verdict, et la page le dit (« after widening ») — sinon une réévaluation ressemble à pas d'évaluation du tout. Il voit désormais autant de chaque passage que le rédacteur (2 000 caractères, marqués `TRUNCATED` au-delà) : à 700 caractères il ne voyait pas les *Agile Manoeuvres* d'Asurmen, qui commencent vers le caractère 940, et répondait honnêtement mais à tort que la règle était absente.

**Le verdict du juge est contraignant.** Un juge qui signale une recherche insuffisante puis qu'on ignore est pire que pas de juge : il produit une réponse assurée à une question dont le système vient d'établir qu'il ne peut pas y répondre. Donc un échec **approfondit la recherche** : le premier passage demande 10 constats par moitié, chaque échec en ajoute 20 de plus à la moitié que le juge désigne, et la recherche continue tant que le juge dit non — `RULES_MAX_PASSES` (3 par défaut) en est le plafond, et le dernier passage est final. Un échec à ce plafond est rapporté comme **« Je ne sais pas »** plutôt que répondu quand même. Trouver un passage classé 7e est une vraie réussite ; répondre à partir d'un passage classé 3e qui parle d'autre chose n'en est pas une, et c'est exactement la différence que le juge existe pour faire.

**Pourquoi une règle que le corpus contient peut manquer à l'appel.** La question d'Asurmen — « peut-il réembarquer après avoir tiré ? » — a été répondue sans que la règle Embarquement (18.02) soit jamais montrée au juge. Trois causes, mesurées : `grep` comparait les termes en sous-chaîne, donc `embark` lisait le mot *dans* `disembark` et la règle Disembarking (1 960 caractères) passait devant Embarking (718) ; le filet donné à Jev coupait à 50 candidats alors qu'Embarking était 54e — Jev réordonne ce qu'on lui donne, il ne l'avait pas reçu ; et même dans un filet de 80, quatre appels mesurés l'ont classé 10e-12e, c'est-à-dire à la limite de la coupe. Les termes se comparent maintenant au **début d'un mot**, le filet de Jev vaut `max(jevMax, K + 70)` et son état de 40 000 caractères est réparti sur les candidats au lieu d'être tronqué en silence, et **l'ancrage** place en tête les enregistrements dont le titre commence par un mot de la question ou de sa traduction — `Embarking` plutôt que `NORMAL MOVE` — quel que soit l'avis de Jev.

**Deux réglages : rapide ou approfondi.** Le sélecteur à côté de la question change quatre choses d'un coup : la profondeur du premier passage (5 constats par moitié en rapide, 10 en approfondi), le nombre d'élargissements (2 contre 3), la largeur du filet donné à Jev (60 contre 80) et le raisonnement du juge. Le raisonnement est le levier qui compte : mesuré, le temps du juge suit son propre raisonnement, pas la taille du prompt (10 constats et 23 constats : 31,9 s contre 33,0 s de moyenne sur cinq questions, et l'appel le plus lent — 134,5 s — avait le plus petit prompt). Le couper fait passer le juge de 33,0 s de moyenne (médiane 20,6 s) à 7,1 s (médiane 6,0 s) et coûte 79,4 % → 61,8 % de précision sur le même banc. Prendre 5 constats au lieu de 10 coûte 93,1 % au lieu de 96,6 % de rappel — l'ancrage est ce qui rend le réglage rapide acceptable. Sur la question d'Asurmen, à la même minute : juge en ~2 s en rapide contre ~49 s en approfondi, les deux répondant `high` au premier passage.

**Les constats s'affichent sans attendre le reste.** La recherche prend deux secondes, le juge et la prose vingt de plus : la réponse arrive donc **en morceaux** (`POST /rules/ask` avec `"stream": true`, un objet JSON par ligne) plutôt que d'un bloc à la fin. Les constats apparaissent dès qu'ils sont prêts, le juge et la rédaction suivent chacun à leur rythme — et le juge est placé **en haut**, au-dessus des constats qu'il juge, même s'il arrive en dernier.

**Les citations sont construites par le serveur, pas décrites par le modèle.** Chaque `[n]` renvoie à une URL réellement indexée, et à l'ancre de la section à l'intérieur — `…/core-rules/#1.-Hit-Roll`. L'ancre est dérivée du titre par le serveur (`1. Hit Roll 05.01` → `1.-Hit-Roll`), jamais écrite par le modèle : celui-ci n'a le droit d'écrire que des marqueurs, jamais des liens. Une ancre inexistante est ignorée par le navigateur, donc une erreur ne coûte rien et une réussite mène droit à la règle.

**Entrée vocale.** Le bouton *Voice* transcrit dans le navigateur (Web Speech API) — gratuit, sans clé, sans serveur. Il faut un contexte sûr (`https` ou `localhost`) et Chrome, Edge ou Safari ; ailleurs le bouton se retire au lieu de casser. La transcription n'est **pas** envoyée d'elle-même : la reconnaissance se trompe sur les noms propres — *Wracks*, *Victrix*, *Fulgurite* — et une question qui nomme la mauvaise unité ramène la mauvaise règle. Le sélecteur FR/EN à côté donne la langue à écouter, et le serveur s'en sert pour la recherche.

Les clés viennent de l'environnement, puis du magasin de credentials DSH (`~/.dsh/.credentials.yaml`) : `OPENCODE_GO_API_KEY` (Jev), `SENSENOVA_API_KEY` (le juge, la traduction et la prose), `UPSTASH_VECTOR_REST_URL` et `UPSTASH_VECTOR_REST_TOKEN` (l'index). `DSH_CREDENTIALS` pointe un autre fichier.

L'inférence fait **deux routes, parce que les deux moitiés échouent différemment**. L'**écrivain** produit la réponse citée que lit le lecteur : `RULES_MODEL`, `RULES_MODEL_ENDPOINT`, `RULES_MODEL_KEY`, SenseNova par défaut. Un petit modèle est mauvais exactement là — sur le banc de vraies questions, ministral-8b a refusé 54 des 65 réponses que le juge avait acceptées (22 % face aux rulings de la communauté) et a répondu aux six questions françaises avec aplomb et à côté (0 %) — ce n'est donc pas là qu'il faut économiser. La **route rapide** est ce qui ne fait que décider ou reformuler — la question traduite, les termes de recherche, le juge : `RULES_FAST_MODEL`, `RULES_FAST_ENDPOINT`, `RULES_FAST_KEY`, et sans aucune des trois c'est la route de l'écrivain. N'importe quel endpoint compatible OpenAI fait l'affaire, y compris un serveur sur cette machine, cru sur parole pour l'authentification.

Le raisonnement, c'est l'attente du début, et le **juge le garde** : sur les mêmes 17 questions, un juge sans raisonnement a marqué 61,8 % là où le même juge en réfléchissant a marqué 79,4 % — il accepte des constats qui ne répondent pas, et l'écrivain rédige ensuite à partir d'eux. `medium` est la valeur par défaut parce que c'est celle qui se tient (~375 jetons de raisonnement sur les deux essais d'un vrai prompt de juge, là où le défaut du modèle errait entre 80 et 367) ; `RULES_FAST_REASONING=none` rachète les secondes et `high` existe aussi. L'écrivain garde le réglage du modèle, et `RULES_MODEL_REASONING` force l'un ou l'autre. Un appel peut prendre trois minutes (`RULES_MODEL_TIMEOUT_MS`, `RULES_FAST_TIMEOUT_MS`) : à 90 s, le juge qui réfléchit a coupé 7 questions réelles sur 25 — une réponse perdue là où une réponse lente aurait suffi. `RULES_JEV_MODEL` et les trois `RULES_*_ENDPOINT` changent les passerelles. `RULES_EDITION` choisit l'édition — la 11e depuis juin 2026, `wh40k10ed` pour la précédente. C'est un réglage de déploiement, pas un détail : la 10e et la 11e répondent différemment à la même question. Une clé manquante dégrade une étape : sans Jev le tri reste lexical, sans clé d'écrivain pas de prose, sans clé rapide ni traduction ni verdict. Un modèle hébergé sur une boîte CPU n'est pas une option : Upstash Box offre 2 à 8 vCPU et aucun GPU — soit des minutes de traitement de prompt par appel au juge — et son « budget LLM » compte un harnais d'agent auquel on apporte sa propre clé, pas un modèle qu'il servirait. Jev est de nouveau la passerelle gratuite d'OpenCode Zen (`RULES_JEV_GATEWAY=openrouter` bascule sur l'endpoint payant qui a tenu la place pendant les limites du gratuit ; douze appels de classement en rafale sont passés le 2026-10-12). Une route rapide qui marche : `RULES_FAST_ENDPOINT=https://opencode.ai/zen/go/v1/chat/completions`, `RULES_FAST_MODEL=glm-5.3-flash`, `RULES_FAST_KEY=OPENCODE_GO_API_KEY` — la passerelle de chat d'opencode.ai exige un en-tête `x-opencode-session` à chaque appel et répond 400 sans lui ; le code l'envoie lui-même (n'importe quel identifiant stable suffit, ce n'est pas de l'authentification). `GET /health` publie l'état des clés sous `rules` et la taille du corpus sous `corpus`.

**Ce que le changement de modèle coûte.** `node tests/eval-reddit.mjs --limit 16` note la couverture du juge et sa latence (moyenne et médiane) ; lancé deux fois — par défaut, puis avec `RULES_MODEL_ENDPOINT`, `RULES_MODEL` et `RULES_MODEL_KEY` pointés sur une autre route — il met les deux côte à côte, sur exactement les mêmes questions et le même classement Jev.

**La précision, sur de vraies questions.** La couverture n'est pas une réponse. Les questions du banc reddit ont été posées dans les fils hebdomadaires et on y a répondu ; `tests/fixtures/reddit-answers.json` est cette clé de réponses, récoltée entière dans `tests/fixtures/reddit-threads/` et reconstruite par `node tests/build-reddit-answers.mjs`. `node tests/eval-accuracy.mjs` passe chaque question par le chemin de la page et fait noter la réponse par un **autre** modèle — DeepSeek par défaut, déplaçable avec `RULES_GRADER_ENDPOINT`, `RULES_GRADER_MODEL` et `RULES_GRADER_KEY` — face à ce que le fil a tranché : `correct`, `partial` (demi-point) ou `wrong`. Une question que le fil n'a jamais tranchée rend un refus correct ; la précision vaut `(correct + partial / 2) / graded`. Chaque question est écrite dans `accuracy.ndjson` au fur et à mesure, et une question déjà présente n'est pas refaite : un long passage reprend où il s'était arrêté. `--bank fr` note les six questions françaises de `tests/fixtures/rules-questions-fr.json`, en français, contre la réponse qu'un joueur français a donnée ; sa question et sa réponse telles qu'il les a postées sont conservées dans ce fichier à côté de la formulation du banc (`asked` / `answer`), pour que la clé ne dépende pas du journal de session d'où elle vient.

Le corpus se rafraîchit hors ligne : `node src/rules-corpus.mjs --check` compare le marqueur d'édition et de version de chaque source à ce qui est stocké, `--scrape --set factions` retélécharge l'export CSV, `--ingest` réindexe, `--prune` supprime de l'index les vecteurs que le corpus n'a plus. C'est le marqueur qui dit si notre copie a vieilli, pas la date du dernier passage.

**Quand cette copie a-t-elle été faite ?** `GET /health` publie `corpus.updated` — la date de construction de notre copie, tirée de la copie elle-même — et non un verdict sur ce qu'un autre site aurait ou non publié. Le pied de page /rules l'affiche. Une date exacte qu'on peut vérifier vaut mieux qu'une comparaison grossière qui date trois choses différentes.


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
node src/parse.mjs "https://miniheadquarters.com/tournaments/team/administrate/<slug>/army-lists" --cookie "sessionid=...; csrftoken=..."
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
node tools\\mhq-parser\\src\\archive.mjs --plan          # ce qu'une récolte considérerait, sans rien récupérer
node tools\\mhq-parser\\src\\archive.mjs --months 12     # récolter les 12 derniers mois
node tools\\mhq-parser\\src\\archive.mjs --list          # ce qu'il y a dedans
node tools\\mhq-parser\\src\\archive.mjs --verify        # chaque entrée pointe encore vers un fichier lisible
node tools\\mhq-parser\\src\\archive.mjs --reindex       # reconstruire l'index depuis les fichiers
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

La dernière ligne est la signature la plus fiable, mais **18 % seulement** des 7 128 listes de l'année en cours en portent une : l'essentiel se reconnaît à la structure. `node src/formats.mjs` rejoue l'analyse sur l'archive ; le détail est dans [formats.md](./formats.md).

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

Le dépôt a une disposition simple : les sources dans **src/**, la documentation dans **docs/**, les données de travail dans **workspace/** (non suivi, régénérable) et les tests dans **tests/**.

- **src/** - tout ce qui s'exécute, et les deux pages que le serveur lit à chaque requête : `parse.mjs` (l'analyseur), `server.mjs`, `archive.mjs`, `formats.mjs`, `verify-points.mjs`, `glossary.mjs`, `translate-fr-en.mjs`, `rules.mjs` (édition, clés, ancres), `rules-corpus.mjs` (corpus, recherche, juge, rédaction), `index.html`, `rules.html`
- **archive/** - les événements fermés déjà récoltés, un fichier JSON par tournoi (suivi : c'est le magasin que le site relit)
- **docs/** - `developer-doc.md` (comment fonctionne l'analyseur et pourquoi), `rules-page.md` (la page /rules, de la question à la citation), `translate.md` (dictionnaire FR/EN), `formats.md`, `glossary-fr-en.md`, `HANDOFF.md`
- **tests/** - une suite par sujet ; `tests/fixtures/` porte les listes réelles, les questions reddit et françaises et leur clé de réponses
- **workspace/** - le corpus de règles et l'export CSV, l'état de l'index vectoriel, les exécutions d'évaluation et les journaux du serveur. Non suivi, propre à la machine : `node src/rules-corpus.mjs --scrape` le reconstruit
- **README.md** - ce fichier, la façade du dépôt (humain et agent)
- **AGENTS.md** - les conventions de travail

---

# MHQ Army-List Parser (English)

Pull a [MiniHeadQuarters](https://miniheadquarters.com) army-lists page and dump the armies as structured JSON plus a compact "one line per unit" mini view. Node 18 or higher.

## Quick start

```powershell
node tools\\mhq-parser\\src\\parse.mjs "https://miniheadquarters.com/tournaments/team/army-lists/<event-slug>"
```

The argument is an MHQ URL **or** the path to a list file. The default output directory is `<event-slug>/` relative to the script - the file's own name, for a list. Both files go there:

- `<event-slug>\\mhq_army_lists.json`  (structured: players, units, headers)
- `<event-slug>\\mhq_army_lists.mini.md`  (compact Markdown view)

Override the output directory:

```powershell
node tools\\mhq-parser\\src\\parse.mjs "https://miniheadquarters.com/tournaments/team/army-lists/<event-slug>" --out-dir data\\mhq\\<slug>
```

## Web UI

A small local server, with no dependencies at all, serves a single page that calls the parser:

```powershell
node tools\\mhq-parser\\src\\server.mjs
```

Paste the event URL into http://127.0.0.1:8787 and press **Parse**. **Browse** opens a picker of recent tournaments, and **From file** opens the file explorer to parse a MiniHeadQuarters page you already saved (Ctrl+S in your browser): the markup is the whole input, so no request goes to the site and no session is used — a private, unpublished or offline page parses like any other. The lists are grouped by team; each army shows its points total (parsed vs declared), its detachment, its force dispositions and its warnings, followed by the unit table. Text search, the faction filter and the warnings-only view filter as you type; `Copy mini` copies the Markdown view and `Download JSON` downloads what the parser would have written.

Parsing always goes through the server: the browser cannot fetch miniheadquarters.com directly, there being no CORS header. The page is re-read on every request, so editing index.html needs no restart.

| Flag | Default | Purpose |
|------|---------|---------|
| **--port <n>** | 8787 | Listening port (`PORT`) |
| **--host <h>** | 127.0.0.1 | Listening interface (`HOST`) |

Endpoints: `GET /` (the page), `GET /health`, `POST /parse` with a JSON body "{"url":"...", "cookie":"..."}" — the session comes from `POST /login` (or the `MHQ_COOKIE` variable) and is needed for organiser/admin views — `POST /parse-file?name=<file>`, whose body is the raw HTML page (32 MB limit) and which answers like `/parse`, and `POST /parse-list?name=<file>`, whose body is pasted list text and which answers the same way. `POST /feedback`, whose JSON body `{"body":"..."}` (the first line becomes the title) files an issue on GitHub when `GITHUB_TOKEN` is set, and otherwise returns a prefilled `github.com/<repo>/issues/new` link — the one the footer's **Feedback** button opens. `FEEDBACK_REPO` overrides the target repository (`BOGOSbot/mhq-parser` by default). An event held in `archive/` is answered by `/parse` straight off disk, with no request to miniheadquarters.com; `"live": true` in the body declines the cache. The rules page lives at `GET /rules` and answers through `POST /rules/ask`.

## The /rules page

Beside the army-list parser, `GET /rules` serves a page that answers a **rules question** — "can a unit shoot after it Fell Back?", or the same asked in French — by citing the rules rather than by trusting what a model already believes. It goes to `POST /rules/ask` (`{"question":"...", "lang":"fr|en"}`) and comes back with its sources.

The rules are **read and indexed ahead of time**, not re-read per question. The corpus has two halves, in two namespaces of one Upstash vector index:

| half | what it holds | source |
|------|---------------|--------|
| `rules` | core rules, appendix, event companion, core stratagems | Wahapedia 11th-edition pages + the CSV export |
| `factions` | 1,548 datasheet values + 2,385 keyword/ability records, 1,449 stratagems, 329 detachments, 935 enhancements | Wahapedia's official CSV export |

A datasheet is **two records, not one**: "what is a Tyrannofex's Toughness?" and "does it have the FRAME keyword?" have nothing to do with each other, and as one record each is half noise to the other. Values (M, T, Sv, weapon profiles, points) in one, keywords and abilities in the other, citing the same page. Chunking is structural — a section first, its paragraphs next, its sentences as a last resort — and each chunk carries its parent sections' titles into the index with it (`Battle-shock Rolls > Datasheets`).

The CSV export carries the faction half because the faction *pages* hold **no datasheets at all** — the very thing players ask about — and because it is the site's own data rather than our reading of its HTML: no chrome to strip, no heading to mis-attribute.

Four steps, each one timed in the progress bar:

1. **translate** — a French question is turned into English search terms first: the corpus is English and `grep` cannot match a word that is not there. The FR/EN glossary (`glossary-fr-en.json`, read off the Munitorum Field Manual published in both languages) settles what it knows; the model carries the rest. Those terms are **search input, never a translation shown as a fact**.
2. **retrieve** — each half is searched separately: embeddings (bge-m3) and `grep` in union, merged by reciprocal rank, then **Jev** (`jev-1.13-free`) reranks. Jev is the free half: it decides, it does not write. Terms match at the **start of a word** — `embark` reaches `Embarking` and `embarked` without reading the word inside `disembark` — and the net Jev is given is much wider than the cut it fills.
3. **judge** — a separate judge says whether the findings answer the question, and **always with a confidence level** (`low` / `med` / `high`).
4. **answer** — the writer (SenseNova by default, `RULES_MODEL`) writes from the surviving findings only.

**The judge re-reads after a widening.** The second verdict is a second verdict and the page says so ("after widening") — otherwise a re-evaluation looks like no evaluation at all. It now sees as much of each passage as the compiler does (2,000 characters, marked `TRUNCATED` beyond that): at 700 it could not see Asurmen's *Agile Manoeuvres*, which start around character 940, and answered honestly but wrongly that the rule was absent.

**The judge's verdict is binding.** A judge that flags a retrieval as insufficient and is then ignored is worse than no judge at all: it produces a confident answer to a question the system has just established it cannot answer. So a miss **deepens the search**: the first pass asks for 10 findings a side, each miss adds 20 more to the half the judge names, and the search keeps going while the judge says no — `RULES_MAX_PASSES` (3 by default) is the ceiling and the last pass is final. A miss at that ceiling is reported as **"I do not know"** rather than answered anyway. Finding a passage ranked 7th is a real win; answering from a passage ranked 3rd that is about something else is not, and that difference is exactly what the judge exists to make.

**Why a rule the corpus holds can fail to appear.** The Asurmen question — "can he re-embark after shooting?" — was answered without the Embarking rule (18.02) ever being shown to the judge. Three causes, measured: `grep` compared terms as substrings, so `embark` read the word *inside* `disembark` and Disembarking (1,960 characters) outranked Embarking (718); the net Jev was handed cut at 50 candidates while Embarking sat 54th — Jev reorders what it is given, and it had not been given it; and even in a net of 80, four measured calls ranked it 10th-12th, right on the cut. Terms now match at the **start of a word**, Jev's net is `max(jevMax, K + 70)` with its 40,000-character state spent across the candidates rather than sliced off silently, and **anchoring** puts the records whose title starts with a word of the question or its translation in front of the judge — `Embarking` rather than `NORMAL MOVE` — whatever Jev thinks.

**Two settings: fast or deep.** The switch beside the question changes four things at once: how deep the first pass looks (5 findings a side fast, 10 deep), how many times a miss widens it (2 against 3), how wide the net given to Jev is (60 against 80), and whether the judge reasons. Reasoning is the lever that matters: measured, the judge's wall-clock follows its own thinking, not the size of the prompt (10 findings and 23 findings: 31.9s against 33.0s mean over five questions, and the single slowest call - 134.5s - had the smaller prompt). Turning it off takes the judge from a 33.0s mean (20.6s median) to 7.1s (6.0s median) and costs 79.4% → 61.8% accuracy on the same bank. Taking 5 findings instead of 10 costs recall, 93.1% against 96.6% - the anchoring is what makes the fast setting acceptable. On the Asurmen question, same minute: the judge answered in ~2s fast against ~49s deep, both `high` on the first pass.

**The findings appear without waiting for the rest.** Retrieval takes two seconds and the judge and the prose take twenty more, so the answer arrives **in pieces** (`POST /rules/ask` with `"stream": true`, one JSON object per line) rather than in one block at the end. The findings land as soon as they are ready and the judge and the prose follow at their own pace — with the judge placed **at the top**, above the findings it judges, even though it arrives last.

**The citations are built by the server, not described by the model.** Every `[n]` resolves to a URL that was really fetched for that request, and to the anchor of the section inside it — `…/core-rules/#1.-Hit-Roll`. The anchor is derived by the server from the heading (`1. Hit Roll 05.01` → `1.-Hit-Roll`), never written by the model: the model may write markers, never links. A fragment that does not exist is ignored by the browser, so a wrong guess costs nothing and a right one lands on the rule.

**Voice input.** The *Voice* button transcribes in the browser (Web Speech API) — free, no key, no server. It needs a secure context (`https` or `localhost`) and Chrome, Edge or Safari; anywhere else the button removes itself rather than breaking. The transcript is **not** submitted on its own: recognition mangles proper nouns — *Wracks*, *Victrix*, *Fulgurite* — and a question naming the wrong unit retrieves the wrong rule. The FR/EN selector beside it sets the language to listen for, and the server uses that for the search.

Keys come from the environment first, then from the DSH credential store (`~/.dsh/.credentials.yaml`): `OPENCODE_GO_API_KEY` (Jev), `SENSENOVA_API_KEY` (the judge, the translation and the prose), `UPSTASH_VECTOR_REST_URL` and `UPSTASH_VECTOR_REST_TOKEN` (the index). `DSH_CREDENTIALS` points at another file.

The inference is **two routes, because the two halves fail differently**. The **writer** produces the cited answer the reader sees: `RULES_MODEL`, `RULES_MODEL_ENDPOINT`, `RULES_MODEL_KEY`, SenseNova by default. A small model is worst exactly there — on the real question bank ministral-8b refused 54 of the 65 answers the judge had accepted (22% against the community's rulings) and answered the six French questions fluently and wrongly (0%) — so the writer is not where to save money. The **fast route** is what only decides or rewrites — the translated question, the search terms, the judge: `RULES_FAST_MODEL`, `RULES_FAST_ENDPOINT`, `RULES_FAST_KEY`, and with none of the three set it is the writer's own route. Any OpenAI-compatible endpoint will do, including a server on this machine, which is taken at its word about authentication.

Reasoning is the upfront wait, and the **judge keeps it**: on the same 17 questions a judge without it scored 61.8% where the same judge thinking scored 79.4% — it accepts findings that do not answer, and the writer then writes from them. `medium` is the default because it is the setting that behaves (~375 reasoning tokens on both samples of a real judge prompt, where the model's own default wandered between 80 and 367); `RULES_FAST_REASONING=none` buys back the seconds and `high` is there too. The writer keeps the model's own setting, and `RULES_MODEL_REASONING` overrides either. One call may take three minutes (`RULES_MODEL_TIMEOUT_MS`, `RULES_FAST_TIMEOUT_MS`): at 90s the thinking judge cut off 7 of 25 real questions, which is a lost answer where a slow one would have done. `RULES_JEV_MODEL` and the three `RULES_*_ENDPOINT` change the gateways. `RULES_EDITION` picks the edition — 11th since June 2026, `wh40k10ed` for the previous one. It is a deployment setting, not a detail: 10th and 11th answer the same question differently. A missing key degrades one step instead of failing the request: no Jev means a lexical ranking, no writer key means no prose, no fast key means no translation and no verdict. A model hosted on a CPU box is not one of the options: Upstash Box offers 2–8 vCPU and no GPU, which is minutes of prompt processing per judge call, and its built-in "LLM budget" meters an agent harness you bring your own key to, not a model it serves. Jev is the free OpenCode Zen gateway again (`RULES_JEV_GATEWAY=openrouter` switches to the paid decisions endpoint that stood in while the free tier was rate-limiting; twelve ranker calls in a burst went through on 2026-10-12). A fast route that works: `RULES_FAST_ENDPOINT=https://opencode.ai/zen/go/v1/chat/completions`, `RULES_FAST_MODEL=glm-5.3-flash`, `RULES_FAST_KEY=OPENCODE_GO_API_KEY` — the opencode.ai chat gateway wants an `x-opencode-session` header on every call and answers 400 without one, which the code sends itself (any stable id routes it; it is not authentication). `GET /health` publishes the key state under `rules` and the corpus size under `corpus`.

**What the model change costs.** `node tests/eval-reddit.mjs --limit 16` reports the judge's coverage and its latency (mean and median); run twice — once by default, once with `RULES_MODEL_ENDPOINT`, `RULES_MODEL` and `RULES_MODEL_KEY` pointing at another route — it puts the two side by side, on exactly the same questions and the same Jev ranking.

**Accuracy on real questions.** Coverage is not an answer. The reddit bank's questions were asked in weekly threads and answered under them; `tests/fixtures/reddit-answers.json` is that answer key, harvested whole into `tests/fixtures/reddit-threads/` and rebuilt by `node tests/build-reddit-answers.mjs`. `node tests/eval-accuracy.mjs` runs each question through the page's own path and has a **different** model — DeepSeek by default, moved with `RULES_GRADER_ENDPOINT`, `RULES_GRADER_MODEL` and `RULES_GRADER_KEY` — grade the answer against what the thread ruled: `correct`, `partial` (half credit) or `wrong`. A question the thread never settled makes a refusal correct; accuracy is `(correct + partial / 2) / graded`. Each question is appended to `accuracy.ndjson` as it lands and a question already in that file is not redone, so a long run resumes. `--bank fr` grades the six French questions of `tests/fixtures/rules-questions-fr.json` in French against the answer a French player gave; the verbatim question and answer he posted are kept in that file beside the benchmark's own phrasing (`asked` / `answer`), so the key does not depend on the session log it was read out of.

The corpus refreshes offline: `node src/rules-corpus.mjs --check` compares each source's edition-and-version marker against what is stored, `--scrape --set factions` re-downloads the CSV export, `--ingest` re-indexes, `--prune` deletes index vectors the corpus no longer has. It is the marker that says whether our copy has gone stale, not the date we last looked.

**When was this copy made?** `GET /health` publishes `corpus.updated` — the build date of our own copy, read from the corpus itself — rather than a verdict on what some other site may or may not have published. The /rules footer shows it. An exact date a reader can check beats a coarse comparison dating three different things.


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
node src/parse.mjs "https://miniheadquarters.com/tournaments/team/administrate/<slug>/army-lists" --cookie "sessionid=...; csrftoken=..."
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
node tools\\mhq-parser\\src\\archive.mjs --plan          # what a harvest would consider, fetching nothing
node tools\\mhq-parser\\src\\archive.mjs --months 12     # harvest the last 12 months of closed events
node tools\\mhq-parser\\src\\archive.mjs --list          # what is in there
node tools\\mhq-parser\\src\\archive.mjs --verify        # every entry still resolves to a readable file
node tools\\mhq-parser\\src\\archive.mjs --reindex       # rebuild the index from the files on disk
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

The last line is the strongest signature, but **only 18%** of the 7,128 lists in the current window carry one: the rest are recognised by shape. `node src/formats.mjs` replays the analysis over the archive; the full write-up is in [formats.md](./formats.md).

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

The repository keeps one shape: sources in **src/**, documentation in **docs/**, working data in **workspace/** (untracked, regenerable) and tests in **tests/**.

- **src/** - everything that runs, plus the two pages the server reads on each request: `parse.mjs` (the parser), `server.mjs`, `archive.mjs`, `formats.mjs`, `verify-points.mjs`, `glossary.mjs`, `translate-fr-en.mjs`, `rules.mjs` (edition, keys, anchors), `rules-corpus.mjs` (corpus, retrieval, judge, writer), `index.html`, `rules.html`
- **archive/** - the closed events harvested so far, one JSON file per tournament (tracked: the store the site reads back)
- **docs/** - `developer-doc.md` (how the parser works and why), `rules-page.md` (the /rules page, from question to citation), `translate.md` (FR/EN dictionary), `formats.md`, `glossary-fr-en.md`, `HANDOFF.md`
- **tests/** - one suite per subject; `tests/fixtures/` holds the real lists, the reddit and French question banks and their answer key
- **workspace/** - the rules corpus and CSV export, the vector-index state, the eval runs and the server logs. Untracked and per-machine: `node src/rules-corpus.mjs --scrape` rebuilds it
- **README.md** - this file, the repository's front page (human and agent)
- **AGENTS.md** - the working conventions
