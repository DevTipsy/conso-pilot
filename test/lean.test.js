'use strict';
// Lot 5 : contexte chargé et /lean (§6).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, sandbox, useEnv, runHook, assistantLines, userLine, appendLines } = require('./helpers');

const LEAN = path.join(ROOT, 'bin', 'lean');
const SID = 'sess-lean';

function attachment(a) {
  return JSON.stringify({ parentUuid: null, isSidechain: false, attachment: a, type: 'attachment', uuid: `att-${Math.random()}`, timestamp: new Date().toISOString(), sessionId: SID });
}

function skillListing(entries) {
  return {
    type: 'skill_listing',
    content: entries.map(([n, d]) => (d ? `- ${n}: ${d}` : `- ${n}`)).join('\n'),
    skillCount: entries.length,
    isInitial: true,
    names: entries.map(([n]) => n),
  };
}

// Inventaire type : un plugin Claude Code (skills + serveur MCP), un plugin de l'app, un connecteur claude.ai,
// un serveur de .mcp.json, un serveur utilisateur, des outils intégrés.
function inventoryLines({ big = 0 } = {}) {
  const desc = 'x'.repeat(396);
  return [
    attachment(skillListing([
      ['outils:analyse', desc],
      ['outils:rapport', `${desc}\n\nsuite de la description sur plusieurs lignes\n- pas une entrée`],
      ['appli:courrier', desc],
      ['init', desc],
    ])),
    attachment({
      type: 'deferred_tools_delta',
      addedNames: ['CronCreate', 'mcp__plugin_outils_srv__lire', 'mcp__plugin_outils_srv__ecrire', 'mcp__1a59c906-04da-521d-bda7-7f71b9f9e01c__batch', 'mcp__projet-db__query', 'mcp__perso__ping'],
      addedLines: [],
      removedNames: [],
      needsAuthMcpServers: ['plugin:appli:gmail'],
      failedMcpServers: [],
    }),
    attachment({
      type: 'prompt_snapshot',
      systemPrompt: ['…'],
      tools: [
        { name: 'Bash', description: 'b'.repeat(4000), schema: {} },
        { name: 'mcp__ccd_session__mark_chapter', description: 'c'.repeat(400), schema: {} },
        { name: 'mcp__perso__gros', description: 'p'.repeat(40000 + big), schema: {} },
      ],
    }),
    attachment({ type: 'mcp_instructions_delta', addedNames: ['plugin:outils:srv'], addedBlocks: ['i'.repeat(800)] }),
    attachment({ type: 'agent_listing_delta', addedTypes: ['Explore', 'outils:revue'], addedLines: ['- Explore: …', `- outils:revue: ${'a'.repeat(200)}`], builtInTypes: ['Explore'], isInitial: true }),
  ];
}

function setupSources(sb) {
  const claude = sb.env.CLAUDE_CONFIG_DIR;
  const install = path.join(claude, 'plugins', 'cache', 'mk', 'outils-dir', '1.0.0');
  fs.mkdirSync(path.join(install, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(install, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'outils' }));
  fs.writeFileSync(path.join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'outils-dir@mk': [{ scope: 'user', installPath: install, version: '1.0.0' }] },
  }));
  fs.writeFileSync(path.join(claude, 'settings.json'), `${JSON.stringify({ enabledPlugins: { 'outils-dir@mk': true } }, null, 2)}\n`);
  fs.writeFileSync(path.join(claude, '.claude.json'), JSON.stringify({ mcpServers: { perso: { command: 'x' } }, projects: {} }));
  fs.writeFileSync(path.join(sb.env.CLAUDE_PROJECT_DIR, '.mcp.json'), JSON.stringify({ mcpServers: { 'projet-db': { command: 'y' } } }));
}

function run(sb, args = []) {
  return spawnSync(process.execPath, [LEAN, ...args], { cwd: sb.env.CLAUDE_PROJECT_DIR, env: { ...process.env, ...sb.env }, encoding: 'utf8' });
}

