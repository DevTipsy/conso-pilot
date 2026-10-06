'use strict';
// État de session (spec §2.3) : un fichier par session, state/<session_id>.json.
// Les curseurs des sous-agents ont leur propre fichier (state/agents/<agent_id>.json) :
// SubagentStop est asynchrone et ne doit pas écraser l'état écrit en parallèle par Stop.
const fs = require('fs');
const path = require('path');
const { dataDir, readJson, writeJsonAtomic } = require('./util');
const { newActivity } = require('./transcript');

function stateDir() {
  return path.join(dataDir(), 'state');
}

function safeId(id) {
  return String(id || 'inconnu').replace(/[^A-Za-z0-9_-]/g, '_');
}

function statePath(sessionId) {
  return path.join(stateDir(), `${safeId(sessionId)}.json`);
}

function newState(input = {}) {
  return {
    session: input.session_id || null,
    project: projectOf(input),
    transcript: input.transcript_path || null,
    cursor: {},
    baseline: null,
    baselinePending: true,
    lastContext: null,
    lastResponseAt: null,
    model: null,
    effort: null,
    fast: null,
    ttlMinutes: null,
    ttlSource: null,
    turns: 0,
    alerts: {},
    blockedHash: null,
    handoffDone: false,
    activity: newActivity(),
    autoSave: null,
    createdAt: new Date().toISOString(),
    updatedAt: null,
  };
}

function projectOf(input = {}) {
  return process.env.CLAUDE_PROJECT_DIR || input.cwd || null;
}

function loadState(sessionId) {
  return readJson(statePath(sessionId), null);
}

function saveState(state) {
  state.updatedAt = new Date().toISOString();
  writeJsonAtomic(statePath(state.session), state);
}

// Charge l'état de la session, ou en crée un (hook reçu sans SessionStart préalable).
function loadOrCreate(input) {
  const st = loadState(input.session_id) || newState(input);
  if (!st.transcript && input.transcript_path) st.transcript = input.transcript_path;
  if (!st.project) st.project = projectOf(input);
  return st;
}

// Contexte ajouté = contexte − baseline (spec §2.2).
function addedContext(state) {
  if (state.lastContext == null || state.baseline == null) return null;
  return Math.max(0, state.lastContext - state.baseline);
}

// Observations de la barre d'état (§4) : fichier à part, state/live/<session_id>.json, pour ne jamais
// écraser l'état écrit par les hooks (curseur du transcript) lors d'écritures concurrentes.
function livePath(sessionId) {
  return path.join(stateDir(), 'live', `${safeId(sessionId)}.json`);
}

function readLive(sessionId) {
  return readJson(livePath(sessionId), null);
}

// La barre d'état est la source préférée (§2.3) quand son relevé est plus récent que l'état.
function applyLive(state) {
  const live = readLive(state.session);
  if (!live || !live.ts || String(live.ts) <= String(state.updatedAt || '')) return state;
  const src = "barre d'état";
  if (live.model) state.model = { value: live.model, source: src };
  if (live.effort) state.effort = { value: live.effort, source: src };
  if (typeof live.fast === 'boolean') state.fast = { value: live.fast, source: src };
  if (typeof live.context === 'number') state.lastContext = live.context;
  if (typeof live.contextSize === 'number') state.contextSize = live.contextSize;
  return state;
}

function agentStatePath(agentId) {
  return path.join(stateDir(), 'agents', `${safeId(agentId)}.json`);
}

// Le plus récent des états de session d'un projet (pour /conso-pilot:status hors hook).
function latestStateFor(project) {
  let best = null;
  let names;
  try {
    names = fs.readdirSync(stateDir()).filter((n) => n.endsWith('.json'));
  } catch {
    return null;
  }
  for (const name of names) {
    const st = readJson(path.join(stateDir(), name), null);
    if (!st || (project && st.project !== project)) continue;
    if (!best || String(st.updatedAt) > String(best.updatedAt)) best = st;
  }
  return best;
}

// Supprime les états de plus de `maxAgeDays` jours ; au plus une fois par jour.
function pruneStates(maxAgeDays = 30) {
  const dir = stateDir();
  const marker = path.join(dir, '.pruned');
  const today = new Date().toISOString().slice(0, 10);
  try {
    if (fs.readFileSync(marker, 'utf8') === today) return;
  } catch {
    // jamais fait
  }
  const limit = Date.now() - maxAgeDays * 86400000;
  for (const sub of [dir, path.join(dir, 'agents'), path.join(dir, 'live')]) {
    let names = [];
    try {
      names = fs.readdirSync(sub);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(sub, name);
      try {
        if (fs.statSync(file).mtimeMs < limit) fs.unlinkSync(file);
      } catch {
        // fichier déjà supprimé par un autre hook
      }
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(marker, today);
}

module.exports = {
  stateDir, statePath, livePath, readLive, applyLive, newState, loadState, saveState, loadOrCreate, addedContext, agentStatePath, latestStateFor, projectOf,
  pruneStates,
};
