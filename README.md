# conso-pilot

> 🇬🇧 English below · 🇫🇷 Version française plus bas

A Claude Code plugin that measures and reduces how many tokens Claude Code burns — context, handoffs, cache, and weighted cost.
Un plugin Claude Code qui mesure et réduit la consommation de tokens de Claude Code — contexte, handoff, cache et coût pondéré.

---

## 🇬🇧 English

### What it does

Claude Code sessions quietly accumulate cost: context keeps growing, the prompt cache expires, heavy folders get read into memory, and an over-powered model runs trivial tasks. **conso-pilot** watches all of this and nudges you at the right moment.

- **Measure** — per-project / per-model consumption (today & 7 days), raw and cost-weighted, including sub-agents and your most expensive sessions.
- **Handoff & resume** — summarize a long session into a compact note, clear the chat, and reload the summary automatically so you keep going without the token bloat.
- **Cache alerts** — warns (or blocks) when you're about to pay full price because the prompt cache expired.
- **Lean context** — shows the real weight of every plugin, skill, connector and MCP server loaded into each chat, and lets you turn off what you don't use.
- **Model & effort advice** — classifies each request and suggests a cheaper model or effort level when the task doesn't need the expensive one.
- **Heavy-folder guard** — blocks broad reads of `node_modules/`, `build/`, lock files, etc., and steers Claude toward targeted reads.

### Installation

```bash
/plugin marketplace add DevTipsy/conso-pilot
```
```bash
/plugin install conso-pilot@conso-pilot
```

Then run once (installs the status line and allows `/handoff` to save without prompting — shows a diff and asks before writing):

```bash
/conso-pilot:setup
```

Update later:

```bash
/plugin marketplace update conso-pilot && /plugin update conso-pilot@conso-pilot
```

### Main commands

| Command | What it does |
|---|---|
| `/conso` | Consumption by project and model (today / 7 days), raw and weighted; sub-agent share; most expensive sessions; estimated savings |
| `/handoff` | Claude writes a compact summary of the session, saves it, clears the chat, and reloads the summary — all in one command. If a message was blocked by the cache guard before sending, it is captured too, so nothing is lost |
| `/resume` | Reloads the project's last handoff (`--auto` for the latest auto-save) |
| `/lean` | Weight of loaded plugins / skills / connectors / MCP servers; `/lean off <name>` disables one after confirmation |
| `/conso-pilot:status` | Config, session state, detected integrations, last 5 errors |
| `/conso-pilot:setup` / `uninstall` | Install or remove the status line and handoff permission |

All data stays local in `~/.claude/conso-pilot/`. Nothing is sent anywhere.

Full specification: [SPEC.md](SPEC.md).

---

## 🇫🇷 Français

### À quoi ça sert

Une session Claude Code coûte de plus en plus cher sans qu'on le voie : le contexte grossit, le cache du prompt expire, des dossiers lourds sont lus en mémoire, un modèle trop puissant traite des tâches triviales. **conso-pilot** surveille tout ça et t'alerte au bon moment.

- **Mesurer** — consommation par projet / par modèle (jour & 7 jours), brute et pondérée, sous-agents et sessions les plus coûteuses compris.
- **Handoff & reprise** — résume une longue session en une note compacte, vide la discussion, et recharge le résumé automatiquement : tu continues sans traîner tout le contexte.
- **Alertes de cache** — prévient (ou bloque) quand tu vas payer plein tarif parce que le cache du prompt a expiré.
- **Contexte allégé** — affiche le poids réel de chaque plugin, skill, connecteur et serveur MCP chargé dans chaque discussion, et permet de désactiver ce qui ne sert pas.
- **Conseils de modèle et d'effort** — classe chaque demande et suggère un modèle ou un effort moins cher quand la tâche ne justifie pas le plus puissant.
- **Garde-fou dossiers lourds** — bloque les lectures larges de `node_modules/`, `build/`, fichiers de verrouillage, etc., et oriente Claude vers des lectures ciblées.

### Installation

```bash
/plugin marketplace add DevTipsy/conso-pilot
```
```bash
/plugin install conso-pilot@conso-pilot
```

Puis, une fois (installe la barre d'état et autorise `/handoff` à enregistrer sans confirmation — affiche un diff et demande avant d'écrire) :

```bash
/conso-pilot:setup
```

Mise à jour plus tard :

```bash
/plugin marketplace update conso-pilot && /plugin update conso-pilot@conso-pilot
```

### Commandes principales

| Commande | Rôle |
|---|---|
| `/conso` | Consommation par projet et modèle (jour / 7 jours), brute et pondérée ; part des sous-agents ; sessions les plus coûteuses ; gains estimés |
| `/handoff` | Claude rédige un résumé compact de la session, l'enregistre, vide la discussion et recharge le résumé — le tout en une commande. Si un message a été bloqué par la garde de cache avant envoi, il est capturé aussi : rien n'est perdu |
| `/resume` | Recharge le dernier handoff du projet (`--auto` : la dernière sauvegarde automatique) |
| `/lean` | Poids des plugins / skills / connecteurs / serveurs MCP chargés ; `/lean off <nom>` en désactive un après confirmation |
| `/conso-pilot:status` | Configuration, état de la session, intégrations détectées, 5 dernières erreurs |
| `/conso-pilot:setup` / `uninstall` | Installe ou retire la barre d'état et la permission de handoff |

Toutes les données restent en local dans `~/.claude/conso-pilot/`. Rien n'est envoyé ailleurs.

Spécification complète : [SPEC.md](SPEC.md).

---

## Tests

```bash
npm test
```

`node:test`, sans dépendance externe / no external dependencies.

## License

MIT
