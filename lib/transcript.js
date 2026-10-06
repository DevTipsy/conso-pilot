'use strict';
// Lecture incrémentale des transcripts (spec §1) : on ne lit que les octets ajoutés depuis l'offset
// mémorisé ; sans offset, seulement les 256 derniers Ko. Un `usage` compté par `message.id`.
const fs = require('fs');
const inventory = require('./inventory');

const TAIL_BYTES = 256 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const SEEN_IDS_MAX = 200;

// Renvoie les lignes complètes ajoutées depuis `offset` et le nouvel offset (fin de la dernière ligne complète).
function readNewLines(file, offset) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return { lines: [], offset: offset ?? 0, missing: true };
  }
  try {
    const { size } = fs.fstatSync(fd);
    let start = offset;
    let partialFirst = false;
    if (start == null || start > size) {
      // Pas d'état, ou fichier réécrit : on repart de la fin.
      start = Math.max(0, size - TAIL_BYTES);
      partialFirst = start > 0;
    } else if (size - start > MAX_CHUNK_BYTES) {
      start = size - MAX_CHUNK_BYTES;
      partialFirst = true;
    }
    if (size <= start) return { lines: [], offset: start };
    const buf = Buffer.allocUnsafe(size - start);
    let read = 0;
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, buf.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    const lastNl = buf.lastIndexOf(10, read - 1);
    if (lastNl < 0) return { lines: [], offset: start };
    let from = 0;
    if (partialFirst) from = buf.indexOf(10) + 1;
    const text = from <= lastNl ? buf.toString('utf8', from, lastNl) : '';
    return { lines: text ? text.split('\n') : [], offset: start + lastNl + 1 };
  } finally {
    fs.closeSync(fd);
  }
}

function toCall(o) {
  const m = o.message;
  const u = m.usage;
  const cc = u.cache_creation;
  const creation = u.cache_creation_input_tokens || 0;
  let c5m = 0;
  let c1h = 0;
  if (cc) {
    c5m = cc.ephemeral_5m_input_tokens || 0;
    c1h = cc.ephemeral_1h_input_tokens || 0;
  } else {
    c5m = creation; // ventilation absente : compté au tarif 5 min (le plus bas)
  }
  return {
    id: m.id,
    ts: o.timestamp,
    model: m.model,
    effort: o.effort || null,
    fast: u.speed ? u.speed === 'fast' : null,
    input: u.input_tokens || 0,
    c5m,
    c1h,
    cacheRead: u.cache_read_input_tokens || 0,
    output: u.output_tokens || 0,
    context: (u.input_tokens || 0) + creation + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0),
    ttl: c1h > 0 ? 60 : c5m > 0 ? 5 : null,
  };
}

// --- Activité de la session (sauvegarde automatique, spec §5.3) : extraite mécaniquement, sans IA.
const PROMPTS_MAX = 10;
const PROMPT_CHARS = 500;
const FILES_MAX = 100;
const ERRORS_MAX = 5;
const PENDING_BASH_MAX = 30;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

function newActivity() {
  return { firstPrompt: null, prompts: [], files: [], todos: [], nextTaskId: 1, errors: [], pendingBash: [] };
}

// Texte d'une demande de l'utilisateur ; null pour les messages techniques (résultats d'outils, rappels, méta).
function promptText(o) {
  if (o.isMeta || o.isSidechain) return null;
  if (o.origin && o.origin.kind && o.origin.kind !== 'human') return null;
  const c = o.message && o.message.content;
  let text;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b && b.type === 'tool_result')) return null;
    text = c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  } else return null;
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
    text = `${cmd[1].trim()} ${args ? args[1].trim() : ''}`;
  }
  text = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<(local-command-[\w-]+|command-message)>[\s\S]*?<\/\1>/g, '')
    .replace(/<\/?pasted_content[^>]*>/g, '')
    .trim();
  if (!text || text.startsWith('Caveat:') || text.startsWith('[Request interrupted')) return null;
  return text.length > PROMPT_CHARS ? `${text.slice(0, PROMPT_CHARS)}…` : text;
}

function resultLines(content) {
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
  return text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).map((l) => (l.length > 200 ? `${l.slice(0, 200)}…` : l));
}

function collectUser(act, o) {
  const c = o.message && o.message.content;
  if (Array.isArray(c)) {
    for (const b of c) {
      if (!b || b.type !== 'tool_result' || !b.is_error) continue;
      const pending = act.pendingBash.find((p) => p.id === b.tool_use_id);
      if (!pending) continue;
      act.errors.push({ cmd: pending.cmd, lines: resultLines(b.content), ts: o.timestamp || null });
      if (act.errors.length > ERRORS_MAX) act.errors.splice(0, act.errors.length - ERRORS_MAX);
    }
  }
  const text = promptText(o);
  if (!text) return;
  if (!act.firstPrompt) act.firstPrompt = text;
  act.prompts.push({ text, ts: o.timestamp || null });
  if (act.prompts.length > PROMPTS_MAX) act.prompts.splice(0, act.prompts.length - PROMPTS_MAX);
}

