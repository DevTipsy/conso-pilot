'use strict';
// Handoff et sauvegarde de l'historique (spec §5) :
//   handoffs/<slug>/AAAA-MM-JJ_HHMM_<session8>.md  handoff manuel (/handoff)
//   handoffs/<slug>/latest.md                      copie du dernier handoff manuel, seul fichier relu automatiquement
//   handoffs/<slug>/auto/<session8>.md             sauvegarde automatique, une par session, réécrite sur place
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { dataDir, writeTextAtomic, projectSlug, shortId } = require('./util');

const DATED_RE = /^\d{4}-\d{2}-\d{2}_\d{4}_[^/]*\.md$/;
const CHARS_PER_TOKEN = 4;

function projectDir(project) {
  return path.join(dataDir(), 'handoffs', projectSlug(project));
}

function latestPath(project) {
  return path.join(projectDir(project), 'latest.md');
}

function autoPath(project, sessionId) {
  return path.join(projectDir(project), 'auto', `${shortId(sessionId)}.md`);
}

function summaryPath(autoFile) {
  return autoFile.replace(/\.md$/, '.summary.md');
}

// --- En-tête YAML (valeurs écrites en JSON, qui est du YAML valide).
function frontMatter(meta) {
  const lines = Object.entries(meta).map(([k, v]) => `${k}: ${v == null ? 'null' : JSON.stringify(v)}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

function parseDoc(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { meta: {}, body: text.trim() };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const raw = line.slice(i + 1).trim();
    try {
      meta[line.slice(0, i).trim()] = JSON.parse(raw);
    } catch {
      meta[line.slice(0, i).trim()] = raw;
    }
  }
  return { meta, body: text.slice(m[0].length).trim() };
}

function readDoc(file) {
  let text;
  let stat;
  try {
    text = fs.readFileSync(file, 'utf8');
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const doc = parseDoc(text);
  const created = Date.parse(doc.meta.created);
  doc.createdMs = Number.isNaN(created) ? stat.mtimeMs : created;
  doc.file = file;
  return doc;
}

// Objectif : première ligne non vide sous le titre « Objectif ».
function extractObjectif(text) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => /^#+\s*objectif/i.test(l.trim()));
  if (i < 0) return null;
  for (const l of lines.slice(i + 1)) {
    const t = l.trim();
    if (/^#/.test(t)) break;
    if (t) return oneLine(t.replace(/^[-*]\s*/, ''));
  }
  return null;
}

function oneLine(text, max = 160) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function localStamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}`;
}

function displayDate(ms) {
  return new Date(ms).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

// --- Rétention (§5.1) : au plus une fois par jour et par projet ; latest.md n'est jamais supprimé.
function pruneDir(dir, keep, cfg, now) {
  let names;
  try {
    names = fs.readdirSync(dir).filter(keep);
  } catch {
    return;
  }
  const files = names.map((n) => {
    const file = path.join(dir, n);
    try {
      return { file, mtime: fs.statSync(file).mtimeMs };
    } catch {
      return null;
    }
  }).filter(Boolean).sort((a, b) => b.mtime - a.mtime);
  const limit = now - cfg.retentionDays * 86400000;
  files.forEach((f, i) => {
    if (i < cfg.retentionMaxFiles && f.mtime >= limit) return;
    for (const victim of [f.file, summaryPath(f.file)]) {
      try {
        fs.unlinkSync(victim);
      } catch {
        // déjà supprimé
      }
    }
  });
}

function applyRetention(project, cfg, now = Date.now()) {
  const dir = projectDir(project);
  const marker = path.join(dir, '.retention');
  const today = new Date(now).toISOString().slice(0, 10);
  try {
    if (fs.readFileSync(marker, 'utf8') === today) return;
  } catch {
    // jamais fait
  }
  pruneDir(dir, (n) => DATED_RE.test(n), cfg, now);
  pruneDir(path.join(dir, 'auto'), (n) => n.endsWith('.md') && !n.endsWith('.summary.md'), cfg, now);
  writeTextAtomic(marker, today);
}

// --- Handoff manuel (§5.2), écrit par bin/save-handoff.
function saveHandoff({ text, sessionId, project, contextTokens, cfg, now = new Date() }) {
  const body = parseDoc(String(text || '')).body; // en-tête éventuel de Claude ignoré
  if (!body) throw new Error('handoff vide');
  const meta = {
    created: now.toISOString(),
    session: sessionId || null,
    project,
    objectif: extractObjectif(body),
    context_tokens: contextTokens ?? null,
  };
  const doc = `${frontMatter(meta)}\n${body}\n`;
  const file = path.join(projectDir(project), `${localStamp(now)}_${shortId(sessionId) || 'inconnu'}.md`);
  writeTextAtomic(file, doc);
  writeTextAtomic(latestPath(project), doc);
  applyRetention(project, cfg, now.getTime());
  return { file, meta };
}

// --- Sauvegarde automatique (§5.3) : rendu mécanique de l'activité extraite du transcript.
function relPath(file, project) {
  if (project && file.startsWith(`${project}/`)) return file.slice(project.length + 1);
  return file;
}

const TODO_MARK = { completed: '[x]', in_progress: '[~]', pending: '[ ]' };

function renderAuto(st, now) {
  const act = st.activity;
  const meta = {
    created: (st.autoSave && st.autoSave.createdAt) || now.toISOString(),
    updated: now.toISOString(),
    session: st.session,
    project: st.project,
    objectif: act.firstPrompt ? oneLine(act.firstPrompt) : null,
    context_tokens: st.lastContext ?? null,
  };
  const out = [`# Sauvegarde automatique — session ${shortId(st.session)}`, ''];
  if (st.blockedPrompt) {
    out.push('## Message en attente (bloqué avant envoi — à traiter en premier)', st.blockedPrompt, '');
  }
  out.push(`## Dernières demandes (${act.prompts.length})`);
  act.prompts.forEach((p, i) => out.push(`${i + 1}. ${p.text.replace(/\n+/g, '\n   ')}`));
  if (act.files.length) {
    out.push('', '## Fichiers créés ou modifiés');
    for (const f of act.files) out.push(`- \`${relPath(f, st.project)}\``);
  }
  if (act.todos.length) {
    out.push('', '## Liste de tâches');
    for (const t of act.todos) out.push(`- ${TODO_MARK[t.status] || '[ ]'} ${t.content}`);
  }
  if (act.errors.length) {
    out.push('', '## Commandes en erreur');
    for (const e of act.errors) {
      out.push(`- \`${oneLine(e.cmd, 200)}\``);
      if (e.lines.length) out.push('  ```', ...e.lines.map((l) => `  ${l}`), '  ```');
    }
  }
  return `${frontMatter(meta)}\n${out.join('\n')}\n`;
}

function hasActivity(st) {
  const a = st.activity;
  return Boolean(st.blockedPrompt || (a && (a.prompts.length || a.files.length || a.todos.length || a.errors.length)));
}

/**
 * Écrit auto/<session8>.md si l'intervalle est écoulé (ou si `force`). Renvoie le chemin écrit, sinon null.
 * L'état est modifié (autoSave) mais pas enregistré : à l'appelant de le faire.
 */
function autoSave(st, cfg, { force = false, now = new Date() } = {}) {
  if (!st.project || !st.session || !hasActivity(st)) return null;
  const last = st.autoSave && st.autoSave.savedAt ? Date.parse(st.autoSave.savedAt) : 0;
  if (!force && now.getTime() - last < cfg.autoSaveEveryMinutes * 60000) return null;
  const file = autoPath(st.project, st.session);
  writeTextAtomic(file, renderAuto(st, now));
  st.autoSave = { createdAt: (st.autoSave && st.autoSave.createdAt) || now.toISOString(), savedAt: now.toISOString() };
  applyRetention(st.project, cfg, now.getTime());
  if (force && cfg.aiSummary) spawnSummary(file);
  return file;
}

// Résumé IA optionnel (aiSummary) : processus détaché, jamais attendu.
function spawnSummary(autoFile) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'ai-summary'), autoFile], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CONSO_PILOT_DISABLE: '1' },
  });
  child.unref();
}

