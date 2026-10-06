'use strict';
// Outils de test : environnement isolé, fabrication de transcripts au format réel, exécution des hooks.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'bin', 'hook.js');

// Par défaut, les conseils du lot 6 (consigne de délégation, modèle, effort) sont coupés pour que les tests
// des autres lots ne voient que leurs propres sorties ; `{ advice: true }` garde la configuration par défaut.
function sandbox({ advice = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conso-pilot-test-'));
  const env = {
    CONSO_PILOT_HOME: path.join(dir, 'data'),
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    CLAUDE_PROJECT_DIR: path.join(dir, 'projet'),
    CONSO_PILOT_NOTIFY_LOG: path.join(dir, 'notifications.log'),
    CONSO_PILOT_RTK_BIN: path.join(dir, 'rtk-absent'), // rtk remplacé dans les tests qui en ont besoin
    CONSO_PILOT_SYNC_ECO: '1',
    CLAUDE_PID: '', // pas de lecture du processus Claude Code qui lance les tests
    CLAUDE_EFFORT: '',
  };
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  fs.mkdirSync(env.CLAUDE_PROJECT_DIR, { recursive: true });
  if (!advice) {
    fs.mkdirSync(env.CONSO_PILOT_HOME, { recursive: true });
    fs.writeFileSync(path.join(env.CONSO_PILOT_HOME, 'config.json'), JSON.stringify({ delegationHint: false, modelAdvice: 'off', effortAdvice: false }));
  }
  return { dir, env, transcript: path.join(dir, 'session.jsonl') };
}

// Applique l'environnement au processus courant (tests unitaires des modules).
function readNotifications(env) {
  try {
    return fs.readFileSync(env.CONSO_PILOT_NOTIFY_LOG, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function useEnv(env) {
  Object.assign(process.env, env);
  require('../lib/config').resetConfigCache();
}

function runHook(env, input) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms };
}

let n = 0;

// Un appel API = plusieurs lignes (une par bloc de contenu), même message.id, même usage.
function assistantLines(usage, { model = 'claude-opus-5-5', blocks = 2, effort = 'medium', ttl = '1h', sidechain = false, tools = [] } = {}) {
  n += 1;
  const id = `msg_test_${n}`;
  const creation = usage.cache_creation ?? 0;
  const u = {
    input_tokens: usage.input ?? 2,
    cache_creation_input_tokens: creation,
    cache_read_input_tokens: usage.cache_read ?? 0,
    output_tokens: usage.output ?? 100,
    cache_creation: {
      ephemeral_1h_input_tokens: ttl === '1h' ? creation : 0,
      ephemeral_5m_input_tokens: ttl === '5m' ? creation : 0,
    },
    speed: usage.fast ? 'fast' : 'standard',
  };
  const content = [{ type: 'thinking' }, { type: 'text', text: 'ok' }, ...tools.map((t) => (typeof t === 'string' ? { type: 'tool_use', name: t, input: {} } : { type: 'tool_use', ...t }))];
  const lines = [];
  for (let i = 0; i < Math.max(blocks, content.length); i += 1) {
    lines.push(JSON.stringify({
      parentUuid: null,
      isSidechain: sidechain,
      message: { model, id, type: 'message', role: 'assistant', content: [content[i % content.length]], usage: u },
      type: 'assistant',
      uuid: `uuid-${n}-${i}`,
      timestamp: new Date().toISOString(),
      effort,
      sessionId: 'session-test',
    }));
  }
  return lines;
}

function userLine(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: new Date().toISOString() });
}

function compactBoundaryLine() {
  return JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', timestamp: new Date().toISOString() });
}

function appendLines(file, lines) {
  fs.appendFileSync(file, `${lines.join('\n')}\n`);
}

function readLog(env) {
  const dir = env.CONSO_PILOT_HOME;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^log-\d{4}-\d{2}\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

function readState(env, sessionId) {
  return JSON.parse(fs.readFileSync(path.join(env.CONSO_PILOT_HOME, 'state', `${sessionId}.json`), 'utf8'));
}

// Entrée de hook réelle (enregistrée par la sonde du lot 0), adaptée au bac à sable.
function fixtureInput(event, overrides = {}) {
  const file = path.join(__dirname, 'fixtures', 'hooks', `${event}.jsonl`);
  const first = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]);
  delete first.ts;
  return { ...first, ...overrides };
}

module.exports = {
  ROOT, sandbox, useEnv, readNotifications, runHook, assistantLines, userLine, compactBoundaryLine, appendLines, readLog, readState, fixtureInput,
};
