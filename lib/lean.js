'use strict';
// /lean (spec §6) : poids du contexte chargé par plugins, skills et serveurs MCP, dernier usage dans le projet,
// désactivation (après confirmation, sauvegarde datée, toujours par ce script).
//
// Poids : inventaire relevé dans le transcript (lib/inventory.js). Dernier usage : appels Skill, outils
// mcp__<serveur>__*, agents et commandes /plugin:nom lus dans les transcripts du projet (lecture
// incrémentale, mise en cache), ce qui donne l'historique dès la première utilisation.
const fs = require('fs');
const path = require('path');
const { claudeHome, dataDir, readJson, writeJsonAtomic, writeTextAtomic, projectSlug } = require('./util');
const { loadConfig } = require('./config');
const inventory = require('./inventory');
const { serialize, diffLines } = require('./setup');
const { tokens, table, home, ago } = require('./format');
const { settingsFiles } = require('./settings');

const KIND_LABEL = {
  plugin: 'plugin',
  'plugin-app': "plugin de l'app",
  'mcp-projet': 'MCP projet (.mcp.json)',
  'mcp-local': 'MCP local',
  'mcp-user': 'MCP utilisateur',
  connecteur: 'connecteur claude.ai',
  'mcp-app': "MCP de l'app ou connecteur",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Nom de serveur tel qu'il apparaît dans les noms d'outils (mcp__<nom>__outil).
function normServer(name) {
  return String(name).replace(/[^A-Za-z0-9_-]/g, '_');
}

function serverOfTool(name) {
  if (!name.startsWith('mcp__')) return null;
  const end = name.indexOf('__', 5);
  return end > 5 ? name.slice(5, end) : null;
}

// Outils de l'app desktop elle-même (session, panneaux) : non désactivables.
function isAppBuiltinServer(key) {
  return key.startsWith('ccd_');
}

function claudeJsonPath() {
  return process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(require('os').homedir(), '.claude.json');
}

// --- Sources désactivables : plugins Claude Code installés, serveurs MCP déclarés dans des fichiers.
function sources(project) {
  const plugins = new Map(); // nom (plugin.json) → { key, scope, installPath }
  const installed = readJson(path.join(claudeHome(), 'plugins', 'installed_plugins.json'), {});
  for (const [key, list] of Object.entries((installed && installed.plugins) || {})) {
    for (const p of Array.isArray(list) ? list : []) {
      if (p.projectPath && p.projectPath !== project) continue;
      const manifest = readJson(path.join(p.installPath || '', '.claude-plugin', 'plugin.json'), null);
      const name = (manifest && manifest.name) || key.split('@')[0];
      plugins.set(name, { key, scope: p.scope || 'user', installPath: p.installPath });
      break;
    }
  }
  const mcp = new Map(); // nom normalisé → { name, kind }
  const cj = readJson(claudeJsonPath(), {}) || {};
  for (const name of Object.keys(cj.mcpServers || {})) mcp.set(normServer(name), { name, kind: 'mcp-user' });
  const local = cj.projects && cj.projects[project];
  for (const name of Object.keys((local && local.mcpServers) || {})) mcp.set(normServer(name), { name, kind: 'mcp-local' });
  if (project) {
    const pj = readJson(path.join(project, '.mcp.json'), null);
    const servers = pj && (pj.mcpServers || pj);
    for (const name of Object.keys(servers && typeof servers === 'object' ? servers : {})) mcp.set(normServer(name), { name, kind: 'mcp-projet' });
  }
  return { plugins, mcp };
}

// --- Regroupement de l'inventaire par élément désactivable.

function pluginOfServer(key, names) {
  if (!key.startsWith('plugin_')) return null;
  const rest = key.slice('plugin_'.length);
  let best = null;
  for (const n of names) if (rest.startsWith(`${n}_`) && (!best || n.length > best.length)) best = n;
  return best || rest.split('_')[0];
}

/**
 * @returns {{rows: object[], builtin: {tokens: number, skills: number, tools: number}, skills: object[], total: number}}
 */
function weigh(inv, src = { plugins: new Map(), mcp: new Map() }, cfg = loadConfig()) {
  const cpt = cfg.leanCharsPerToken || 4;
  const rows = new Map();
  const builtin = { chars: 0, skills: 0, tools: 0 };
  const pluginNames = new Set(src.plugins.keys());
  for (const n of Object.keys(inv.skills || {})) if (n.includes(':')) pluginNames.add(n.split(':')[0]);
  for (const n of Object.keys(inv.agents || {})) if (n.includes(':')) pluginNames.add(n.split(':')[0]);
  for (const n of Object.keys(inv.instructions || {})) if (n.startsWith('plugin:')) pluginNames.add(n.split(':')[1]);

  function row(id, kind) {
    if (!rows.has(id)) rows.set(id, { id, kind, chars: 0, skills: 0, agents: 0, tools: 0, deferred: 0, instructions: false, servers: new Set(), samples: [] });
    return rows.get(id);
  }
  function pluginRow(name) {
    return row(`plugin:${name}`, src.plugins.has(name) ? 'plugin' : 'plugin-app');
  }
  function serverRow(key) {
    const plugin = pluginOfServer(key, pluginNames);
    if (plugin) {
      const r = pluginRow(plugin);
      r.servers.add(key.slice(`plugin_${plugin}_`.length) || key);
      return r;
    }
    const known = src.mcp.get(key);
    const kind = known ? known.kind : UUID.test(key) ? 'connecteur' : 'mcp-app';
    const r = row(`mcp:${key}`, kind);
    r.name = known ? known.name : key;
    return r;
  }

  const skills = [];
  for (const [name, chars] of Object.entries(inv.skills || {})) {
    if (!name.includes(':')) {
      builtin.chars += chars;
      builtin.skills += 1;
      continue;
    }
    const r = pluginRow(name.split(':')[0]);
    r.chars += chars;
    r.skills += 1;
    skills.push({ name, plugin: name.split(':')[0], chars });
  }
  const builtinAgents = new Set(inv.builtInAgents || []);
  for (const [name, chars] of Object.entries(inv.agents || {})) {
    if (!name.includes(':') || builtinAgents.has(name)) {
      builtin.chars += chars;
      continue;
    }
    const r = pluginRow(name.split(':')[0]);
    r.chars += chars;
    r.agents += 1;
  }
  for (const [name, t] of Object.entries(inv.tools || {})) {
    const key = serverOfTool(name);
    if (!key || isAppBuiltinServer(key)) {
      builtin.chars += t.chars;
      builtin.tools += 1;
      continue;
    }
    const r = serverRow(key);
    r.chars += t.chars;
    r.tools += 1;
    if (t.deferred) r.deferred += 1;
    if (r.samples.length < 3) r.samples.push(name.slice(name.indexOf('__', 5) + 2));
  }
  for (const [name, chars] of Object.entries(inv.instructions || {})) {
    const key = normServer(name.startsWith('plugin:') ? `plugin_${name.slice(7).replace(/:/g, '_')}` : name);
    if (isAppBuiltinServer(key)) continue;
    const r = serverRow(key);
    r.chars += chars;
    r.instructions = true;
  }

  const list = [...rows.values()].map((r) => ({ ...r, servers: [...r.servers], tokens: Math.round(r.chars / cpt) }));
  list.sort((a, b) => b.tokens - a.tokens);
  skills.forEach((s) => { s.tokens = Math.round(s.chars / cpt); });
  skills.sort((a, b) => b.tokens - a.tokens);
  return {
    rows: list,
    skills,
    builtin: { tokens: Math.round(builtin.chars / cpt), skills: builtin.skills, tools: builtin.tools },
    total: list.reduce((s, r) => s + r.tokens, 0),
  };
}

// --- Dernier usage dans le projet : transcripts de ~/.claude/projects/<projet>/ (sous-agents compris).

// Dossier des transcripts du projet : Claude Code remplace tout caractère non alphanumérique par « - »
// (différent de projectSlug, qui nomme les dossiers de conso-pilot).
function transcriptsDir(project) {
  return path.join(claudeHome(), 'projects', String(project || '').replace(/[^A-Za-z0-9]/g, '-'));
}

function usagePath(project) {
  return path.join(dataDir(), 'cache', 'usage', `${projectSlug(project)}.json`);
}

function transcriptFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...transcriptFiles(p));
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function mark(last, key, ts) {
  if (key && ts && (!last[key] || last[key] < ts)) last[key] = ts;
}

