'use strict';
// Utilitaires communs : chemins, écritures atomiques, journal d'erreurs.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ERRORS_MAX_BYTES = 1024 * 1024;

function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function dataDir() {
  return process.env.CONSO_PILOT_HOME || path.join(claudeHome(), 'conso-pilot');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Fichier temporaire + rename : jamais de fichier à moitié écrit.
function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function writeTextAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function logError(err, context = '') {
  try {
    const file = path.join(ensureDir(dataDir()), 'errors.log');
    const msg = err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err);
    fs.appendFileSync(file, `${new Date().toISOString()} ${context} ${msg}\n`);
    const { size } = fs.statSync(file);
    if (size > ERRORS_MAX_BYTES) {
      // On garde la seconde moitié, à partir d'un début de ligne.
      const buf = fs.readFileSync(file);
      const keep = buf.subarray(buf.indexOf(10, size - ERRORS_MAX_BYTES / 2) + 1);
      fs.writeFileSync(file, keep);
    }
  } catch {
    // Rien à faire : le journal d'erreurs ne doit jamais casser un hook.
  }
}

// Même règle que ~/.claude/projects/ : « / » et « . » remplacés par « - ».
function projectSlug(projectPath) {
  return String(projectPath || 'inconnu').replace(/[/.]/g, '-');
}

function shortId(sessionId) {
  return String(sessionId || '').slice(0, 8);
}

module.exports = {
  claudeHome, dataDir, ensureDir, readJson, writeJsonAtomic, writeTextAtomic, logError, projectSlug, shortId,
};
