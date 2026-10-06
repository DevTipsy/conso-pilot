#!/usr/bin/env node
// Sonde du lot 0 : enregistre l'entrée brute de chaque hook dans ~/.claude/conso-pilot/probe/<événement>.jsonl.
// Fail-open : toute erreur → sortie 0 sans rien afficher.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(os.homedir(), '.claude', 'conso-pilot', 'probe');

function main() {
  const raw = fs.readFileSync(0, 'utf8');
  const input = JSON.parse(raw);
  const event = input.hook_event_name || 'unknown';
  fs.mkdirSync(DIR, { recursive: true });
  const rec = { ts: new Date().toISOString(), ...input };
  if (typeof rec.prompt === 'string' && rec.prompt.length > 500) rec.prompt = rec.prompt.slice(0, 500) + '…';
  if (typeof rec.last_assistant_message === 'string' && rec.last_assistant_message.length > 300) {
    rec.last_assistant_message = rec.last_assistant_message.slice(0, 300) + '…';
  }
  fs.appendFileSync(path.join(DIR, `${event}.jsonl`), JSON.stringify(rec) + '\n');

  // Test [L0-2] : bloque une fois un prompt contenant SONDE-BLOQUE ; le même texte renvoyé passe.
  if (event === 'UserPromptSubmit' && /SONDE-BLOQUE/.test(input.prompt || '')) {
    const hash = crypto.createHash('sha1').update(input.prompt).digest('hex');
    const marker = path.join(DIR, `blocked-${input.session_id}`);
    const last = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
    if (last === hash) {
      fs.unlinkSync(marker);
      return;
    }
    fs.writeFileSync(marker, hash);
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: '[sonde conso-pilot] Message bloqué volontairement. Ton texte est-il encore dans le champ de saisie (ou récupérable avec ↑) ? Renvoie-le tel quel : il passera.',
    }));
  }
}

try { main(); } catch (e) { /* fail-open */ }
process.exit(0);