function noteToolUse(last, b, ts) {
  const input = b.input || {};
  if (b.name === 'Skill' && input.skill) {
    const skill = String(input.skill).replace(/^\//, '');
    mark(last, `skill:${skill}`, ts);
    if (skill.includes(':')) mark(last, `plugin:${skill.split(':')[0]}`, ts);
  } else if ((b.name === 'Agent' || b.name === 'Task') && input.subagent_type) {
    const type = String(input.subagent_type);
    mark(last, `agent:${type}`, ts);
    if (type.includes(':')) mark(last, `plugin:${type.split(':')[0]}`, ts);
  } else if (typeof b.name === 'string') {
    const key = serverOfTool(b.name);
    if (key) mark(last, `mcp:${key}`, ts);
  }
}

function scanUsageLine(last, line) {
  const tool = line.includes('"tool_use"');
  const cmd = !tool && line.includes('<command-name>');
  if (!tool && !cmd) return;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  const ts = o.timestamp;
  const c = o.message && o.message.content;
  if (o.type === 'assistant' && Array.isArray(c)) {
    for (const b of c) if (b && b.type === 'tool_use') noteToolUse(last, b, ts);
  } else if (o.type === 'user') {
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
    const m = /<command-name>\/?([^<\s]+)<\/command-name>/.exec(text);
    if (m && m[1].includes(':')) {
      mark(last, `skill:${m[1]}`, ts);
      mark(last, `plugin:${m[1].split(':')[0]}`, ts);
    }
  }
}

// Lecture incrémentale : seuls les octets ajoutés depuis la dernière fois sont relus.
function lastUses(project) {
  const file = usagePath(project);
  const cache = readJson(file, null) || { files: {}, last: {} };
  const dir = transcriptsDir(project);
  let changed = false;
  for (const f of transcriptFiles(dir)) {
    const rel = path.relative(dir, f);
    let size;
    try {
      size = fs.statSync(f).size;
    } catch {
      continue;
    }
    let from = cache.files[rel] || 0;
    if (from > size) from = 0; // fichier réécrit
    if (from === size) continue;
    cache.files[rel] = inventory.eachLine(f, (line) => scanUsageLine(cache.last, line), from);
    changed = true;
  }
  if (changed) writeJsonAtomic(file, cache);
  return cache.last;
}

function rowLastUse(r, last) {
  if (r.id.startsWith('plugin:')) {
    const name = r.id.slice(7);
    let best = last[`plugin:${name}`] || null;
    for (const s of r.servers) {
      const t = last[`mcp:plugin_${name}_${s}`];
      if (t && (!best || t > best)) best = t;
    }
    return best;
  }
  return last[r.id] || null;
}

// --- Inventaire courant du projet : relevé par Stop, sinon lu dans le dernier transcript du projet.

function currentInventory(project) {
  const cached = inventory.load(project);
  if (cached) return cached;
  const dir = transcriptsDir(project);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).map((n) => path.join(dir, n));
  } catch {
    return null;
  }
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const f of files.slice(0, 3)) {
    const inv = inventory.fromTranscript(f);
    if (inv) {
      inventory.save(project, inv);
      return inventory.load(project);
    }
  }
  return null;
}