function stop(sb) {
  return runHook(sb.env, { session_id: SID, transcript_path: sb.transcript, cwd: sb.env.CLAUDE_PROJECT_DIR, hook_event_name: 'Stop', background_tasks: [] });
}

test('inventaire : découpage des skills et regroupement par élément désactivable', () => {
  const sb = sandbox();
  useEnv(sb.env);
  setupSources(sb);
  const inventory = require('../lib/inventory');
  const lean = require('../lib/lean');
  const { loadConfig } = require('../lib/config');
  const inv = inventory.newInventory(SID);
  for (const l of inventoryLines()) inventory.apply(inv, inventory.reduce(JSON.parse(l).attachment));

  assert.deepStrictEqual(Object.keys(inv.skills), ['outils:analyse', 'outils:rapport', 'appli:courrier', 'init']);
  assert.ok(inv.skills['outils:rapport'] > inv.skills['outils:analyse'], 'description multiligne rattachée à sa skill');

  const w = lean.weigh(inv, lean.sources(sb.env.CLAUDE_PROJECT_DIR), loadConfig());
  const byId = Object.fromEntries(w.rows.map((r) => [r.id, r]));
  assert.strictEqual(byId['plugin:outils'].kind, 'plugin');
  assert.strictEqual(byId['plugin:outils'].skills, 2);
  assert.strictEqual(byId['plugin:outils'].agents, 1);
  assert.strictEqual(byId['plugin:outils'].tools, 2);
  assert.strictEqual(byId['plugin:outils'].instructions, true);
  assert.deepStrictEqual(byId['plugin:outils'].servers, ['srv']);
  assert.strictEqual(byId['plugin:appli'].kind, 'plugin-app');
  assert.strictEqual(byId['mcp:1a59c906-04da-521d-bda7-7f71b9f9e01c'].kind, 'connecteur');
  assert.strictEqual(byId['mcp:projet-db'].kind, 'mcp-projet');
  assert.strictEqual(byId['mcp:perso'].kind, 'mcp-user');
  assert.strictEqual(byId['mcp:perso'].tools, 2);
  assert.strictEqual(byId['mcp:perso'].deferred, 1);
  assert.strictEqual(w.rows[0].id, 'mcp:perso', 'trié par poids');
  // Intégrés : skill sans préfixe, outils non MCP, outils de l'app (ccd_), agents natifs.
  assert.strictEqual(w.builtin.skills, 1);
  assert.strictEqual(w.builtin.tools, 3);
  assert.ok(!w.rows.some((r) => r.id.includes('ccd_')));
  assert.strictEqual(w.total, w.rows.reduce((s, r) => s + r.tokens, 0));
});

