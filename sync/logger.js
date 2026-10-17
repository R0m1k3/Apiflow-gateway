'use strict';
/**
 * Journal applicatif : sortie console + tampon circulaire affiché par le dashboard.
 * Les messages sont du texte brut ; le dashboard les insère via textContent (jamais innerHTML).
 */
const MAX_LINES = 500;
const MAX_LEN   = 4000;
const buffer = [];

function push(level, args) {
  const msg = args
    .map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')
    .slice(0, MAX_LEN);
  buffer.push({ ts: new Date().toISOString(), level, msg });
  if (buffer.length > MAX_LINES) buffer.shift();
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  out(`[${level}] ${msg}`);
}

module.exports = {
  info:  (...a) => push('info', a),
  warn:  (...a) => push('warn', a),
  error: (...a) => push('error', a),
  getLogs: (limit = 200) => buffer.slice(-Math.min(Math.max(1, limit | 0), MAX_LINES)),
};
