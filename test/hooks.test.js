'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  sandbox, runHook, assistantLines, userLine, compactBoundaryLine, appendLines, readLog, readState, fixtureInput,
} = require('./helpers');

const SID = 'sess-1';

function input(sb, event, extra = {}) {
  return { session_id: SID, transcript_path: sb.transcript, cwd: sb.env.CLAUDE_PROJECT_DIR, hook_event_name: event, ...extra };
}

function turn(sb, usage, opts) {
  appendLines(sb.transcript, [userLine('demande'), ...assistantLines(usage, opts)]);
  return runHook(sb.env, input(sb, 'Stop', { stop_hook_active: false, effort: { level: 'high' }, background_tasks: [] }));
}

test('SessionStart crée la config par défaut et l\'état de session ; seule sortie : la consigne de délégation', () => {
  const sb = sandbox({ advice: true });
  const r = runHook(sb.env, input(sb, 'SessionStart', { source: 'startup' }));
  assert.strictEqual(r.status, 0);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /^Délègue les recherches larges à Explore/);
  assert.ok(fs.existsSync(path.join(sb.env.CONSO_PILOT_HOME, 'config.json')));
  const st = readState(sb.env, SID);
  assert.strictEqual(st.project, sb.env.CLAUDE_PROJECT_DIR);
  assert.strictEqual(st.ttlMinutes, 60);
});

test('baseline à la première réponse, contexte ajouté ensuite', () => {
  const sb = sandbox();
  runHook(sb.env, input(sb, 'SessionStart', { source: 'startup' }));
  turn(sb, { cache_creation: 20000, output: 0 });
  let st = readState(sb.env, SID);
  assert.strictEqual(st.baseline, 20002);
  turn(sb, { cache_read: 20000, cache_creation: 30000, output: 0 });
  st = readState(sb.env, SID);
  assert.strictEqual(st.baseline, 20002);
  assert.strictEqual(st.lastContext, 50002);
  assert.strictEqual(st.turns, 2);
  assert.deepStrictEqual(st.effort, { value: 'high', source: 'Stop' });
  assert.deepStrictEqual(st.model, { value: 'claude-opus-5-5', source: 'transcript' });
});

test('après un compactage, la baseline est remesurée (PreCompact)', () => {
  const sb = sandbox();
  turn(sb, { cache_creation: 20000, output: 0 });
  turn(sb, { cache_read: 20000, cache_creation: 100000, output: 0 });
  runHook(sb.env, input(sb, 'PreCompact', { trigger: 'manual' }));
  runHook(sb.env, input(sb, 'SessionStart', { source: 'compact' }));
  turn(sb, { cache_creation: 25000, output: 0 });
  const st = readState(sb.env, SID);
  assert.strictEqual(st.baseline, 25002);
  assert.strictEqual(st.lastContext - st.baseline, 0);
  assert.ok(readLog(sb.env).some((e) => e.type === 'compact' && e.trigger === 'manual'));
});

test('compactage automatique en cours de tour : détecté dans le transcript', () => {
  const sb = sandbox();
  turn(sb, { cache_creation: 20000, output: 0 });
  appendLines(sb.transcript, [compactBoundaryLine()]);
  turn(sb, { cache_creation: 30000, output: 0 });
  assert.strictEqual(readState(sb.env, SID).baseline, 30002);
});

test('journal : somme = usages dédoublonnés par message.id (critère 6)', () => {
  const sb = sandbox();
  const usages = [
    { input: 3, cache_creation: 1000, cache_read: 0, output: 40 },
    { input: 1, cache_creation: 200, cache_read: 1000, output: 70 },
    { input: 2, cache_creation: 0, cache_read: 1200, output: 15 },
  ];
  appendLines(sb.transcript, [userLine('a'), ...assistantLines(usages[0], { blocks: 3, tools: ['Bash'] }), ...assistantLines(usages[1], { blocks: 5 })]);
  runHook(sb.env, input(sb, 'Stop'));
  appendLines(sb.transcript, [userLine('b'), ...assistantLines(usages[2], { blocks: 2 })]);
  runHook(sb.env, input(sb, 'Stop'));
  runHook(sb.env, input(sb, 'Stop')); // Stop sans nouvelle réponse : rien à ajouter

  const turns = readLog(sb.env).filter((e) => e.type === 'turn');
  assert.strictEqual(turns.length, 2);
  const sum = (k) => turns.reduce((a, t) => a + t[k], 0);
  assert.strictEqual(sum('input'), 6);
  assert.strictEqual(sum('cache_1h'), 1200);
  assert.strictEqual(sum('cache_read'), 2200);
  assert.strictEqual(sum('output'), 125);
  assert.strictEqual(sum('calls'), 3);
  assert.strictEqual(turns[0].agent, 'main');
  assert.strictEqual(turns[0].context, 1 + 200 + 1000 + 70);
});

