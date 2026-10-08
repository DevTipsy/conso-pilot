'use strict';
// Gestionnaires des hooks : mesure, état de session, journal (lot 1) ; sauvegarde auto et relecture (lot 2) ;
// alertes « handoff » et « cache expiré » (lot 3, §3) ; dossiers lourds (lot 4, §7).
// Sorties : relecture du handoff (SessionStart, §5.4), systemMessage ou blocage des alertes (§3),
// refus d'un accès large à un dossier lourd (PreToolUse, §7).
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const state = require('./state');
const journal = require('./journal');
const { scan, sumByModel } = require('./transcript');
const { measureMain, applyTtl, parseTtl, fillFromSettings } = require('./measure');
const { readJson, writeJsonAtomic } = require('./util');
const handoff = require('./handoff');
const { isContextModeActive } = require('./settings');
const { tokens } = require('./format');
const alerts = require('./alerts');
const { recordPluginRoot } = require('./setup');
const heavy = require('./heavy');
const inventory = require('./inventory');
const lean = require('./lean');
const advice = require('./advice');

// Consigne de délégation (§9.1), injectée au début d'une discussion (≤ 80 tokens).
const DELEGATION_HINT = 'Délègue les recherches larges à Explore, les builds et tests à runner, les décisions difficiles à architect ; fais toi-même les petites tâches.';

function logTurns(calls, base, context) {
  for (const g of sumByModel(calls)) {
    journal.append({
      type: 'turn',
      ...base,
      model: g.model,
      effort: g.effort || base.effort || null,
      fast: g.fast,
      input: g.input,
      cache_5m: g.cache_5m,
      cache_1h: g.cache_1h,
      cache_read: g.cache_read,
      output: g.output,
      context,
      calls: g.calls,
    });
  }
}

// Appels de la conversation principale lus hors Stop (PreCompact, SessionEnd) : journalisés aussi,
// sinon le curseur avancé les ferait disparaître du journal.
function logMain(st, calls) {
  if (!calls.length) return;
  logTurns(calls, { project: st.project, session: st.session, agent: 'main', effort: st.effort && st.effort.value }, st.lastContext);
}

// Relecture du dernier handoff manuel (§5.4) ; la sauvegarde auto n'est jamais injectée.
function resumeOutput(source, sessionId, project, cfg, now = Date.now()) {
  if (source === 'resume' || source === 'fork') return null;
  const doc = handoff.readLatest(project);
  if (!doc) return null;
  const age = now - doc.createdMs;
  let inject;
  if (source === 'compact') {
    // context-mode réinjecte déjà son propre résumé après un compactage.
    if (isContextModeActive(project) || doc.meta.session !== sessionId) return null;
    inject = true;
  } else if (source === 'clear') {
    inject = age < cfg.clearResumeMinutes * 60000;
  } else {
    inject = age < cfg.autoResumeHours * 3600000;
  }
  const what = `Handoff du ${handoff.displayDate(doc.createdMs)}`;
  const objectif = doc.meta.objectif ? ` : ${doc.meta.objectif}` : '';
  if (!inject) return { systemMessage: `${what} disponible${objectif} — tape /resume pour le charger.` };
  const text = handoff.injectionText(doc, cfg);
  return {
    systemMessage: `${what} rechargé (~${tokens(handoff.approxTokens(text))} tokens)${objectif}.`,
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
  };
}

function SessionStart(input) {
  const cfg = loadConfig();
  const source = input.source || 'startup';
  // /clear crée une nouvelle session : l'état neuf remesure la baseline à la première réponse.
  let st = state.loadState(input.session_id);
  if (!st) {
    st = state.newState(input);
    // Discussion neuve : lecture depuis le début, pour relever l'inventaire du contexte chargé (§6).
    if (source === 'startup' || source === 'clear') st.cursor = { offset: 0 };
  }
  if (input.transcript_path) st.transcript = input.transcript_path;
  if (source === 'compact') st.baselinePending = true;
  if (typeof input.context_tokens === 'number') st.lastContext = input.context_tokens;
  if (input.model) st.model = { value: input.model, source: 'SessionStart' };
  fillFromSettings(st);
  applyTtl(st, cfg, null, null);
  state.saveState(st);
  state.pruneStates();
  recordPluginRoot(); // pour les lanceurs stables de la barre d'état et de save-handoff
  let out = resumeOutput(source, input.session_id, st.project, cfg);
  if (cfg.delegationHint && (source === 'startup' || source === 'clear')) {
    const prev = out && out.hookSpecificOutput ? out.hookSpecificOutput.additionalContext : null;
    out = { ...(out || {}), hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: prev ? `${prev}\n\n${DELEGATION_HINT}` : DELEGATION_HINT } };
  }
  const cacheMsg = alerts.resumeCacheMessage(input, cfg);
  if (!cacheMsg) return out;
  alerts.notify(cacheMsg, cfg);
  return out && out.systemMessage ? { ...out, systemMessage: `${out.systemMessage}\n${cacheMsg}` } : { ...(out || {}), systemMessage: cacheMsg };
}

