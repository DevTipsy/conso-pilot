'use strict';
// Journal mensuel (spec §8.1) : ~/.claude/conso-pilot/log-AAAA-MM.jsonl, une ligne JSON par événement.
const fs = require('fs');
const path = require('path');
const { dataDir, ensureDir } = require('./util');

function monthKey(date) {
  return date.toISOString().slice(0, 7);
}

function logPath(date = new Date()) {
  return path.join(dataDir(), `log-${monthKey(date)}.jsonl`);
}

// Ajout simple : lignes < 4 Ko, atomiques en mode append.
function append(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  ensureDir(dataDir());
  fs.appendFileSync(logPath(), `${line}\n`);
}

// Lignes du journal dont ts ≥ since (lit les fichiers mensuels concernés).
function readSince(since) {
  const out = [];
  const months = new Set();
  for (let d = new Date(since); d <= new Date(); d.setUTCDate(d.getUTCDate() + 1)) months.add(monthKey(d));
  months.add(monthKey(new Date()));
  const sinceIso = since.toISOString();
  for (const m of [...months].sort()) {
    let text;
    try {
      text = fs.readFileSync(path.join(dataDir(), `log-${m}.jsonl`), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const o = JSON.parse(line);
        if (o.ts >= sinceIso) out.push(o);
      } catch {
        // ligne tronquée : ignorée
      }
    }
  }
  return out;
}

module.exports = { append, readSince, logPath };
