'use strict';
// Alertes (spec §3) : « Handoff maintenant » (fin de tâche ou plafond) et expiration du cache.
// Canaux : systemMessage (ou reason d'un blocage), notification macOS détachée, couleur de la barre d'état.
const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');
const { addedContext } = require('./state');
const { tokens } = require('./format');

// Dernière phrase terminée par « ? », mise en forme Markdown finale ignorée.
function endsWithQuestion(text) {
  return String(text || '').replace(/[\s*_`)\]»"'’>]+$/u, '').endsWith('?');
}

// Tâche de fond en cours : statut inconnu compté comme « en cours » (jamais d'alerte en plein travail).
function backgroundRunning(tasks) {
  if (!Array.isArray(tasks)) return false;
  return tasks.some((t) => !t || typeof t !== 'object' || !t.status || /running|pending|in_progress/i.test(String(t.status)));
}

// Tâche terminée (§3.1, déclencheur A).
function taskFinished(input, st) {
  if (input.stop_hook_active) return false;
  if (backgroundRunning(input.background_tasks)) return false;
  const lm = st.cursor && st.cursor.lastMessage;
  if (lm && lm.tool) return false;
  // last_assistant_message est tronqué (« … ») au-delà d'une certaine longueur : on prend alors le transcript.
  const msg = input.last_assistant_message;
  const text = typeof msg === 'string' && msg && !msg.endsWith('…') ? msg : lm && lm.text;
  if (endsWithQuestion(text)) return false;
  const todos = (st.activity && st.activity.todos) || [];
  return todos.every((t) => t.status === 'completed');
}

function handoffText(st, added) {
  return `🔴 Handoff maintenant — contexte ${tokens(st.lastContext)} (+${tokens(added)}). Lance /handoff (résumé, puis discussion vidée et résumé rechargé).`;
}

// Déclencheur A (hook Stop) : seuil atteint et tâche terminée ; répété seulement après +handoffRepeatEvery.
function handoffOnStop(input, st, cfg, now = Date.now()) {
  if (st.handoffDone) return null;
  const added = addedContext(st);
  if (added == null || added < cfg.handoffAt) return null;
  const prev = st.alerts && st.alerts.handoff;
  if (prev && added < prev.added + cfg.handoffRepeatEvery) return null;
  if (!taskFinished(input, st)) return null;
  st.alerts = { ...st.alerts, handoff: { added, ts: new Date(now).toISOString() } };
  return handoffText(st, added);
}

// Déclencheur B (hook UserPromptSubmit) : plafond, à chaque message. `first` : première fois (notification).
function handoffOnPrompt(st, cfg, now = Date.now()) {
  if (st.handoffDone) return null;
  const added = addedContext(st);
  if (added == null || added < cfg.handoffForceAt) return null;
  const first = !(st.alerts && st.alerts.force);
  if (first) st.alerts = { ...st.alerts, force: { added, ts: new Date(now).toISOString() } };
  return { text: handoffText(st, added), first };
}

function handoffAlertActive(st, cfg) {
  if (!st || st.handoffDone) return false;
  const added = addedContext(st);
  return Boolean((st.alerts && st.alerts.handoff) || (added != null && added >= cfg.handoffForceAt));
}

// Temps écoulé depuis la dernière réponse et temps restant avant l'expiration du cache (§2.4).
function cacheClock(st, now = Date.now()) {
  if (!st || !st.lastResponseAt || !st.ttlMinutes) return null;
  const pause = now - Date.parse(st.lastResponseAt);
  if (Number.isNaN(pause)) return null;
  return { pause, left: st.ttlMinutes * 60000 - pause };
}

function cacheExpired(st, cfg, now = Date.now()) {
  if (cfg.cacheGuard === 'off') return false;
  const c = cacheClock(st, now);
  return Boolean(c && c.left < 0 && (st.lastContext || 0) >= cfg.cacheWarnMinTokens);
}

function duration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}

function fingerprint(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 16);
}

// Pause plus longue que le TTL (§3.3). Une seule intervention par pause : le message renvoyé
// (même empreinte, ou tout autre message tant qu'aucune réponse n'a suivi) passe toujours.
function cacheOnPrompt(input, st, cfg, now = Date.now()) {
  if (!cacheExpired(st, cfg, now)) return null;
  const alerts = st.alerts || (st.alerts = {});
  if (alerts.cache && alerts.cache.pause === st.lastResponseAt) return null;
  const hash = fingerprint(input.prompt);
  if (st.blockedHash === hash && cfg.cacheGuard === 'block') return null;
  alerts.cache = { pause: st.lastResponseAt, ts: new Date(now).toISOString() };
  const base = `Cache expiré (pause de ${duration(cacheClock(st, now).pause)}) : ce message va refacturer ~${tokens(st.lastContext)} tokens.`;
  if (cfg.cacheGuard === 'block') {
    st.blockedHash = hash;
    return { block: true, text: `${base} Renvoie-le (↑) pour continuer tel quel, ou fais /clear (une sauvegarde automatique est déjà prise) puis /resume --auto pour repartir au propre avec le contexte rechargé.` };
  }
  return { block: false, text: `${base} Pour changer de sujet, fais plutôt /clear — une sauvegarde automatique est déjà prise, et /resume --auto la recharge si tu veux repartir où tu en étais.` };
}

// Reprise d'une ancienne discussion (§3.3) : champs natifs de SessionStart, aucun calcul.
function resumeCacheMessage(input, cfg) {
  if (input.source !== 'resume' || !input.prompt_cache_likely_expired) return null;
  if (typeof input.context_tokens !== 'number' || input.context_tokens < cfg.cacheWarnMinTokens) return null;
  return `Cache expiré : le prochain message refacturera ~${tokens(input.context_tokens)} tokens. Si tu changes de sujet, fais plutôt /clear — une sauvegarde automatique est prise au passage, et /resume --auto la recharge si besoin.`;
}

// Notification macOS, détachée et jamais attendue (§3.2). CONSO_PILOT_NOTIFY_LOG : journal à la place (tests).
function notify(text, cfg) {
  if (!cfg.notifications) return;
  const log = process.env.CONSO_PILOT_NOTIFY_LOG;
  if (log) {
    fs.appendFileSync(log, `${text}\n`);
    return;
  }
  if (process.platform !== 'darwin') return;
  const esc = (s) => String(s).replace(/[\\"]/g, '\\$&');
  const child = spawn('osascript', ['-e', `display notification "${esc(text)}" with title "conso-pilot"`], {
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', () => {});
  child.unref();
}

module.exports = {
  endsWithQuestion, taskFinished, handoffOnStop, handoffOnPrompt, handoffAlertActive, cacheClock, cacheExpired, cacheOnPrompt,
  resumeCacheMessage, notify, fingerprint, duration,
};
