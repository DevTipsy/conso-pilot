'use strict';
// Mesure (spec §2) : contexte, baseline, modèle / effort / mode rapide, durée du cache.
const { scan, newActivity } = require('./transcript');
const { setting } = require('./settings');

// Durée du cache (§2.4) : forçage de la config > valeur lue > variables d'environnement > défaut 1 h.
function applyTtl(state, cfg, observed, source) {
  if (cfg.cacheTtlMinutes != null) {
    state.ttlMinutes = cfg.cacheTtlMinutes;
    state.ttlSource = 'config';
  } else if (observed) {
    state.ttlMinutes = observed;
    state.ttlSource = source;
  } else if (state.ttlMinutes == null) {
    if (process.env.FORCE_PROMPT_CACHING_5M) {
      state.ttlMinutes = 5;
      state.ttlSource = 'env';
    } else {
      state.ttlMinutes = 60;
      state.ttlSource = process.env.ENABLE_PROMPT_CACHING_1H ? 'env' : 'défaut';
    }
  }
}

// "1h" / "5m" (champ cache_ttl de Pre/PostModelSwitch) → minutes.
function parseTtl(value) {
  const m = /^(\d+)\s*([hm])$/.exec(String(value || ''));
  if (!m) return null;
  return Number(m[1]) * (m[2] === 'h' ? 60 : 1);
}

// Valeurs inconnues complétées par les réglages ; jamais d'écrasement d'une valeur observée.
function fillFromSettings(state) {
  if (!state.model) {
    const m = setting(state.project, 'model');
    if (m) state.model = { value: m, source: 'réglages' };
  }
  if (!state.effort) {
    const e = setting(state.project, 'effortLevel');
    if (e) state.effort = { value: e, source: 'réglages' };
  }
}

// Lit la suite du transcript principal et met l'état à jour. Renvoie les appels API nouveaux.
// `attachments` (facultatif) reçoit les lignes d'inventaire du contexte chargé (§6).
function measureMain(state, cfg, transcriptPath, attachments = null) {
  const file = transcriptPath || state.transcript;
  if (!file) return [];
  if (!state.activity) state.activity = newActivity(); // états du lot 1
  const res = scan(file, state.cursor, { activity: state.activity, attachments });
  state.cursor = res.cursor;
  if (res.compacted) state.baselinePending = true;
  const last = res.last;
  if (last) {
    state.lastContext = last.context;
    state.lastResponseAt = last.ts || new Date().toISOString();
    if (last.model) state.model = { value: last.model, source: 'transcript' };
    if (last.effort) state.effort = { value: last.effort, source: 'transcript' };
    if (last.fast != null) state.fast = { value: last.fast, source: 'transcript' };
    if (state.baselinePending || state.baseline == null) {
      state.baseline = last.context;
      state.baselinePending = false;
      // Nouveau départ (session, compactage) : les alertes et le handoff fait repartent de zéro.
      state.alerts = {};
      state.handoffDone = false;
    }
  }
  applyTtl(state, cfg, last && last.ttl, 'transcript');
  return res.calls;
}

module.exports = { measureMain, applyTtl, parseTtl, fillFromSettings };
