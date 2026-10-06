'use strict';
// Rapport /conso (spec §8.3) : consommation, répartition, sessions, recommandations, gains.
const path = require('path');
const { loadConfig } = require('./config');
const journal = require('./journal');
const { modelFamily, rawTokens, weightedTokens } = require('./cost');
const { tokens, pct, table } = require('./format');
const { computeGains } = require('./gains');
const { followed: followedAdvice } = require('./advice');

const DAY = 86400000;

function startOfToday(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

function agentKind(agent) {
  if (!agent || agent === 'main') return 'main';
  if (agent.startsWith('internal:')) return 'internal';
  return 'subagent';
}

// Noms courts des projets ; chemin complet seulement en cas d'homonymie.
function projectNames(projects) {
  const byBase = new Map();
  for (const p of projects) {
    const base = path.basename(p || '') || '(inconnu)';
    byBase.set(base, (byBase.get(base) || 0) + 1);
  }
  const out = new Map();
  for (const p of projects) {
    const base = path.basename(p || '') || '(inconnu)';
    out.set(p, byBase.get(base) > 1 ? p : base);
  }
  return out;
}

// Gains réalisés (§8.3) : estimations, signalées comme telles.
function gainsSection(entries, since, cfg, now) {
  const g = computeGains(entries, since, cfg, { now });
  const out = ['### Gains estimés (7 jours)'];
  const rows = [];
  rows.push(['rtk (sorties de commandes compactées)', g.rtk ? tokens(g.rtk.tokens) : 'non disponible', g.rtk ? tokens(g.rtk.weighted) : '—']);
  rows.push([`Lectures lourdes bloquées (${g.blocked.count})`, tokens(g.blocked.tokens), tokens(g.blocked.weighted)]);
  rows.push([`Handoffs suivis d'une nouvelle discussion (${g.handoffs.count})`, tokens(g.handoffs.tokens), tokens(g.handoffs.weighted)]);
  rows.push(['**Total**', '', `**${tokens(g.total)}**`]);
  out.push(table(['Source', 'Tokens évités', 'Pondéré'], rows));
  if (g.spent > 0 && g.total > 0) out.push('', `Soit ~${pct(g.total, g.total + g.spent)} de ce qu'aurait coûté la période sans ces économies.`);
  out.push('', g.contextMode
    ? `context-mode déclare ~${tokens(g.contextMode.tokens)} tokens gardés hors du contexte (${g.contextMode.sessions} session(s)) : non ajouté au total, car il compte tout ce qui est traité dans son bac à sable, y compris ce qui n'aurait jamais été lu.`
    : 'context-mode : statistiques non disponibles.');
  out.push('', '_Estimations : rtk et context-mode comptés une fois au prix d\'écriture du cache ; lectures bloquées plafonnées à la sortie maximale de l\'outil, relues à chaque tour restant ; handoffs : écart de contexte × tours suivants au prix de lecture du cache. rtk couvre tous les projets._');
  return out;
}

function buildConsoReport(now = Date.now()) {
  const cfg = loadConfig();
  const today = startOfToday(now).toISOString();
  const since = new Date(now - 7 * DAY);
  const entries = journal.readSince(since);
  const turns = entries.filter((e) => e.type === 'turn');

  const out = ['## conso-pilot — consommation', ''];
  if (!turns.length) {
    out.push('Aucune donnée sur les 7 derniers jours : le journal se remplit à chaque réponse de Claude.');
    return out.join('\n');
  }
  out.push('Pondéré = équivalent « token d\'entrée plein » (coût relatif : cache, sortie, modèle, mode rapide). Brut = somme des tokens.', '');

  // Par projet et modèle
  const groups = new Map();
  const total = { dayRaw: 0, dayW: 0, weekRaw: 0, weekW: 0, turns: 0 };
  const byKind = { main: 0, subagent: 0, internal: 0 };
  const byAgent = new Map();
  const sessions = new Map();
  for (const t of turns) {
    const w = weightedTokens(t, cfg);
    const raw = rawTokens(t);
    const key = `${t.project}|${modelFamily(t.model)}`;
    let g = groups.get(key);
    if (!g) {
      g = { project: t.project, model: modelFamily(t.model), dayRaw: 0, dayW: 0, weekRaw: 0, weekW: 0, turns: 0 };
      groups.set(key, g);
    }
    const isToday = t.ts >= today;
    for (const acc of [g, total]) {
      acc.weekRaw += raw;
      acc.weekW += w;
      if (isToday) {
        acc.dayRaw += raw;
        acc.dayW += w;
      }
    }
    const kind = agentKind(t.agent);
    byKind[kind] += w;
    if (kind === 'subagent') byAgent.set(t.agent, (byAgent.get(t.agent) || 0) + w);

    let s = sessions.get(t.session);
    if (!s) {
      s = { session: t.session, project: t.project, w: 0, ctxSum: 0, ctxN: 0, turns: 0 };
      sessions.set(t.session, s);
    }
    s.w += w;
    if (kind === 'main') {
      g.turns += 1;
      total.turns += 1;
      s.turns += 1;
      if (t.context != null) {
        s.ctxSum += t.context;
        s.ctxN += 1;
      }
    }
  }

  const names = projectNames([...new Set(turns.map((t) => t.project))]);
  const rows = [...groups.values()]
    .sort((a, b) => b.weekW - a.weekW)
    .map((g) => [names.get(g.project), g.model, tokens(g.dayRaw), tokens(g.dayW), tokens(g.weekRaw), tokens(g.weekW), String(g.turns)]);
  rows.push(['**Total**', '', tokens(total.dayRaw), `**${tokens(total.dayW)}**`, tokens(total.weekRaw), `**${tokens(total.weekW)}**`, String(total.turns)]);
  out.push('### Par projet et modèle');
  out.push(table(['Projet', 'Modèle', "Auj. brut", "Auj. pondéré", '7 j brut', '7 j pondéré', 'Tours 7 j'], rows), '');

  // Part des sous-agents et des agents internes
  const all = byKind.main + byKind.subagent + byKind.internal;
  const detail = [...byAgent.entries()].sort((a, b) => b[1] - a[1]).map(([a, w]) => `${a} ${pct(w, all)}`).join(', ');
  out.push('### Répartition (7 jours, pondéré)');
  out.push(`- Conversation principale : ${pct(byKind.main, all)}`);
  out.push(`- Sous-agents : ${pct(byKind.subagent, all)}${detail ? ` (${detail})` : ''}`);
  out.push(`- Agents internes (suggestions, /btw) : ${pct(byKind.internal, all)}`, '');

  // Top 5 des sessions
  const top = [...sessions.values()].sort((a, b) => b.w - a.w).slice(0, 5);
  out.push('### Sessions les plus coûteuses (7 jours)');
  out.push(table(['Session', 'Projet', 'Pondéré', 'Contexte moyen', 'Tours'], top.map((s) => [
    String(s.session || '?').slice(0, 8),
    names.get(s.project),
    tokens(s.w),
    s.ctxN ? tokens(s.ctxSum / s.ctxN) : '—',
    String(s.turns),
  ])), '');

  // Conseils de modèle et d'effort (§9.2) : suivis si un tour suivant de la session utilise la valeur conseillée.
  const turnsAll = entries.filter((e) => e.type === 'turn');
  out.push('### Conseils de modèle et d\'effort (7 jours)');
  const lines = [];
  for (const kind of ['model', 'effort']) {
    const list = entries.filter((e) => e.type === 'advice' && e.kind === kind);
    if (!list.length) continue;
    const ok = list.filter((e) => followedAdvice(e, turnsAll)).length;
    lines.push(`- ${kind === 'model' ? 'Modèle' : 'Effort'} : ${list.length} conseil(s), ${pct(ok, list.length)} suivi(s)${kind === 'model' ? ` (${list.filter((e) => e.blocked).length} message(s) bloqué(s))` : ''}.`);
  }
  out.push(lines.length ? lines.join('\n') : 'Aucun pour l\'instant.', '');

  out.push(...gainsSection(entries, since, cfg, now));
  return out.join('\n');
}

module.exports = { buildConsoReport };
