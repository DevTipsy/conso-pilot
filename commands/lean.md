---
description: Contexte chargé par les plugins, skills et serveurs MCP ; désactive ce qui ne sert pas
argument-hint: "[off|on <nom> [--scope local|projet|user]]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/lean":*), AskUserQuestion
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/lean" $ARGUMENTS`

Recopie la sortie ci-dessus telle quelle, sans commentaire ni résumé. Si elle ne contient pas de « Commande d'application », arrête-toi là.

Sinon, demande confirmation avec AskUserQuestion (« Appliquer » recommandé, « Annuler »). Après accord, lance **uniquement** la commande d'application, recopiée à l'identique, puis recopie sa sortie sans commentaire. N'écris jamais toi-même dans un fichier de réglages et ne lis aucun fichier.