function Stop(input) {
  const cfg = loadConfig();
  const st = state.applyLive(state.loadOrCreate(input));
  const attachments = [];
  const calls = measureMain(st, cfg, input.transcript_path, attachments);
  // L'entrée Stop porte l'effort actif : source plus fiable que le transcript.
  if (input.effort && input.effort.level) st.effort = { value: input.effort.level, source: 'Stop' };
  fillFromSettings(st);
  if (calls.length) st.turns += 1;
  logMain(st, calls);
  handoff.autoSave(st, cfg); // au plus toutes les autoSaveEveryMinutes
  const alert = alerts.handoffOnStop(input, st, cfg); // §3.1, déclencheur A
  state.saveState(st);
  // Contexte chargé (§6) : inventaire relevé dans le transcript, alerte une fois par jour et par projet.
  const leanMsg = attachments.length ? lean.warnOnce(st.project, inventory.record(st.project, st.session, attachments), cfg) : null;
  if (alert) alerts.notify(alert, cfg);
  if (!alert && !leanMsg) return null;
  return { systemMessage: [alert, leanMsg].filter(Boolean).join('\n') }; // jamais de decision: "block" sur Stop
}

// Avant chaque message : plafond du handoff (§3.1, déclencheur B), pause plus longue que le cache (§3.3),
// conseils de modèle et d'effort (§9.2). Aucune lecture de transcript : l'état du dernier Stop suffit.
function UserPromptSubmit(input) {
  const st = state.loadState(input.session_id);
  if (!st) return null;
  const cfg = loadConfig();
  state.applyLive(st);
  advice.fillFromLaunch(st);
  const cache = alerts.cacheOnPrompt(input, st, cfg);
  const force = alerts.handoffOnPrompt(st, cfg);
  if (cache) alerts.notify(cache.text, cfg);
  else if (force && force.first) alerts.notify(force.text, cfg);
  // La reason d'un blocage est montrée à l'utilisateur et n'entre pas dans le contexte.
  if (cache && cache.block) {
    advice.adviceState(st).lastBlocked = true; // jamais deux blocages de suite
    handoff.autoSave(st, cfg, { force: true }); // le message bloqué n'entre pas dans le transcript : on le sauvegarde tout de suite
    state.saveState(st);
    journal.append({ type: 'cache_block', project: st.project, session: st.session, context: st.lastContext, pause_ms: Date.now() - Date.parse(st.lastResponseAt) });
    return { decision: 'block', reason: cache.text };
  }
  const adv = advice.onPrompt(input, st, cfg);
  state.saveState(st);
  for (const e of adv ? adv.entries : []) {
    journal.append({ type: 'advice', project: st.project, session: st.session, ...e, mode: e.kind === 'model' ? cfg.modelAdvice : 'hint', context: st.lastContext });
  }
  if (adv && adv.block) return { decision: 'block', reason: adv.texts.join('\n') };
  const texts = [force && force.text, cache && cache.text, ...(adv ? adv.texts : [])].filter(Boolean);
  return texts.length ? { systemMessage: texts.join('\n') } : null;
}

// Changement de modèle demandé par l'utilisateur (§9.2) : question seulement là où elle s'affiche
// (modelSwitchAskSources) ; ailleurs « ask » vaudrait refus, donc aucune réponse.
function PreModelSwitch(input) {
  const cfg = loadConfig();
  const text = advice.onModelSwitch(input, state.loadState(input.session_id), cfg);
  if (!text) return null;
  return { hookSpecificOutput: { hookEventName: 'PreModelSwitch', permissionDecision: 'ask', permissionDecisionReason: text } };
}

