#!/usr/bin/env node
// Barre d'état de test du lot 0 : enregistre le dernier JSON reçu et affiche une ligne reconnaissable.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.claude', 'conso-pilot', 'probe');

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'statusline-latest.json'), JSON.stringify({ ts: new Date().toISOString(), ...input }, null, 2));
  fs.appendFileSync(path.join(DIR, 'statusline-calls.log'), `${new Date().toISOString()} ${input.session_id || '?'}\n`);
  const model = input.model?.display_name || '?';
  const effort = input.effort?.level || '?';
  const ctx = input.context_window?.current_usage;
  const used = ctx ? Math.round((ctx.input_tokens + ctx.cache_creation_input_tokens + ctx.cache_read_input_tokens) / 1000) + 'k' : '?';
  process.stdout.write(`🔬 SONDE conso-pilot · ${model}·${effort} · ctx ${used}`);
} catch (e) {
  process.stdout.write('🔬 SONDE conso-pilot');
}
