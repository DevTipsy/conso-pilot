'use strict';
// Configuration : ~/.claude/conso-pilot/config.json, créée avec les défauts au premier lancement.
// Clés inconnues ignorées, clés manquantes complétées par les défauts (spec annexe A).
const fs = require('fs');
const path = require('path');
const { dataDir, readJson, writeJsonAtomic } = require('./util');

const DEFAULTS = Object.freeze({
  handoffAt: 40000,
  handoffForceAt: 100000,
  handoffRepeatEvery: 20000,
  cacheGuard: 'block',
  cacheWarnMinTokens: 50000,
  cacheTtlMinutes: null,
  notifications: true,
  resumeMaxTokens: 2000,
  autoResumeHours: 2,
  clearResumeMinutes: 30,
  retentionDays: 30,
  retentionMaxFiles: 50,
  autoSaveEveryMinutes: 5,
  aiSummary: false,
  leanWarnTokens: 15000,
  leanCharsPerToken: 4,
  heavyPaths: ['DerivedData/', 'Pods/', 'node_modules/', 'build/', '.build/', 'dist/', '.gradle/', '*.xcarchive',
    'Package.resolved', 'package-lock.json', 'yarn.lock', 'Podfile.lock'],
  heavyFileBytes: 1048576,
  targetedReadMaxLines: 300,
  modelAdvice: 'hint',
  modelAdviceMaxAddedTokens: 10000,
  effortAdvice: true,
  effortAdviceEvery: 5,
  modelSwitchGuardMinAddedTokens: 10000,
  modelSwitchAskSources: [],
  delegationHint: true,
  advice: {
    simple: { model: 'sonnet', effort: 'low' },
    standard: { model: 'sonnet', effort: 'medium' },
    complex: { model: 'opus', effort: 'high' },
    critical: { model: 'opus', effort: 'xhigh' },
  },
  costWeights: {
    models: { fable: 4, opus: 2, sonnet: 1, haiku: 0.5 },
    fastModeMultiplier: 2,
    outputRatio: 5,
    cacheWrite5m: 1.25,
    cacheWrite1h: 2,
    cacheRead: 0.1,
  },
  contextWindowByModel: { default: 200000 },
});

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Fusion récursive limitée aux clés des défauts ; les dictionnaires libres (poids des modèles,
// fenêtres par modèle) acceptent en plus les clés ajoutées par l'utilisateur.
const OPEN_MAPS = new Set(['costWeights.models', 'contextWindowByModel']);

function merge(defaults, user, prefix = '') {
  const out = {};
  const keys = OPEN_MAPS.has(prefix) && isPlainObject(user)
    ? new Set([...Object.keys(defaults), ...Object.keys(user)])
    : Object.keys(defaults);
  for (const key of keys) {
    const def = defaults[key];
    const val = isPlainObject(user) ? user[key] : undefined;
    const sub = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(def)) out[key] = merge(def, val, sub);
    else if (val === undefined) out[key] = def;
    else if (def === null || def === undefined || typeof val === typeof def || (Array.isArray(def) && Array.isArray(val))) out[key] = val;
    else out[key] = def; // type incohérent → défaut
  }
  return out;
}

function configPath() {
  return path.join(dataDir(), 'config.json');
}

let cached = null;

function loadConfig() {
  if (cached) return cached;
  const file = configPath();
  if (!fs.existsSync(file)) writeJsonAtomic(file, DEFAULTS);
  cached = merge(DEFAULTS, readJson(file, {}));
  return cached;
}

function resetConfigCache() {
  cached = null;
}

module.exports = { DEFAULTS, loadConfig, resetConfigCache, configPath, merge };
