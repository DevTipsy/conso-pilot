'use strict';
// Conseils de modèle et d'effort (spec §9.2), règles locales sans IA, zéro token (systemMessage ou reason).
// Un hook ne peut changer ni le modèle ni l'effort : il conseille, ou bloque le premier envoi en mode « block ».
const { spawnSync } = require('child_process');
const { addedContext } = require('./state');
const { modelFamily } = require('./cost');
const { fingerprint } = require('./alerts');
const { tokens } = require('./format');

const LEVELS = ['simple', 'standard', 'complex', 'critical'];
const LEVEL_LABEL = { simple: 'simple', standard: 'standard', complex: 'complexe', critical: 'critique' };
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_LABEL = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };

function norm(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Mots-clés sans accents (le texte est normalisé de la même façon).
const SIMPLE = /\b(renomme[rsz]?|explique[rsz]?|ou est|ou se trouve|typo|faute de frappe|traduis|tradui[st]|rename|explain|where is|translate)\b/;
const COMPLEX = /\b(architecture|concoi[st]|concevoir|refactor(ing)? global|refactorise tout|migration|migrer|bug introuvable|performances?|design|root cause|cause racine)\b/;
const CRITICAL = /(reflechis a fond|ultrathink|\bmax\b|think hard(er)?|reflexion maximale)/;
// Fichiers mentionnés : chemins (a/b), noms avec extension (Foo.swift), références @fichier.
const FILE = /(?:^|[\s`'"(@])((?:[\w.-]+\/)+[\w.-]+|[\w-]+\.(?:swift|kt|kts|java|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|c|cc|cpp|h|hpp|m|mm|json|ya?ml|toml|md|html|css|scss|sql|sh|gradle|plist|xib|storyboard|xcconfig))(?=$|[\s`'"),.:;!?])/g;

function filesMentioned(prompt) {
  const set = new Set();
  for (const m of String(prompt || '').matchAll(FILE)) set.add(m[1]);
  return set.size;
}

// Classement heuristique (§9.2). Les commandes (/handoff…) et prompts vides ne sont pas classés.
function classify(prompt) {
  const raw = String(prompt || '').trim();
  if (!raw || raw.startsWith('/')) return null;
  const text = norm(raw);
  const files = filesMentioned(raw);
  if (CRITICAL.test(text)) return 'critical';
  if (COMPLEX.test(text) || files >= 4) return 'complex';
  if (SIMPLE.test(text) || (raw.length < 200 && files <= 1)) return 'simple';
  return 'standard';
}

function effortIndex(e) {
  return EFFORTS.indexOf(String(e || '').toLowerCase());
}

// Changer d'effort garde le cache sur Opus 5.5, Sonnet 5.5 et Fable 5.1 (§9.0) ; Haiku ne gère pas l'effort.
function effortFree(model) {
  const m = String(model || '').toLowerCase();
  return /(opus|sonnet)-5-5|fable-5-1|opus-5\.5|sonnet-5\.5|fable-5\.1|^(opus|sonnet|fable)$/.test(m);
}

function weight(family, cfg) {
  return cfg.costWeights.models[family];
}

// Modèle donné au lancement (--model du processus Claude Code), quand aucune autre source ne le donne.
function launchModel() {
  const pid = Number(process.env.CLAUDE_PID);
  if (!pid) return null;
  try {
    const r = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 500 });
    const m = /--model[= ](\S+)/.exec(r.stdout || '');
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Effort et modèle complétés par l'environnement du lancement (CLAUDE_EFFORT, --model), sans écraser une valeur observée.
function fillFromLaunch(st) {
  if (!st.effort && process.env.CLAUDE_EFFORT) st.effort = { value: process.env.CLAUDE_EFFORT, source: 'lancement' };
  if (!st.model && !st.launchChecked) {
    st.launchChecked = true; // une seule lecture du processus par session
    const m = launchModel();
    if (m) st.model = { value: m, source: 'lancement' };
  }
}

/**
 * Conseils pour un message. Met à jour `st.advice` (compteurs). Renvoie null ou
 * { texts: string[], block: boolean, entries: object[] } (entries : lignes de journal « advice »).
 */
function adviceState(st) {
  return st.advice || (st.advice = { prompts: 0, lastEffortAt: null, models: [], lastBlocked: false });
}

function onPrompt(input, st, cfg) {
  const adv = adviceState(st);
  const index = adv.prompts;
  adv.prompts += 1;
  const level = classify(input.prompt);
  const texts = [];
  const entries = [];
  let block = false;
  const model = st.model && st.model.value;
  const family = model ? modelFamily(model) : null;
  const target = level ? cfg.advice[level] : null;

  // Mode rapide (§9.2) : rappel au premier message.
  if (index === 0 && st.fast && st.fast.value === true) {
    texts.push(`⚡ Mode rapide actif : il multiplie le coût${family === 'opus' ? " d'Opus" : ''} (×${cfg.costWeights.fastModeMultiplier} pondéré).`);
    entries.push({ kind: 'fast', level, from: model || null });
  }
  if (!target) return finish();

  // Modèle : au premier message, ou tant que le contexte ajouté reste sous modelAdviceMaxAddedTokens.
  const added = addedContext(st);
  const early = index === 0 || (added != null && added < cfg.modelAdviceMaxAddedTokens);
  const wanted = String(target.model || '').toLowerCase();
  const wantedFamily = modelFamily(wanted === 'opusplan' ? 'opus' : wanted);
  if (cfg.modelAdvice !== 'off' && early && wantedFamily && !adv.models.includes(`${level}:${wantedFamily}`)) {
    const label = `${MODEL_LABEL[wantedFamily] || target.model}${level === 'complex' && wantedFamily === 'opus' ? ' (ou opusplan)' : ''}`;
    let advise = false;
    let comparable = false;
    if (family && weight(family, cfg) != null && weight(wantedFamily, cfg) != null) {
      comparable = true;
      const cheaper = weight(wantedFamily, cfg) < weight(family, cfg);
      const pricier = weight(wantedFamily, cfg) > weight(family, cfg);
      // Un modèle plus cher n'est conseillé que pour les tâches complexes ou critiques.
      advise = cheaper || (pricier && (level === 'complex' || level === 'critical'));
    } else {
      advise = index === 0; // modèle inconnu : conseil sans comparaison, une fois, jamais de blocage
    }
    if (advise) {
      adv.models.push(`${level}:${wantedFamily}`);
      let text = `Tâche jugée ${LEVEL_LABEL[level]} → ${label} + effort ${target.effort} (sélecteur de modèle${family ? ` ; actuel : ${MODEL_LABEL[family] || model}` : ''}).`;
      if (added != null && added > 0) text += ` Changer de modèle renvoie ~${tokens(st.lastContext)} tokens au nouveau modèle.`;
      const canBlock = cfg.modelAdvice === 'block' && comparable && !adv.lastBlocked && adv.blockedHash !== fingerprint(input.prompt);
      if (canBlock) {
        block = true;
        adv.blockedHash = fingerprint(input.prompt);
        text += ' Change puis renvoie, ou renvoie tel quel pour ignorer.';
      }
      texts.push(text);
      entries.push({ kind: 'model', level, from: model || null, to: wantedFamily, effort: target.effort, blocked: block });
    }
  }

  // Effort : à chaque message dès qu'il est connu, écart ≥ 2 crans, au plus une fois toutes les effortAdviceEvery demandes.
  const effort = st.effort && st.effort.value;
  const gap = effortIndex(effort) >= 0 && effortIndex(target.effort) >= 0 ? effortIndex(effort) - effortIndex(target.effort) : 0;
  const due = adv.lastEffortAt == null || index - adv.lastEffortAt >= cfg.effortAdviceEvery;
  if (cfg.effortAdvice && !block && Math.abs(gap) >= 2 && due && (!model || effortFree(model)) && family !== 'haiku') {
    adv.lastEffortAt = index;
    texts.push(`Tâche jugée ${LEVEL_LABEL[level]} : effort ${target.effort} ${gap > 0 ? 'suffit' : 'conseillé'} (actuel : ${effort}). Changer d'effort ne vide pas le cache.`);
    entries.push({ kind: 'effort', level, from: effort, to: target.effort, model: model || null });
  }
  return finish();

  function finish() {
    adv.lastBlocked = block;
    return texts.length ? { texts, block, entries } : null;
  }
}

// Changement de modèle en cours de session (§9.2) : « ask » seulement pour les sources où la question s'affiche.
function onModelSwitch(input, st, cfg) {
  if (!cfg.modelSwitchAskSources.includes(input.source)) return null;
  const ctx = typeof input.context_tokens === 'number' ? input.context_tokens : st && st.lastContext;
  const added = st && st.baseline != null && ctx != null ? ctx - st.baseline : ctx;
  if (added == null || added < cfg.modelSwitchGuardMinAddedTokens) return null;
  return `Changer maintenant renvoie ~${tokens(ctx)} tokens au nouveau modèle. Pour une tâche différente, un /handoff (qui vide la discussion) coûte moins cher. Continuer ?`;
}

// Conseil suivi (pour /conso) : un tour ultérieur de la même session utilise le modèle ou l'effort conseillé.
function followed(entry, turns) {
  return turns.some((t) => t.session === entry.session && t.ts > entry.ts && (t.agent || 'main') === 'main'
    && (entry.kind === 'model' ? modelFamily(t.model) === entry.to : entry.kind === 'effort' ? t.effort === entry.to : false));
}

module.exports = { adviceState, classify, filesMentioned, onPrompt, onModelSwitch, fillFromLaunch, followed, effortFree, LEVELS };
