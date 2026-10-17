'use strict';
/**
 * Dashboard de la sync Hostinger (port 3002, joint par Nginx Proxy Manager sur nginx_default).
 *
 * Sécurité :
 * - HTTP Basic auth (DASHBOARD_USER / DASHBOARD_PASSWORD), comparaison à temps constant ;
 *   sans ces variables, tout répond 503 sauf GET /healthz (healthcheck Docker).
 * - POST /api/sync/run exige l'en-tête X-Requested-By (bloque les formulaires cross-site / CSRF).
 * - Aucune donnée dynamique insérée via innerHTML ; CSP sans script inline.
 */
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { config } = require('./config');
const log = require('./logger');
const { getDst } = require('./db');
const { state } = require('./sync');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback, uniquelocal');

let runFn = null;
let nextRunFn = () => null;
function registerSyncFn(fn) { runFn = fn; }
function registerNextRunFn(fn) { nextRunFn = fn; }

app.get('/healthz', (req, res) => res.json({ ok: true }));

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha(a), sha(b));
}

function basicAuth(req, res, next) {
  if (!config.dashboardUser || !config.dashboardPass) {
    return res.status(503).type('text/plain; charset=utf-8')
      .send('dashboard désactivé: définir DASHBOARD_USER/DASHBOARD_PASSWORD');
  }
  const header = req.get('authorization') || '';
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header);
  let user = '';
  let pass = '';
  if (m) {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i >= 0) { user = decoded.slice(0, i); pass = decoded.slice(i + 1); }
  }
  // Les deux comparaisons sont toujours évaluées (pas de court-circuit)
  const okUser = safeEqual(user, config.dashboardUser);
  const okPass = safeEqual(pass, config.dashboardPass);
  if (m && okUser && okPass) return next();
  if (m) log.warn(`Authentification dashboard refusée (ip ${req.ip})`);
  res.set('WWW-Authenticate', 'Basic realm="ff_sync_hostinger", charset="UTF-8"');
  return res.status(401).type('text/plain; charset=utf-8').send('Authentification requise');
}

app.use(basicAuth);
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  next();
});
app.use(express.json({ limit: '10kb' }));

app.get('/api/status', async (req, res) => {
  let tables = [];
  let dbError = null;
  try {
    const { rows } = await getDst().query(
      `SELECT table_name, last_sync, rows_synced, status, error_msg, strategy, duration_ms, detail
       FROM public.sync_log ORDER BY table_name`,
    );
    tables = rows;
  } catch (err) {
    // 42P01 = sync_log pas encore créée (aucune exécution)
    if (err.code !== '42P01') dbError = 'base destination injoignable';
    if (err.code !== '42P01') log.error(`/api/status : ${err.message}`);
  }
  res.json({
    running: state.running,
    force: state.force,
    phase: state.phase,
    progress: state.progress,
    lastRun: state.lastRun,
    tables,
    dbError,
  });
});

app.get('/api/logs', (req, res) => {
  res.json(log.getLogs(parseInt(req.query.limit, 10) || 200));
});

app.get('/api/next', (req, res) => {
  const next = nextRunFn();
  res.json({ next: next ? next.toISOString() : null, cron: config.cron, timeZone: config.timeZone });
});

app.post('/api/sync/run', (req, res) => {
  if (req.get('x-requested-by') !== 'ff-dashboard') {
    return res.status(400).json({ error: 'en-tête X-Requested-By manquant' });
  }
  if (state.running) return res.status(409).json({ error: 'Sync déjà en cours' });
  if (!runFn) return res.status(500).json({ error: 'sync non initialisée' });
  const force = req.body?.force === true;
  log.info(`Sync ${force ? 'FORCÉE ' : ''}demandée depuis le dashboard (ip ${req.ip})`);
  res.status(202).json({ message: force ? 'Sync forcée lancée' : 'Sync lancée' });
  runFn({ force, trigger: 'dashboard' }).catch(err => log.error(`Sync manuelle : ${err.message}`));
});

const PUBLIC_DIR = path.join(__dirname, 'public');
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/app.js', (req, res) => res.type('application/javascript').sendFile(path.join(PUBLIC_DIR, 'app.js')));

app.use((req, res) => res.status(404).json({ error: 'not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  log.error(`HTTP ${req.method} ${req.path} : ${err.message}`);
  res.status(500).json({ error: 'erreur interne' });
});

function startDashboard() {
  if (!config.dashboardUser || !config.dashboardPass) {
    log.warn('DASHBOARD_USER / DASHBOARD_PASSWORD non définis : dashboard et API désactivés (503)');
  }
  return app.listen(config.port, '0.0.0.0', () => {
    log.info(`Dashboard sync Hostinger : port ${config.port}`);
  });
}

module.exports = { app, startDashboard, registerSyncFn, registerNextRunFn };