test('SubagentStop : journalisé avec le type d\'agent, sans double comptage (critère 5)', () => {
  const sb = sandbox();
  const agentFile = path.join(sb.dir, 'subagents', 'agent-abc.jsonl');
  fs.mkdirSync(path.dirname(agentFile), { recursive: true });
  appendLines(agentFile, assistantLines({ input: 5, output: 9 }, { sidechain: true, model: 'claude-haiku-4-5', blocks: 3 }));
  // Ancien format : les lignes du sous-agent figurent aussi dans le transcript principal.
  appendLines(sb.transcript, [...assistantLines({ input: 1, output: 1 }), ...assistantLines({ input: 5, output: 9 }, { sidechain: true })]);
  const sub = { agent_id: 'abc', agent_type: 'runner', agent_transcript_path: agentFile };
  runHook(sb.env, input(sb, 'SubagentStop', sub));
  runHook(sb.env, input(sb, 'SubagentStop', sub)); // relancé : rien de neuf
  runHook(sb.env, input(sb, 'Stop'));

  const turns = readLog(sb.env).filter((e) => e.type === 'turn');
  const runner = turns.filter((t) => t.agent === 'runner');
  assert.strictEqual(runner.length, 1);
  assert.strictEqual(runner[0].output, 9);
  assert.strictEqual(runner[0].model, 'claude-haiku-4-5');
  assert.strictEqual(turns.filter((t) => t.agent === 'main').reduce((a, t) => a + t.output, 0), 1);
});

test('SubagentStop : type absent → méta-données, sinon agent interne', () => {
  const sb = sandbox();
  const dir = path.join(sb.dir, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  appendLines(path.join(dir, 'agent-x.jsonl'), assistantLines({ output: 1 }, { sidechain: true }));
  fs.writeFileSync(path.join(dir, 'agent-x.meta.json'), JSON.stringify({ agentType: 'Explore' }));
  appendLines(path.join(dir, 'agent-y.jsonl'), assistantLines({ output: 2 }, { sidechain: true }));
  runHook(sb.env, input(sb, 'SubagentStop', { agent_id: 'x', agent_type: '', agent_transcript_path: path.join(dir, 'agent-x.jsonl') }));
  runHook(sb.env, input(sb, 'SubagentStop', { agent_id: 'y', agent_type: '', agent_transcript_path: path.join(dir, 'agent-y.jsonl') }));
  // Agent interne réel (suggestion de prompt) : transcript inexistant.
  const r = runHook(sb.env, fixtureInput('SubagentStop', { agent_transcript_path: path.join(dir, 'absent.jsonl') }));
  assert.strictEqual(r.status, 0);
  assert.deepStrictEqual(readLog(sb.env).map((e) => e.agent).sort(), ['Explore', 'internal:unknown']);
  assert.ok(!fs.existsSync(path.join(sb.env.CONSO_PILOT_HOME, 'errors.log')));
});

test('PostModelSwitch : modèle et TTL mis à jour, changement journalisé', () => {
  const sb = sandbox();
  turn(sb, { cache_creation: 1000, output: 0 });
  const r = runHook(sb.env, fixtureInput('PostModelSwitch', { session_id: SID, cwd: sb.env.CLAUDE_PROJECT_DIR, transcript_path: sb.transcript }));
  assert.strictEqual(r.stdout, '');
  const st = readState(sb.env, SID);
  assert.deepStrictEqual(st.model, { value: 'claude-haiku-4-5-20251001', source: 'PostModelSwitch' });
  assert.strictEqual(st.ttlSource, 'PostModelSwitch');
  const sw = readLog(sb.env).find((e) => e.type === 'model_switch');
  assert.strictEqual(sw.from, 'claude-opus-5-5');
  assert.strictEqual(sw.context, 104136);
});

test('SessionEnd /clear journalisé avec le contexte de la session', () => {
  const sb = sandbox();
  turn(sb, { cache_creation: 42000, output: 0 });
  const r = runHook(sb.env, input(sb, 'SessionEnd', { reason: 'clear' }));
  assert.ok(r.ms < 500, `SessionEnd ${r.ms} ms`);
  const ev = readLog(sb.env).find((e) => e.type === 'clear');
  assert.strictEqual(ev.context, 42002);
});

test('reprise : context_tokens de SessionStart repris dans l\'état', () => {
  const sb = sandbox();
  runHook(sb.env, input(sb, 'SessionStart', { source: 'resume', context_tokens: 150000, prompt_cache_likely_expired: true }));
  assert.strictEqual(readState(sb.env, SID).lastContext, 150000);
});

test('entrées réelles de la sonde : aucun hook ne plante', () => {
  const sb = sandbox();
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'PreModelSwitch', 'PostModelSwitch']) {
    const r = runHook(sb.env, fixtureInput(event, { session_id: SID, transcript_path: sb.transcript }));
    assert.strictEqual(r.status, 0, event);
    assert.strictEqual(r.stdout, '', event);
  }
  assert.ok(!fs.existsSync(path.join(sb.env.CONSO_PILOT_HOME, 'errors.log')));
});

test('fail-open : entrée invalide → code 0, rien affiché, erreur journalisée (critère 13)', () => {
  const sb = sandbox();
  const r = runHook(sb.env, '{ pas du json');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.match(fs.readFileSync(path.join(sb.env.CONSO_PILOT_HOME, 'errors.log'), 'utf8'), /SyntaxError/);
});

test('fail-open : dossier de données inutilisable → code 0, rien affiché', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.dir, 'fichier'), '');
  const env = { ...sb.env, CONSO_PILOT_HOME: path.join(sb.dir, 'fichier', 'data') };
  appendLines(sb.transcript, assistantLines({ output: 1 }));
  const r = runHook(env, input(sb, 'Stop'));
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});
