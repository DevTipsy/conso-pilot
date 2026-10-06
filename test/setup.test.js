'use strict';
// Lot 3 : barre d'état (§4), /conso-pilot:setup et /conso-pilot:uninstall (§10, critère 18).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, sandbox, runHook, assistantLines, userLine, appendLines, readState } = require('./helpers');

const SID = 'sess-barre';
const EDIT = path.join(ROOT, 'bin', 'settings-edit');

function run(sb, file, args = [], stdin = '', extraEnv = {}) {
  return spawnSync(process.execPath, [file, ...args], { input: stdin, env: { ...process.env, ...sb.env, ...extraEnv }, encoding: 'utf8' });
}

function settingsFile(sb) {
  return path.join(sb.env.CLAUDE_CONFIG_DIR, 'settings.json');
}

function statusInput(sb, extra = {}) {
  return {
    session_id: SID,
    transcript_path: sb.transcript,
    model: { id: 'claude-sonnet-5-5', display_name: 'Sonnet' },
    effort: { level: 'medium' },
    fast_mode: false,
    context_window: {
      context_window_size: 200000,
      current_usage: { input_tokens: 2, cache_creation_input_tokens: 2000, cache_read_input_tokens: 72000, output_tokens: 0 },
    },
    rate_limits: { five_hour: { used_percentage: 42.4, resets_at: 0 }, seven_day: { used_percentage: 18, resets_at: 0 } },
    ...extra,
  };
}

function baseline(sb, ctx) {
  appendLines(sb.transcript, [userLine('x'), ...assistantLines({ cache_creation: ctx - 2, output: 0 })]);
  runHook(sb.env, { session_id: SID, transcript_path: sb.transcript, cwd: sb.env.CLAUDE_PROJECT_DIR, hook_event_name: 'Stop', background_tasks: [] });
}

test('barre d\'état : segments, contexte ajouté, minuteur du cache, troncature', () => {
  const sb = sandbox();
  baseline(sb, 22002);
  const r = run(sb, path.join(ROOT, 'bin', 'statusline'), [], JSON.stringify(statusInput(sb)));
  assert.strictEqual(r.stdout, 'Sonnet·medium · ctx 74k (+52k) · 5h 42% · 7j 18%');

  // Minuteur affiché dans les 10 dernières minutes.
  const file = path.join(sb.env.CONSO_PILOT_HOME, 'state', `${SID}.json`);
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  st.lastResponseAt = new Date(Date.now() - 57 * 60000).toISOString();
  fs.writeFileSync(file, JSON.stringify(st));
  assert.match(run(sb, path.join(ROOT, 'bin', 'statusline'), [], JSON.stringify(statusInput(sb))).stdout, / · cache 2:5\d$|cache 3:00$/);

  const narrow = run(sb, path.join(ROOT, 'bin', 'statusline'), [], JSON.stringify(statusInput(sb)), { COLUMNS: '30' });
  assert.strictEqual(narrow.stdout, 'Sonnet·medium · ctx 74k (+52k)');

  const empty = run(sb, path.join(ROOT, 'bin', 'statusline'), [], JSON.stringify({ session_id: 'inconnue', model: { display_name: 'Opus' } }));
  assert.strictEqual(empty.stdout, 'Opus');
});

test('barre d\'état : rouge seulement quand une alerte est active', () => {
  const sb = sandbox();
  baseline(sb, 20002);
  const input = statusInput(sb, { context_window: { current_usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 130000, output_tokens: 0 } } });
  const red = run(sb, path.join(ROOT, 'bin', 'statusline'), [], JSON.stringify(input)).stdout;
  assert.ok(red.startsWith('\x1b[31m') && red.endsWith('\x1b[0m'), JSON.stringify(red));
  assert.ok(!run(sb, path.join(ROOT, 'bin', 'statusline'), [], JSON.stringify(statusInput(sb))).stdout.includes('\x1b['));

  const file = path.join(sb.env.CONSO_PILOT_HOME, 'state', `${SID}.json`);
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  st.lastResponseAt = new Date(Date.now() - 2 * 3600000).toISOString();
  fs.writeFileSync(file, JSON.stringify(st));
  const expired = run(sb, path.join(ROOT, 'bin', 'statusline'), [], JSON.stringify(statusInput(sb))).stdout;
  assert.match(expired, /^\x1b\[31m.* · cache expiré\x1b\[0m$/);
});

test('barre d\'état : relevé lu par les hooks (modèle, effort, mode rapide)', () => {
  const sb = sandbox();
  baseline(sb, 20002);
  run(sb, path.join(ROOT, 'bin', 'statusline'), [], JSON.stringify(statusInput(sb, { effort: { level: 'low' }, fast_mode: true })));
  const live = JSON.parse(fs.readFileSync(path.join(sb.env.CONSO_PILOT_HOME, 'state', 'live', `${SID}.json`), 'utf8'));
  assert.strictEqual(live.effort, 'low');
  runHook(sb.env, { session_id: SID, hook_event_name: 'UserPromptSubmit', prompt: 'x', cwd: sb.env.CLAUDE_PROJECT_DIR });
  // UserPromptSubmit sans alerte n'écrit rien : on vérifie via /conso-pilot:status.
  const status = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'status'), SID], { env: { ...process.env, ...sb.env }, encoding: 'utf8' }).stdout;
  assert.match(status, /effort : low \(barre d'état\) · mode rapide : oui/);
  assert.strictEqual(readState(sb.env, SID).baseline, 20002, 'état des hooks intact');
});

