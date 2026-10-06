'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { scan, sumByModel, TAIL_BYTES } = require('../lib/transcript');
const { sandbox, assistantLines, userLine, compactBoundaryLine, appendLines } = require('./helpers');

test('un usage compté par message.id malgré les lignes répétées', () => {
  const { transcript } = sandbox();
  appendLines(transcript, [userLine('bonjour'), ...assistantLines({ input: 10, cache_creation: 1000, cache_read: 5000, output: 50 }, { blocks: 4 })]);
  const res = scan(transcript, {});
  assert.strictEqual(res.calls.length, 1);
  assert.strictEqual(res.last.context, 10 + 1000 + 5000 + 50);
});

test('lecture incrémentale : seule la suite est lue, pas de double comptage', () => {
  const { transcript } = sandbox();
  appendLines(transcript, assistantLines({ output: 1 }));
  const first = scan(transcript, {});
  assert.strictEqual(first.calls.length, 1);
  appendLines(transcript, [...assistantLines({ output: 2 }), ...assistantLines({ output: 3 })]);
  const second = scan(transcript, first.cursor);
  assert.deepStrictEqual(second.calls.map((c) => c.output), [2, 3]);
  const third = scan(transcript, second.cursor);
  assert.strictEqual(third.calls.length, 0);
});

test('ligne incomplète en fin de fichier : relue au passage suivant', () => {
  const { transcript } = sandbox();
  const [a, b] = assistantLines({ output: 7 });
  fs.writeFileSync(transcript, `${a}\n${b.slice(0, 40)}`);
  const first = scan(transcript, {});
  assert.strictEqual(first.calls.length, 1);
  fs.appendFileSync(transcript, `${b.slice(40)}\n`);
  const second = scan(transcript, first.cursor);
  assert.strictEqual(second.calls.length, 0, 'même message.id : déjà compté');
  assert.strictEqual(second.cursor.offset, fs.statSync(transcript).size);
});

test('sans état : seuls les 256 derniers Ko sont lus', () => {
  const { transcript } = sandbox();
  const filler = userLine('x'.repeat(10000));
  appendLines(transcript, assistantLines({ output: 999 }));
  appendLines(transcript, Array(40).fill(filler));
  appendLines(transcript, assistantLines({ output: 1 }));
  assert.ok(fs.statSync(transcript).size > TAIL_BYTES);
  const res = scan(transcript, {});
  assert.deepStrictEqual(res.calls.map((c) => c.output), [1]);
});

test('lignes de sous-agent ignorées dans le transcript principal', () => {
  const { transcript } = sandbox();
  appendLines(transcript, [...assistantLines({ output: 5 }, { sidechain: true }), ...assistantLines({ output: 6 })]);
  assert.deepStrictEqual(scan(transcript, {}).calls.map((c) => c.output), [6]);
  assert.strictEqual(scan(transcript, {}, { sidechain: true }).calls.length, 2);
});

test('TTL lu dans cache_creation : 1 h ou 5 min', () => {
  const { transcript } = sandbox();
  appendLines(transcript, assistantLines({ cache_creation: 100 }, { ttl: '1h' }));
  assert.strictEqual(scan(transcript, {}).last.ttl, 60);
  appendLines(transcript, assistantLines({ cache_creation: 100 }, { ttl: '5m' }));
  assert.strictEqual(scan(transcript, {}).last.ttl, 5);
});

test('compact_boundary détecté', () => {
  const { transcript } = sandbox();
  appendLines(transcript, [compactBoundaryLine(), ...assistantLines({ output: 1 })]);
  assert.strictEqual(scan(transcript, {}).compacted, true);
});

test('sumByModel regroupe par modèle et mode rapide', () => {
  const { transcript } = sandbox();
  appendLines(transcript, [
    ...assistantLines({ input: 1, output: 10 }, { model: 'claude-opus-5-5' }),
    ...assistantLines({ input: 2, output: 20 }, { model: 'claude-opus-5-5' }),
    ...assistantLines({ input: 3, output: 30 }, { model: 'claude-sonnet-5-5' }),
  ]);
  const groups = sumByModel(scan(transcript, {}).calls);
  assert.deepStrictEqual(groups.map((g) => [g.model, g.input, g.output, g.calls]), [
    ['claude-opus-5-5', 3, 30, 2],
    ['claude-sonnet-5-5', 3, 30, 1],
  ]);
});
