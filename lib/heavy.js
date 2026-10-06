'use strict';
// Dossiers et fichiers lourds (spec §7) : accès large refusé (raison adressée à Claude), accès ciblé
// autorisé avec un avertissement visible. Ne réécrit jamais l'entrée (pas de conflit avec rtk / context-mode)
// et ne répond jamais « allow » (les permissions natives restent seules juges).
const fs = require('fs');
const path = require('path');

const DENY_REASON = 'Dossier lourd bloqué par défaut. Si une erreur peut venir d\'ici, fais un accès ciblé '
  + '(Grep avec un motif précis, Read avec offset/limit ≤ 300, tail d\'un log).';

// Taille évitée plafonnée à ce que l'outil aurait réellement renvoyé : Read ~25k tokens, sorties Bash,
// Grep et Glob tronquées à ~30 000 caractères par Claude Code.
const OUTPUT_CAP = { Read: 100000, Bash: 30000, Grep: 30000, Glob: 30000 };
// Fichiers que Read affiche autrement que comme du texte : pas de refus sur la seule taille.
const MEDIA_RE = /\.(png|jpe?g|gif|webp|heic|bmp|tiff?|pdf|ipynb)$/i;
const VAGUE_PATTERNS = new Set(['.', '.*', '.+', '*', '^', '$', '^.*$']);

function segments(p) {
  return String(p || '').split(/[\\/]+/).filter(Boolean);
}

// Motif de la config : « dossier/ » (segment de chemin), « *.ext » (fin d'un segment), sinon nom exact.
function matchesHeavy(p, patterns) {
  const segs = segments(p);
  for (const pat of patterns) {
    if (pat.endsWith('/')) {
      if (segs.includes(pat.slice(0, -1))) return pat;
    } else if (pat.startsWith('*.')) {
      if (segs.some((s) => s.endsWith(pat.slice(1)))) return pat;
    } else if (segs.includes(pat)) return pat;
  }
  return null;
}

function statOf(p, cwd) {
  try {
    return fs.statSync(path.resolve(cwd || process.cwd(), p));
  } catch {
    return null;
  }
}

// Chemin lourd : motif de la config, ou fichier texte plus gros que heavyFileBytes.
function heavyInfo(p, cwd, cfg) {
  if (!p) return null;
  const pattern = matchesHeavy(p, cfg.heavyPaths || []);
  const st = statOf(p, cwd);
  const size = st && st.isFile() ? st.size : null;
  if (pattern) return { path: p, pattern, size };
  if (size != null && size > cfg.heavyFileBytes && !MEDIA_RE.test(p)) return { path: p, pattern: null, size };
  return null;
}

function isVague(pattern) {
  const s = String(pattern || '').trim();
  return s.length < 3 || VAGUE_PATTERNS.has(s);
}

// --- Découpage minimal d'une commande shell : segments (; && || |) puis mots (guillemets respectés).
// Corps des here-documents retirés : ce sont des données, pas des commandes.
function stripHeredocs(cmd) {
  const lines = cmd.split('\n');
  const out = [];
  let end = null;
  for (const line of lines) {
    if (end != null) {
      if (line.replace(/^\t+/, '') === end) end = null;
      continue;
    }
    out.push(line);
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (m) end = m[2];
  }
  return out.join('\n');
}

function splitCommand(raw) {
  const cmd = stripHeredocs(String(raw || ''));
  const parts = [];
  let cur = [];
  let word = '';
  let has = false;
  let quote = null;
  const push = () => {
    if (has) cur.push(word);
    word = '';
    has = false;
  };
  for (let i = 0; i < cmd.length; i += 1) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < cmd.length) word += cmd[(i += 1)];
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < cmd.length) {
      word += cmd[(i += 1)];
      has = true;
    } else if (/\s/.test(c)) {
      if (c === '\n') {
        push();
        if (cur.length) parts.push(cur);
        cur = [];
      } else push();
    } else if (c === '&' && (cmd[i - 1] === '>' || cmd[i - 1] === '<')) {
      word += c; // 2>&1
    } else if (c === ';' || c === '|' || c === '&') {
      push();
      while (cmd[i + 1] === '|' || cmd[i + 1] === '&') i += 1;
      if (cur.length) parts.push(cur);
      cur = [];
    } else {
      word += c;
      has = true;
    }
  }
  push();
  if (cur.length) parts.push(cur);
  return parts;
}

// Arguments hors options et redirections (« > f », « 2>&1 », « <<EOF »…).
function operands(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (/^\d*[<>]/.test(a)) {
      if (/^\d*[<>]+&?$/.test(a)) i += 1; // la cible est le mot suivant
      continue;
    }
    if (a.startsWith('-')) continue;
    out.push(a);
  }
  return out;
}

// Nombre de lignes demandé à head / tail ; null = tout le fichier (tail -n +1, etc.).
function lineCount(args) {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    let v = null;
    if (a === '-n' || a === '--lines') v = args[i + 1];
    else if (/^-n/.test(a)) v = a.slice(2);
    else if (/^--lines=/.test(a)) v = a.slice(8);
    else if (/^-\d+$/.test(a)) v = a.slice(1);
    if (v != null) {
      if (String(v).startsWith('+')) return Number(v.slice(1)) <= 1 ? null : Infinity;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    if (a === '-f' || a === '-F') continue;
  }
  return 10;
}

