'use strict';
// /conso-pilot:setup et /conso-pilot:uninstall (spec §10) : modifications de ~/.claude/settings.json,
// toujours faites par ce script (chemin protégé, jamais par Write/Edit), après affichage d'un diff.
//
// Le dossier d'installation du plugin change à chaque version (plugins/cache/…/<version>) : la barre
// d'état et la permission visent donc des lanceurs stables, ~/.claude/conso-pilot/bin/<nom>, qui
// chargent le script du plugin dont le chemin est relevé à chaque SessionStart (fichier plugin-root).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { claudeHome, dataDir, ensureDir, readJson, writeJsonAtomic, writeTextAtomic } = require('./util');
const { loadConfig } = require('./config');
const { home } = require('./format');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const SHIMS = ['statusline', 'save-handoff'];

const SHIM_SOURCE = `#!/usr/bin/env node
'use strict';
// Lanceur stable installé par /conso-pilot:setup : exécute la version courante du plugin conso-pilot.
const fs = require('fs');
const path = require('path');
let root = '';
try {
  root = fs.readFileSync(path.join(__dirname, '..', 'plugin-root'), 'utf8').trim();
} catch {
  // plugin-root absent : rien à lancer
}
const target = path.join(root, 'bin', path.basename(__filename));
if (root && fs.existsSync(target)) require(target);
`;

function settingsPath() {
  return path.join(claudeHome(), 'settings.json');
}

function installPath() {
  return path.join(dataDir(), 'install.json');
}

function shimPath(name) {
  return path.join(dataDir(), 'bin', name);
}

function quote(p) {
  return /[\s"'$`\\]/.test(p) ? `"${p.replace(/(["$`\\])/g, '\\$1')}"` : p;
}

function statusLineCommand() {
  return `node ${quote(shimPath('statusline'))}`;
}

// Commande d'enregistrement du handoff : lanceur stable s'il est installé, sinon le script du plugin.
function saveHandoffCommand(fallback) {
  const shim = shimPath('save-handoff');
  return `node ${quote(fs.existsSync(shim) ? shim : fallback)}`;
}

function permissionRule() {
  return `Bash(node ${quote(shimPath('save-handoff'))}:*)`;
}

// Chemin du plugin relevé à chaque SessionStart (une lecture, une écriture seulement s'il change).
function recordPluginRoot(root = PLUGIN_ROOT) {
  const file = path.join(dataDir(), 'plugin-root');
  let current = null;
  try {
    current = fs.readFileSync(file, 'utf8').trim();
  } catch {
    // premier lancement
  }
  if (current !== root) writeTextAtomic(file, `${root}\n`);
}

function sha(text) {
  return crypto.createHash('sha256').update(text == null ? '' : text).digest('hex');
}

function readSettings() {
  const file = settingsPath();
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { file, raw: null, data: {} };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${home(file)} n'est pas un JSON valide (${err.message}) : rien n'est modifié`);
  }
  return { file, raw, data };
}

// Même indentation et même fin de fichier que l'original.
function serialize(data, raw) {
  const m = raw && /^\{\r?\n([ \t]+)"/.exec(raw);
  const indent = m ? m[1] : 2;
  const eol = raw == null || raw.endsWith('\n') ? '\n' : '';
  return `${JSON.stringify(data, null, indent)}${eol}`;
}

// Diff ligne à ligne (plus longue sous-suite commune), avec 2 lignes de contexte.
function diffLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push([' ', a[i]]);
      i += 1;
      j += 1;
    } else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) {
      ops.push(['-', a[i]]);
      i += 1;
    } else {
      ops.push(['+', b[j]]);
      j += 1;
    }
  }
  const keep = ops.map((op, k) => ops.slice(Math.max(0, k - 2), k + 3).some((o) => o[0] !== ' '));
  const out = [];
  ops.forEach((op, k) => {
    if (keep[k]) out.push(`${op[0]} ${op[1]}`);
    else if (keep[k - 1]) out.push('  …');
  });
  return out.join('\n');
}

function backup(raw, label) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = path.join(dataDir(), 'backups', `settings-${stamp}-${label}.json`);
  if (raw != null) writeTextAtomic(file, raw);
  return raw == null ? null : file;
}

function isOurStatusLine(sl) {
  return Boolean(sl && typeof sl.command === 'string' && sl.command.includes(shimPath('statusline')));
}

// --- setup

/**
 * @param {'chain'|'replace'|'keep'|null} mode  traitement d'une barre d'état existante (null : à choisir)
 */
