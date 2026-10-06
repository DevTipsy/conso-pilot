---
description: Charge le dernier handoff du projet (--auto : la dernière sauvegarde automatique)
argument-hint: "[--auto]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/reprendre":*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/reprendre" $ARGUMENTS`

Le texte ci-dessus résume la session précédente de ce projet. Prends-en connaissance sans relire les fichiers cités, réponds en une ligne (objectif et prochaine étape), puis attends la consigne.
