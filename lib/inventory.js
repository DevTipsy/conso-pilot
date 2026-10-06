'use strict';
// Inventaire du contexte chargé (spec §6), relevé dans le transcript plutôt qu'estimé à partir des fichiers :
// Claude Code y écrit, en début de discussion puis à chaque changement, des lignes « attachment » qui
// contiennent exactement ce que le modèle reçoit :
//   skill_listing          liste des skills et commandes (texte complet) ;
//   deferred_tools_delta   noms des outils différés (recherche d'outils), ajoutés / retirés ;
//   prompt_snapshot        définitions complètes des outils non différés (absent hors de l'app) ;
//   mcp_instructions_delta instructions des serveurs MCP ;
//   agent_listing_delta    liste des agents.
// Le poids d'un élément = caractères ÷ leanCharsPerToken. Couvre aussi les plugins et connecteurs de l'app,
// absents des fichiers de ~/.claude.
const fs = require('fs');
const path = require('path');
const { dataDir, readJson, writeJsonAtomic, projectSlug } = require('./util');

const TYPES = new Set(['skill_listing', 'deferred_tools_delta', 'prompt_snapshot', 'mcp_instructions_delta', 'agent_listing_delta']);
const MARK = '"attachment":{"type":"';

function newInventory(session = null) {
  return { session, skills: {}, tools: {}, instructions: {}, agents: {}, builtInAgents: [], needsAuth: [], failed: [], observedAt: null };
}

// Type d'attachment d'une ligne brute, sans l'analyser (filtre rapide de la lecture incrémentale).
function attachmentType(line) {
  const i = line.indexOf(MARK);
  if (i < 0) return null;
  const start = i + MARK.length;
  const type = line.slice(start, line.indexOf('"', start));
  return TYPES.has(type) ? type : null;
}

// Réduit une attachment à ce qui sert au calcul (prompt_snapshot peut peser plusieurs centaines de Ko).
function reduce(a) {
  if (a.type !== 'prompt_snapshot') return a;
  if (!Array.isArray(a.tools)) return null; // instantané sans outils : rien à relever
  return { type: a.type, tools: a.tools.map((t) => ({ name: t.name, chars: JSON.stringify(t).length })) };
}

// Découpe le texte de skill_listing en entrées « - nom: description » (descriptions sur plusieurs lignes).
function splitSkills(content, names) {
  const known = new Set(names || []);
  const out = {};
  let current = null;
  for (const line of String(content || '').split('\n')) {
    const m = line.startsWith('- ') ? /^- (.+?)(?::(?: |$)|$)/.exec(line) : null;
    if (m && (known.size === 0 || known.has(m[1]))) {
      current = m[1];
      out[current] = 0;
    }
    if (current) out[current] += line.length + 1;
  }
  return out;
}

function apply(inv, a, ts = null) {
  if (!a) return inv;
  switch (a.type) {
    case 'skill_listing': {
      const parsed = splitSkills(a.content, a.names);
      if (a.isInitial !== false) inv.skills = parsed;
      else Object.assign(inv.skills, parsed);
      break;
    }
    case 'deferred_tools_delta': {
      const names = [...(a.addedNames || []), ...(a.readdedNames || [])];
      names.forEach((n, i) => {
        const line = (a.addedLines && a.addedLines[i]) || n;
        inv.tools[n] = { chars: String(line).length + 1, deferred: true };
      });
      for (const n of a.removedNames || []) delete inv.tools[n];
      if (Array.isArray(a.needsAuthMcpServers)) inv.needsAuth = a.needsAuthMcpServers;
      if (Array.isArray(a.failedMcpServers)) inv.failed = a.failedMcpServers.map((f) => (typeof f === 'string' ? f : f.name));
      break;
    }
    case 'prompt_snapshot': {
      // Les outils non différés de l'instantané remplacent les précédents ; les différés restent.
      for (const [n, t] of Object.entries(inv.tools)) if (!t.deferred) delete inv.tools[n];
      for (const t of a.tools || []) inv.tools[t.name] = { chars: t.chars, deferred: false };
      break;
    }
    case 'mcp_instructions_delta': {
      (a.addedNames || []).forEach((n, i) => {
        inv.instructions[n] = String((a.addedBlocks && a.addedBlocks[i]) || '').length;
      });
      for (const n of a.removedNames || []) delete inv.instructions[n];
      break;
    }
    case 'agent_listing_delta': {
      if (a.isInitial) inv.agents = {};
      (a.addedTypes || []).forEach((n, i) => {
        inv.agents[n] = String((a.addedLines && a.addedLines[i]) || n).length + 1;
      });
      for (const n of a.removedTypes || []) delete inv.agents[n];
      if (Array.isArray(a.builtInTypes)) inv.builtInAgents = a.builtInTypes;
      break;
    }
    default:
      return inv;
  }
  inv.observedAt = ts || new Date().toISOString();
  return inv;
}

// --- Cache par projet : dernier inventaire observé (cache/inventory/<projet>.json).

function inventoryPath(project) {
  return path.join(dataDir(), 'cache', 'inventory', `${projectSlug(project)}.json`);
}

function load(project) {
  return readJson(inventoryPath(project), null);
}

function save(project, inv) {
  writeJsonAtomic(inventoryPath(project), { ...inv, project });
}

// Applique les attachments lues par un Stop. Nouvelle session : on repart d'un inventaire vide
// (la liste initiale de la session décrit tout ce qui est chargé). Renvoie l'inventaire enregistré.
function record(project, session, attachments) {
  if (!attachments.length) return null;
  const prev = load(project);
  const inv = prev && prev.session === session ? prev : newInventory(session);
  for (const { a, ts } of attachments) apply(inv, a, ts);
  save(project, inv);
  return inv;
}

// Lecture directe d'un transcript complet (commande /lean, quand aucun inventaire n'a encore été relevé).
function fromTranscript(file) {
  const inv = newInventory(path.basename(file, '.jsonl'));
  let found = false;
  eachLine(file, (line) => {
    if (!attachmentType(line)) return;
    try {
      const o = JSON.parse(line);
      if (o.isSidechain) return;
      apply(inv, reduce(o.attachment), o.timestamp);
      found = true;
    } catch {
      // ligne illisible : ignorée
    }
  });
  return found ? inv : null;
}

// Parcours ligne à ligne par blocs (transcripts de plusieurs centaines de Mo) ; `from` : offset de départ.
function eachLine(file, fn, from = 0) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return from;
  }
  const CHUNK = 8 * 1024 * 1024;
  let pos = from;
  let rest = Buffer.alloc(0);
  let end = from;
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (n === 0) break;
      pos += n;
      const data = rest.length ? Buffer.concat([rest, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0;
      let nl;
      while ((nl = data.indexOf(10, start)) >= 0) {
        if (nl > start) fn(data.toString('utf8', start, nl));
        start = nl + 1;
      }
      end = pos - (data.length - start);
      rest = Buffer.from(data.subarray(start));
    }
  } finally {
    fs.closeSync(fd);
  }
  return end; // fin de la dernière ligne complète
}

module.exports = { newInventory, attachmentType, reduce, splitSkills, apply, load, save, record, fromTranscript, eachLine, inventoryPath };