function planSetup(mode = null) {
  const s = readSettings();
  const after = JSON.parse(JSON.stringify(s.data));
  const notes = [];
  const prev = s.data.statusLine;
  let statusMode = 'new';
  if (isOurStatusLine(prev)) {
    statusMode = 'present';
    notes.push("Barre d'état conso-pilot déjà installée.");
  } else if (prev) {
    statusMode = mode || 'chain';
    if (statusMode === 'keep') notes.push("Barre d'état existante conservée telle quelle (pas de barre conso-pilot).");
    else after.statusLine = { ...prev, type: 'command', command: statusLineCommand() };
  } else {
    after.statusLine = { type: 'command', command: statusLineCommand() };
  }
  const rule = permissionRule();
  const allow = (after.permissions && Array.isArray(after.permissions.allow)) ? after.permissions.allow : null;
  const addPermission = !(allow && allow.includes(rule));
  if (addPermission) {
    after.permissions = { ...(after.permissions || {}) };
    after.permissions.allow = [...(allow || []), rule];
  } else notes.push('Permission de save-handoff déjà présente.');
  const text = serialize(after, s.raw);
  const changed = s.raw == null ? true : text !== s.raw;
  return {
    settings: s, after, text, changed, statusMode, previous: prev || null, addPermission, rule, notes,
    choice: Boolean(prev) && !isOurStatusLine(prev) && mode == null,
  };
}

function installShims() {
  for (const name of SHIMS) {
    const file = shimPath(name);
    writeTextAtomic(file, SHIM_SOURCE);
    fs.chmodSync(file, 0o755);
  }
}

function applySetup(mode = 'chain') {
  loadConfig(); // crée config.json s'il manque
  recordPluginRoot();
  installShims();
  const plan = planSetup(mode);
  const prevInstall = readJson(installPath(), null);
  if (!plan.changed) return { plan, backupFile: null };
  const backupFile = backup(plan.settings.raw, 'avant-setup');
  writeTextAtomic(plan.settings.file, plan.text);
  writeJsonAtomic(installPath(), {
    installedAt: new Date().toISOString(),
    settingsFile: plan.settings.file,
    backup: backupFile,
    afterSha: sha(plan.text),
    // Barre déjà installée par un setup précédent : on garde ce qu'il avait relevé.
    statusMode: plan.statusMode === 'present' ? (prevInstall ? prevInstall.statusMode : 'new') : plan.statusMode,
    previousStatusLine: plan.statusMode === 'present' ? (prevInstall ? prevInstall.previousStatusLine : null) : plan.previous,
    statusLineCommand: statusLineCommand(),
    addedPermission: plan.addPermission || Boolean(prevInstall && prevInstall.addedPermission),
    permissionRule: plan.rule,
  });
  return { plan, backupFile };
}

// --- uninstall

function stripOurs(data, inst) {
  const after = JSON.parse(JSON.stringify(data));
  if (isOurStatusLine(after.statusLine)) {
    if (inst.previousStatusLine) after.statusLine = inst.previousStatusLine;
    else delete after.statusLine;
  }
  const p = after.permissions;
  if (inst.addedPermission && p && Array.isArray(p.allow) && p.allow.includes(inst.permissionRule)) {
    p.allow = p.allow.filter((r) => r !== inst.permissionRule);
    if (!p.allow.length) delete p.allow;
    if (!Object.keys(p).length) delete after.permissions;
  }
  return after;
}

function planUninstall() {
  const inst = readJson(installPath(), null);
  const s = readSettings();
  if (!inst) return { inst: null, settings: s, changed: false };
  // Fichier inchangé depuis le setup : on repart de la sauvegarde faite juste avant (restauration à l'identique).
  let base = { raw: s.raw, data: s.data };
  let restored = false;
  if (s.raw != null && sha(s.raw) === inst.afterSha) {
    if (!inst.backup) return { inst, settings: s, restored: true, text: null, changed: true }; // fichier créé par le setup
    try {
      const raw = fs.readFileSync(inst.backup, 'utf8');
      base = { raw, data: JSON.parse(raw) };
      restored = true;
    } catch {
      // sauvegarde illisible : retrait ciblé sur le fichier actuel
    }
  }
  // Retrait ciblé de ce que le setup a ajouté (sans effet sur une sauvegarde déjà propre : octets conservés).
  const stripped = stripOurs(base.data, inst);
  const text = JSON.stringify(stripped) === JSON.stringify(base.data) ? base.raw : serialize(stripped, base.raw);
  return { inst, settings: s, restored, text, changed: s.raw != null && text !== s.raw };
}

function applyUninstall() {
  const plan = planUninstall();
  let backupFile = null;
  if (plan.changed) {
    backupFile = backup(plan.settings.raw, 'avant-uninstall');
    if (plan.text == null) fs.unlinkSync(plan.settings.file);
    else writeTextAtomic(plan.settings.file, plan.text);
  }
  for (const name of SHIMS) fs.rmSync(shimPath(name), { force: true });
  fs.rmSync(installPath(), { force: true });
  return { plan, backupFile };
}

module.exports = {
  settingsPath, installPath, shimPath, statusLineCommand, saveHandoffCommand, permissionRule, recordPluginRoot, readSettings,
  serialize, diffLines, planSetup, applySetup, planUninstall, applyUninstall, isOurStatusLine, quote, ensureDir,
};
