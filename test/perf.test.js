'use strict';
// Critère 14 : sur un transcript de 50 Mo, chaque hook synchrone < 200 ms (p95 sur 20 exécutions).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { sandbox, runHook, assistantLines, userLine, appendLines } = require('./helpers');

const RUNS = 20;
const LIMIT_MS = 200;

function p95(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.ceil(0.95 * s.length) - 1];
}

function bigTranscript(file, bytes) {
  const block = [];
  const big = userLine('y'.repeat(20000));
  for (let i = 0; i < 20; i += 1) block.push(big, ...assistantLines({ cache_read: 50000, output: 300 }, { blocks: 3, tools: ['Read'] }));
  const chunk = `${block.join('\n')}\n`;
  const fd = fs.openSync(file, 'w');
  for (let written = 0; written < bytes; written += chunk.length) fs.writeSync(fd, chunk);
  fs.closeSync(fd);
}

test('Stop sur un transcript de 50 Mo : p95 < 200 ms, avec et sans état', () => {
  const sb = sandbox();
  bigTranscript(sb.transcript, 50 * 1024 * 1024);
  const timings = { sansEtat: [], incremental: [] };
  for (let i = 0; i < RUNS; i += 1) {
    const sid = `perf-${i}`;
    const base = { session_id: sid, transcript_path: sb.transcript, cwd: sb.env.CLAUDE_PROJECT_DIR, hook_event_name: 'Stop' };
    timings.sansEtat.push(runHook(sb.env, base).ms);
    appendLines(sb.transcript, [userLine('suite'), ...assistantLines({ cache_read: 60000, output: 200 })]);
    timings.incremental.push(runHook(sb.env, base).ms);
  }
  for (const [name, values] of Object.entries(timings)) {
    const v = p95(values);
    assert.ok(v < LIMIT_MS, `${name} : p95 = ${v.toFixed(0)} ms`);
  }
});

test('SessionStart, PreCompact, SessionEnd : p95 < 200 ms', () => {
  const sb = sandbox();
  bigTranscript(sb.transcript, 50 * 1024 * 1024);
  for (const [event, extra] of [['SessionStart', { source: 'startup' }], ['UserPromptSubmit', { prompt: 'x' }], ['PreToolUse', { tool_name: 'Bash', tool_input: { command: 'cat node_modules/x && ls -R build' } }], ['PreCompact', { trigger: 'auto' }], ['SessionEnd', { reason: 'clear' }]]) {
    const values = [];
    for (let i = 0; i < RUNS; i += 1) {
      values.push(runHook(sb.env, { session_id: 'perf', transcript_path: sb.transcript, hook_event_name: event, ...extra }).ms);
    }
    assert.ok(p95(values) < LIMIT_MS, `${event} : p95 = ${p95(values).toFixed(0)} ms`);
  }
});