// --- Alerte (§6) : une fois par jour et par projet, dès que l'inventaire relevé dépasse leanWarnTokens.

function warnOnce(project, inv, cfg, now = new Date()) {
  if (!inv || !cfg.leanWarnTokens) return null;
  const { total } = weigh(inv, { plugins: new Map(), mcp: new Map() }, cfg);
  if (total <= cfg.leanWarnTokens) return null;
  const file = path.join(dataDir(), 'cache', 'lean-warned.json');
  const warned = readJson(file, {}) || {};
  const day = now.toISOString().slice(0, 10);
  const slug = projectSlug(project);
  if (warned[slug] === day) return null;
  warned[slug] = day;
  writeJsonAtomic(file, warned);
  return `~${tokens(total)} tokens d'outils/skills chargés — /lean pour alléger`;
}

// --- Rapport.

function content(r) {
  const parts = [];
  if (r.skills) parts.push(`${r.skills} skill${r.skills > 1 ? 's' : ''}`);
  if (r.agents) parts.push(`${r.agents} agent${r.agents > 1 ? 's' : ''}`);
  const pl = (n) => (n > 1 ? 's' : '');
  if (r.tools) parts.push(`${r.tools} outil${pl(r.tools)}${r.deferred === r.tools ? ` différé${pl(r.tools)}` : r.deferred ? ` (${r.deferred} différé${pl(r.deferred)})` : ''}`);
  if (r.instructions) parts.push('instructions');
  return parts.join(' · ') || '—';
}