test('setup : aperçu sans écriture, puis application enchaînée ; uninstall restaure à l\'identique (critère 18)', () => {
  const sb = sandbox();
  const original = '{\n    "permissions": {\n        "allow": ["Bash(ls:*)"]\n    },\n    "statusLine": { "type": "command", "command": "echo AVANT", "padding": 1 }\n}\n';
  fs.writeFileSync(settingsFile(sb), original);

  const preview = run(sb, EDIT, ['setup']);
  assert.strictEqual(preview.status, 0, preview.stdout);
  assert.match(preview.stdout, /aperçu, rien n'est écrit/);
  assert.match(preview.stdout, /```diff[\s\S]*\+ .*"command": "node .*conso-pilot-test-.*\/data\/bin\/statusline"/);
  assert.match(preview.stdout, /setup --apply --chain/);
  assert.match(preview.stdout, /setup --apply --replace/);
  assert.strictEqual(fs.readFileSync(settingsFile(sb), 'utf8'), original, 'aperçu : rien d\'écrit');

  const applied = run(sb, EDIT, ['setup', '--apply', '--chain']);
  assert.match(applied.stdout, /mis à jour/);
  const afterRaw = fs.readFileSync(settingsFile(sb), 'utf8');
  const after = JSON.parse(afterRaw);
  const shim = path.join(sb.env.CONSO_PILOT_HOME, 'bin', 'statusline');
  assert.deepStrictEqual(after.statusLine, { type: 'command', command: `node ${shim}`, padding: 1 });
  assert.deepStrictEqual(after.permissions.allow, ['Bash(ls:*)', `Bash(node ${path.join(sb.env.CONSO_PILOT_HOME, 'bin', 'save-handoff')}:*)`]);
  assert.match(fs.readFileSync(settingsFile(sb), 'utf8'), /^\{\n {4}"permissions"/, 'indentation conservée');
  const backups = fs.readdirSync(path.join(sb.env.CONSO_PILOT_HOME, 'backups'));
  assert.strictEqual(fs.readFileSync(path.join(sb.env.CONSO_PILOT_HOME, 'backups', backups[0]), 'utf8'), original);
  assert.ok(fs.existsSync(path.join(sb.env.CONSO_PILOT_HOME, 'config.json')));

  // Lanceur stable + enchaînement : l'ancienne barre en préfixe.
  const bar = run(sb, shim, [], JSON.stringify(statusInput(sb)));
  assert.strictEqual(bar.stdout, 'AVANT · Sonnet·medium · ctx 74k · 5h 42% · 7j 18%');
  // Commande d'enregistrement du handoff : lanceur stable (couvert par la permission).
  assert.match(run(sb, path.join(ROOT, 'bin', 'save-handoff'), ['--prepare']).stdout, new RegExp(`node ${path.join(sb.env.CONSO_PILOT_HOME, 'bin', 'save-handoff')} <<'EOF'`));

  assert.match(run(sb, EDIT, ['setup']).stdout, /Rien à modifier/, 'setup idempotent');

  const un = run(sb, EDIT, ['uninstall']);
  assert.match(un.stdout, /restauration à l'identique/);
  assert.strictEqual(fs.readFileSync(settingsFile(sb), 'utf8'), afterRaw, 'aperçu : rien d\'écrit');
  run(sb, EDIT, ['uninstall', '--apply']);
  assert.strictEqual(fs.readFileSync(settingsFile(sb), 'utf8'), original, 'octet pour octet');
  assert.ok(!fs.existsSync(shim));
  assert.ok(fs.existsSync(path.join(sb.env.CONSO_PILOT_HOME, 'config.json')), 'données gardées');
  assert.match(run(sb, EDIT, ['uninstall']).stdout, /rien à retirer/);
});

test('setup sans settings.json : créé puis supprimé par uninstall ; modifié entre-temps : retrait ciblé', () => {
  const sb = sandbox();
  run(sb, EDIT, ['setup', '--apply']);
  assert.ok(JSON.parse(fs.readFileSync(settingsFile(sb), 'utf8')).statusLine);
  run(sb, EDIT, ['uninstall', '--apply']);
  assert.ok(!fs.existsSync(settingsFile(sb)));

  const sb2 = sandbox();
  fs.writeFileSync(settingsFile(sb2), '{\n  "model": "sonnet"\n}\n');
  run(sb2, EDIT, ['setup', '--apply', '--replace']);
  const s = JSON.parse(fs.readFileSync(settingsFile(sb2), 'utf8'));
  s.effortLevel = 'low'; // modification de l'utilisateur après le setup
  s.permissions.allow.push('Bash(git:*)');
  fs.writeFileSync(settingsFile(sb2), JSON.stringify(s, null, 2));
  const un = run(sb2, EDIT, ['uninstall', '--apply']);
  assert.match(un.stdout, /nettoyé/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsFile(sb2), 'utf8')), { model: 'sonnet', effortLevel: 'low', permissions: { allow: ['Bash(git:*)'] } });
});

test('setup --keep : ancienne barre conservée, permission seule ; JSON invalide : rien modifié', () => {
  const sb = sandbox();
  fs.writeFileSync(settingsFile(sb), '{"statusLine":{"type":"command","command":"echo A"}}');
  run(sb, EDIT, ['setup', '--apply', '--keep']);
  const s = JSON.parse(fs.readFileSync(settingsFile(sb), 'utf8'));
  assert.strictEqual(s.statusLine.command, 'echo A');
  assert.strictEqual(s.permissions.allow.length, 1);

  const bad = sandbox();
  fs.writeFileSync(settingsFile(bad), '{ invalide');
  const r = run(bad, EDIT, ['setup', '--apply']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /n'est pas un JSON valide/);
  assert.strictEqual(fs.readFileSync(settingsFile(bad), 'utf8'), '{ invalide');
});
