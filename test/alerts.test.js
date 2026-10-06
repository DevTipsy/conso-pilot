'use strict';
// Lot 3 : alertes « Handoff maintenant » (§3.1) et « cache expiré » (§3.3) — critères 1, 2, 7, 8.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  sandbox, runHook, assistantLines, userLine, appendLines, readState, readNotifications, fixtureInput,
} = require('./helpers');
const { endsWithQuestion } = require('../lib/alerts');

const SID = 'sess-alertes';

function input(sb, event, extra = {}) {
  return { session_id: SID, transcript_path: sb.transcript, cwd: sb.env.CLAUDE_PROJECT_DIR, hook_event_name: event, ...extra };
}

// Un tour : demande + réponse, puis Stop. `ctx` : contexte total visé ; `stop` : champs de l'entrée Stop.
function turn(sb, ctx, { tools = [], stop = {} } = {}) {
  appendLines(sb.transcript, [userLine('demande'), ...assistantLines({ cache_creation: ctx - 2, output: 0 }, { tools })]);
  const r = runHook(sb.env, input(sb, 'Stop', {
    stop_hook_active: false, background_tasks: [], last_assistant_message: 'Terminé.', ...stop,
  }));
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

function prompt(sb, text = 'suite') {
  const r = runHook(sb.env, input(sb, 'UserPromptSubmit', { prompt: text }));
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

function writeConfig(sb, cfg) {
  fs.mkdirSync(sb.env.CONSO_PILOT_HOME, { recursive: true });
  const file = path.join(sb.env.CONSO_PILOT_HOME, 'config.json');
  const base = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  fs.writeFileSync(file, JSON.stringify({ ...base, ...cfg }));
}

function patchState(sb, patch) {
  const file = path.join(sb.env.CONSO_PILOT_HOME, 'state', `${SID}.json`);
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...st, ...patch(st) }));
}

test('dernière phrase en question', () => {
  assert.ok(endsWithQuestion('On continue ?'));
  assert.ok(endsWithQuestion('Je lance le lot 4 ?**\n'));
  assert.ok(!endsWithQuestion('Fait. Tu veux voir ? Voilà.'));
  assert.ok(!endsWithQuestion(''));
});

test('critère 1 : alerte seulement en fin de tâche, non répétée, puis à chaque message au plafond', () => {
  const sb = sandbox();
  assert.strictEqual(turn(sb, 20002), null, 'baseline 20k');
  assert.strictEqual(turn(sb, 50002), null, '+30k : rien');
  // +45k pendant une tâche : appel d'outil, tâches en cours, tâche de fond, question.
  assert.strictEqual(turn(sb, 65002, { tools: ['Bash'] }), null, 'dernier message avec appel d\'outil');
  assert.strictEqual(turn(sb, 65002, { tools: [{ name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'in_progress' }] } }] }), null);
  assert.strictEqual(turn(sb, 65002), null, 'liste de tâches non terminée');
  turn(sb, 65002, { tools: [{ name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'completed' }] } }] });
  assert.strictEqual(turn(sb, 65002, { stop: { background_tasks: [{ id: 'b1', status: 'running' }] } }), null, 'tâche de fond');
  assert.strictEqual(turn(sb, 65002, { stop: { last_assistant_message: 'Je passe au lot 4 ?' } }), null, 'question');
  assert.strictEqual(turn(sb, 65002, { stop: { stop_hook_active: true } }), null, 'stop_hook_active');
  assert.deepStrictEqual(readNotifications(sb.env), []);

  const out = turn(sb, 65002);
  assert.strictEqual(out.systemMessage, '🔴 Handoff maintenant — contexte 65k (+45k). Lance /handoff (résumé, puis discussion vidée et résumé rechargé).');
  assert.strictEqual(out.decision, undefined, 'Stop ne bloque jamais');
  assert.strictEqual(readNotifications(sb.env).length, 1);
  assert.strictEqual(turn(sb, 66002), null, 'non répétée au tour suivant');
  assert.match(turn(sb, 85002).systemMessage, /\+65k/, 'répétée après +20k');

  assert.strictEqual(prompt(sb), null, 'sous le plafond : rien avant le message');
  turn(sb, 121002);
  const n = readNotifications(sb.env).length;
  for (let i = 0; i < 3; i += 1) assert.match(prompt(sb).systemMessage, /^🔴 Handoff maintenant — contexte 121k \(\+101k\)/);
  assert.strictEqual(readNotifications(sb.env).length, n + 1, 'une seule notification pour le plafond');

  patchState(sb, () => ({ handoffDone: true }));
  assert.strictEqual(prompt(sb), null, 'après /handoff : plus d\'alerte');
  assert.strictEqual(turn(sb, 125002), null);
});

test('critère 2 : après un compactage, baseline remesurée et alertes remises à zéro', () => {
  const sb = sandbox();
  turn(sb, 20002);
  assert.ok(turn(sb, 70002).systemMessage);
  runHook(sb.env, input(sb, 'PreCompact', { trigger: 'auto' }));
  runHook(sb.env, input(sb, 'SessionStart', { source: 'compact' }));
  assert.strictEqual(turn(sb, 30002), null, 'pas d\'alerte immédiate');
  const st = readState(sb.env, SID);
  assert.strictEqual(st.baseline, 30002);
  assert.deepStrictEqual(st.alerts, {});
  assert.ok(turn(sb, 75002).systemMessage, 'nouvelle alerte à +45k de la nouvelle baseline');
});

