'use strict';
// Lecture des réglages effectifs de Claude Code (utilisateur < projet < local), en lecture seule.
const path = require('path');
const { claudeHome, readJson } = require('./util');

function settingsFiles(project) {
  const files = [path.join(claudeHome(), 'settings.json')];
  if (project) {
    files.push(path.join(project, '.claude', 'settings.json'));
    files.push(path.join(project, '.claude', 'settings.local.json'));
  }
  return files;
}

// Valeur d'une clé de premier niveau ; la dernière source (la plus spécifique) l'emporte.
function setting(project, key) {
  let value;
  for (const f of settingsFiles(project)) {
    const s = readJson(f, null);
    if (s && s[key] !== undefined) value = s[key];
  }
  return value;
}

// enabledPlugins fusionné (utilisateur puis projet).
function enabledPlugins(project) {
  const out = {};
  for (const f of settingsFiles(project)) {
    const s = readJson(f, null);
    if (s && s.enabledPlugins && typeof s.enabledPlugins === 'object') Object.assign(out, s.enabledPlugins);
  }
  return out;
}

function isContextModeActive(project) {
  return Object.entries(enabledPlugins(project)).some(([k, v]) => k.startsWith('context-mode@') && v === true);
}

module.exports = { setting, enabledPlugins, isContextModeActive, settingsFiles };
