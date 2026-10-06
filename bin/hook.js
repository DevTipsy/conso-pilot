#!/usr/bin/env node
'use strict';
// Point d'entrée unique des hooks : aiguillage sur hook_event_name.
// Fail-open (spec §1) : toute exception → code 0, rien sur la sortie standard, trace dans errors.log.
const fs = require('fs');
const { logError } = require('../lib/util');

let event = '?';
try {
  // Sessions lancées par le plugin lui-même (résumé IA) : aucun hook.
  if (process.env.CONSO_PILOT_DISABLE) process.exit(0);
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  event = input.hook_event_name || '?';
  const handler = require('../lib/handlers')[event];
  if (handler) {
    const out = handler(input);
    if (out) process.stdout.write(JSON.stringify(out));
  }
} catch (err) {
  logError(err, event);
}
process.exit(0);
