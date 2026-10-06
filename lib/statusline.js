'use strict';
// Barre d'état combinée (spec §4) :
//   Sonnet·medium · ctx 74k (+52k) · 5h 42% · 7j 18% · cache 3:12 · éco ~1.2M
// Champ absent → segment omis. Neutre, rouge seulement quand une alerte §3.1 ou §3.3 est active.
const path = require('path');
const state = require('./state');
const alerts = require('./alerts');
const { dataDir, readJson, writeJsonAtomic } = require('./util');
const { tokens } = require('./format');
const { scheduleEcoRefresh } = require('./gains');

const RED = '\x1b[31m';
const RESET = '\x1b[0m';
const LIVE_REFRESH_MS = 5 * 60000;
const TIMER_WINDOW_MS = 10 * 60000;

function contextOf(input) {
  const u = input.context_window && input.context_window.current_usage;
  if (!u) return null;
  return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
}

function pctSegment(label, limit) {
  if (!limit || typeof limit.used_percentage !== 'number') return null;
  return `${label} ${Math.round(limit.used_percentage)}%`;
}

function clock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Relevé pour les hooks (§2.3), écrit seulement s'il change ou toutes les 5 min.
function recordLive(input, ctx, now) {
  if (!input.session_id) return;
  const live = {
    model: (input.model && input.model.id) || null,
    effort: (input.effort && input.effort.level) || null,
    fast: typeof input.fast_mode === 'boolean' ? input.fast_mode : null,
    context: ctx,
    contextSize: (input.context_window && input.context_window.context_window_size) || null,
  };
  const prev = state.readLive(input.session_id);
  if (prev) {
    const same = Object.keys(live).every((k) => prev[k] === live[k]);
    if (same && now - Date.parse(prev.ts) < LIVE_REFRESH_MS) return;
  }
  writeJsonAtomic(state.livePath(input.session_id), { ts: new Date(now).toISOString(), ...live });
}

// Ligne de la barre d'état. `columns` : largeur disponible (segments de droite retirés en premier).
function render(input, cfg, { now = Date.now(), columns = null, write = true } = {}) {
  const ctx = contextOf(input);
  if (write) recordLive(input, ctx, now);
  const st = input.session_id ? state.loadState(input.session_id) : null;
  const segs = [];

  let model = input.model && input.model.display_name;
  if (model) {
    if (input.effort && input.effort.level) model += `·${input.effort.level}`;
    if (input.fast_mode) model += '·rapide';
    segs.push(model);
  }

  if (ctx != null) {
    const base = st && !st.baselinePending ? st.baseline : null;
    segs.push(`ctx ${tokens(ctx)}${base != null ? ` (+${tokens(Math.max(0, ctx - base))})` : ''}`);
  }

  const rl = input.rate_limits || {};
  for (const s of [pctSegment('5h', rl.five_hour), pctSegment('7j', rl.seven_day)]) if (s) segs.push(s);

  let red = false;
  if (st) {
    const view = { ...st, lastContext: ctx != null ? ctx : st.lastContext };
    red = alerts.handoffAlertActive(view, cfg);
    const c = alerts.cacheClock(view, now);
    if (alerts.cacheExpired(view, cfg, now)) {
      red = true;
      segs.push('cache expiré');
    } else if (c && c.left > 0 && c.left <= TIMER_WINDOW_MS) {
      segs.push(`cache ${clock(c.left)}`);
    }
  }

  // Gains pondérés (§8.3) : lus dans un cache recalculé par un processus détaché (jamais rtk en synchrone).
  if (write) scheduleEcoRefresh(now);
  const eco = readJson(path.join(dataDir(), 'cache', 'eco.json'), null);
  if (eco && typeof eco.weighted === 'number' && eco.weighted > 0) segs.push(`éco ~${tokens(eco.weighted)}`);

  let line = segs.join(' · ');
  if (columns > 0) {
    while (segs.length > 1 && [...line].length > columns) {
      segs.pop();
      line = segs.join(' · ');
    }
  }
  return red ? `${RED}${line}${RESET}` : line;
}

module.exports = { render, contextOf };