test('critère 7 : pause > TTL avec 50k → message bloqué, renvoyé tel quel → passe', () => {
  const sb = sandbox();
  turn(sb, 20002);
  turn(sb, 52002);
  assert.strictEqual(prompt(sb, 'question'), null, 'cache chaud : rien');
  patchState(sb, () => ({ lastResponseAt: new Date(Date.now() - 75 * 60000).toISOString() }));
  const out = prompt(sb, 'question');
  assert.strictEqual(out.decision, 'block');
  assert.strictEqual(out.reason, 'Cache expiré (pause de 1 h 15) : ce message va refacturer ~52k tokens. Renvoie-le (↑) pour continuer tel quel, ou fais /clear (une sauvegarde automatique est déjà prise) puis /resume --auto pour repartir au propre avec le contexte rechargé.');
  assert.strictEqual(out.systemMessage, undefined);
  assert.strictEqual(readNotifications(sb.env).length, 1);
  assert.strictEqual(prompt(sb, 'question'), null, 'renvoyé tel quel : passe');
  assert.strictEqual(prompt(sb, 'autre chose'), null, 'une seule intervention par pause');
  // Nouvelle réponse puis nouvelle pause : nouvelle intervention.
  turn(sb, 53002);
  patchState(sb, () => ({ lastResponseAt: new Date(Date.now() - 61 * 60000).toISOString() }));
  assert.strictEqual(prompt(sb, 'encore').decision, 'block');
});

test('critère 7 : modes hint et off, seuil de contexte, TTL de 5 min', () => {
  const sb = sandbox();
  writeConfig(sb, { cacheGuard: 'hint' });
  turn(sb, 20002);
  turn(sb, 52002);
  patchState(sb, () => ({ lastResponseAt: new Date(Date.now() - 90 * 60000).toISOString() }));
  const out = prompt(sb);
  assert.strictEqual(out.decision, undefined);
  assert.match(out.systemMessage, /^Cache expiré \(pause de 1 h 30\).*fais plutôt \/clear/);

  const off = sandbox();
  writeConfig(off, { cacheGuard: 'off' });
  turn(off, 52002);
  patchState(off, () => ({ lastResponseAt: new Date(Date.now() - 90 * 60000).toISOString() }));
  assert.strictEqual(prompt(off), null);

  const small = sandbox();
  turn(small, 30002);
  patchState(small, () => ({ lastResponseAt: new Date(Date.now() - 90 * 60000).toISOString() }));
  assert.strictEqual(prompt(small), null, 'contexte < 50k : rien');

  const five = sandbox();
  appendLines(five.transcript, assistantLines({ cache_creation: 60000, output: 0 }, { ttl: '5m' }));
  runHook(five.env, input(five, 'Stop', { stop_hook_active: false, background_tasks: [] }));
  assert.strictEqual(readState(five.env, SID).ttlMinutes, 5);
  patchState(five, () => ({ lastResponseAt: new Date(Date.now() - 6 * 60000).toISOString() }));
  assert.match(prompt(five).reason, /pause de 6 min/);
});

test('critère 8 : reprise d\'une discussion de 150k vieille de 2 h → ligne « Cache expiré » native', () => {
  const sb = sandbox();
  const r = runHook(sb.env, input(sb, 'SessionStart', { source: 'resume', prompt_cache_likely_expired: true, context_tokens: 150000, seconds_since_last_response: 7200 }));
  assert.strictEqual(JSON.parse(r.stdout).systemMessage,
    'Cache expiré : le prochain message refacturera ~150k tokens. Si tu changes de sujet, fais plutôt /clear — une sauvegarde automatique est prise au passage, et /resume --auto la recharge si besoin.');
  assert.strictEqual(readNotifications(sb.env).length, 1);
  const warm = runHook(sb.env, input(sb, 'SessionStart', { source: 'resume', prompt_cache_likely_expired: false, context_tokens: 150000 }));
  assert.strictEqual(warm.stdout, '');
  const small = runHook(sb.env, input(sb, 'SessionStart', { source: 'resume', prompt_cache_likely_expired: true, context_tokens: 30000 }));
  assert.strictEqual(small.stdout, '');
});

test('notifications désactivables', () => {
  const sb = sandbox();
  writeConfig(sb, { notifications: false });
  turn(sb, 20002);
  assert.ok(turn(sb, 70002).systemMessage);
  assert.deepStrictEqual(readNotifications(sb.env), []);
});

test('entrées réelles Stop et UserPromptSubmit : aucune sortie sans état ni seuil', () => {
  const sb = sandbox();
  for (const event of ['UserPromptSubmit', 'Stop']) {
    const r = runHook(sb.env, fixtureInput(event, { session_id: 'reel', transcript_path: sb.transcript, cwd: sb.env.CLAUDE_PROJECT_DIR }));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', event);
  }
});