test('Stop : inventaire relevé dès la première réponse, alerte une fois par jour et par projet', () => {
  const sb = sandbox();
  setupSources(sb);
  // Discussion neuve : SessionStart part du début du transcript (les attachments précèdent la 1re réponse).
  runHook(sb.env, { session_id: SID, transcript_path: sb.transcript, cwd: sb.env.CLAUDE_PROJECT_DIR, hook_event_name: 'SessionStart', source: 'startup' });
  // Instantané plus gros que la fenêtre de 256 Ko lue sans état.
  appendLines(sb.transcript, [...inventoryLines({ big: 300 * 1024 }), userLine('bonjour'), ...assistantLines({ cache_creation: 30000 })]);
  const r = stop(sb);
  assert.strictEqual(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.match(out.systemMessage, /^~\d+k tokens d'outils\/skills chargés — \/lean pour alléger$/);
  assert.ok(r.ms < 1000);
  const inv = JSON.parse(fs.readFileSync(path.join(sb.env.CONSO_PILOT_HOME, 'cache', 'inventory', `${sb.env.CLAUDE_PROJECT_DIR.replace(/[/.]/g, '-')}.json`), 'utf8'));
  assert.strictEqual(inv.session, SID);
  assert.ok(inv.tools.mcp__perso__gros.chars > 300 * 1024);

  // Nouvel inventaire le même jour : pas de seconde alerte.
  appendLines(sb.transcript, [attachment({ type: 'deferred_tools_delta', addedNames: ['mcp__perso__autre'], removedNames: ['mcp__perso__ping'] }), userLine('suite'), ...assistantLines({ cache_read: 30000 })]);
  assert.strictEqual(stop(sb).stdout, '');
  const inv2 = JSON.parse(fs.readFileSync(path.join(sb.env.CONSO_PILOT_HOME, 'cache', 'inventory', `${sb.env.CLAUDE_PROJECT_DIR.replace(/[/.]/g, '-')}.json`), 'utf8'));
  assert.ok(inv2.tools.mcp__perso__autre && !inv2.tools.mcp__perso__ping, 'deltas appliqués');
});

test('Stop : pas d\'alerte sous le seuil', () => {
  const sb = sandbox();
  runHook(sb.env, { session_id: SID, transcript_path: sb.transcript, cwd: sb.env.CLAUDE_PROJECT_DIR, hook_event_name: 'SessionStart', source: 'startup' });
  appendLines(sb.transcript, [attachment(skillListing([['petit:outil', 'court']])), userLine('x'), ...assistantLines({ cache_creation: 30000 })]);
  assert.strictEqual(stop(sb).stdout, '');
});

test('/lean : rapport trié, dernier usage lu dans les transcripts du projet', () => {
  const sb = sandbox();
  setupSources(sb);
  const dir = path.join(sb.env.CLAUDE_CONFIG_DIR, 'projects', sb.env.CLAUDE_PROJECT_DIR.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(path.join(dir, 'sess', 'subagents'), { recursive: true });
  const t = path.join(dir, `${SID}.jsonl`);
  appendLines(t, [...inventoryLines(), userLine('<command-name>/appli:courrier</command-name><command-args></command-args>'),
    ...assistantLines({ cache_read: 100 }, { tools: [{ name: 'Skill', id: 't1', input: { skill: 'outils:analyse' } }] })]);
  // Usage par un sous-agent : compté aussi.
  appendLines(path.join(dir, 'sess', 'subagents', 'agent-1.jsonl'), assistantLines({ cache_read: 100 }, { sidechain: true, tools: [{ name: 'mcp__projet-db__query', id: 't2', input: {} }] }));

  const r = run(sb);
  assert.strictEqual(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  const row = (name) => lines.find((l) => l.startsWith(`| ${name} |`));
  assert.match(lines.find((l) => l.startsWith('| perso')), /MCP utilisateur/);
  assert.match(row('outils'), /\| plugin \| \d+ \| 2 skills · 1 agent · 2 outils différés · instructions \|/);
  assert.match(row('outils'), /à l'instant/);
  assert.match(row('appli'), /plugin de l'app.*à l'instant/);
  assert.match(row('projet-db'), /MCP projet \(\.mcp\.json\).*à l'instant/);
  assert.match(row('perso'), /jamais/);
  assert.match(r.stdout, /### Jamais utilisés dans ce projet/);
  assert.match(r.stdout, /- perso \(~\d+k\) — `\/mcp` en CLI/);
  assert.match(r.stdout, /Serveurs en attente d'authentification : 1/);
  assert.match(r.stdout, /invalider le cache/);
  assert.ok(r.stdout.indexOf('| perso') < r.stdout.indexOf('| outils'), 'trié par poids');

  // Deuxième lancement : lecture incrémentale (offsets mis en cache), même résultat.
  const usage = JSON.parse(fs.readFileSync(path.join(sb.env.CONSO_PILOT_HOME, 'cache', 'usage', `${sb.env.CLAUDE_PROJECT_DIR.replace(/[/.]/g, '-')}.json`), 'utf8'));
  assert.strictEqual(usage.files[`${SID}.jsonl`], fs.statSync(t).size);
  assert.ok(usage.last['skill:outils:analyse'] && usage.last['plugin:appli'] && usage.last['mcp:projet-db']);
  assert.strictEqual(run(sb).stdout, r.stdout);
});

test('/lean sans inventaire : message d\'attente', () => {
  const sb = sandbox();
  const r = run(sb);
  assert.match(r.stdout, /Inventaire pas encore relevé/);
});

test('/lean off|on : aperçu sans écriture, application avec sauvegarde, réactivation', () => {
  const sb = sandbox();
  setupSources(sb);
  const local = path.join(sb.env.CLAUDE_PROJECT_DIR, '.claude', 'settings.local.json');

  const preview = run(sb, ['off', 'outils']);
  assert.match(preview.stdout, /désactiver plugin `outils-dir@mk` \(aperçu/);
  assert.match(preview.stdout, /"outils-dir@mk": false/);
  assert.match(preview.stdout, /Commande d'application : `node ".*bin\/lean" off outils --apply`/);
  assert.ok(!fs.existsSync(local), 'aperçu : aucune écriture');

  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, '{\n    "model": "sonnet"\n}\n');
  const applied = run(sb, ['off', 'outils', '--apply']);
  assert.match(applied.stdout, /✅ outils désactivé/);
  assert.strictEqual(fs.readFileSync(local, 'utf8'), '{\n    "model": "sonnet",\n    "enabledPlugins": {\n        "outils-dir@mk": false\n    }\n}\n');
  const backups = fs.readdirSync(path.join(sb.env.CONSO_PILOT_HOME, 'backups'));
  assert.strictEqual(backups.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(sb.env.CONSO_PILOT_HOME, 'backups', backups[0]), 'utf8'), '{\n    "model": "sonnet"\n}\n');

  // Rapport : section des éléments désactivés, avec la commande de réactivation.
  const t = path.join(sb.env.CLAUDE_CONFIG_DIR, 'projects', sb.env.CLAUDE_PROJECT_DIR.replace(/[^A-Za-z0-9]/g, '-'), `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(t), { recursive: true });
  appendLines(t, inventoryLines());
  assert.match(run(sb).stdout, /- outils \(local, à l'instant\) — réactiver : `\/lean on outils`/);

  run(sb, ['on', 'outils', '--apply']);
  assert.strictEqual(fs.readFileSync(local, 'utf8'), '{\n    "model": "sonnet"\n}\n');

  // Désactivé au niveau utilisateur : la réactivation locale écrit « true ».
  const user = path.join(sb.env.CLAUDE_CONFIG_DIR, 'settings.json');
  fs.writeFileSync(user, JSON.stringify({ enabledPlugins: { 'outils-dir@mk': false } }));
  run(sb, ['on', 'outils', '--apply']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(local, 'utf8')).enabledPlugins, { 'outils-dir@mk': true });

  // Serveur de .mcp.json → disabledMcpjsonServers ; portée « projet » → fichier partagé.
  run(sb, ['off', 'projet-db', '--scope', 'projet', '--apply']);
  const shared = JSON.parse(fs.readFileSync(path.join(sb.env.CLAUDE_PROJECT_DIR, '.claude', 'settings.json'), 'utf8'));
  assert.deepStrictEqual(shared.disabledMcpjsonServers, ['projet-db']);
  run(sb, ['on', 'projet-db', '--scope', 'projet', '--apply']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(sb.env.CLAUDE_PROJECT_DIR, '.claude', 'settings.json'), 'utf8')), {});

  // Serveur utilisateur, connecteur : marche à suivre, aucun fichier modifié.
  const before = fs.readFileSync(user, 'utf8');
  assert.match(run(sb, ['off', 'perso', '--apply']).stdout, /`\/mcp` en CLI/);
  assert.match(run(sb, ['off', 'inconnu']).stdout, /réglages de l'app/);
  assert.strictEqual(fs.readFileSync(user, 'utf8'), before);

  // JSON invalide : rien n'est modifié.
  fs.writeFileSync(local, '{ cassé');
  const bad = run(sb, ['off', 'outils', '--apply']);
  assert.match(bad.stdout, /n'est pas un JSON valide/);
  assert.strictEqual(fs.readFileSync(local, 'utf8'), '{ cassé');
});
