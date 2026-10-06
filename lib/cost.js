'use strict';
// Tokens pondérés (spec §8.2) : équivalent « token d'entrée plein ».

function modelFamily(model) {
  const m = String(model || '').toLowerCase();
  for (const f of ['fable', 'opus', 'sonnet', 'haiku']) if (m.includes(f)) return f;
  return m || 'inconnu';
}

function rawTokens(r) {
  return (r.input || 0) + (r.cache_5m || 0) + (r.cache_1h || 0) + (r.cache_read || 0) + (r.output || 0);
}

function weightedTokens(r, cfg) {
  const w = cfg.costWeights;
  const base = (r.input || 0)
    + w.cacheWrite5m * (r.cache_5m || 0)
    + w.cacheWrite1h * (r.cache_1h || 0)
    + w.cacheRead * (r.cache_read || 0)
    + w.outputRatio * (r.output || 0);
  const modelWeight = w.models[modelFamily(r.model)] ?? 1;
  return base * modelWeight * (r.fast ? w.fastModeMultiplier : 1);
}

module.exports = { modelFamily, rawTokens, weightedTokens };
