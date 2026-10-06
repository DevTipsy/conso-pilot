---
description: Résumé structuré de la session, enregistré, puis discussion vidée (le résumé est rechargé). --keep pour ne pas vider
argument-hint: "[--keep]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/save-handoff":*), ToolSearch, mcp__ccd_session_mgmt__clear_session
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/save-handoff" --prepare`

Rédige le handoff de cette session à partir de ce que tu sais déjà : **ne relis aucun fichier et ne lance aucune autre commande**. En français, 1 500 tokens au plus, Markdown, sections dans cet ordre (omets une section vide) :

## Objectif
Une seule ligne.
## État actuel
## Décisions prises
Décision — pourquoi.
## Fichiers modifiés ou importants
`chemin:ligne` — rôle.
## Commandes utiles
## Pièges rencontrés
## Prochaines étapes

N'écris aucun fichier toi-même : enregistre le handoff en **une seule** commande Bash, la commande d'enregistrement ci-dessus recopiée à l'identique (après /conso-pilot:setup, elle est pré-autorisée telle quelle), suivie du texte puis d'une ligne `EOF` :

```
<commande d'enregistrement affichée ci-dessus> <<'EOF'
## Objectif
…
EOF
```

Ensuite, recopie les lignes affichées par le script, sans autre commentaire.

Enfin, sauf si les arguments de la commande contiennent `--keep` (arguments : « $ARGUMENTS ») et seulement si l'enregistrement a réussi : si l'outil `mcp__ccd_session_mgmt__clear_session` existe (app desktop ; chargé au besoin avec ToolSearch), appelle-le avec `session_id: "self"` — la discussion sera vidée à la fin de ce tour et le handoff rechargé automatiquement. Sinon (CLI), termine par : « Tape /clear : le résumé sera rechargé automatiquement. »