function label(r) {
  if (r.id.startsWith('plugin:')) return r.id.slice(7);
  if (r.kind === 'connecteur') return `${r.name.slice(0, 8)}… (${r.samples.join(', ')})`;
  return r.name || r.id.slice(4);
}

function lastUseText(iso, now) {
  return iso ? ago(iso, now) : 'jamais';
}

function actionsPath() {
  return path.join(dataDir(), 'lean-actions.json');
}

function buildLeanReport({ project, now = Date.now() } = {}) {
  const cfg = loadConfig();
  const out = ['## conso-pilot — contexte chargé (/lean)', ''];
  const inv = currentInventory(project);
  if (!inv) {
    out.push("Inventaire pas encore relevé pour ce projet : il apparaît après la première réponse d'une nouvelle discussion.");
    out.push('', 'En attendant, `/context` (natif) donne le détail exact.');
    return out.join('\n');
  }
  const src = sources(project);
  const w = weigh(inv, src, cfg);
  const last = lastUses(project);
  out.push(`Relevé ${ago(inv.observedAt, now)} (discussion \`${String(inv.session).slice(0, 8)}\`) · estimation : caractères ÷ ${cfg.leanCharsPerToken} · \`/context\` (natif) donne le détail exact.`, '');
  out.push(`**~${tokens(w.total)} tokens** chargés à chaque discussion par les plugins, connecteurs et serveurs MCP${w.total > cfg.leanWarnTokens ? ` (seuil d'alerte : ${tokens(cfg.leanWarnTokens)})` : ''}, plus ~${tokens(w.builtin.tokens)} d'outils et skills intégrés (non désactivables).`, '');

  const MAX_ROWS = 25;
  const shown = w.rows.slice(0, MAX_ROWS);
  out.push(table(['Élément', 'Type', '~Tokens', 'Contenu', 'Dernier usage ici'],
    shown.map((r) => [label(r), KIND_LABEL[r.kind], tokens(r.tokens), content(r), lastUseText(rowLastUse(r, last), now)])));
  const rest = w.rows.slice(MAX_ROWS);
  if (rest.length) out.push('', `… et ${rest.length} autres (${tokens(rest.reduce((s, r) => s + r.tokens, 0))} au total).`);

  if (w.skills.length) {
    out.push('', '### Skills les plus lourds', '');
    out.push(table(['Skill', '~Tokens', 'Dernier usage ici'],
      w.skills.slice(0, 10).map((s) => [s.name, tokens(s.tokens), lastUseText(last[`skill:${s.name}`], now)])));
  }

  const unused = w.rows.filter((r) => !rowLastUse(r, last) && r.tokens >= 500);
  if (unused.length) {
    out.push('', `### Jamais utilisés dans ce projet : ~${tokens(unused.reduce((s, r) => s + r.tokens, 0))} tokens`, '');
    out.push(unused.slice(0, 15).map((r) => `- ${label(r)} (~${tokens(r.tokens)}) — ${howTo(r, src)}`).join('\n'));
  }

  if (inv.needsAuth && inv.needsAuth.length) {
    out.push('', `Serveurs en attente d'authentification : ${inv.needsAuth.length} (non chargés, seul leur nom est listé).`);
  }

  const actions = (readJson(actionsPath(), []) || []).filter((a) => a.project === project || a.scope === 'user');
  const off = new Map();
  for (const a of actions) off.set(`${a.kind}:${a.name}`, a);
  const stillOff = [...off.values()].filter((a) => a.action === 'off');
  if (stillOff.length) {
    out.push('', '### Désactivés avec /lean', '');
    out.push(stillOff.map((a) => `- ${a.name} (${a.scope}, ${ago(a.ts, now)}) — réactiver : \`/lean on ${a.name}${a.scope === 'local' ? '' : ` --scope ${a.scope}`}\``).join('\n'));
  }

  out.push('', '### Pour alléger', '');
  out.push('- Plugin Claude Code ou serveur de `.mcp.json` : `/lean off <nom>` (réglages locaux du projet ; `--scope projet` pour le fichier partagé, `--scope user` pour tous les projets). Aperçu et confirmation avant écriture.');
  out.push('- Serveur MCP utilisateur ou local : `/mcp` en CLI (ou `claude mcp remove <nom>`).');
  out.push("- Plugin de l'app ou connecteur : réglages de l'app (Connecteurs, Plugins) ou claude.ai › Réglages › Connecteurs.");
  out.push('- ⚠️ Activer ou désactiver un plugin ou un serveur en cours de discussion peut invalider le cache : appliquer de préférence avant une nouvelle discussion.');
  return out.join('\n');
}

function howTo(r, src) {
  if (r.kind === 'plugin' || r.kind === 'mcp-projet') return `\`/lean off ${r.kind === 'plugin' ? r.id.slice(7) : r.name}\``;
  if (r.kind === 'mcp-user' || r.kind === 'mcp-local') return '`/mcp` en CLI';
  return "réglages de l'app / claude.ai";
}

// --- Désactivation / réactivation.

const SCOPES = ['local', 'projet', 'user'];

function scopeFile(project, scope) {
  if (scope === 'user') return path.join(claudeHome(), 'settings.json');
  if (!project) throw new Error('projet inconnu');
  return path.join(project, '.claude', scope === 'projet' ? 'settings.json' : 'settings.local.json');
}

function readFileJson(file) {
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { file, raw: null, data: {} };
  }
  try {
    return { file, raw, data: JSON.parse(raw) };
  } catch (err) {
    throw new Error(`${home(file)} n'est pas un JSON valide (${err.message}) : rien n'est modifié`);
  }
}

