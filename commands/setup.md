---
description: Installe la barre d'état et la permission de /handoff (diff et confirmation avant toute écriture)
allowed-tools: Bash(node:*), AskUserQuestion
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/settings-edit" setup`

Recopie l'aperçu ci-dessus tel quel. S'il indique « Rien à modifier », arrête-toi là.

Sinon, demande confirmation avec AskUserQuestion : une option par commande d'application listée (la première est recommandée), plus « Annuler ». Après accord, lance **uniquement** la commande choisie, recopiée à l'identique, puis recopie sa sortie sans commentaire. N'écris jamais toi-même dans `~/.claude/` et ne lis aucun fichier.
