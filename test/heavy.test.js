'use strict';
// Lot 4 : dossiers lourds (§7, critère 12) et gains (§8.3, critère 16).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, sandbox, useEnv, runHook, assistantLines, userLine, appendLines, readLog } = require('./helpers');
const { DEFAULTS } = require('../lib/config');
const heavy = require('../lib/heavy');

const SID = 'sess-lourd';

function pre(sb, tool, toolInput) {
  const r = runHook(sb.env, { session_id: SID, cwd: sb.env.CLAUDE_PROJECT_DIR, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

function denied(out) {
  return Boolean(out && out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision === 'deny');
}

test('critère 12 : Read complet d\'un log de DerivedData refusé ; Grep « error » autorisé avec message', () => {
  const sb = sandbox();
  const dir = path.join(sb.env.CLAUDE_PROJECT_DIR, 'DerivedData', 'Logs');
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'gros.log');
  fs.writeFileSync(log, 'x'.repeat(200000));

  const out = pre(sb, 'Read', { file_path: log });
  assert.ok(denied(out));
  assert.strictEqual(out.hookSpecificOutput.permissionDecisionReason, heavy.DENY_REASON);
  assert.strictEqual(out.systemMessage, undefined);
  const deny = readLog(sb.env).find((e) => e.type === 'deny');
  assert.strictEqual(deny.tool, 'Read');
  assert.strictEqual(deny.size, 200000);
  assert.strictEqual(deny.bytes, 100000, 'plafonné à la sortie maximale de Read');

  const grep = pre(sb, 'Grep', { pattern: 'error', path: dir });
  assert.ok(!denied(grep));
  assert.strictEqual(grep.systemMessage, `⚠️ Lecture ciblée dans un dossier normalement bloqué : ${dir}`);
  assert.strictEqual(grep.hookSpecificOutput, undefined, 'jamais « allow » : les permissions natives s\'appliquent');

  assert.ok(pre(sb, 'Read', { file_path: log, offset: 1000, limit: 200 }).systemMessage, 'lecture ciblée');
  assert.ok(denied(pre(sb, 'Read', { file_path: log, limit: 2000 })), 'limit > 300');
  assert.ok(denied(pre(sb, 'Grep', { pattern: '.*', path: dir })), 'motif vague');
});

test('Read : fichier > 1 Mo hors dossier lourd refusé, image non ; fichier normal ignoré', () => {
  const sb = sandbox();
  const big = path.join(sb.env.CLAUDE_PROJECT_DIR, 'data.json');
  fs.writeFileSync(big, 'x'.repeat(DEFAULTS.heavyFileBytes + 1));
  const img = path.join(sb.env.CLAUDE_PROJECT_DIR, 'capture.png');
  fs.writeFileSync(img, 'x'.repeat(DEFAULTS.heavyFileBytes + 1));
  const small = path.join(sb.env.CLAUDE_PROJECT_DIR, 'src.js');
  fs.writeFileSync(small, 'ok');
  assert.ok(denied(pre(sb, 'Read', { file_path: big })));
  assert.strictEqual(pre(sb, 'Read', { file_path: img }), null);
  assert.strictEqual(pre(sb, 'Read', { file_path: small }), null);
  assert.ok(pre(sb, 'Read', { file_path: path.join(sb.env.CLAUDE_PROJECT_DIR, 'package-lock.json'), limit: 50 }).systemMessage);
});

test('Bash : commandes larges refusées, ciblées signalées, autres ignorées', () => {
  const cfg = DEFAULTS;
  const kind = (cmd) => (heavy.checkBash(cmd, '/tmp', cfg) || { kind: null }).kind;
  for (const cmd of ['cat node_modules/a/index.js', 'less build/out.log', 'ls -R Pods', 'ls -la -R node_modules', 'find DerivedData -name "*.log"',
    'tree dist', 'grep -r . node_modules', 'head -n 1000 build/a.log', 'tail -n +1 DerivedData/x.log', 'rtk read yarn.lock',
    'cd app && cat Package.resolved', 'FOO=1 cat .build/debug.yaml']) {
    assert.strictEqual(kind(cmd), 'deny', cmd);
  }
  for (const cmd of ['tail -n 100 DerivedData/x.log', 'tail DerivedData/x.log', 'head -50 build/a.log', 'grep -rn "fatal error" DerivedData/', 'rg -e Undefined node_modules/x']) {
    assert.strictEqual(kind(cmd), 'warn', cmd);
  }
  for (const cmd of ['ls node_modules', 'find . -name x', 'npm test', 'git status 2>&1 | tail -5', 'xcodebuild -derivedDataPath DerivedData build',
    "node save-handoff <<'EOF'\ncat node_modules/x\nEOF", 'echo "cat node_modules" > notes.txt', 'cat src/build.js']) {
    assert.strictEqual(kind(cmd), null, cmd);
  }
});

test('Glob : ** dans un dossier lourd refusé ; motif précis signalé ; config vide → rien', () => {
  const sb = sandbox();
  assert.ok(denied(pre(sb, 'Glob', { pattern: 'node_modules/**/*.js' })));
  assert.ok(pre(sb, 'Glob', { pattern: 'node_modules/react/package.json' }).systemMessage);
  assert.strictEqual(pre(sb, 'Glob', { pattern: 'src/**/*.ts' }), null);
  assert.strictEqual(heavy.check({ tool_name: 'Bash', tool_input: { command: 'cat node_modules/x' } }, { ...DEFAULTS, heavyPaths: [], heavyFileBytes: 0 }), null);
});

test('gains : lectures bloquées et handoffs (formules §8.3)', () => {
  const sb = sandbox();
  useEnv(sb.env);
  const { computeGains } = require('../lib/gains');
  const cfg = require('../lib/config').loadConfig();
  const t = (min) => new Date(Date.UTC(2026, 9, 6, 10, min)).toISOString();
  const turn = (session, min, context, model = 'claude-opus-5-5') => ({ type: 'turn', ts: t(min), project: '/p', session, agent: 'main', model, input: 0, cache_5m: 0, cache_1h: 0, cache_read: context, output: 0, context });
  const entries = [
    turn('A', 0, 20000), { type: 'deny', ts: t(1), project: '/p', session: 'A', bytes: 40000, model: 'claude-opus-5-5', ttl: 60 },
    turn('A', 2, 60000), turn('A', 3, 80000), turn('A', 4, 90000), turn('A', 5, 100000),
    { type: 'handoff', ts: t(6), project: '/p', session: 'A', context: 100000 },
    turn('B', 10, 20000), turn('B', 11, 25000), turn('B', 12, 30000),
    turn('C', 200, 20000), // ouverte plus de 2 h après : ne compte pas
  ];
  const g = computeGains(entries, new Date(t(0)), cfg);
  // 40 000 octets → 10 000 tokens × (2 + 0,1 × 4 tours restants) × 2 (Opus) = 48 000.
  assert.strictEqual(g.blocked.count, 1);
  assert.strictEqual(Math.round(g.blocked.weighted), 48000);
  // (100k − 20k) × (3 tours × 0,1 + 2) × 2 = 368 000.
  assert.strictEqual(g.handoffs.count, 1);
  assert.strictEqual(Math.round(g.handoffs.weighted), 368000);
  assert.strictEqual(g.rtk, null, 'rtk absent');
  assert.strictEqual(Math.round(g.total), 416000);
});

test('critère 16 : /conso affiche les gains rtk (mis en cache) et context-mode à part ; barre d\'état « éco »', () => {
  const sb = sandbox();
  const fake = path.join(sb.dir, 'rtk');
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> ${path.join(sb.dir, 'rtk-calls')}\necho '{"summary":{"total_saved":99999},"daily":[{"date":"2020-01-01","saved_tokens":5000},{"date":"${today}","saved_tokens":10000}]}'\n`);
  fs.chmodSync(fake, 0o755);
  const cmDir = path.join(sb.env.CLAUDE_CONFIG_DIR, 'context-mode', 'sessions');
  fs.mkdirSync(cmDir, { recursive: true });
  fs.writeFileSync(path.join(cmDir, 'stats-pid-1.json'), JSON.stringify({ updated_at: Date.now(), tokens_saved: 1600000 }));
  fs.writeFileSync(path.join(cmDir, 'stats-pid-2.json'), JSON.stringify({ updated_at: Date.now() - 30 * 86400000, tokens_saved: 9 }));
  const env = { ...sb.env, CONSO_PILOT_RTK_BIN: fake };
  appendLines(sb.transcript, [userLine('x'), ...assistantLines({ input: 1000, output: 0 }, { model: 'claude-sonnet-5-5' })]);
  runHook(env, { session_id: SID, transcript_path: sb.transcript, cwd: sb.env.CLAUDE_PROJECT_DIR, hook_event_name: 'Stop' });

  const conso = () => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'conso')], { env: { ...process.env, ...env }, encoding: 'utf8' }).stdout;
  const out = conso();
  // rtk : 10 000 tokens (7 jours) × 2 (écriture cache 1 h) × 1 (Sonnet) = 20 000.
  assert.match(out, /\| rtk \(sorties de commandes compactées\) \| 10k \| 20k \|/);
  assert.match(out, /\| \*\*Total\*\* \|  \| \*\*20k\*\* \|/);
  assert.match(out, /context-mode déclare ~1\.6M tokens gardés hors du contexte \(1 session\(s\)\) : non ajouté au total/);
  conso();
  assert.strictEqual(fs.readFileSync(path.join(sb.dir, 'rtk-calls'), 'utf8').trim().split('\n').length, 1, 'rtk gain mis en cache 5 min');

  const bar = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'statusline')], {
    input: JSON.stringify({ session_id: SID, model: { display_name: 'Sonnet' } }), env: { ...process.env, ...env }, encoding: 'utf8',
  }).stdout;
  assert.strictEqual(bar, 'Sonnet · éco ~20k');
});