const CONTENT_CMDS = new Set(['cat', 'less', 'more', 'bat', 'read']);
const LISTING_CMDS = new Set(['tree', 'find', 'fd']);
const GREP_CMDS = new Set(['grep', 'egrep', 'rg', 'ag', 'ack']);

function hasRecursiveFlag(args) {
  return args.some((a) => a === '--recursive' || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a));
}

// Analyse d'une commande Bash : { kind: 'deny' | 'warn', info } pour le premier accès lourd trouvé.
function checkBash(command, cwd, cfg) {
  let warn = null;
  for (let words of splitCommand(String(command || ''))) {
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words = words.slice(1); // VAR=x cmd
    if (words[0] === 'rtk' || words[0] === 'sudo' || words[0] === 'command') words = words.slice(1);
    const cmd = path.basename(words[0] || '');
    const args = words.slice(1);
    const ops = operands(args);
    const heavy = (list) => list.map((p) => heavyInfo(p, cwd, cfg)).find(Boolean) || null;

    if (CONTENT_CMDS.has(cmd)) {
      const h = heavy(ops);
      if (h) return { kind: 'deny', info: h };
    } else if (cmd === 'ls' && hasRecursiveFlag(args)) {
      const h = heavy(ops);
      if (h) return { kind: 'deny', info: { ...h, listing: true } };
    } else if (LISTING_CMDS.has(cmd)) {
      // find : chemins = arguments avant la première expression (-name, !, ( …).
      const end = args.findIndex((a) => /^[-(!]/.test(a));
      const h = heavy(cmd === 'find' ? operands(end < 0 ? args : args.slice(0, end)) : ops);
      if (h) return { kind: 'deny', info: { ...h, listing: true } };
    } else if (cmd === 'head' || cmd === 'tail') {
      const h = heavy(ops);
      if (h) {
        const n = lineCount(args);
        if (n == null || n > cfg.targetedReadMaxLines) return { kind: 'deny', info: h };
        warn = warn || { kind: 'warn', info: h };
      }
    } else if (GREP_CMDS.has(cmd)) {
      const eIdx = args.findIndex((a) => a === '-e' || a === '--regexp');
      const pattern = eIdx >= 0 ? args[eIdx + 1] : ops[0];
      const targets = eIdx >= 0 ? ops.filter((o) => o !== pattern) : ops.slice(1);
      const h = heavy(targets);
      if (h) {
        if (isVague(pattern)) return { kind: 'deny', info: h };
        warn = warn || { kind: 'warn', info: h };
      }
    }
  }
  return warn;
}

/**
 * Décision pour une entrée PreToolUse.
 * @returns {null | {kind: 'deny'|'warn', tool: string, info: {path, pattern, size, listing?}}}
 */
function check(input, cfg) {
  if (!cfg.heavyPaths || (!cfg.heavyPaths.length && !cfg.heavyFileBytes)) return null;
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  const cwd = input.cwd;
  let res = null;
  if (tool === 'Read') {
    const h = heavyInfo(ti.file_path, cwd, cfg);
    if (h) {
      const limit = Number(ti.limit);
      res = !ti.limit || !(limit <= cfg.targetedReadMaxLines) ? { kind: 'deny', info: h } : { kind: 'warn', info: h };
    }
  } else if (tool === 'Bash') {
    res = checkBash(ti.command, cwd, cfg);
  } else if (tool === 'Grep') {
    // Grep respecte déjà .gitignore : seulement quand le chemin vise explicitement un dossier lourd.
    const h = (ti.path && matchesHeavy(ti.path, cfg.heavyPaths) && heavyInfo(ti.path, cwd, cfg))
      || (ti.glob && matchesHeavy(ti.glob, cfg.heavyPaths) && { path: ti.glob, pattern: matchesHeavy(ti.glob, cfg.heavyPaths), size: null });
    if (h) res = isVague(ti.pattern) ? { kind: 'deny', info: h } : { kind: 'warn', info: h };
  } else if (tool === 'Glob') {
    const target = [ti.path, ti.pattern].find((p) => p && matchesHeavy(p, cfg.heavyPaths));
    if (target) {
      const info = { path: target, pattern: matchesHeavy(target, cfg.heavyPaths), size: null, listing: true };
      res = /\*\*/.test(ti.pattern || '') ? { kind: 'deny', info } : { kind: 'warn', info };
    }
  }
  return res ? { ...res, tool } : null;
}

// Octets évités par un refus : taille du fichier, plafonnée à la sortie maximale de l'outil.
function avoidedBytes(tool, info) {
  const cap = OUTPUT_CAP[tool] || 30000;
  return info.size != null && !info.listing ? Math.min(info.size, cap) : cap;
}

module.exports = { check, checkBash, matchesHeavy, splitCommand, avoidedBytes, isVague, DENY_REASON };
