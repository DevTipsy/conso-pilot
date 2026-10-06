'use strict';
// Rapport /conso-pilot:status (spec §10).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { DEFAULTS, loadConfig, configPath } = require('./config');
const state = require('./state');
const { setting, isContextModeActive } = require('./settings');
const { dataDir, readJson } = require('./util');
const { tokens, home, ago } = require('./format');
const alerts = require('./alerts');
const setup = require('./setup');

function changedKeys(cfg) {
  return Object.keys(DEFAULTS).filter((k) => JSON.stringify(cfg[k]) !== JSON.stringify(DEFAULTS[k]));
}

function contextWindow(cfg, model) {
  if (!model) return cfg.contextWindowByModel.default;
  if (/\[1m\]/i.test(model)) return 1000000;
  return cfg.contextWindowByModel[model] || cfg.contextWindowByModel.default;
}

function rtkVersion() {
  try {
    const r = spawnSync('rtk', ['--version'], { encoding: 'utf8', timeout: 1000 });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

function lastErrors(n) {
  try {
    const lines = fs.readFileSync(path.join(dataDir(), 'errors.log'), 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

function src(field) {
  return field ? `${field.value} (${field.source})` : 'inconnu';
}

function buildStatusReport({ sessionId, project, now = Date.now() } = {}) {
  const cfg = loadConfig();
  const out = ['## conso-pilot — état', ''];

  out.push('### Configuration');
  out.push(`- Fichier : \`${home(configPath())}\``);
  out.push(`- Handoff : à +${tokens(cfg.handoffAt)} en fin de tâche (rappel tous les +${tokens(cfg.handoffRepeatEvery)}), à chaque message dès +${tokens(cfg.handoffForceAt)}`);
  out.push(`- Cache expiré : \`${cfg.cacheGuard}\` dès ${tokens(cfg.cacheWarnMinTokens)} · TTL ${cfg.cacheTtlMinutes == null ? 'automatique' : `forcé à ${cfg.cacheTtlMinutes} min`}`);
  out.push(`- Conseil de modèle : \`${cfg.modelAdvice}\` · conseil d'effort : ${cfg.effortAdvice ? 'oui' : 'non'} · notifications : ${cfg.notifications ? 'oui' : 'non'}`);
  const changed = changedKeys(cfg);
  out.push(`- Clés modifiées : ${changed.length ? changed.map((k) => `\`${k}\``).join(', ') : 'aucune (défauts)'}`, '');

  out.push('### Session');
  let st = (sessionId && state.loadState(sessionId)) || state.latestStateFor(project);
  if (st) st = state.applyLive(st);
  if (!st) {
    out.push('Aucun état enregistré pour ce projet (il apparaît après la première réponse de Claude).', '');
  } else {
    const model = st.model && st.model.value;
    const added = state.addedContext(st);
    out.push(`- Session : \`${String(st.session).slice(0, 8)}\`${sessionId && st.session !== sessionId ? ' (dernière session connue du projet)' : ''}`);
    out.push(`- Modèle : ${src(st.model)} · effort : ${src(st.effort)} · mode rapide : ${st.fast ? (st.fast.value ? 'oui' : 'non') : 'inconnu'}`);
    out.push(`- Contexte : ${tokens(st.lastContext)} / ${tokens(contextWindow(cfg, model))} · baseline ${tokens(st.baseline)}${st.baselinePending ? ' (à remesurer)' : ''} · ajouté ${added == null ? '—' : `+${tokens(added)}`}`);
    let cache = `cache ${st.ttlMinutes ?? '?'} min (${st.ttlSource || '?'})`;
    if (st.lastResponseAt && st.ttlMinutes) {
      const left = Math.round((Date.parse(st.lastResponseAt) + st.ttlMinutes * 60000 - now) / 60000);
      cache += left > 0 ? `, expire dans ${left} min` : ', probablement expiré';
    }
    out.push(`- Dernière réponse : ${ago(st.lastResponseAt, now)} · ${cache}`);
    const active = [];
    if (alerts.handoffAlertActive(st, cfg)) active.push('handoff maintenant');
    if (alerts.cacheExpired(st, cfg, now)) active.push('cache expiré');
    out.push(`- Tours : ${st.turns} · handoff fait : ${st.handoffDone ? 'oui' : 'non'} · alertes actives : ${active.length ? active.join(', ') : 'aucune'}`, '');
  }

  out.push('### Intégrations');
  const rtk = rtkVersion();
  out.push(`- rtk : ${rtk ? `détecté (${rtk})` : 'non détecté'}`);
  out.push(`- context-mode : ${isContextModeActive(project) ? 'actif' : 'inactif'}`);
  const sl = setting(project, 'statusLine');
  const inst = readJson(setup.installPath(), null);
  let bar = 'non configurée (/conso-pilot:setup)';
  if (setup.isOurStatusLine(sl)) bar = `conso-pilot${inst && inst.statusMode === 'chain' ? ' (enchaînée avec l\'ancienne)' : ''}`;
  else if (sl && sl.command) bar = `autre (\`${sl.command}\`)`;
  out.push(`- Barre d'état : ${bar} — affichée en CLI seulement (l'app ne l'affiche pas)`);
  out.push(`- Setup : ${inst ? `fait ${ago(inst.installedAt, now)}${inst.addedPermission ? ', permission de save-handoff ajoutée' : ''}` : 'non fait'}`, '');

  out.push('### Dernières erreurs');
  const errs = lastErrors(5);
  if (!errs.length) out.push('Aucune.');
  else out.push('```', ...errs, '```');
  return out.join('\n');
}

module.exports = { buildStatusReport };
