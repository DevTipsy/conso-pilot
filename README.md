# conso-pilot

Plugin Claude Code qui mesure et réduit la consommation de tokens. Spécification complète : [SPEC.md](SPEC.md).

État : **lots 1 à 6 terminés** (mesure, état de session, journal, `/conso`, `/conso-pilot:status` ; handoff, sauvegarde automatique, relecture, `/reprendre` ; alertes handoff et cache, barre d'état, `/conso-pilot:setup` et `uninstall` ; dossiers lourds, gains dans `/conso` ; contexte chargé et `/lean` ; conseils de modèle et d'effort, agents `runner` et `architect`).

## Installation (scope utilisateur)

```bash
claude plugin marketplace add /Users/thibault/Documents/Projets/conso-pilot
```

```bash
claude plugin install conso-pilot@conso-pilot
```

Mise à jour après modification du dépôt :

```bash
claude plugin marketplace update conso-pilot && claude plugin update conso-pilot@conso-pilot
```

Puis, une fois, `/conso-pilot:setup` (barre d'état et permission de `/handoff`, avec diff et confirmation).

Pour un essai ponctuel sans installation : `claude --plugin-dir /Users/thibault/Documents/Projets/conso-pilot`.

## Commandes

| Commande | Rôle |
|---|---|
| `/conso` | Consommation par projet et modèle (jour / 7 jours), brute et pondérée ; part des sous-agents ; sessions les plus coûteuses ; gains estimés (rtk, lectures bloquées, handoffs ; context-mode à part) |
| `/conso-pilot:status` | Configuration, état de la session, intégrations détectées, 5 dernières erreurs |
| `/handoff` | Claude rédige un résumé structuré (≤ 1 500 tokens), enregistré par `bin/save-handoff`, puis vide la discussion (app : automatiquement, après ton accord ; CLI : tape `/clear`) — le résumé est rechargé aussitôt. `/handoff --garder` : sans vider |
| `/reprendre` | Charge le dernier handoff du projet ; `--auto` : la dernière sauvegarde automatique |
| `/lean` | Poids des plugins, skills, connecteurs et serveurs MCP chargés à chaque discussion, avec leur dernier usage dans le projet ; `/lean off <nom>` / `/lean on <nom>` (`--scope local\|projet\|user`) désactive ou réactive un plugin Claude Code ou un serveur de `.mcp.json`, après aperçu et confirmation |
| `/conso-pilot:setup` | Installe (ou enchaîne avec l'existante) la barre d'état et autorise `save-handoff` ; diff et confirmation avant écriture, sauvegarde datée |
| `/conso-pilot:uninstall` | Retire ce que setup a ajouté (restauration à l'identique si `settings.json` n'a pas bougé) ; garde les données |

## Alertes

- **🔴 Handoff maintenant** : contexte ajouté (depuis la première réponse ou le dernier compactage) ≥ 40k et tâche terminée (pas d'appel d'outil ni de question en fin de réponse, tâches toutes terminées, aucune tâche de fond) ; rappel tous les +20k. Dès +100k : à chaque message. Plus rien après `/handoff`.
- **Cache expiré** : pause plus longue que la durée du cache (1 h en général) avec ≥ 50k de contexte → le message est bloqué une fois (`cacheGuard: "block"`) ; ↑ puis Entrée pour l'envoyer quand même. `"hint"` : simple avertissement ; `"off"`.
- Reprise d'une ancienne discussion au cache expiré : une ligne d'avertissement.
- Canaux : message dans la discussion (non envoyé au modèle), notification macOS (`notifications: false` pour couper), barre d'état en rouge.

## Dossiers lourds

`DerivedData/`, `Pods/`, `node_modules/`, `build/`, `.build/`, `dist/`, `.gradle/`, `*.xcarchive`, fichiers de verrouillage et tout fichier texte > 1 Mo (`heavyPaths`, `heavyFileBytes`) :

- accès large refusé, avec une consigne à Claude (Read complet ou `limit` > 300, `cat`, `less`, `ls -R`, `find`, `tree`, `grep` au motif vague, `head`/`tail` de plus de 300 lignes, Glob `**`) ;
- accès ciblé autorisé avec un avertissement (Grep avec un vrai motif, Read avec `limit` ≤ 300, `tail -n 100`) ;
- `heavyPaths: []` et `heavyFileBytes: 0` désactivent le contrôle.

## Modèle, effort et agents

- Chaque message est classé sans IA (simple, standard, complexe, critique : longueur, fichiers mentionnés, mots-clés comme « renomme », « architecture », « ultrathink ») ; correspondance dans `advice` (défaut : Sonnet/low, Sonnet/medium, Opus/high, Opus/xhigh).
- **Modèle** : conseil au premier message (ou tant que le contexte ajouté < 10k), une fois par niveau ; un modèle plus cher n'est conseillé que pour les tâches complexes ou critiques. `modelAdvice` : `"hint"` (défaut, simple message), `"block"` (premier envoi bloqué, ↑ puis Entrée pour l'envoyer tel quel), `"off"`. Changer de modèle vide le cache : c'est pour ça que le conseil arrive tôt.
- **Effort** : conseillé à tout moment si l'écart est d'au moins 2 crans (au plus une fois toutes les 5 demandes). Sur Opus 5.5, Sonnet 5.5 et Fable 5.1, changer d'effort **ne vide pas le cache**.
- `opusplan` (alias natif) : Opus pour planifier, Sonnet pour exécuter — bon compromis pour les tâches complexes.
- Mode rapide actif : rappel au premier message (il double le coût pondéré).
- Agents fournis : `runner` (Haiku, Bash et Read) lance builds et tests et ne rend que les erreurs utiles ; `architect` (Opus, effort high, lecture seule) rend une recommandation argumentée. Une consigne de 30 tokens en début de discussion indique à Claude de leur déléguer (et à `Explore` les recherches larges) ; `delegationHint: false` pour la retirer.
- `/conso` indique combien de conseils ont été suivis.
- Changement de modèle en cours de session : la confirmation native de Claude Code s'applique ; `modelSwitchAskSources` permet d'y ajouter la question de conso-pilot (CLI, à relever).

## Contexte chargé (`/lean`)

- Inventaire **relevé, pas estimé** : Claude Code écrit dans le transcript la liste exacte des skills, des outils (différés ou non), des instructions MCP et des agents envoyés au modèle. conso-pilot la lit à la première réponse de chaque discussion (poids = caractères ÷ 4, `leanCharsPerToken`). Plugins et connecteurs de l'app compris.
- Au-delà de 15k tokens désactivables (`leanWarnTokens`) : « ~XXk tokens d'outils/skills chargés — /lean pour alléger », une fois par jour et par projet.
- Dernier usage : appels `Skill`, outils `mcp__…`, agents et commandes `/plugin:nom` lus dans les transcripts du projet (sous-agents compris), relus de façon incrémentale.
- Désactivation par le script, jamais par Claude : plugin → `enabledPlugins` (défaut : `.claude/settings.local.json` du projet, non partagé) ; serveur de `.mcp.json` → `disabledMcpjsonServers`. Serveur MCP utilisateur ou local : `/mcp` ; plugin de l'app ou connecteur : réglages de l'app. Sauvegarde datée dans `backups/`, historique dans `lean-actions.json`.

## Barre d'état (CLI seulement)

`Sonnet·medium · ctx 74k (+52k) · 5h 42% · 7j 18% · cache 3:12 · éco ~528k` — « éco » : gains pondérés sur 7 jours, recalculés en arrière-plan toutes les 5 min ; minuteur du cache dans ses 10 dernières minutes, segments de droite retirés si la largeur manque. L'app desktop n'affiche pas `statusLine`. Une barre existante peut être enchaînée (sa sortie en préfixe).

## Handoff et reprise

- `/handoff` puis `/clear` dans les 30 min : le résumé est rechargé automatiquement (plafond 2 000 tokens). Nouvelle discussion dans les 2 h : idem. Au-delà, une ligne propose `/reprendre`.
- Après un compactage, le handoff n'est réinjecté que s'il date de la session courante et que context-mode est inactif.
- Sauvegarde automatique, sans IA ni token : à chaque fin de réponse (au plus toutes les 5 min), avant un compactage et en fin de session ; 10 dernières demandes, fichiers modifiés, liste de tâches, 5 dernières commandes en erreur. Jamais injectée automatiquement.
- Option `aiSummary` (défaut `false`) : résumé détaché par `claude -p --model haiku` en fin de session (consomme du quota).
- `/conso-pilot:setup` autorise `Bash(node ~/.claude/conso-pilot/bin/save-handoff:*)` : plus de confirmation à chaque `/handoff`.

## Données

Tout est dans `~/.claude/conso-pilot/` :

- `config.json` : créée avec les défauts au premier lancement (spec annexe A) ;
- `state/<session_id>.json` : état de session (offset du transcript, baseline, contexte, modèle, effort, TTL du cache) ;
- `log-AAAA-MM.jsonl` : une ligne par tour et par modèle (`type: "turn"`, champs `project, session, agent, model, effort, fast, input, cache_5m, cache_1h, cache_read, output, context, calls`), plus les événements `compact`, `clear`, `handoff`, `model_switch`, `deny` (accès lourd refusé, taille évitée), `cache_block` ;
- `handoffs/<slug-du-projet>/` : handoffs datés, `latest.md` (dernier handoff manuel, seul relu automatiquement), `auto/<session8>.md` (sauvegarde automatique) ; rétention 30 jours / 50 fichiers par projet ;
- `state/live/<session_id>.json` : derniers relevés de la barre d'état (modèle, effort, mode rapide, contexte) ;
- `bin/statusline`, `bin/save-handoff` : lanceurs stables installés par setup (suivent les mises à jour du plugin via `plugin-root`) ; `install.json` : ce que setup a modifié ; `backups/` : copies datées de `settings.json` ;
- `cache/` : `rtk-gain.json` (sortie de `rtk gain`, 5 min), `eco.json` (total des gains pour la barre d'état), `inventory/<projet>.json` (dernier inventaire du contexte chargé), `usage/<projet>.json` (dernier usage par élément, offsets de lecture), `lean-warned.json` ;
- `lean-actions.json` : désactivations et réactivations faites par `/lean` ;
- `errors.log` : erreurs des hooks (fail-open, tronqué à 1 Mo).

## Tokens pondérés

`(input + 1,25 × cache_5m + 2 × cache_1h + 0,1 × cache_read + 5 × output) × poids du modèle × (mode rapide ? 2 : 1)`, poids en config (`costWeights`).

## Tests

```bash
npm test
```

`node:test`, sans dépendance. Les entrées de hook réelles relevées par la sonde du lot 0 sont dans `test/fixtures/hooks/`.
