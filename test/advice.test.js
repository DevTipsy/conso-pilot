'use strict';
// Lot 6 : conseils de modèle et d'effort (§9.2), PreModelSwitch, consigne de délégation et agents (§9.1).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT, sandbox, useEnv, runHook, assistantLines, userLine, appendLines, readLog, readState, fixtureInput } = require('./helpers');

const SID = 'sess-conseil';

function hook(sb, event, extra = {}) {
  const r = runHook(sb.env, { session_id: SID, transcript_path: sb.transcript, cwd: sb.env.CLAUDE_PROJECT_DIR, hook_event_name: event, ...extra });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

function writeConfig(sb, cfg) {
  fs.mkdirSync(sb.env.CONSO_PILOT_HOME, { recursive: true });
  fs.writeFileSync(path.join(sb.env.CONSO_PILOT_HOME, 'config.json'), JSON.stringify(cfg));
}

// Session démarrée, une première réponse (baseline) avec le modèle et l'effort donnés.
function start(sb, { model = 'claude-opus-5-5', effort = 'high', ctx = 20002, fast = false } = {}) {
  hook(sb, 'SessionStart', { source: 'startup' });
  appendLines(sb.transcript, [userLine('x'), ...assistantLines({ cache_creation: ctx - 2, output: 0, fast }, { model, effort })]);
  hook(sb, 'Stop', { background_tasks: [], effort: { level: effort } });
}

test('classement heuristique des demandes', () => {
  const { classify, filesMentioned } = require('../lib/advice');
  assert.strictEqual(classify('renomme la variable foo en bar'), 'simple');
  assert.strictEqual(classify('Explain what this regex does in detail, with examples, covering every branch and the edge cases around unicode, anchors, lookbehinds and flags, then compare it with the version used in the other module of the backend service'), 'simple');
  assert.strictEqual(classify('corrige le test qui échoue dans Login.swift'), 'simple');
  assert.strictEqual(classify('Conçois l\'architecture du module de synchronisation hors ligne'), 'complex');
  assert.strictEqual(classify('modifie A.swift, B.swift, C.swift et lib/d.ts pour ajouter le champ'), 'complex');
  assert.strictEqual(classify('ultrathink : pourquoi ce crash ?'), 'critical');
  assert.strictEqual(classify('Réfléchis à fond avant de répondre'), 'critical');
  assert.strictEqual(classify(`${'Ajoute un écran de réglages avec trois options et la persistance. '.repeat(4)}`), 'standard');
  assert.strictEqual(classify('compare Foo.swift et Bar.swift'), 'standard', 'court mais deux fichiers');
  assert.strictEqual(classify('/handoff'), null);
  assert.strictEqual(filesMentioned('voir `src/app.ts`, @README.md et Package.swift.'), 3);
});

test('modèle : conseil au premier message, plus cher seulement pour complexe/critique, une fois par niveau', () => {
  const sb = sandbox({ advice: true });
  start(sb, { model: 'claude-opus-5-5', effort: 'medium' });
  const first = hook(sb, 'UserPromptSubmit', { prompt: 'renomme foo en bar' });
  assert.strictEqual(first.systemMessage, 'Tâche jugée simple → Sonnet + effort low (sélecteur de modèle ; actuel : Opus).');
  assert.strictEqual(hook(sb, 'UserPromptSubmit', { prompt: 'renomme aussi baz' }), null, 'même conseil déjà donné');

  const sonnet = sandbox({ advice: true });
  start(sonnet, { model: 'claude-sonnet-5-5', effort: 'medium' });
  assert.strictEqual(hook(sonnet, 'UserPromptSubmit', { prompt: 'renomme foo en bar' }), null, 'déjà le bon modèle');
  const complex = hook(sonnet, 'UserPromptSubmit', { prompt: 'conçois l\'architecture de la synchro' });
  assert.match(complex.systemMessage, /^Tâche jugée complexe → Opus \(ou opusplan\) \+ effort high \(sélecteur de modèle ; actuel : Sonnet\)\./);

  // Contexte ajouté ≥ modelAdviceMaxAddedTokens : plus de conseil de modèle.
  const late = sandbox({ advice: true });
  start(late, { model: 'claude-sonnet-5-5', effort: 'medium' });
  hook(late, 'UserPromptSubmit', { prompt: 'Ajoute un écran de réglages avec trois options et la persistance des choix. '.repeat(4) });
  appendLines(late.transcript, [userLine('y'), ...assistantLines({ cache_read: 20000, cache_creation: 15000, output: 0 }, { model: 'claude-sonnet-5-5', effort: 'medium' })]);
  hook(late, 'Stop', { background_tasks: [] });
  assert.strictEqual(hook(late, 'UserPromptSubmit', { prompt: 'conçois l\'architecture de la synchro' }), null);

  const log = readLog(sb.env).filter((e) => e.type === 'advice');
  assert.strictEqual(log.length, 1);
  assert.deepStrictEqual({ kind: log[0].kind, level: log[0].level, to: log[0].to, mode: log[0].mode }, { kind: 'model', level: 'simple', to: 'sonnet', mode: 'hint' });
});

test('modèle inconnu : conseil sans comparaison au premier message ; modèle lu au lancement sinon', () => {
  const sb = sandbox({ advice: true });
  hook(sb, 'SessionStart', { source: 'startup' });
  const out = hook(sb, 'UserPromptSubmit', { prompt: 'renomme foo' });
  assert.strictEqual(out.systemMessage, 'Tâche jugée simple → Sonnet + effort low (sélecteur de modèle).');

  // --model du processus Claude Code (CLAUDE_PID) et CLAUDE_EFFORT de l'environnement.
  const fake = path.join(sb.dir, 'fake-claude.js');
  fs.writeFileSync(fake, 'setTimeout(() => {}, 5000);');
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [fake, '--model', 'claude-sonnet-5-5', '--effort', 'xhigh']);
  try {
    const launched = sandbox({ advice: true });
    launched.env.CLAUDE_PID = String(child.pid);
    launched.env.CLAUDE_EFFORT = 'xhigh';
    hook(launched, 'SessionStart', { source: 'startup' });
    const r = hook(launched, 'UserPromptSubmit', { prompt: 'renomme foo' });
    assert.strictEqual(r.systemMessage, 'Tâche jugée simple : effort low suffit (actuel : xhigh). Changer d\'effort ne vide pas le cache.');
    const st = readState(launched.env, SID);
    assert.deepStrictEqual(st.model, { value: 'claude-sonnet-5-5', source: 'lancement' });
    assert.deepStrictEqual(st.effort, { value: 'xhigh', source: 'lancement' });
  } finally {
    child.kill();
  }
});

