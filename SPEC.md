# Cahier des charges — plugin Claude Code « conso-pilot » (v3)

> v3 du 2026-10-05. Les hypothèses de la v2 ont été vérifiées dans la documentation officielle de Claude Code (hooks, barre d'état, cache, permissions, sous-agents ; sources en annexe C) et sur cette machine (Claude Code 2.1.251, rtk 0.51, context-mode 1.0.169).
> Il ne reste que **deux** points à confirmer en conditions réelles, marqués **[L0]** (§12) ; la spec définit le comportement de repli pour chacun.

## 0. Objectif

Réduire la consommation de tokens de Claude Code pour atteindre les limites d'usage (fenêtres 5 h / 7 j) le plus tard possible, **sans dégrader la qualité du travail** :
- surveiller la taille du contexte et alerter au bon moment ;
- faciliter le passage « résumé → nouvelle discussion » (handoff) ;
- ne jamais perdre l'historique utile (sauvegarde automatique) ;
- limiter le contexte chargé inutilement (plugins, skills, MCP, dossiers lourds) ;
- orienter vers le modèle et l'effort les moins chers adaptés à la tâche ;
- mesurer la consommation et les gains réels, **pondérés par le coût**.

Environnement : macOS, Claude Code ≥ 2.1.251 (app desktop, onglet Code + CLI), abonnement Claude, installation **scope user**.

Déjà installés, à **intégrer sans les réimplémenter** :
- `rtk` 0.51 : hook `PreToolUse` Bash qui réécrit les commandes ; commande `rtk gain` ;
- `context-mode` 1.0.169 : hooks `SessionStart`, `PreToolUse` (Bash, Read, Grep, Agent, WebFetch, `mcp__`), `PostToolUse`, `UserPromptSubmit`, `PreCompact`, `Stop` ; outil `ctx_stats`.

Fonctions **natives** de Claude Code sur lesquelles le plugin s'appuie au lieu de les refaire :
- confirmation native avant un changement de modèle tant que le cache est chaud, pilotable par les hooks `PreModelSwitch` / `PostModelSwitch` ;
- champs de reprise de `SessionStart` (`seconds_since_last_response`, `context_tokens`, `prompt_cache_likely_expired`) ;
- champs de la barre d'état (`context_window`, `rate_limits`, `effort.level`, `fast_mode`).

## 1. Contraintes techniques (obligatoires)

- Scripts en **Node.js sans dépendance**. Hooks synchrones < 200 ms (mesuré, cf. §11).
- Hooks qui affichent un `systemMessage` : **synchrones** obligatoirement (le `systemMessage` d'un hook `async` n'est pas montré à l'utilisateur). Les hooks purement journaliers peuvent être `async`.
- **Lecture incrémentale des transcripts** : jamais de lecture complète. Chaque session garde dans son état l'offset (octets) déjà traité ; on ne lit que la suite. Sans état, lire seulement les 256 derniers Ko.
- **Dédoublonnage** : le transcript écrit une ligne par bloc de contenu, chacune répétant le même `message.id` et le même `usage`. Tout calcul compte **un `usage` par `message.id`**.
- **Fail-open** : toute exception → sortie code 0 sans sortie standard ; l'erreur est ajoutée à `~/.claude/conso-pilot/errors.log` (tronqué à 1 Mo).
- **Aucun appel réseau**, aucune télémétrie, aucun proxy des appels API.
- **Zéro token par défaut** : seuls entrent dans le contexte du modèle le handoff relu (§5.4), la consigne de délégation (§9.1) et les raisons de refus adressées à Claude (§7). Tout le reste passe par `systemMessage`, `reason` (blocage, non ajouté au contexte), la barre d'état ou les notifications.
- Effets de bord lents (notification `osascript`, `rtk gain`, résumé IA) lancés **détachés** (`spawn` + `unref`), jamais attendus.
- Configuration : `~/.claude/conso-pilot/config.json`, créée avec les défauts au premier lancement ; clés inconnues ignorées, clés manquantes complétées par les défauts (annexe A).
- Données : `~/.claude/conso-pilot/` (hors projets, jamais commitées). Écritures atomiques (fichier temporaire + `rename`), **toujours faites par les scripts du plugin, jamais par les outils Write/Edit de Claude** : les écritures de Claude dans `~/.claude/` sont des chemins protégés que les règles `allow` ne pré-approuvent pas.
- Écriture concurrente : journal en ajout simple (`appendFileSync`, lignes < 4 Ko) ; un fichier d'état par session (`state/<session_id>.json`).
- `SessionEnd` dispose de 1,5 s au total (les `timeout` des hooks de plugin ne relèvent pas ce budget) : le hook `SessionEnd` doit finir en < 500 ms.

## 2. Mesure

### 2.1 Taille du contexte
- Définition (alignée sur Claude Code) : `contexte = input_tokens + cache_creation_input_tokens + cache_read_input_tokens (+ output_tokens)` du **dernier appel API** de la conversation principale, dédoublonné.
- Sources, par ordre de préférence :
  1. `context_window.current_usage` du JSON de la barre d'état, quand elle tourne ;
  2. `context_tokens` de l'entrée `SessionStart` (reprise) ou `PreModelSwitch` ;
  3. dernier `usage` assistant du transcript.
- Fenêtre max : `context_window.context_window_size` (200 000 ou 1 000 000), sinon table par modèle de la config.

### 2.2 Contexte de base (`baseline`)
- Taille mesurée à la **première réponse** de la session.
- **Remesurée** à la première réponse qui suit un compactage (`PreCompact` marque l'état) ou un `/clear` (nouvelle session).
- Les seuils du §3 s'appliquent au **contexte ajouté** = `contexte − baseline`.

### 2.3 État de session
Fichier `state/<session_id>.json` : offset transcript, baseline, dernier contexte, horodatage de la dernière réponse, modèle, effort, mode rapide, TTL du cache, alertes déjà émises, empreinte du dernier prompt bloqué.

Sources du modèle, de l'effort et du mode rapide :
| Donnée | Sources, par ordre de préférence |
|---|---|
| modèle | barre d'état `model.id` → `PostModelSwitch` (nouveau modèle) → `SessionStart.model` (peut manquer après `/clear`) → `message.model` du dernier message assistant → réglage `model` |
| effort | barre d'état `effort.level` → entrée `Stop` / `SubagentStop` `effort.level` → champ `effort` des lignes assistant du transcript → réglage `effortLevel` (projet puis utilisateur) → « inconnu » |
| mode rapide | barre d'état `fast_mode` → `usage.speed` du dernier appel (`"fast"` / `"standard"`) → réglage correspondant → « inconnu » |

Constat du lot 1 : l'effort et le mode rapide sont donc connus **dans l'app aussi**, sans barre d'état.

Une valeur « inconnue » désactive toute comparaison (§9.2) : conseil sans comparaison, jamais de blocage.

### 2.4 Durée du cache (TTL)
- **Lue, pas calibrée** : dans le dernier `usage`, `cache_creation.ephemeral_1h_input_tokens > 0` → 60 min ; `ephemeral_5m_input_tokens > 0` → 5 min ; sinon dernière valeur connue.
- Défauts (documentés) : **1 h** pour la conversation principale sur abonnement dans l'usage inclus ; **5 min** quand l'abonnement consomme des crédits d'usage supplémentaires, et **5 min pour les sous-agents**. Les variables `FORCE_PROMPT_CACHING_5M` / `ENABLE_PROMPT_CACHING_1H` sont respectées si présentes dans l'environnement.
- `cacheTtlMinutes` en config sert uniquement de forçage manuel (`null` = automatique).

## 3. Alertes

### 3.1 Une seule alerte : « Handoff maintenant » (pas de pré-alerte)
Aucun avertissement préalable : le message apparaît uniquement quand il faut agir.
- **Déclencheur A, fin de tâche** (hook `Stop`) : contexte ajouté ≥ `handoffAt` (défaut 40k) **et** tâche terminée, c'est-à-dire :
  - `stop_hook_active` est faux ;
  - aucune tâche de fond en cours (`background_tasks` vide ou sans `running`) ;
  - `last_assistant_message` ne se termine pas par une question (dernière phrase sans `?`) ;
  - le dernier message assistant du transcript ne contient pas d'appel d'outil ;
  - la dernière liste de tâches (TodoWrite / TaskUpdate) est vide ou entièrement `completed`.
- A ne se répète pas tant que le contexte ajouté n'a pas progressé de `handoffRepeatEvery` (défaut 20k) depuis la dernière alerte A.
- **Déclencheur B, plafond** (hook `UserPromptSubmit`) : contexte ajouté ≥ `handoffForceAt` (défaut 100k) → alerte à **chaque** message, jusqu'au handoff, au compactage ou au `/clear`.
- Texte : « 🔴 Handoff maintenant — contexte XXk (+YYk). Lance /handoff puis /clear. »
- Jamais de blocage de message pour le handoff ; `Stop` ne renvoie jamais `decision: "block"`.

### 3.2 Canaux
- **`systemMessage`** d'une ligne (« message d'avertissement montré à l'utilisateur », sur toutes les surfaces) : canal principal. Non envoyé au modèle.
- **Notification macOS** (`osascript`, détachée) quand l'alerte §3.1 se déclenche et pour l'alerte cache §3.3. Désactivable (`notifications: false`).
- **Barre d'état** (CLI ; dans l'app seulement si elle y est affichée **[L0-1]**) : taille du contexte en neutre, rouge uniquement quand une alerte est active.

### 3.3 Alerte d'expiration du cache
- **Reprise d'une ancienne discussion** (`SessionStart`, `source` = `resume`) : si `prompt_cache_likely_expired` est vrai et `context_tokens` ≥ `cacheWarnMinTokens` (défaut 50k) → `systemMessage` : « Cache expiré : le prochain message refacturera ~Xk tokens. Si tu changes de sujet, fais plutôt /clear (la sauvegarde sera proposée). » Champs natifs, aucun calcul.
- **Pause dans la discussion en cours** (`UserPromptSubmit`) : si `maintenant − dernière réponse > TTL` (§2.4) **et** contexte ≥ `cacheWarnMinTokens` :
  - mode `cacheGuard: "block"` (défaut) : bloquer le message (`decision: "block"`, la `reason` est montrée à l'utilisateur et **n'entre pas** dans le contexte) : « Cache expiré (pause de XX min) : ce message va refacturer ~Xk tokens. Renvoie-le pour continuer, ou fais /clear (la sauvegarde sera rechargée). » Un message identique (même empreinte) envoyé ensuite passe toujours ;
  - mode `hint` : même texte en `systemMessage`, sans blocage ;
  - mode `off`.
- **[L0-2]** Si le texte d'un prompt bloqué n'est récupérable ni dans l'app ni dans la CLI (flèche ↑), le défaut passe à `hint`.
- Proposer `/clear` et non `/handoff` : rédiger un handoff obligerait à relire tout le contexte au prix plein.
- Avec un TTL d'1 h, l'alerte est rare : c'est voulu.
- Barre d'état : minuteur « cache mm:ss », affiché seulement dans les 10 dernières minutes avant l'expiration.

## 4. Barre d'état combinée

Une ligne, par exemple :
`Sonnet·medium · ctx 74k (+52k) · 5h 42% · 7j 18% · cache 3:12 · éco ~1.2M`

- Champs lus dans le JSON reçu : `model.display_name`, `effort.level`, `fast_mode`, `context_window.*`, `rate_limits.five_hour` / `seven_day` (`used_percentage`, `resets_at`). Champ absent → segment omis. Aucun appel réseau.
- Couleur neutre ; **rouge** seulement si une alerte §3.1 ou §3.3 est active.
- « éco » : total pondéré des gains (§8.3), lu dans un cache recalculé au plus toutes les 5 min par un processus détaché (jamais `rtk gain` en synchrone).
- Effet de bord : met à jour l'état de session (§2.3). Cache de rendu par `session_id` (pas par PID).
- Largeur : lire `COLUMNS` ; tronquer les segments de droite en premier.
- Si une barre d'état existe déjà, `/conso-pilot:setup` propose de l'**enchaîner** : `bin/statusline` exécute l'ancienne commande et ajoute sa sortie en préfixe.
- Installation par `/conso-pilot:setup` (§10).
- **[L0-1]** Si l'app desktop n'affiche pas `statusLine`, la barre d'état reste un bonus CLI ; dans l'app, l'état de session est alimenté par les hooks seuls (§2.3) et l'effort reste « inconnu » sauf s'il est fixé dans les réglages.

## 5. Handoff et sauvegarde de l'historique

### 5.1 Stockage
`~/.claude/conso-pilot/handoffs/<slug-du-projet>/`
- `AAAA-MM-JJ_HHMM_<session8>.md` : handoff manuel ;
- `latest.md` : copie du **dernier handoff manuel uniquement** ;
- `auto/<session8>.md` : sauvegarde automatique, **une par session**, réécrite sur place.
- Slug : chemin absolu du projet avec `/` et `.` remplacés par `-` (comme `~/.claude/projects/`).
- En-tête YAML : `created`, `session`, `project`, `objectif` (1 ligne), `context_tokens`.
- Rétention : `retentionDays` (30) ou `retentionMaxFiles` (50) par projet, appliquée au plus une fois par jour.
- Ce schéma rend l'ordre `SessionEnd` (ancienne session) / `SessionStart` (nouvelle) sans importance lors d'un `/clear` : la relecture ne lit que `latest.md`, que `SessionEnd` ne touche jamais.

### 5.2 Commande `/handoff`
Claude rédige un résumé **≤ 1 500 tokens** avec les sections :
- Objectif (1 ligne, reprise dans l'en-tête) ;
- État actuel ;
- Décisions prises (et pourquoi) ;
- Fichiers modifiés ou importants (`chemin:ligne`) ;
- Commandes utiles ;
- Pièges rencontrés ;
- Prochaines étapes.

Claude **n'écrit pas le fichier lui-même** : il exécute `node "<chemin absolu>/bin/save-handoff" <<'EOF' … EOF` (chemin fourni par `save-handoff --prepare` dans la commande) (texte sur l'entrée standard ; un heredoc n'est pas soumis aux contrôles de redirection). Le script :
- écrit le fichier daté et `latest.md`, applique la rétention ;
- marque l'état de session `handoffDone` (désactive l'alerte B) ;
- affiche « Fais /clear (ou ouvre une nouvelle discussion) — le résumé sera rechargé automatiquement ».

`/conso-pilot:setup` ajoute la règle `Bash(node <chemin absolu du plugin>/bin/save-handoff:*)` dans `permissions.allow` des réglages utilisateur, pour éviter une confirmation à chaque fois.

### 5.3 Sauvegarde automatique (zéro token)
- Hook `Stop` : met à jour `auto/<session8>.md` **au plus toutes les `autoSaveEveryMinutes` (5 min)**, en réutilisant la lecture incrémentale. C'est la sauvegarde principale : elle couvre aussi une discussion supprimée dans l'app sans `/clear`.
- Hooks `PreCompact` et `SessionEnd` : dernière mise à jour forcée (< 500 ms, possible grâce à l'état incrémental).
- Contenu, extrait **mécaniquement** sans IA :
  - les 10 dernières demandes de l'utilisateur (500 caractères max chacune) ;
  - les fichiers créés ou modifiés (Edit / Write / NotebookEdit), dédoublonnés ;
  - la dernière liste de tâches ;
  - les 5 dernières commandes en erreur (commande + 3 premières lignes d'erreur).
- Option `aiSummary` (défaut **false**) : résumé en arrière-plan avec `claude -p --model haiku`, détaché. Consomme du quota.

### 5.4 Relecture automatique (hook `SessionStart`)
| `source` | Comportement |
|---|---|
| `clear` | Injecter `latest.md` en `additionalContext` (plafond `resumeMaxTokens` = 2 000) **seulement s'il a moins de `clearResumeMinutes` (30 min)** : c'est le cas « /handoff puis /clear ». Sinon, `systemMessage` qui propose `/reprendre`. |
| `compact` | Ne rien injecter si context-mode est actif (il réinjecte déjà son snapshot) ; sinon injecter `latest.md` s'il date de la session courante. |
| `startup` | Injecter si `latest.md` a moins de `autoResumeHours` (2 h). Sinon : « Handoff du <date> disponible : <objectif> — tape /reprendre pour le charger ». |
| `resume` / `fork` | Ne rien injecter (déjà en contexte) ; alerte cache éventuelle (§3.3). |

- En-tête de l'injection : « Reprise de la session précédente (handoff du <date>) ».
- La sauvegarde `auto/` n'est **jamais injectée automatiquement** ; `/reprendre --auto` la charge à la main.
- context-mode est « actif » si une entrée `context-mode@…` vaut `true` dans `enabledPlugins` effectif (utilisateur + projet).

## 6. Audit du contexte chargé + `/lean`

> Lot 5 : l'estimation par fichiers ci-dessous est remplacée par l'inventaire exact relevé dans le transcript, et l'alerte est émise à la première réponse (détails et raisons en §12, lot 5).

- `SessionStart` : estimer le poids des éléments chargés :
  - descriptions de skills (frontmatter `description` des `SKILL.md` des plugins actifs) : caractères ÷ 4 ;
  - commandes et agents des plugins : idem ;
  - outils MCP : différés par la recherche d'outils (cas par défaut sur les modèles compatibles) × 15, non différés × 300 ;
  - pondérations ajustables en config.
- Calcul mis en cache 24 h (clé = empreinte des réglages et des dossiers de plugins), pour rester < 200 ms.
- Si le total estimé dépasse `leanWarnTokens` (15k) : `systemMessage` **une fois par jour et par projet** : « ~XXk tokens d'outils/skills chargés — /lean pour alléger ».
- Commande `/lean` (sortie du script affichée telle quelle) : tableau des plugins, skills et serveurs MCP triés par poids, avec la date de dernière utilisation dans ce projet (journal §8 : appels `Skill`, outils `mcp__<serveur>__*`, agents).
- Désactivation, toujours après confirmation et sauvegarde datée du fichier, par le script (pas par Write/Edit) :
  - plugin → `enabledPlugins: { "x": false }` dans `.claude/settings.json` du projet ou dans les réglages utilisateur ;
  - serveur MCP de `.mcp.json` → `disabledMcpjsonServers` ;
  - serveur MCP utilisateur ou connecteur claude.ai → pas de modification de fichier : indiquer la marche à suivre (`/mcp` en CLI, interface Connecteurs dans l'app).
- Avertir qu'activer ou désactiver un plugin ou un serveur MCP en cours de session peut invalider le cache : appliquer de préférence avant une nouvelle discussion.
- Rappeler que `/context` (natif) donne le détail exact.

## 7. Dossiers lourds : bloqués par défaut, avec exception

- Liste par défaut (configurable) : `DerivedData/`, `Pods/`, `node_modules/`, `build/`, `.build/`, `dist/`, `.gradle/`, `*.xcarchive`, `Package.resolved`, `package-lock.json`, `yarn.lock`, `Podfile.lock`, tout fichier > `heavyFileBytes` (1 Mo).
- Périmètre :
  - **Read** : cible principale ;
  - **Bash** : `cat`, `less`, `ls -R`, `find`, `tree`, `grep -r` sur ces chemins ; analyse de la commande telle que reçue (rtk réécrit via `updatedInput`, sans en changer la cible) ;
  - **Grep / Glob** : seulement quand le chemin vise explicitement un dossier lourd (par défaut, Grep respecte déjà `.gitignore`).
- Règles :
  - **Accès large** (Read sans `limit` ou avec `limit` > `targetedReadMaxLines` (300), liste récursive, Grep au motif vague — < 3 caractères, `.` ou `.*`) → `permissionDecision: "deny"` avec une raison adressée à Claude : « Dossier lourd bloqué par défaut. Si une erreur peut venir d'ici, fais un accès ciblé (Grep avec un motif précis, Read avec offset/limit ≤ 300, tail d'un log). »
  - **Accès ciblé** (Grep avec motif, Read avec `limit` ≤ 300, `tail`/`head -n ≤ 300`) → autorisé, `systemMessage` : « ⚠️ Lecture ciblée dans un dossier normalement bloqué : <chemin> ».
- Coexistence avec context-mode (qui a aussi des hooks sur Read, Grep, Bash) : les hooks tournent en parallèle et un `deny` l'emporte toujours ; conso-pilot ne fait que refuser ou laisser passer, il ne réécrit jamais l'entrée, donc pas de conflit d'`updatedInput`.
- Chaque refus est journalisé avec la taille du fichier ou du dossier évitée (§8).

## 8. Journal, consommation et gains

### 8.1 Journal
- Hooks `Stop` et `SubagentStop` (`async`, sans sortie) : une ligne JSONL **par tour** dans `~/.claude/conso-pilot/log-AAAA-MM.jsonl`, avec la somme dédoublonnée de tous les appels API du tour :
  `ts, projet, session, agent, modèle, effort, input, cache_creation_5m, cache_creation_1h, cache_read, output, contexte, nb_appels`.
- Pour `SubagentStop` : lire `agent_transcript_path` (transcript propre du sous-agent) ; `agent` = `agent_type`. Les agents internes de Claude Code (suggestions de prompt, `/btw`) déclenchent aussi `SubagentStop` : ils sont journalisés avec `agent: "internal:<type>"` et comptés à part dans `/conso`.
- Autres événements journalisés (`type`) : `deny` (§7), `handoff`, `clear`, `compact`, `advice` (§9.2), `cache_block` (§3.3), `model_switch` (`PostModelSwitch`).

### 8.2 Unité de coût
Les quotas sont pondérés par le coût, pas par le nombre brut de tokens. Les rapports utilisent des **tokens pondérés** (équivalent « token d'entrée plein ») :
`pondéré = (input + 1,25 × cache_5m + 2 × cache_1h + 0,1 × cache_read + outputRatio × output) × poids du modèle × (mode rapide ? fastModeMultiplier : 1)`
Poids et ratios en config (annexe A), à ajuster si les tarifs changent. Les chiffres bruts restent affichés à côté.

### 8.3 Commande `/conso`
Script dont la sortie est affichée telle quelle (Claude ne relit aucun fichier) :
- consommation par projet et par modèle (jour / 7 jours), brute et pondérée ;
- part des sous-agents et des agents internes ;
- top 5 des sessions les plus coûteuses, avec contexte moyen et nombre de tours ;
- recommandations de modèle (§9.2) : nombre, % suivies ;
- **gains réalisés (estimations, signalées comme telles)** :
  - rtk : sortie de `rtk gain` (mise en cache) ;
  - context-mode : `stats.json` de son dossier de plugin s'il est lisible, sinon « non disponible » ;
  - lectures bloquées : taille évitée ÷ 4, comptée une fois au prix d'écriture du cache puis au prix de lecture du cache pour les tours restants de la session ;
  - handoffs : (contexte avant − contexte après) × tours suivants × 0,1, plus la création de cache évitée ;
  - total pondéré.

## 9. Choix du modèle et de l'effort

### 9.0 Principes (vérifiés)
- **Un hook ne peut pas changer le modèle ni l'effort.** Il peut bloquer un message, afficher un conseil, ou intervenir sur un changement de modèle demandé par l'utilisateur (`PreModelSwitch`).
- **Changer de modèle vide le cache** (chaque modèle a son propre cache). Claude Code demande déjà confirmation tant que le cache est chaud.
- **Changer d'effort ne vide pas le cache** sur Opus 5.5, Sonnet 5.5 et Fable 5.1 avec un abonnement : l'effort s'ajuste **à tout moment** sans surcoût. Sur les autres modèles (dont Haiku 4.5), il le vide.
- Donc : **conseiller l'effort à tout moment, le modèle seulement en début de session.**
- Les tarifs ne sont pas codés en dur : poids relatifs en config (§8.2).
- Ce qui compte, c'est le coût de la tâche terminée : un modèle trop faible qui recommence coûte plus cher.

### 9.1 Sous-agents
| Agent | Modèle | Effort | Outils | Rôle |
|---|---|---|---|---|
| `Explore` (natif) | natif | — | — | Recherches larges. **Pas d'agent `explorer` fourni** : doublon, et une description de plus dans le contexte. |
| `runner` | haiku | — (Haiku ne gère pas l'effort) | Bash, Read | Lance builds et tests (xcodebuild, swift test, npm test…) ; ne rend **que** les erreurs et avertissements utiles, dédoublonnés, ≤ 300 mots. |
| `architect` | opus | `high` (champ `effort` du frontmatter) | Read, Grep, Glob | Conception, bug difficile, revue de plan ; rend une recommandation argumentée ; ne modifie pas le code. |

- Les sous-agents ont un cache de 5 min par défaut ; ne pas le modifier (le champ `experimental.cacheTtl` reste à `null` dans la config).
- Consigne injectée au `SessionStart` (≤ 80 tokens, sources `startup` et `clear` uniquement) : « Délègue les recherches larges à Explore, les builds et tests à runner, les décisions difficiles à architect ; fais toi-même les petites tâches. » Désactivable (`delegationHint: false`).

### 9.2 Recommandation (règles locales, zéro token)
- Hook `UserPromptSubmit`, classement heuristique sans IA :
  - **simple** : prompt < 200 caractères, ≤ 1 fichier mentionné, ou mots-clés FR/EN (« renomme, explique, où est, typo, traduis, rename, explain, where is ») ;
  - **complexe** : mots-clés « architecture, conçois, refactor global, migration, bug introuvable, performance, design, root cause », ou ≥ 4 fichiers mentionnés ;
  - **critique** : demandé explicitement (« réfléchis à fond », « ultrathink », « max ») ;
  - sinon **standard**.
- Correspondance (configurable) :

  | Niveau | Modèle | Effort |
  |---|---|---|
  | simple | Sonnet | `low` |
  | standard | Sonnet | `medium` |
  | complexe | Opus (ou `opusplan`) | `high` |
  | critique | Opus | `xhigh` |

- **Effort** : comparé à **chaque** message dès que l'effort actif est connu (§2.3), sans condition de contexte (le changement ne coûte rien sur les modèles 5.5). Conseil seulement en cas d'écart d'au moins 2 crans (ex. `high` pour une tâche simple), au plus une fois toutes les `effortAdviceEvery` (5) demandes. Toujours en `systemMessage`, jamais de blocage.
- **Modèle** : comparé uniquement au **premier message** d'une session (y compris après `/clear`) ou tant que le contexte ajouté est < `modelAdviceMaxAddedTokens` (10k).
  - mode `modelAdvice: "hint"` (défaut) : `systemMessage` « Tâche jugée <niveau> → <modèle> + effort <x> (sélecteur de modèle). » ;
  - mode `block` : bloquer le message avec le même texte suivi de « Change puis renvoie, ou renvoie tel quel pour ignorer. » Un message identique (même empreinte) envoyé ensuite passe toujours ; jamais deux blocages de suite dans une session. N'est proposé que si **[L0-2]** confirme que le texte bloqué est récupérable ;
  - mode `off`.
- Ne conseiller un modèle **plus cher** que pour les niveaux complexe et critique.
- Hook **`PreModelSwitch`** : quand l'utilisateur change de modèle en cours de session avec un contexte ajouté ≥ 10k, répondre `permissionDecision: "ask"` avec « Changer maintenant renvoie ~Xk tokens (`context_tokens`) au nouveau modèle. Pour une tâche différente, un /handoff puis /clear coûte moins cher. Continuer ? ». Seul `/model` en session interactive affiche cette question ; ailleurs (`-p`, `/config`, `set_model`, sélecteur de l'app), `ask` vaut **refus**. Le hook ne répond donc `ask` que pour les valeurs de `source` correspondant à `/model` interactif, relevées par la sonde du lot 0 (liste en config, `modelSwitchAskSources`) ; pour toute autre valeur, il ne répond rien et la confirmation native s'applique.
- Hook **`PostModelSwitch`** : met à jour le modèle dans l'état de session et journalise `model_switch` (pour mesurer si les conseils sont suivis).
- **Mode rapide** actif (`fast_mode`) : rappel au premier message de chaque session (« le mode rapide augmente le coût d'Opus »).
- README : documenter l'alias natif `opusplan` et le réglage de l'effort sans perte de cache.

## 10. Commandes

| Commande | Rôle |
|---|---|
| `/handoff` | Résumé structuré, enregistré par `bin/save-handoff`, puis discussion vidée (app) ; `--garder` pour ne pas vider |
| `/conso` | Rapport consommation + gains |
| `/lean` | Audit et désactivation des plugins, skills, MCP |
| `/reprendre` | Charge le dernier handoff du projet (`--auto` : la sauvegarde auto) |
| `/conso-pilot:setup` | Crée la config, installe ou enchaîne la barre d'état, ajoute la permission de `save-handoff` ; affiche un diff et demande confirmation avant toute écriture ; sauvegarde datée des fichiers modifiés |
| `/conso-pilot:status` | Config, seuils, état de la session, intégrations détectées (rtk, context-mode, barre d'état), 5 dernières erreurs de `errors.log` |
| `/conso-pilot:uninstall` | Retire la barre d'état et la permission ajoutées (restaure la sauvegarde), garde les données |

- Les modifications de `~/.claude/settings.json` (setup, uninstall, `/lean`) sont faites par un script (`bin/settings-edit`) lancé par Claude après confirmation, jamais par Write/Edit (chemin protégé).
- Les commandes qui ne font qu'afficher un résultat (`/conso`, `/lean` sans action, `/conso-pilot:status`) exécutent un script et demandent à Claude de recopier la sortie sans commentaire.
- Noms choisis pour éviter les commandes natives (`/resume`, `/compact`, `/clear`, `/context`, `/model`…) ; en cas de conflit, Claude Code les expose en `/conso-pilot:<nom>`.

## 11. Critères d'acceptation

Les tests automatisés (`npm test`, `node:test`, sans dépendance) rejouent des transcripts et des entrées de hook enregistrés (dossier `test/fixtures/`).

1. Base 20k. +30k → aucune alerte. +45k pendant une tâche (dernier message avec appel d'outil, tâches en cours ou tâche de fond active) → aucune alerte ; +45k tâche terminée → une alerte « Handoff maintenant » (`systemMessage` + notification + barre rouge en CLI), non répétée au tour suivant. +101k → alerte à chaque message.
2. Après un compactage, la baseline est remesurée : pas d'alerte immédiate.
3. Premier message « renomme cette variable » sous Opus `high` → conseil « Sonnet + effort low ». Avec +20k de contexte → pas de conseil de modèle, mais conseil d'effort (`high` → `low`, écart de 2 crans).
4. `/model sonnet` en cours de session avec +30k → question de `PreModelSwitch` citant `context_tokens` ; après le changement, l'état indique Sonnet.
5. Un build est délégué à `runner` ; sa consommation apparaît dans `/conso` (via `SubagentStop`), sans double comptage ; les agents internes sont comptés à part.
6. Comptage : sur un transcript enregistré, la somme du journal = somme des `usage` dédoublonnés par `message.id`.
7. Pause > TTL avec 50k de contexte → message bloqué ; renvoyé tel quel → passe. TTL détecté = 60 min sur un transcript avec `ephemeral_1h_input_tokens`, 5 min avec `ephemeral_5m_input_tokens`.
8. Reprise (`resume`) d'une discussion de 150k vieille de 2 h → ligne « Cache expiré… » issue des champs natifs.
9. Nouvelle discussion 5 h après un handoff → pas d'injection, une ligne propose `/reprendre`.
10. `/handoff` → fichier daté + `latest.md`, sans demande de confirmation ; `/clear` dans les 30 min → résumé réinjecté (vérifier avec `/context`) ; `/clear` 2 h plus tard → simple proposition.
11. `/compact` et `/clear` → `auto/<session>.md` à jour **avant** l'effacement ; `latest.md` inchangé ; `SessionEnd` < 500 ms.
12. `Read DerivedData/…/gros.log` complet → refusé avec la raison ; `Grep "error" DerivedData/…` → autorisé avec message visible.
13. Script de hook volontairement cassé → la session continue, l'erreur est dans `errors.log`.
14. Performance : sur un transcript de 50 Mo, chaque hook synchrone < 200 ms (p95 sur 20 exécutions).
15. `git status` passe toujours par rtk ; `/context-mode:ctx-doctor` reste entièrement au vert.
16. `/conso` affiche les chiffres par projet (bruts et pondérés) et les gains rtk.
17. Aucun trafic réseau émis par le plugin (vérifié avec `nettop` pendant une session de test).
18. `/conso-pilot:uninstall` restaure `settings.json` à l'identique.

## 12. Plan de réalisation

- **Lot 0 — deux vérifications en conditions réelles** (≈ 10 min, hook « sonde » qui enregistre ses entrées dans `~/.claude/conso-pilot/probe/` ; ces enregistrements servent ensuite de fixtures de test) :
  - **[L0-1]** l'app desktop affiche-t-elle `statusLine` ? (configurer une barre d'état de test, ouvrir une discussion dans l'onglet Code) ;
  - **[L0-2]** après un blocage `UserPromptSubmit`, le texte du prompt est-il récupérable (app : champ restauré ? CLI : flèche ↑) ?
  - au passage (relevé, pas une vérification) : valeurs de `source` reçues par `PreModelSwitch` pour `/model` en CLI et pour le sélecteur de l'app, à reporter dans `modelSwitchAskSources`.
  - **Résultats (2026-10-06, app desktop, Claude Code 2.1.251)** :
    - [L0-1] **négatif** : `statusLine` jamais appelée dans l'app (hooks du même `settings.local.json` actifs) → repli §4 : barre d'état = bonus CLI.
    - [L0-2] **positif** : le champ n'est pas restauré, mais le texte bloqué se récupère avec ↑ ; renvoyé tel quel, il passe → `cacheGuard: "block"` reste le défaut, `modelAdvice: "block"` autorisé. CLI (↑) : à confirmer.
    - `PreModelSwitch.source` : dans l'app, sélecteur **et** `/model` → `"sdk"` (donc **pas** dans `modelSwitchAskSources` : `ask` y vaudrait refus). L'app affiche sa propre confirmation (« Changer de modèle ? ») **avant** le hook. CLI `/model` : à relever.
    - Champs reçus par `Pre`/`PostModelSwitch` en plus de ceux prévus : `from_model`, `to_model`, `requested_model`, `prompt_cache_warm`, `cache_ttl` (`"1h"`), `estimated_cache_write_usd`, `pricing` → `cache_ttl` est une source directe pour §2.4, `estimated_cache_write_usd` utilisable dans le message `ask`.
- **Lot 1** : mesure, état de session, journal, `/conso` (sans gains), `/conso-pilot:status`.
  - **Fait (2026-10-06)** : hooks `SessionStart`, `Stop`, `SubagentStop` (async), `PreCompact`, `SessionEnd`, `PostModelSwitch` (async) ; critères 6, 13, 14 et la partie mesure des critères 2, 5, 7 couverts par `npm test`. Journal vérifié sur un transcript réel (somme identique au calcul dédoublonné indépendant) ; `Stop` en 50 ms sur un transcript de 152 Mo.
  - Agents internes : `agent_type` vide **et** aucun transcript (`agent_transcript_path` inexistant) → rien à compter ; un agent sans type mais avec transcript est étiqueté par son `.meta.json` (`agentType`), sinon `internal:unknown`.
- **Lot 2** : handoff, sauvegarde auto, relecture, `/reprendre`.
  - **Fait (2026-10-06)** : `bin/save-handoff`, `bin/reprendre`, `/handoff`, `/reprendre`, sauvegarde auto (`Stop` toutes les 5 min, `PreCompact` et `SessionEnd` forcés), relecture `SessionStart` (§5.4), rétention, `aiSummary` ; critères 9, 10, 11 couverts par `npm test` (sauf la vérification `/context`, manuelle).
  - L'activité (demandes, fichiers, tâches, erreurs) est extraite pendant la lecture incrémentale de chaque `Stop` et gardée dans l'état de session ; seule l'écriture du fichier est espacée. `PreCompact` et `SessionEnd` journalisent aussi les appels lus avant eux (sinon perdus pour le journal).
  - Demandes retenues : lignes `user` non méta, `origin.kind` humain, sans `tool_result` ; rappels système retirés ; commandes réduites à `/nom args`. Tâches : `TodoWrite` remplace la liste, `TaskCreate` / `TaskUpdate` la modifient (identifiants numérotés dans l'ordre de création). Erreurs : `tool_result` en erreur d'un appel `Bash`.
  - Le chemin de `save-handoff` est appelé via `node` (couvert par `allowed-tools: Bash(node:*)` de la commande).
- **Lot 3** : alertes §3, barre d'état, `/conso-pilot:setup` / `uninstall`.
  - **Fait (2026-10-06)** : hook `UserPromptSubmit` (plafond du handoff, cache expiré), alerte A sur `Stop`, alerte de reprise sur `SessionStart`, notifications détachées, `bin/statusline`, `bin/settings-edit` (`setup` / `uninstall`), commandes `/conso-pilot:setup` et `/conso-pilot:uninstall` ; critères 1, 2, 7, 8 et 18 couverts par `npm test`.
  - « Dernier message avec appel d'outil » et texte final : suivis pendant la lecture incrémentale (`cursor.lastMessage`) ; `last_assistant_message` tronqué (« … ») → texte du transcript. Tâche de fond sans statut lisible = en cours.
  - Alertes et `handoffDone` remis à zéro à chaque remesure de la baseline (nouvelle session, compactage).
  - Cache expiré : une seule intervention par pause (clé = horodatage de la dernière réponse) : le message renvoyé passe, et un autre message aussi. Texte : « …ou fais /clear puis /reprendre --auto » (la sauvegarde auto n'est jamais rechargée seule, « rechargée » aurait été inexact).
  - Notification au déclencheur B : la première fois seulement (le `systemMessage` reste à chaque message).
  - Barre d'état : ses relevés vont dans `state/live/<session>.json` (jamais dans l'état des hooks, pour ne pas écraser le curseur du transcript) ; les hooks et `/conso-pilot:status` les appliquent s'ils sont plus récents que l'état. Contexte = `current_usage` avec `output_tokens` (même définition que §2.1). Segment « éco » lu dans `cache/eco.json`, produit au lot 4.
  - Le dossier du plugin change à chaque version (`plugins/cache/…/<version>`) : `statusLine` et la permission visent des **lanceurs stables** `~/.claude/conso-pilot/bin/{statusline,save-handoff}`, qui chargent le script du plugin indiqué par `plugin-root` (réécrit à chaque `SessionStart`). `save-handoff --prepare` affiche ce lanceur quand il existe, sans guillemets, pour que la règle `Bash(node <lanceur>:*)` corresponde.
  - `uninstall` : si `settings.json` n'a pas bougé depuis le setup (empreinte SHA-256), restauration octet pour octet de la sauvegarde ; sinon retrait ciblé (barre d'état rétablie, règle retirée). Indentation et fin de fichier d'origine conservées.
- **Lot 4** : dossiers lourds §7, gains §8.3.
  - **Fait (2026-10-06)** : hook `PreToolUse` (matcher `Read|Bash|Grep|Glob`), journal `deny` et `cache_block`, section « Gains estimés » de `/conso`, segment « éco » (cache `cache/eco.json`, recalcul détaché `bin/eco-refresh` au plus toutes les 5 min) ; critères 12 et 16 couverts par `npm test`. Sonde du lot 0 désactivée (`.claude/settings.local.json` du dépôt supprimé ; `probe/` gardé pour relever `PreModelSwitch.source` en CLI au lot 6).
  - Le hook ne répond jamais `allow` (un accès ciblé reçoit seulement un `systemMessage`) : les permissions natives restent seules juges.
  - Bash : analyse par segments (`;`, `&&`, `||`, `|`), guillemets respectés, corps des here-documents et cibles de redirection ignorés, préfixes `rtk`, `sudo`, `VAR=…` retirés. `ls` sans `-R` et `find .` ne sont pas concernés (seuls les chemins explicitement lourds le sont). `grep`/`rg` : motif vague → refus, sinon avertissement. `head`/`tail` : ≤ 300 lignes → avertissement, au-delà ou `-n +1` → refus.
  - Taille au-delà de `heavyFileBytes` : sans effet sur les images et PDF (Read les affiche autrement).
  - Taille évitée d'un refus **plafonnée à la sortie maximale de l'outil** (Read ~100 000 caractères ≈ 25k tokens, Bash/Grep/Glob ~30 000) : on ne compte que ce qui serait réellement entré dans le contexte ; pas de parcours de dossier dans le hook.
  - rtk : `rtk gain -d -f json`, jours de la période (tous projets), mis en cache 5 min ; pondéré = tokens × écriture cache 1 h × poids moyen des modèles de la période (borne basse : relectures ignorées).
  - context-mode : `~/.claude/context-mode/sessions/stats-*.json` (`tokens_saved`, filtré sur `updated_at`). **Affiché mais pas ajouté au total** : il compte tout ce qui passe par son bac à sable (≈ 149M tokens sur 7 jours ici), y compris ce qui n'aurait jamais été lu.
  - Handoffs : nouvelle discussion du même projet ouverte dans les `autoResumeHours` après le handoff ; gain = (contexte du handoff − contexte de sa première réponse) × (tours × lecture cache + une écriture cache 1 h) × poids du modèle.
- **Lot 5** : `/lean` §6.
  - **Fait (2026-10-06)** : `lib/inventory.js`, `lib/lean.js`, `bin/lean`, commande `/lean` (rapport, `off` / `on` avec aperçu, confirmation, sauvegarde datée) ; alerte « ~XXk tokens d'outils/skills chargés » ; couvert par `test/lean.test.js`.
  - **Inventaire relevé dans le transcript, pas estimé à partir des fichiers** : Claude Code y écrit des lignes `attachment` qui décrivent exactement ce que reçoit le modèle — `skill_listing` (texte complet des skills et commandes), `deferred_tools_delta` (noms des outils différés, ajouts et retraits, serveurs en attente d'authentification), `prompt_snapshot` (définitions complètes des outils non différés ; vu dans l'app), `mcp_instructions_delta`, `agent_listing_delta`. Poids = caractères ÷ `leanCharsPerToken` (4). Les pondérations « × 15 / × 300 » deviennent inutiles. Raison : l'essentiel du poids constaté ici vient de plugins et connecteurs fournis par l'app (≈ 300 skills, 400 outils différés), absents des fichiers de `~/.claude` ; le nombre d'outils d'un serveur MCP n'est de toute façon pas connaissable hors ligne.
  - Relevé pendant la lecture incrémentale de `Stop` (filtre sur `"attachment":{"type":"…"`), enregistré dans `cache/inventory/<projet>.json` seulement quand une telle ligne est lue. `SessionStart` (`startup`, `clear`) fait partir la lecture du début du transcript, sinon un `prompt_snapshot` de plusieurs centaines de Ko sortirait de la fenêtre de 256 Ko.
  - **Alerte à la première réponse, pas au `SessionStart`** : rien n'est encore écrit dans le transcript au `SessionStart`, et un inventaire de la session précédente serait périmé après un `/lean off`. Seuil comparé au total **désactivable** (outils natifs, skills sans préfixe, agents natifs et outils `ccd_*` de l'app exclus, affichés à part).
  - Dernier usage : transcripts du projet (`~/.claude/projects/<chemin, non alphanumériques → « - »>/`, sous-agents compris) relus de façon incrémentale (`cache/usage/<projet>.json`), plutôt que le journal : historique disponible dès le premier `/lean` (152 Mo lus en 0,5 s, puis 0,06 s). Usage = appel `Skill`, outil `mcp__<serveur>__*`, agent `plugin:type`, commande `/plugin:nom`.
  - Classement : plugin Claude Code (`installed_plugins.json`, nom lu dans `plugin.json` — il peut différer du nom d'installation) ; plugin de l'app (préfixe de skill ou serveur `plugin_<nom>_…` inconnu des fichiers) ; serveur de `.mcp.json`, local ou utilisateur (`~/.claude.json`) ; connecteur claude.ai (identifiant UUID, montré avec trois noms d'outils) ; autre serveur de l'app.
  - Portée par défaut de `/lean off` : `.claude/settings.local.json` du projet (non commité) ; `--scope projet` pour `.claude/settings.json` (partagé), `--scope user` pour `~/.claude/settings.json`. `/lean on` retire le `false` posé, et écrit `true` si le plugin reste désactivé à un autre niveau. Historique dans `lean-actions.json` (section « Désactivés avec /lean » du rapport).
- **Lot 6** : agents, conseils d'effort et de modèle, `PreModelSwitch` / `PostModelSwitch` §9.
  - **Fait (2026-10-06)** : `lib/advice.js`, agents `agents/runner.md` et `agents/architect.md`, consigne de délégation (`SessionStart` `startup`/`clear`, ajoutée après le handoff relu), conseils sur `UserPromptSubmit`, hook `PreModelSwitch`, section « Conseils de modèle et d'effort » de `/conso` ; couvert par `test/advice.test.js`.
  - Sources supplémentaires (§2.3), utilisées seulement si rien d'autre ne donne la valeur : effort = variable `CLAUDE_EFFORT` de l'environnement des hooks ; modèle = option `--model` du processus Claude Code (`ps -o args= -p $CLAUDE_PID`, ~3 ms, une fois par session). Dans l'app, `SessionStart` ne fournit pas `model` : sans cela, le premier message n'aurait jamais de comparaison.
  - Classement : simple = mots-clés **ou** (< 200 caractères **et** ≤ 1 fichier) ; complexe = mots-clés ou ≥ 4 fichiers ; critique en premier. Les commandes (`/…`) ne sont pas classées. Fichiers = chemins `a/b`, noms avec extension de code connue, `@fichier`.
  - Modèle : conseillé au premier message ou tant que le contexte ajouté < `modelAdviceMaxAddedTokens`, **une fois par couple (niveau, modèle conseillé) et par session** ; plus cher seulement pour complexe/critique ; comparaison par les poids `costWeights.models`. Modèle inconnu : conseil sans comparaison au premier message seulement, jamais de blocage. En `block`, un blocage du cache expiré compte comme blocage (jamais deux de suite).
  - Effort : écart ≥ 2 crans dans les deux sens (`low` < `medium` < `high` < `xhigh` < `max`), sur Opus 5.5 / Sonnet 5.5 / Fable 5.1 seulement.
  - Suivi (`/conso`) : calculé à l'affichage — un conseil est suivi si un tour ultérieur de la même session utilise le modèle (famille) ou l'effort conseillé ; le journal reste en ajout simple.
  - `PreModelSwitch` : réponse `hookSpecificOutput.permissionDecision: "ask"` seulement si `source` ∈ `modelSwitchAskSources` (vide par défaut : l'app envoie `"sdk"`, où `ask` vaudrait refus) et contexte ajouté ≥ `modelSwitchGuardMinAddedTokens`.
  - **`/handoff` vide aussi la discussion** (demande utilisateur) : dans l'app, la commande appelle `mcp__ccd_session_mgmt__clear_session` avec `"self"` (effectif à la fin du tour, approuvé par l'utilisateur) ; le `SessionStart` `clear` qui suit recharge le handoff (< `clearResumeMinutes`). En CLI, aucun outil ne peut lancer `/clear` : la commande demande de le taper. `/handoff --garder` ne vide pas.

## Annexe A — `config.json` par défaut

```json
{
  "handoffAt": 40000,
  "handoffForceAt": 100000,
  "handoffRepeatEvery": 20000,
  "cacheGuard": "block",
  "cacheWarnMinTokens": 50000,
  "cacheTtlMinutes": null,
  "notifications": true,
  "resumeMaxTokens": 2000,
  "autoResumeHours": 2,
  "clearResumeMinutes": 30,
  "retentionDays": 30,
  "retentionMaxFiles": 50,
  "autoSaveEveryMinutes": 5,
  "aiSummary": false,
  "leanWarnTokens": 15000,
  "leanCharsPerToken": 4,
  "heavyPaths": ["DerivedData/", "Pods/", "node_modules/", "build/", ".build/", "dist/", ".gradle/", "*.xcarchive",
                 "Package.resolved", "package-lock.json", "yarn.lock", "Podfile.lock"],
  "heavyFileBytes": 1048576,
  "targetedReadMaxLines": 300,
  "modelAdvice": "hint",
  "modelAdviceMaxAddedTokens": 10000,
  "effortAdvice": true,
  "effortAdviceEvery": 5,
  "modelSwitchGuardMinAddedTokens": 10000,
  "modelSwitchAskSources": [],
  "delegationHint": true,
  "advice": {
    "simple":   { "model": "sonnet", "effort": "low" },
    "standard": { "model": "sonnet", "effort": "medium" },
    "complex":  { "model": "opus",   "effort": "high" },
    "critical": { "model": "opus",   "effort": "xhigh" }
  },
  "costWeights": {
    "models": { "fable": 4, "opus": 2, "sonnet": 1, "haiku": 0.5 },
    "fastModeMultiplier": 2,
    "outputRatio": 5,
    "cacheWrite5m": 1.25,
    "cacheWrite1h": 2,
    "cacheRead": 0.1
  },
  "contextWindowByModel": { "default": 200000 }
}
```

## Annexe B — Changements

### v2 → v3 (vérifications dans la documentation)
| § | v2 | v3 | Fait établi |
|---|---|---|---|
| 0, 9 | Changement de modèle surveillé par `UserPromptSubmit` seul | Hooks `PreModelSwitch` (question avec `context_tokens`) et `PostModelSwitch` (suivi du modèle) | Ces deux hooks existent ; la confirmation native couvre déjà le cas « cache chaud » |
| 9.0, 9.2 | Effort conseillé en début de session seulement ; effet sur le cache à vérifier | Effort conseillé à tout moment | Sur Opus 5.5 / Sonnet 5.5 / Fable 5.1 avec abonnement, changer d'effort garde le cache |
| 9.1 | Champ `effort` du frontmatter à vérifier | `architect` en `effort: high` ; pas d'effort pour Haiku | Le frontmatter des sous-agents accepte `effort` |
| 2.4 | TTL 60 min constaté | 1 h conversation principale, 5 min sous-agents et crédits d'usage | Règles documentées de choix du TTL |
| 3.3 | Pause détectée par calcul seulement | Plus les champs natifs de reprise (`prompt_cache_likely_expired`, `context_tokens`) | Disponibles dans `SessionStart` depuis 2.1.251 |
| 3.3 | `reason` du blocage : visibilité non précisée | Montrée à l'utilisateur, non ajoutée au contexte | Documenté |
| 1, 5.2, 10 | Écriture dans `~/.claude` « peut-être » confirmée | Toujours par script ; jamais par Write/Edit | Les chemins protégés ne sont pas pré-approuvés par `permissions.allow` |
| 1, 3.2 | `systemMessage` partout | Hooks synchrones pour tout `systemMessage` | Le `systemMessage` d'un hook `async` n'est pas montré |
| 1, 5.3 | `SessionEnd` sans contrainte | < 500 ms ; `Stop` devient la sauvegarde principale | Budget `SessionEnd` de 1,5 s, non relevable par un plugin |
| 2.1, 4 | Champs de la barre d'état supposés | `context_window.*`, `rate_limits.*`, `effort.level`, `fast_mode` confirmés | Documentés |
| 3.1 | Fin de tâche sans tâches de fond | Ajout de `background_tasks` | Champ de l'entrée `Stop` |
| 5.1 | Ordre `SessionEnd`/`SessionStart` à vérifier | Sans importance par construction | `latest.md` n'est écrit que par `/handoff` |
| 8.1 | Tous les `SubagentStop` comptés pareil | Agents internes (`/btw`, suggestions) comptés à part | Ils déclenchent aussi `SubagentStop` |
| 12 | 7 vérifications | 2 vérifications | Les 5 autres sont tranchées par la documentation |

### v1 → v2
| § | v1 | v2 | Raison |
|---|---|---|---|
| 1 | Lecture du transcript non précisée | Lecture incrémentale + dédoublonnage par `message.id` | Transcripts de plusieurs dizaines de Mo ; `usage` répété sur chaque bloc |
| 2.2 | Baseline mesurée une fois | Remesurée après compactage / `/clear` | Sinon fausse alerte ou alerte manquée |
| 2.4 / 3.3 | TTL 5 min auto-calibré | TTL lu dans `cache_creation.ephemeral_1h/5m` | Le TTL réel est d'1 h ici |
| 3.1 | « Aucun outil appelé dans le dernier tour » | Dernier message sans outil ni question + tâches terminées | Un tour de travail contient presque toujours des outils |
| 3.3 / 9.2 | Blocage systématique | Modes `block` / `hint` / `off` | Le texte bloqué peut être perdu |
| 4 | Barre d'état comme canal clé | Canal principal = `systemMessage` ; barre d'état enchaînable | Affichage dans l'app non garanti |
| 5.1 / 5.4 | `latest.md` = plus récent (auto inclus) | `latest.md` = manuel uniquement | Sinon la sauvegarde mécanique écrase le handoff |
| 5.4 | Injection après tout `/clear` | Seulement si handoff < 30 min | Un `/clear` sert souvent à changer de sujet |
| 6 | `enabledPlugins` pour tout | Plugins / `disabledMcpjsonServers` / marche à suivre pour les connecteurs | `enabledPlugins` ne couvre pas les MCP |
| 7 | Grep/Glob toujours filtrés | Read et Bash en priorité | Grep respecte déjà `.gitignore` |
| 8 | Tokens bruts, gains ÷ 4 | Tokens pondérés par le coût | Une relecture en cache coûte ~10 % |
| 9.0 | Tarifs codés en dur | Poids relatifs en config | Tarifs susceptibles de changer |
| 9.1 | Agent `explorer` | Agent natif `Explore` | Doublon |
| 10 | — | `/conso-pilot:uninstall`, diff avant `setup` | Réversibilité |

## Annexe C — Sources

Documentation officielle Claude Code, consultée le 2026-10-05 :
- Hooks : https://code.claude.com/docs/en/hooks — entrées `SessionStart` (champs de reprise), `Stop` (`last_assistant_message`, `background_tasks`), `SubagentStop` (`agent_transcript_path`), `UserPromptSubmit` (`decision`/`reason`), `PreModelSwitch` / `PostModelSwitch`, `SessionEnd` (budget 1,5 s), hooks `async`.
- Barre d'état : https://code.claude.com/docs/en/statusline — `context_window`, `rate_limits`, `effort.level`, `fast_mode`.
- Cache : https://code.claude.com/docs/en/prompt-caching — TTL, changement de modèle et d'effort.
- Chemins protégés : https://code.claude.com/docs/en/permission-modes#protected-paths
- Sous-agents : https://code.claude.com/docs/en/sub-agents — frontmatter (`model`, `effort`, `experimental.cacheTtl`).

Constats locaux : transcript avec `cache_creation.ephemeral_1h_input_tokens` > 0 et lignes multiples par `message.id` ; aucune `statusLine` configurée ; hooks de context-mode listés en §0.
