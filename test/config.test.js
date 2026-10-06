'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { sandbox, useEnv } = require('./helpers');
const { DEFAULTS, loadConfig, resetConfigCache, configPath, merge } = require('../lib/config');

test('config créée avec les défauts au premier lancement', () => {
  useEnv(sandbox({ advice: true }).env);
  const cfg = loadConfig();
  assert.deepStrictEqual(cfg, merge(DEFAULTS, {}));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(configPath(), 'utf8')), JSON.parse(JSON.stringify(DEFAULTS)));
});

test('clés inconnues ignorées, manquantes complétées, types incohérents remplacés', () => {
  useEnv(sandbox().env);
  fs.mkdirSync(require('path').dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify({
    handoffAt: 30000,
    inconnue: 1,
    notifications: 'oui',
    cacheTtlMinutes: 5,
    costWeights: { models: { opus: 3, mythos: 8 } },
  }));
  resetConfigCache();
  const cfg = loadConfig();
  assert.strictEqual(cfg.handoffAt, 30000);
  assert.strictEqual(cfg.inconnue, undefined);
  assert.strictEqual(cfg.notifications, true);
  assert.strictEqual(cfg.cacheTtlMinutes, 5);
  assert.deepStrictEqual(cfg.costWeights.models, { fable: 4, opus: 3, sonnet: 1, haiku: 0.5, mythos: 8 });
  assert.strictEqual(cfg.costWeights.outputRatio, 5);
});