function collectToolUse(act, b) {
  const input = b.input || {};
  if (EDIT_TOOLS.has(b.name)) {
    const file = input.file_path || input.notebook_path;
    if (!file) return;
    const i = act.files.indexOf(file);
    if (i >= 0) act.files.splice(i, 1);
    act.files.push(file); // le plus récent en dernier
    if (act.files.length > FILES_MAX) act.files.shift();
  } else if (b.name === 'TodoWrite' && Array.isArray(input.todos)) {
    act.todos = input.todos.map((t) => ({ content: String(t.content || ''), status: t.status || 'pending' }));
  } else if (b.name === 'TaskCreate') {
    act.todos.push({ id: String(act.nextTaskId), content: String(input.subject || ''), status: 'pending' });
    act.nextTaskId += 1;
  } else if (b.name === 'TaskUpdate' && input.taskId != null) {
    const t = act.todos.find((x) => x.id === String(input.taskId));
    if (t && input.status === 'deleted') act.todos.splice(act.todos.indexOf(t), 1);
    else if (t && input.status) t.status = input.status;
    if (t && input.subject) t.content = String(input.subject);
  } else if (b.name === 'Bash' && b.id && input.command) {
    act.pendingBash.push({ id: b.id, cmd: String(input.command).slice(0, 300) });
    if (act.pendingBash.length > PENDING_BASH_MAX) act.pendingBash.shift();
  }
}

/**
 * Parcourt la suite du transcript.
 * @param {string} file
 * @param {{offset?: number, seenIds?: string[]}} cursor  état de lecture (mis à jour et renvoyé)
 * @param {{sidechain?: boolean, activity?: object, attachments?: object[]}} opts  sidechain=true pour un transcript de sous-agent ;
 *   activity : activité de la session, complétée sur place (demandes, fichiers, tâches, erreurs) ;
 *   attachments : reçoit les lignes d'inventaire du contexte chargé ({a, ts}, spec §6)
 * @returns {{calls: object[], last: object|null, lastMessage: object|null, compacted: boolean, cursor: object, missing?: boolean}}
 */
function scan(file, cursor = {}, opts = {}) {
  const { lines, offset, missing } = readNewLines(file, cursor.offset);
  const seen = new Set(cursor.seenIds || []);
  const seenOrder = [...(cursor.seenIds || [])];
  const calls = [];
  const act = opts.activity || null;
  // Dernier message assistant de la conversation principale : appel d'outil ? texte final ? (alerte §3.1)
  let lastMessage = cursor.lastMessage || null;
  let last = null;
  let compacted = false;

  for (const line of lines) {
    if (opts.attachments && inventory.attachmentType(line)) {
      try {
        const o = JSON.parse(line);
        const a = inventory.reduce(o.attachment);
        if (a && !o.isSidechain) opts.attachments.push({ a, ts: o.timestamp || null });
      } catch {
        // ligne illisible : ignorée
      }
      continue;
    }
    const isAssistant = line.includes('"assistant"');
    // Lignes utilisateur : demandes et erreurs seulement (les résultats d'outils réussis peuvent peser lourd).
    const isUser = act !== null && line.includes('"type":"user"')
      && (!line.includes('"tool_result"') || line.includes('"is_error":true'));
    if (!isAssistant && !isUser && !line.includes('compact_boundary')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      compacted = true;
      continue;
    }
    if (o.type === 'user' && act) {
      collectUser(act, o);
      continue;
    }
    if (o.type !== 'assistant' || !o.message || !o.message.usage || !o.message.id) continue;
    // Transcript principal : les lignes de sous-agents (anciennes versions) sont comptées par SubagentStop.
    if (!opts.sidechain && o.isSidechain) continue;
    // Un bloc de contenu par ligne : les appels d'outils se lisent avant le dédoublonnage par message.id.
    if (act && Array.isArray(o.message.content)) {
      for (const b of o.message.content) if (b && b.type === 'tool_use') collectToolUse(act, b);
    }
    if (!opts.sidechain && o.message.model !== '<synthetic>') {
      if (!lastMessage || lastMessage.id !== o.message.id) lastMessage = { id: o.message.id, tool: false, text: '' };
      for (const b of Array.isArray(o.message.content) ? o.message.content : []) {
        if (b && b.type === 'tool_use') lastMessage.tool = true;
        else if (b && b.type === 'text' && b.text) lastMessage.text = String(b.text).slice(-300);
      }
    }
    if (o.message.model === '<synthetic>') continue;
    if (seen.has(o.message.id)) continue;
    seen.add(o.message.id);
    seenOrder.push(o.message.id);
    const call = toCall(o);
    calls.push(call);
    last = call;
  }

  return {
    calls,
    last,
    compacted,
    missing,
    lastMessage,
    cursor: { offset, seenIds: seenOrder.slice(-SEEN_IDS_MAX), lastMessage },
  };
}

// Somme des appels, groupée par modèle (une ligne de journal par modèle et par tour).
function sumByModel(calls) {
  const groups = new Map();
  for (const c of calls) {
    const key = `${c.model}|${c.fast === true}`;
    let g = groups.get(key);
    if (!g) {
      g = { model: c.model, fast: c.fast === true, input: 0, cache_5m: 0, cache_1h: 0, cache_read: 0, output: 0, calls: 0, effort: c.effort };
      groups.set(key, g);
    }
    g.input += c.input;
    g.cache_5m += c.c5m;
    g.cache_1h += c.c1h;
    g.cache_read += c.cacheRead;
    g.output += c.output;
    g.calls += 1;
    if (c.effort) g.effort = c.effort;
  }
  return [...groups.values()];
}

module.exports = { scan, readNewLines, sumByModel, newActivity, promptText, TAIL_BYTES };