// --- Relecture (§5.4).
function truncate(body, maxTokens) {
  const max = maxTokens * CHARS_PER_TOKEN;
  if (body.length <= max) return body;
  const cut = body.lastIndexOf('\n', max);
  return `${body.slice(0, cut > max / 2 ? cut : max)}\n\n… (tronqué à ~${maxTokens} tokens)`;
}

function injectionText(doc, cfg, label = 'handoff') {
  return `Reprise de la session précédente (${label} du ${displayDate(doc.createdMs)})\n\n${truncate(doc.body, cfg.resumeMaxTokens)}`;
}

function approxTokens(text) {
  return Math.round(text.length / CHARS_PER_TOKEN);
}

function readLatest(project) {
  return readDoc(latestPath(project));
}

// Sauvegarde auto la plus récente du projet, hors session courante (vide juste après un /clear).
function readLatestAuto(project, excludeSession) {
  const dir = path.join(projectDir(project), 'auto');
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md') && !n.endsWith('.summary.md'));
  } catch {
    return null;
  }
  const exclude = excludeSession ? `${shortId(excludeSession)}.md` : null;
  const docs = names.map((n) => ({ n, mtime: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
  const pick = docs.find((d) => d.n !== exclude) || docs[0];
  if (!pick) return null;
  const doc = readDoc(path.join(dir, pick.n));
  if (doc) {
    try {
      doc.body += `\n\n## Résumé IA\n${fs.readFileSync(summaryPath(doc.file), 'utf8').trim()}`;
    } catch {
      // pas de résumé IA
    }
  }
  return doc;
}

module.exports = {
  projectDir, latestPath, autoPath, summaryPath, parseDoc, readDoc, extractObjectif, saveHandoff, autoSave, renderAuto,
  applyRetention, injectionText, approxTokens, readLatest, readLatestAuto, displayDate, oneLine,
};
