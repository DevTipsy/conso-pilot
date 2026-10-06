'use strict';
// Mise en forme des rapports (markdown recopié tel quel par Claude).
const os = require('os');

function tokens(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 9.95e6 ? 0 : 1)}M`;
  if (a >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

function pct(part, total) {
  if (!total) return '—';
  return `${Math.round((100 * part) / total)} %`;
}

function table(headers, rows) {
  const lines = [`| ${headers.join(' | ')} |`, `|${headers.map((h, i) => (i === 0 ? '---' : '---:')).join('|')}|`];
  for (const r of rows) lines.push(`| ${r.join(' | ')} |`);
  return lines.join('\n');
}

function home(p) {
  const h = os.homedir();
  return p && p.startsWith(h) ? `~${p.slice(h.length)}` : p;
}

function ago(iso, now = Date.now()) {
  if (!iso) return '—';
  const min = Math.round((now - Date.parse(iso)) / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `il y a ${h} h ${String(min % 60).padStart(2, '0')}`;
  return `il y a ${Math.floor(h / 24)} j`;
}

module.exports = { tokens, pct, table, home, ago };
