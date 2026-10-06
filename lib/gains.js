'use strict';
// Gains réalisés (spec §8.3) — estimations, en tokens pondérés (§8.2) :
//   rtk            : `rtk gain` (tokens de sortie économisés), mis en cache 5 min ;
//   context-mode   : statistiques de ses sessions, affichées seulement (non ajoutées au total : elles comptent
//                    tout ce qui a été traité dans son bac à sable, même ce qui n'aurait jamais été lu) ;
//   lectures bloquées (§7) et handoffs (§5) : calculés à partir du journal.
// Le total pondéré sert aussi au segment « éco » de la barre d'état (cache/eco.json, processus détaché).
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { claudeHome, dataDir, readJson, writeJsonAtomic } = require('./util');
const { modelFamily, weightedTokens } = require('./cost');

const CHARS_PER_TOKEN = 4;
const CACHE_MS = 5 * 60000;
const DAY = 86400000;

function cacheFile(name) {
  return path.join(dataDir(), 'cache', name);
}

function modelWeight(model, cfg) {
  return cfg.costWeights.models[modelFamily(model)] ?? 1;
}

// Poids moyen des modèles de la conversation principale sur la période (pondéré par les tokens bruts).
function averageModelWeight(turns, cfg) {
  let sum = 0;
  let n = 0;
  for (const t of turns) {
    if (t.agent && t.agent !== 'main') continue;
    const raw = (t.input || 0) + (t.cache_5m || 0) + (t.cache_1h || 0) + (t.cache_read || 0) + (t.output || 0);
    sum += raw * modelWeight(t.model, cfg);
    n += raw;
  }
  return n ? sum / n : 1;
}

function cacheWriteFactor(cfg, ttl) {
  return ttl === 5 ? cfg.costWeights.cacheWrite5m : cfg.costWeights.cacheWrite1h;
}

// --- rtk : `rtk gain -d -f json`, jamais appelé depuis un hook ni depuis la barre d'état.
function rtkDaily({ refresh = true, now = Date.now() } = {}) {
  const file = cacheFile('rtk-gain.json');
  const cached = readJson(file, null);
  if (cached && now - cached.at < CACHE_MS) return cached.data;
  if (!refresh) return cached ? cached.data : null;
  let data = null;
  try {
    const r = spawnSync(process.env.CONSO_PILOT_RTK_BIN || 'rtk', ['gain', '-d', '-f', 'json'], { encoding: 'utf8', timeout: 3000 });
    if (r.status === 0) data = JSON.parse(r.stdout);
  } catch {
    data = null;
  }
  writeJsonAtomic(file, { at: now, data });
  return data;
}

function rtkSaved(since, opts) {
  const data = rtkDaily(opts);
  if (!data) return null;
  const day = since.toISOString().slice(0, 10);
  if (Array.isArray(data.daily)) {
    return data.daily.filter((d) => d.date >= day).reduce((s, d) => s + (d.saved_tokens || 0), 0);
  }
  return data.summary ? data.summary.total_saved || 0 : null;
}

// --- context-mode : ~/.claude/context-mode/sessions/stats-pid-*.json (un fichier par session).
function contextModeSaved(since) {
  const dir = path.join(claudeHome(), 'context-mode', 'sessions');
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => /^stats-.*\.json$/.test(n));
  } catch {
    return null;
  }
  let total = 0;
  let sessions = 0;
  for (const n of names) {
    const s = readJson(path.join(dir, n), null);
    if (!s || typeof s.tokens_saved !== 'number' || !(s.updated_at >= since.getTime())) continue;
    total += s.tokens_saved;
    sessions += 1;
  }
  return { tokens: total, sessions };
}

// Tours de la conversation principale par session, triés par date.
function mainTurnsBySession(turns) {
  const map = new Map();
  for (const t of turns) {
    if (t.agent && t.agent !== 'main') continue;
    if (!map.has(t.session)) map.set(t.session, []);
    map.get(t.session).push(t);
  }
  for (const list of map.values()) list.sort((a, b) => (a.ts < b.ts ? -1 : 1));
  return map;
}

