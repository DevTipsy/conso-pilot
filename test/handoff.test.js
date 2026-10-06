'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ROOT, sandbox, useEnv, runHook, assistantLines, userLine, appendLines, readLog, readState,
} = require('./helpers');

const SID = 'abcdef12-3456-7890-abcd-ef1234567890';
const S8 = 'abcdef12';

function input(sb, event, extra = {}) {
  return { session_id: SID, transcript_path: sb.transcript, cwd: sb.env.CLAUDE_PROJECT_DIR, hook_event_name: event, ...extra };
}

function handoffDir(sb) {
  return path.join(sb.env.CONSO_PILOT_HOME, 'handoffs', sb.env.CLAUDE_PROJECT_DIR.replace(/[/.]/g, '-'));
}

function autoFile(sb) {
  return path.join(handoffDir(sb), 'auto', `${S8}.md`);
}

// Ligne assistant ne contenant qu'un appel d'outil (format réel : un bloc par ligne).
let n = 0;
function toolLine(name, toolInput) {
  n += 1;
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    timestamp: new Date().toISOString(),
    message: {
      id: `msg_tool_${n}`,
      model: 'claude-opus-5-5',
      role: 'assistant',
      content: [{ type: 'tool_use', id: `toolu_${n}`, name, input: toolInput }],
      usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000, output_tokens: 10 },
    },
  });
}

function toolErrorLine(toolLineText, text) {
  const id = JSON.parse(toolLineText).message.content[0].id;
  return JSON.stringify({
    type: 'user',
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: text }] },
    toolUseResult: `Error: ${text}`,
  });
}

function humanLine(content, extra = {}) {
  return JSON.stringify({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content }, timestamp: new Date().toISOString(), ...extra });
}

function saveHandoff(sb, text, env = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, 'bin', 'save-handoff')], {
    input: text,
    env: { ...process.env, ...sb.env, CLAUDE_CODE_SESSION_ID: SID, ...env },
    encoding: 'utf8',
  });
}

function reprendre(sb, args = [], env = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, 'bin', 'reprendre'), ...args], {
    env: { ...process.env, ...sb.env, ...env },
    encoding: 'utf8',
  }).stdout;
}

// Vieillit latest.md : réécrit la date de création de l'en-tête.
function ageLatest(sb, minutes) {
  const file = path.join(handoffDir(sb), 'latest.md');
  const text = fs.readFileSync(file, 'utf8').replace(/^created: .*$/m, `created: "${new Date(Date.now() - minutes * 60000).toISOString()}"`);
  fs.writeFileSync(file, text);
}

const HANDOFF = `## Objectif
Implémenter le lot 2 de conso-pilot.
## État actuel
Sauvegarde auto faite.
## Prochaines étapes
- Tests de relecture.
`;