test('mode block : bloque une fois, le renvoi passe, jamais deux blocages de suite', () => {
  const sb = sandbox({ advice: true });
  writeConfig(sb, { modelAdvice: 'block', effortAdvice: false });
  start(sb, { model: 'claude-opus-5-5' });
  const blocked = hook(sb, 'UserPromptSubmit', { prompt: 'renomme foo en bar' });
  assert.strictEqual(blocked.decision, 'block');
  assert.match(blocked.reason, /Sonnet \+ effort low.*Change puis renvoie, ou renvoie tel quel pour ignorer\.$/);
  assert.strictEqual(hook(sb, 'UserPromptSubmit', { prompt: 'renomme foo en bar' }), null, 'renvoyé tel quel');
  // Autre niveau, juste après un blocage annulé par le renvoi : un nouveau blocage reste possible.
  const crit = hook(sb, 'UserPromptSubmit', { prompt: 'ultrathink sur le design' });
  assert.strictEqual(crit, null, 'déjà sur Opus');
  assert.strictEqual(readLog(sb.env).filter((e) => e.type === 'advice' && e.blocked).length, 1);

  // Modèle inconnu : jamais de blocage.
  const unknown = sandbox({ advice: true });
  writeConfig(unknown, { modelAdvice: 'block' });
  hook(unknown, 'SessionStart', { source: 'startup' });
  assert.strictEqual(hook(unknown, 'UserPromptSubmit', { prompt: 'renomme foo' }).decision, undefined);
});

test('effort : écart ≥ 2 crans, au plus une fois toutes les 5 demandes, pas pour Haiku', () => {
  const sb = sandbox({ advice: true });
  writeConfig(sb, { modelAdvice: 'off' });
  start(sb, { model: 'claude-sonnet-5-5', effort: 'high' });
  const a = hook(sb, 'UserPromptSubmit', { prompt: 'renomme foo' });
  assert.strictEqual(a.systemMessage, 'Tâche jugée simple : effort low suffit (actuel : high). Changer d\'effort ne vide pas le cache.');
  for (let i = 0; i < 4; i += 1) assert.strictEqual(hook(sb, 'UserPromptSubmit', { prompt: 'renomme foo' }), null);
  assert.ok(hook(sb, 'UserPromptSubmit', { prompt: 'renomme foo' }).systemMessage, '5 demandes plus tard');
  assert.strictEqual(hook(sb, 'UserPromptSubmit', { prompt: 'ultrathink : pourquoi ?' }), null, 'high vs xhigh : 1 cran');

  const low = sandbox({ advice: true });
  writeConfig(low, { modelAdvice: 'off' });
  start(low, { model: 'claude-opus-5-5', effort: 'low' });
  assert.match(hook(low, 'UserPromptSubmit', { prompt: 'réfléchis à fond à ce crash' }).systemMessage, /effort xhigh conseillé \(actuel : low\)/);

  const haiku = sandbox({ advice: true });
  writeConfig(haiku, { modelAdvice: 'off' });
  start(haiku, { model: 'claude-haiku-4-5-20251001', effort: 'max' });
  assert.strictEqual(hook(haiku, 'UserPromptSubmit', { prompt: 'renomme foo' }), null);
});

test('mode rapide : rappel au premier message', () => {
  const sb = sandbox({ advice: true });
  writeConfig(sb, { modelAdvice: 'off', effortAdvice: false });
  start(sb, { model: 'claude-opus-5-5', fast: true });
  assert.strictEqual(hook(sb, 'UserPromptSubmit', { prompt: 'Ajoute un écran de réglages. '.repeat(10) }).systemMessage, '⚡ Mode rapide actif : il multiplie le coût d\'Opus (×2 pondéré).');
  assert.strictEqual(hook(sb, 'UserPromptSubmit', { prompt: 'suite' }), null);
});