// Cible : plugin Claude Code (nom ou clé nom@marketplace), sinon serveur de .mcp.json, sinon explication.
function resolveTarget(project, name) {
  const src = sources(project);
  const lower = String(name || '').toLowerCase();
  for (const [pname, p] of src.plugins) {
    if (pname.toLowerCase() === lower || p.key.toLowerCase() === lower || p.key.split('@')[0].toLowerCase() === lower) {
      return { kind: 'plugin', name: pname, key: p.key };
    }
  }
  for (const s of src.mcp.values()) {
    if (s.name.toLowerCase() !== lower && normServer(s.name).toLowerCase() !== lower) continue;
    if (s.kind === 'mcp-projet') return { kind: 'mcp-projet', name: s.name };
    return { kind: s.kind, name: s.name, manual: `serveur MCP ${s.kind === 'mcp-user' ? 'utilisateur' : 'local'} : pas de modification de fichier par conso-pilot. Utilise \`/mcp\` en CLI, ou \`claude mcp remove ${s.name} -s ${s.kind === 'mcp-user' ? 'user' : 'local'}\`.` };
  }
  return { kind: 'inconnu', name, manual: `« ${name} » n'est ni un plugin Claude Code installé ni un serveur de .mcp.json. Plugin de l'app ou connecteur : réglages de l'app (Connecteurs, Plugins) ou claude.ai › Réglages › Connecteurs.` };
}