test('activité extraite du transcript : demandes, fichiers, tâches, commandes en erreur', () => {
  const sb = sandbox();
  const bash = toolLine('Bash', { command: 'npm test' });
  appendLines(sb.transcript, [
    humanLine('ajoute la sauvegarde auto'),
    humanLine([{ type: 'text', text: '<system-reminder>\nrappel\n</system-reminder>' }, { type: 'text', text: 'et la relecture' }]),
    humanLine('<command-message>conso-pilot:conso</command-message>\n<command-name>/conso-pilot:conso</command-name>'),
    humanLine('méta', { isMeta: true }),
    toolLine('Write', { file_path: `${sb.env.CLAUDE_PROJECT_DIR}/lib/a.js`, content: 'x' }),
    toolLine('Edit', { file_path: `${sb.env.CLAUDE_PROJECT_DIR}/lib/b.js` }),
    toolLine('Edit', { file_path: `${sb.env.CLAUDE_PROJECT_DIR}/lib/a.js` }),
    toolLine('TodoWrite', { todos: [{ content: 'écrire', status: 'completed' }, { content: 'tester', status: 'in_progress' }] }),
    toolLine('TaskCreate', { subject: 'documenter' }),
    toolLine('TaskUpdate', { taskId: '1', status: 'completed' }),
    bash,
    toolErrorLine(bash, 'Exit code 1\n\nfail: 2 tests\nligne 3\nligne 4'),
    ...assistantLines({ cache_read: 5000, output: 10 }),
  ]);
  runHook(sb.env, input(sb, 'Stop'));
  const act = readState(sb.env, SID).activity;
  assert.deepStrictEqual(act.prompts.map((p) => p.text), ['ajoute la sauvegarde auto', 'et la relecture', '/conso-pilot:conso']);
  assert.strictEqual(act.firstPrompt, 'ajoute la sauvegarde auto');
  assert.deepStrictEqual(act.files.map((f) => path.basename(f)), ['b.js', 'a.js']);
  assert.deepStrictEqual(act.todos.map((t) => [t.content, t.status]), [['écrire', 'completed'], ['tester', 'in_progress'], ['documenter', 'completed']]);
  assert.deepStrictEqual(act.errors, [{ cmd: 'npm test', lines: ['Exit code 1', 'fail: 2 tests', 'ligne 3'], ts: act.errors[0].ts }]);

  const text = fs.readFileSync(autoFile(sb), 'utf8');
  assert.match(text, /^---\ncreated: /);
  assert.match(text, /objectif: "ajoute la sauvegarde auto"/);
  assert.match(text, /- `lib\/a\.js`/);
  assert.match(text, /- \[~\] tester/);
  assert.match(text, /- `npm test`\n {2}```\n {2}Exit code 1/);
});

test('demandes : 10 dernières, 500 caractères au plus', () => {
  const sb = sandbox();
  const lines = [];
  for (let i = 1; i <= 12; i += 1) lines.push(humanLine(`demande ${i} ${'z'.repeat(i === 12 ? 900 : 0)}`));
  appendLines(sb.transcript, [...lines, ...assistantLines({ output: 1 })]);
  runHook(sb.env, input(sb, 'Stop'));
  const { prompts } = readState(sb.env, SID).activity;
  assert.strictEqual(prompts.length, 10);
  assert.match(prompts[0].text, /^demande 3/);
  assert.strictEqual(prompts[9].text.length, 501); // 500 + « … »
});

test('Stop : sauvegarde auto au plus toutes les autoSaveEveryMinutes', () => {
  const sb = sandbox();
  appendLines(sb.transcript, [humanLine('premier'), ...assistantLines({ output: 1 })]);
  runHook(sb.env, input(sb, 'Stop'));
  assert.doesNotMatch(fs.readFileSync(autoFile(sb), 'utf8'), /second/);
  appendLines(sb.transcript, [humanLine('second'), ...assistantLines({ output: 1 })]);
  runHook(sb.env, input(sb, 'Stop'));
  assert.doesNotMatch(fs.readFileSync(autoFile(sb), 'utf8'), /second/, 'pas de réécriture avant 5 min');
  assert.match(JSON.stringify(readState(sb.env, SID).activity.prompts), /second/, 'activité tout de même à jour');
  fs.writeFileSync(path.join(sb.env.CONSO_PILOT_HOME, 'config.json'), JSON.stringify({ autoSaveEveryMinutes: 0, delegationHint: false, modelAdvice: 'off', effortAdvice: false }));
  appendLines(sb.transcript, [humanLine('troisième'), ...assistantLines({ output: 1 })]);
  runHook(sb.env, input(sb, 'Stop'));
  assert.match(fs.readFileSync(autoFile(sb), 'utf8'), /second[\s\S]*troisième/);
});

test('PreCompact et SessionEnd : sauvegarde forcée, latest.md inchangé, SessionEnd < 500 ms (critère 11)', () => {
  const sb = sandbox();
  appendLines(sb.transcript, [humanLine('début'), ...assistantLines({ cache_creation: 1000, output: 1 })]);
  runHook(sb.env, input(sb, 'Stop'));
  saveHandoff(sb, HANDOFF);
  const latest = fs.readFileSync(path.join(handoffDir(sb), 'latest.md'), 'utf8');

  // Tour interrompu par un compactage automatique : demande et appels lus par PreCompact.
  appendLines(sb.transcript, [humanLine('avant compactage'), ...assistantLines({ input: 7, output: 3 })]);
  runHook(sb.env, input(sb, 'PreCompact', { trigger: 'auto' }));
  assert.match(fs.readFileSync(autoFile(sb), 'utf8'), /avant compactage/);
  assert.ok(readLog(sb.env).some((e) => e.type === 'turn' && e.input === 7), 'appels journalisés par PreCompact');

  appendLines(sb.transcript, [humanLine('juste avant clear'), ...assistantLines({ output: 1 })]);
  const r = runHook(sb.env, input(sb, 'SessionEnd', { reason: 'clear' }));
  assert.ok(r.ms < 500, `SessionEnd ${r.ms} ms`);
  assert.match(fs.readFileSync(autoFile(sb), 'utf8'), /juste avant clear/);
  assert.strictEqual(fs.readFileSync(path.join(handoffDir(sb), 'latest.md'), 'utf8'), latest);
  const outputs = readLog(sb.env).filter((e) => e.type === 'turn').reduce((a, t) => a + t.output, 0);
  assert.strictEqual(outputs, 1 + 3 + 1, 'aucun appel compté deux fois');
});

test('SessionEnd sans activité : aucune sauvegarde', () => {
  const sb = sandbox();
  runHook(sb.env, input(sb, 'SessionStart', { source: 'startup' }));
  runHook(sb.env, input(sb, 'SessionEnd', { reason: 'other' }));
  assert.ok(!fs.existsSync(autoFile(sb)));
});

test('/handoff : fichier daté + latest.md, état handoffDone, journal (critère 10)', () => {
  const sb = sandbox();
  appendLines(sb.transcript, [humanLine('x'), ...assistantLines({ cache_creation: 42000, output: 0 })]);
  runHook(sb.env, input(sb, 'Stop'));
  const r = saveHandoff(sb, HANDOFF);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.match(r.stdout, /Handoff enregistré .*\(Implémenter le lot 2 de conso-pilot\.\)/);
  assert.match(r.stdout, /Rechargé automatiquement après \/clear \(dans les 30 min\)/);
  const dated = fs.readdirSync(handoffDir(sb)).filter((f) => /^\d{4}-\d{2}-\d{2}_\d{4}_abcdef12\.md$/.test(f));
  assert.strictEqual(dated.length, 1);
  const latest = fs.readFileSync(path.join(handoffDir(sb), 'latest.md'), 'utf8');
  assert.strictEqual(latest, fs.readFileSync(path.join(handoffDir(sb), dated[0]), 'utf8'));
  assert.match(latest, /^---\ncreated: "[^"]+"\nsession: "abcdef12-3456-7890-abcd-ef1234567890"\nproject: "[^"]+"\nobjectif: "Implémenter le lot 2 de conso-pilot\."\ncontext_tokens: 42002\n---\n\n## Objectif/);
  assert.strictEqual(readState(sb.env, SID).handoffDone, true);
  assert.ok(readLog(sb.env).some((e) => e.type === 'handoff' && e.context === 42002));
});

test('/handoff --prepare : commande d\'enregistrement avec chemin absolu ; texte vide refusé', () => {
  const sb = sandbox();
  const prep = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'save-handoff'), '--prepare'], { env: { ...process.env, ...sb.env }, encoding: 'utf8' });
  assert.ok(prep.stdout.includes(`node ${path.join(ROOT, 'bin', 'save-handoff')} <<'EOF'`), prep.stdout);
  const r = saveHandoff(sb, '   \n');
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /non enregistré \(handoff vide\)/);
});

test('SessionStart clear : handoff < 30 min réinjecté, sinon proposition (critère 10)', () => {
  const sb = sandbox();
  saveHandoff(sb, HANDOFF);
  const r = runHook(sb.env, input(sb, 'SessionStart', { session_id: 'nouvelle', source: 'clear' }));
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /^Reprise de la session précédente \(handoff du .+\)\n\n## Objectif\nImplémenter le lot 2/);
  assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /^---/m, 'sans en-tête YAML');
  assert.match(out.systemMessage, /^Handoff du .+ rechargé \(~\d+ tokens\) : Implémenter le lot 2/);

  ageLatest(sb, 120);
  const late = JSON.parse(runHook(sb.env, input(sb, 'SessionStart', { session_id: 'autre', source: 'clear' })).stdout);
  assert.strictEqual(late.hookSpecificOutput, undefined);
  assert.match(late.systemMessage, /^Handoff du .+ disponible : Implémenter le lot 2 de conso-pilot\. — tape \/resume pour le charger\.$/);
});

test('SessionStart startup : injecté si < 2 h ; 5 h après → simple proposition (critère 9)', () => {
  const sb = sandbox();
  assert.strictEqual(runHook(sb.env, input(sb, 'SessionStart', { source: 'startup' })).stdout, '', 'aucun handoff : rien');
  saveHandoff(sb, HANDOFF);
  ageLatest(sb, 90);
  assert.ok(JSON.parse(runHook(sb.env, input(sb, 'SessionStart', { session_id: 's2', source: 'startup' })).stdout).hookSpecificOutput);
  ageLatest(sb, 300);
  const out = JSON.parse(runHook(sb.env, input(sb, 'SessionStart', { session_id: 's3', source: 'startup' })).stdout);
  assert.strictEqual(out.hookSpecificOutput, undefined);
  assert.match(out.systemMessage, /tape \/resume/);
});

test('SessionStart compact : rien si context-mode actif ; sinon handoff de la session courante seulement', () => {
  const sb = sandbox();
  saveHandoff(sb, HANDOFF);
  assert.ok(JSON.parse(runHook(sb.env, input(sb, 'SessionStart', { source: 'compact' })).stdout).hookSpecificOutput);
  assert.strictEqual(runHook(sb.env, input(sb, 'SessionStart', { session_id: 'autre', source: 'compact' })).stdout, '');
  fs.writeFileSync(path.join(sb.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ enabledPlugins: { 'context-mode@context-mode': true } }));
  assert.strictEqual(runHook(sb.env, input(sb, 'SessionStart', { source: 'compact' })).stdout, '');
});

test('SessionStart resume / fork : rien d\'injecté', () => {
  const sb = sandbox();
  saveHandoff(sb, HANDOFF);
  for (const source of ['resume', 'fork']) assert.strictEqual(runHook(sb.env, input(sb, 'SessionStart', { source })).stdout, '', source);
});

test('relecture plafonnée à resumeMaxTokens', () => {
  const sb = sandbox();
  saveHandoff(sb, `${HANDOFF}\n## Pièges rencontrés\n${'- piège très long à décrire\n'.repeat(1000)}`);
  const ctx = JSON.parse(runHook(sb.env, input(sb, 'SessionStart', { source: 'clear' })).stdout).hookSpecificOutput.additionalContext;
  assert.ok(ctx.length <= 2000 * 4 + 200, `${ctx.length} caractères`);
  assert.match(ctx, /tronqué à ~2000 tokens\)$/);
});