test('cache expiré bloqué : pas de conseil de modèle bloquant juste après', () => {
  const sb = sandbox({ advice: true });
  writeConfig(sb, { modelAdvice: 'block', effortAdvice: false });
  start(sb, { model: 'claude-opus-5-5', ctx: 60002 });
  const file = path.join(sb.env.CONSO_PILOT_HOME, 'state', `${SID}.json`);
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  st.lastResponseAt = new Date(Date.now() - 2 * 3600000).toISOString();
  fs.writeFileSync(file, JSON.stringify(st));
  assert.match(hook(sb, 'UserPromptSubmit', { prompt: 'renomme foo' }).reason, /^Cache expiré/);
  const again = hook(sb, 'UserPromptSubmit', { prompt: 'renomme foo' });
  assert.strictEqual(again.decision, undefined);
  assert.match(again.systemMessage, /Sonnet \+ effort low/);
});

test('PreModelSwitch : « ask » seulement pour les sources configurées, au-delà du seuil', () => {
  const sb = sandbox({ advice: true });
  start(sb, { ctx: 20002 });
  const app = fixtureInput('PreModelSwitch', { session_id: SID, transcript_path: sb.transcript, context_tokens: 104136 });
  assert.strictEqual(hook(sb, 'PreModelSwitch', app), null, 'source « sdk » (app) : aucune réponse par défaut');

  writeConfig(sb, { modelSwitchAskSources: ['sdk'] });
  const ask = hook(sb, 'PreModelSwitch', app);
  assert.strictEqual(ask.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(ask.hookSpecificOutput.permissionDecisionReason, /^Changer maintenant renvoie ~104k tokens au nouveau modèle\./);
  assert.strictEqual(hook(sb, 'PreModelSwitch', { ...app, context_tokens: 25000 }), null, 'contexte ajouté < 10k');
});

test('consigne de délégation : startup et clear seulement, ajoutée au handoff relu', () => {
  const sb = sandbox({ advice: true });
  const out = hook(sb, 'SessionStart', { source: 'startup' });
  assert.strictEqual(out.hookSpecificOutput.additionalContext, 'Délègue les recherches larges à Explore, les builds et tests à runner, les décisions difficiles à architect ; fais toi-même les petites tâches.');
  assert.strictEqual(out.systemMessage, undefined);
  assert.ok(out.hookSpecificOutput.additionalContext.length / 4 <= 80);
  assert.strictEqual(hook(sb, 'SessionStart', { source: 'resume' }), null);
  assert.strictEqual(hook(sb, 'SessionStart', { source: 'compact' }), null);

  // Handoff récent : relu, consigne à la suite.
  useEnv(sb.env);
  require('../lib/handoff').saveHandoff({ text: '## Objectif\nTester\n', sessionId: 'avant', project: sb.env.CLAUDE_PROJECT_DIR, contextTokens: 50000, cfg: require('../lib/config').loadConfig() });
  const cleared = hook(sb, 'SessionStart', { source: 'clear', session_id: 'apres' });
  assert.match(cleared.systemMessage, /rechargé/);
  assert.match(cleared.hookSpecificOutput.additionalContext, /Tester[\s\S]*\n\nDélègue les recherches/);

  const off = sandbox();
  assert.strictEqual(hook(off, 'SessionStart', { source: 'startup' }), null, 'delegationHint: false');
});

test('/conso : conseils suivis quand un tour suivant utilise la valeur conseillée', () => {
  const sb = sandbox({ advice: true });
  start(sb, { model: 'claude-opus-5-5', effort: 'high' });
  hook(sb, 'UserPromptSubmit', { prompt: 'renomme foo' }); // modèle → sonnet, effort → low
  appendLines(sb.transcript, [userLine('renomme foo'), ...assistantLines({ cache_creation: 20000, output: 0 }, { model: 'claude-sonnet-5-5', effort: 'medium' })]);
  hook(sb, 'Stop', { background_tasks: [], effort: { level: 'medium' } });
  useEnv(sb.env);
  const report = require('../lib/report-conso').buildConsoReport();
  assert.match(report, /- Modèle : 1 conseil\(s\), 100 % suivi\(s\) \(0 message\(s\) bloqué\(s\)\)\./);
  assert.match(report, /- Effort : 1 conseil\(s\), 0 % suivi\(s\)\./);
});

test('agents fournis : runner (haiku) et architect (opus, effort high)', () => {
  const read = (n) => fs.readFileSync(path.join(ROOT, 'agents', `${n}.md`), 'utf8');
  assert.match(read('runner'), /^---\nname: runner\n[\s\S]*model: haiku\ntools: Bash, Read\n---/);
  assert.doesNotMatch(read('runner'), /^effort:/m);
  assert.match(read('architect'), /^---\nname: architect\n[\s\S]*model: opus\neffort: high\ntools: Read, Grep, Glob\n---/);
});
