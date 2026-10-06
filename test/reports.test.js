'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { sandbox, useEnv, runHook, assistantLines, userLine, appendLines } = require('./helpers');

function session(sb, sid, turns, opts) {
  const transcript = path.join(sb.dir, `${sid}.jsonl`);
  for (const usage of turns) {
    appendLines(transcript, [userLine('x'), ...assistantLines(usage, opts)]);
    runHook(sb.env, { session_id: sid, transcript_path: transcript, cwd: sb.env.CLAUDE_PROJECT_DIR, hook_event_name: 'Stop', effort: { level: 'medium' } });
  }
}

test('/conso : chiffres par projet et modèle, bruts et pondérés (critère 16, sans gains)', () => {
  const sb = sandbox();
  useEnv(sb.env);
  session(sb, 'aaaaaaaa-1', [{ input: 1000, cache_creation: 0, cache_read: 0, output: 0 }], { model: 'claude-opus-5-5' });
  session(sb, 'bbbbbbbb-2', [{ input: 1000, cache_creation: 0, cache_read: 0, output: 200 }], { model: 'claude-sonnet-5-5' });
  const agentFile = path.join(sb.dir, 'agent.jsonl');
  appendLines(agentFile, assistantLines({ input: 500, output: 0 }, { model: 'claude-haiku-4-5', sidechain: true }));
  runHook(sb.env, { session_id: 'bbbbbbbb-2', agent_id: 'r1', agent_type: 'runner', agent_transcript_path: agentFile, hook_event_name: 'SubagentStop' });

  const { buildConsoReport } = require('../lib/report-conso');
  const out = buildConsoReport();
  // Opus : 1000 × 2 = 2000 pondérés ; Sonnet : (1000 + 5 × 200) × 1 = 2000 ; Haiku : 500 × 0,5 = 250.
  assert.match(out, /\| projet \| opus \| 1k \| 2k \| 1k \| 2k \| 1 \|/);
  assert.match(out, /\| projet \| sonnet \| 1k \| 2k \| 1k \| 2k \| 1 \|/);
  assert.match(out, /\| projet \| haiku \| 500 \| 250 \| 500 \| 250 \| 0 \|/);
  assert.match(out, /Sous-agents : 6 % \(runner 6 %\)/);
  assert.match(out, /\| aaaaaaaa \| projet \| 2k \| 1k \| 1 \|/);
});

test('/conso sans données : message explicite', () => {
  const sb = sandbox();
  useEnv(sb.env);
  assert.match(require('../lib/report-conso').buildConsoReport(), /Aucune donnée/);
});

test('/conso-pilot:status : config, session, intégrations, erreurs', () => {
  const sb = sandbox({ advice: true });
  useEnv(sb.env);
  session(sb, 'cccccccc-3', [{ cache_creation: 20000, output: 0 }, { cache_read: 20000, cache_creation: 15000, output: 0 }]);
  fs.writeFileSync(path.join(sb.env.CONSO_PILOT_HOME, 'errors.log'), '2026-10-06T00:00:00Z Stop Error: boum\n');
  const { buildStatusReport } = require('../lib/report-status');
  const out = buildStatusReport({ sessionId: 'cccccccc-3', project: sb.env.CLAUDE_PROJECT_DIR });
  assert.match(out, /Clés modifiées : aucune/);
  assert.match(out, /Modèle : claude-opus-5-5 \(transcript\) · effort : medium \(Stop\)/);
  assert.match(out, /Contexte : 35k \/ 200k · baseline 20k · ajouté \+15k/);
  assert.match(out, /cache 60 min \(transcript\), expire dans (59|60) min/);
  assert.match(out, /Error: boum/);
  // Sans identifiant de session : dernière session du projet.
  assert.match(buildStatusReport({ project: sb.env.CLAUDE_PROJECT_DIR }), /Session : `cccccccc`/);
});