test('/resume : dernier handoff ; --auto : sauvegarde auto d\'une autre session', () => {
  const sb = sandbox();
  assert.match(reprendre(sb), /Aucun handoff pour ce projet/);
  appendLines(sb.transcript, [humanLine('travail de la session précédente'), ...assistantLines({ output: 1 })]);
  runHook(sb.env, input(sb, 'Stop'));
  saveHandoff(sb, HANDOFF);
  assert.match(reprendre(sb), /^Reprise de la session précédente \(handoff du .+\)\n\n## Objectif/);
  const auto = reprendre(sb, ['--auto'], { CLAUDE_CODE_SESSION_ID: 'nouvelle-session' });
  assert.match(auto, /^Reprise de la session précédente \(sauvegarde automatique du .+\)\n\n# Sauvegarde automatique — session abcdef12/);
  assert.match(auto, /travail de la session précédente/);
});

test('rétention : retentionMaxFiles par projet, latest.md conservé', () => {
  const sb = sandbox();
  useEnv(sb.env);
  const handoff = require('../lib/handoff');
  const cfg = { ...require('../lib/config').loadConfig(), retentionMaxFiles: 3 };
  for (let i = 0; i < 5; i += 1) {
    handoff.saveHandoff({ text: HANDOFF, sessionId: `s${i}xxxxxx`, project: sb.env.CLAUDE_PROJECT_DIR, cfg, now: new Date(2026, 9, 1, 10, i) });
    const t = new Date(Date.now() - (5 - i) * 60000); // âges distincts, tous dans retentionDays
    fs.utimesSync(path.join(handoffDir(sb), `2026-10-01_100${i}_s${i}xxxxxx.md`), t, t);
  }
  fs.rmSync(path.join(handoffDir(sb), '.retention')); // une fois par jour : on force un nouveau passage
  handoff.applyRetention(sb.env.CLAUDE_PROJECT_DIR, cfg);
  const files = fs.readdirSync(handoffDir(sb)).filter((f) => f.endsWith('.md')).sort();
  assert.deepStrictEqual(files, ['2026-10-01_1002_s2xxxxxx.md', '2026-10-01_1003_s3xxxxxx.md', '2026-10-01_1004_s4xxxxxx.md', 'latest.md']);
});

test('CONSO_PILOT_DISABLE : aucun hook (sessions du résumé IA)', () => {
  const sb = sandbox();
  appendLines(sb.transcript, [humanLine('x'), ...assistantLines({ output: 1 })]);
  const r = runHook({ ...sb.env, CONSO_PILOT_DISABLE: '1' }, input(sb, 'Stop'));
  assert.strictEqual(r.stdout, '');
  assert.ok(!fs.existsSync(path.join(sb.env.CONSO_PILOT_HOME, 'state')));
});

test('ancien état (lot 1) sans activité : complété sans erreur', () => {
  const sb = sandbox();
  appendLines(sb.transcript, [userLine('a'), ...assistantLines({ output: 1 })]);
  runHook(sb.env, input(sb, 'Stop'));
  const file = path.join(sb.env.CONSO_PILOT_HOME, 'state', `${SID}.json`);
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete st.activity;
  delete st.autoSave;
  fs.writeFileSync(file, JSON.stringify(st));
  appendLines(sb.transcript, [humanLine('reprise'), ...assistantLines({ output: 1 })]);
  runHook(sb.env, input(sb, 'Stop'));
  assert.deepStrictEqual(readState(sb.env, SID).activity.prompts.map((p) => p.text), ['reprise']);
  assert.ok(!fs.existsSync(path.join(sb.env.CONSO_PILOT_HOME, 'errors.log')));
});