// État effectif d'un plugin (utilisateur < projet < local), avec `enabledPlugins` de `file` remplacé par `ep`.
function pluginEnabled(project, key, file, ep) {
  let value;
  for (const f of settingsFiles(project)) {
    const plugins = f === file ? ep : ((readJson(f, null) || {}).enabledPlugins || {});
    if (plugins[key] !== undefined) value = plugins[key];
  }
  return value === true;
}

/**
 * @param {'off'|'on'} action
 */
function planToggle({ project, name, action, scope = 'local' }) {
  if (!SCOPES.includes(scope)) throw new Error(`portée inconnue « ${scope} » (local, projet ou user)`);
  const target = resolveTarget(project, name);
  if (target.manual) return { target, changed: false };
  const file = scopeFile(project, scope);
  const s = readFileJson(file);
  const after = JSON.parse(JSON.stringify(s.data));
  if (target.kind === 'plugin') {
    const ep = { ...(after.enabledPlugins || {}) };
    if (action === 'off') ep[target.key] = false;
    else {
      // Réactivation : on retire le « false » de ce fichier ; s'il reste désactivé ailleurs, « true » ici.
      if (ep[target.key] === false) delete ep[target.key];
      if (!pluginEnabled(project, target.key, file, ep)) ep[target.key] = true;
    }
    if (Object.keys(ep).length) after.enabledPlugins = ep;
    else delete after.enabledPlugins;
  } else {
    const list = Array.isArray(after.disabledMcpjsonServers) ? [...after.disabledMcpjsonServers] : [];
    const has = list.includes(target.name);
    if (action === 'off' && !has) list.push(target.name);
    if (action === 'on' && has) list.splice(list.indexOf(target.name), 1);
    if (list.length) after.disabledMcpjsonServers = list;
    else delete after.disabledMcpjsonServers;
  }
  const same = JSON.stringify(after) === JSON.stringify(s.data);
  const text = same ? s.raw : serialize(after, s.raw);
  return { target, scope, settings: s, text, changed: !same };
}

function applyToggle(opts) {
  const plan = planToggle(opts);
  if (!plan.changed) return { plan, backupFile: null };
  let backupFile = null;
  if (plan.settings.raw != null) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    backupFile = path.join(dataDir(), 'backups', `${projectSlug(plan.settings.file).replace(/^-+/, '')}-${stamp}-avant-lean.json`);
    writeTextAtomic(backupFile, plan.settings.raw);
  }
  writeTextAtomic(plan.settings.file, plan.text);
  const actions = readJson(actionsPath(), []) || [];
  actions.push({ ts: new Date().toISOString(), action: opts.action, kind: plan.target.kind, name: plan.target.name, scope: plan.scope, project: opts.project, file: plan.settings.file, backup: backupFile });
  writeJsonAtomic(actionsPath(), actions.slice(-200));
  return { plan, backupFile };
}

module.exports = {
  weigh, sources, lastUses, currentInventory, warnOnce, buildLeanReport, planToggle, applyToggle, resolveTarget, scopeFile, normServer, serverOfTool, SCOPES,
};