// --- Lectures bloquées : tokens évités écrits une fois en cache, puis relus à chaque tour restant.
function blockedGains(entries, bySession, cfg) {
  const denies = entries.filter((e) => e.type === 'deny');
  let tokens = 0;
  let weighted = 0;
  for (const d of denies) {
    const tok = (d.bytes || 0) / CHARS_PER_TOKEN;
    const remaining = (bySession.get(d.session) || []).filter((t) => t.ts > d.ts).length;
    tokens += tok;
    weighted += tok * (cacheWriteFactor(cfg, d.ttl) + cfg.costWeights.cacheRead * remaining) * modelWeight(d.model, cfg);
  }
  return { count: denies.length, tokens, weighted };
}

// --- Handoffs : la nouvelle discussion (même projet, ouverte dans les autoResumeHours) repart d'un contexte
// plus petit ; gain = écart × tours suivants × prix de lecture du cache, plus une création de cache évitée.
function handoffGains(entries, bySession, cfg) {
  const handoffs = entries.filter((e) => e.type === 'handoff' && typeof e.context === 'number');
  const firsts = [...bySession.entries()].map(([session, list]) => ({ session, first: list[0], turns: list }));
  let tokens = 0;
  let weighted = 0;
  let count = 0;
  for (const h of handoffs) {
    const limit = new Date(Date.parse(h.ts) + cfg.autoResumeHours * 3600000).toISOString();
    const next = firsts
      .filter((s) => s.session !== h.session && s.first.project === h.project && s.first.ts > h.ts && s.first.ts <= limit)
      .sort((a, b) => (a.first.ts < b.first.ts ? -1 : 1))[0];
    if (!next || next.first.context == null) continue;
    const delta = Math.max(0, h.context - next.first.context);
    if (!delta) continue;
    const w = modelWeight(next.first.model, cfg);
    count += 1;
    tokens += delta * next.turns.length;
    weighted += delta * (next.turns.length * cfg.costWeights.cacheRead + cfg.costWeights.cacheWrite1h) * w;
  }
  return { count, tokens, weighted };
}

/**
 * Gains sur la période. `entries` : lignes du journal depuis `since`.
 * @param {{refreshRtk?: boolean}} opts  false : rtk lu dans le cache seulement
 */
function computeGains(entries, since, cfg, { refreshRtk = true, now = Date.now() } = {}) {
  const turns = entries.filter((e) => e.type === 'turn');
  const bySession = mainTurnsBySession(turns);
  const avgW = averageModelWeight(turns, cfg);
  const rtk = rtkSaved(since, { refresh: refreshRtk, now });
  const cm = contextModeSaved(since);
  // Sortie d'outil économisée : écrite une fois dans le cache (borne basse, relectures ignorées).
  const rtkWeighted = rtk == null ? null : rtk * cfg.costWeights.cacheWrite1h * avgW;
  const cmWeighted = cm == null ? null : cm.tokens * cfg.costWeights.cacheWrite1h * avgW;
  const blocked = blockedGains(entries, bySession, cfg);
  const handoffs = handoffGains(entries, bySession, cfg);
  const total = (rtkWeighted || 0) + blocked.weighted + handoffs.weighted;
  const spent = turns.reduce((s, t) => s + weightedTokens(t, cfg), 0);
  return {
    rtk: rtk == null ? null : { tokens: rtk, weighted: rtkWeighted },
    contextMode: cm == null ? null : { ...cm, weighted: cmWeighted },
    blocked,
    handoffs,
    total,
    spent,
  };
}

// --- Segment « éco » de la barre d'état : recalcul détaché, au plus toutes les 5 minutes.
function refreshEco(now = Date.now()) {
  const { loadConfig } = require('./config');
  const journal = require('./journal');
  const since = new Date(now - 7 * DAY);
  const g = computeGains(journal.readSince(since), since, loadConfig(), { now });
  writeJsonAtomic(cacheFile('eco.json'), { at: now, weighted: Math.round(g.total), period: '7j' });
}

function scheduleEcoRefresh(now = Date.now()) {
  const eco = readJson(cacheFile('eco.json'), null);
  if (eco && now - eco.at < CACHE_MS) return false;
  const lock = cacheFile('eco.lock');
  try {
    if (now - fs.statSync(lock).mtimeMs < 60000) return false; // recalcul déjà lancé
  } catch {
    // pas de verrou
  }
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, String(now));
  if (process.env.CONSO_PILOT_SYNC_ECO) {
    refreshEco(now); // tests
    return true;
  }
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'eco-refresh')], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return true;
}

module.exports = { computeGains, refreshEco, scheduleEcoRefresh, rtkDaily, contextModeSaved, averageModelWeight };
