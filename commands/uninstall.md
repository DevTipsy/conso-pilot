---
description: Retire la barre d'état et la permission ajoutées par setup (restaure settings.json), garde les données
allowed-tools: Bash(node:*), AskUserQuestion
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/settings-edit" uninstall`

Recopie l'aperçu ci-dessus tel quel. S'il n'affiche aucune commande d'application, arrête-toi là.

Sinon, demande confirmation avec AskUserQuestion (« Appliquer » / « Annuler »). Après accord, lance **uniquement** la commande d'application, recopiée à l'identique, puis recopie sa sortie sans commentaire. N'écris jamais toi-même dans `~/.claude/` et ne lis aucun fichier.