// Dossiers lourds (§7) : accès large refusé (raison adressée à Claude), accès ciblé signalé à l'utilisateur.
function PreToolUse(input) {
  const cfg = loadConfig();
  const res = heavy.check(input, cfg);
  if (!res) return null;
  if (res.kind === 'warn') return { systemMessage: `⚠️ Lecture ciblée dans un dossier normalement bloqué : ${res.info.path}` };
  const st = state.loadState(input.session_id);
  journal.append({
    type: 'deny',
    project: (st && st.project) || state.projectOf(input),
    session: input.session_id,
    tool: res.tool,
    path: String(res.info.path).slice(0, 300),
    size: res.info.size,
    bytes: heavy.avoidedBytes(res.tool, res.info),
    model: st && st.model ? st.model.value : null,
    ttl: st ? st.ttlMinutes : null,
  });
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: heavy.DENY_REASON },
  };
}

// Type d'agent : champ de l'entrée, sinon méta-données écrites à côté du transcript.
function agentLabel(input, file) {
  let type = input.agent_type;
  if (!type) {
    const meta = readJson(file.replace(/\.jsonl$/, '.meta.json'), null);
    type = meta && meta.agentType;
  }
  // Les agents internes (suggestions de prompt, /btw) arrivent sans type.
  return type || 'internal:unknown';
}

function SubagentStop(input) {
  const file = input.agent_transcript_path;
  if (!file || !fs.existsSync(file)) return; // agents internes : pas de transcript, rien à compter
  const statFile = state.agentStatePath(input.agent_id || path.basename(file, '.jsonl'));
  const ast = readJson(statFile, null) || { session: input.session_id, cursor: {} };
  const res = scan(file, ast.cursor, { sidechain: true });
  ast.cursor = res.cursor;
  ast.updatedAt = new Date().toISOString();
  if (res.calls.length) {
    const main = state.loadState(input.session_id);
    logTurns(res.calls, {
      project: (main && main.project) || state.projectOf(input),
      session: input.session_id,
      agent: agentLabel(input, file),
    }, res.last.context);
  }
  writeJsonAtomic(statFile, ast);
}

function PreCompact(input) {
  const cfg = loadConfig();
  const st = state.loadOrCreate(input);
  // Dernière lecture du transcript avant l'effacement, puis sauvegarde forcée (§5.3).
  logMain(st, measureMain(st, cfg, input.transcript_path));
  st.baselinePending = true; // alertes remises à zéro à la remesure de la baseline
  handoff.autoSave(st, cfg, { force: true });
  journal.append({ type: 'compact', project: st.project, session: st.session, trigger: input.trigger || null, context: st.lastContext });
  state.saveState(st);
}

function SessionEnd(input) {
  // Budget < 500 ms : lecture incrémentale de la fin du transcript et sauvegarde forcée.
  const st = state.loadState(input.session_id);
  if (st) {
    const cfg = loadConfig();
    logMain(st, measureMain(st, cfg, input.transcript_path));
    handoff.autoSave(st, cfg, { force: true });
    state.saveState(st);
  }
  if (input.reason !== 'clear') return;
  journal.append({
    type: 'clear',
    project: (st && st.project) || state.projectOf(input),
    session: input.session_id,
    context: st ? st.lastContext : null,
  });
}

function PostModelSwitch(input) {
  const cfg = loadConfig();
  const st = state.loadOrCreate(input);
  if (input.to_model) st.model = { value: input.to_model, source: 'PostModelSwitch' };
  if (typeof input.context_tokens === 'number') st.lastContext = input.context_tokens;
  applyTtl(st, cfg, parseTtl(input.cache_ttl), 'PostModelSwitch');
  journal.append({
    type: 'model_switch',
    project: st.project,
    session: st.session,
    from: input.from_model || null,
    to: input.to_model || null,
    source: input.source || null,
    context: input.context_tokens ?? st.lastContext,
  });
  state.saveState(st);
}

module.exports = { SessionStart, Stop, UserPromptSubmit, PreModelSwitch, PreToolUse, SubagentStop, PreCompact, SessionEnd, PostModelSwitch };
