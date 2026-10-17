'use strict';
/**
 * Configuration du service, lue depuis les variables d'environnement
 * (fournies par docker-compose depuis gateway/.env).
 */
const { parseList, parseWindowTables } = require('./sql');

/**
 * Tables copiées par "fenêtre" : signature par mois + rechargement des mois différents
 * + rechargement systématique des N derniers jours. Clé = table source, valeur = colonne date.
 * Une table configurée mais absente de la source est ignorée silencieusement.
 * Surcharge possible via WINDOW_TABLES="table:colonne,table:colonne".
 */
const DEFAULT_WINDOW_TABLES = {
  mvtart:          'datmvt',
  mvtreg:          'datmvt',
  mvtart_motif:    'datmvt',
  histo_art_gamme: 'date',
  demarques:       'datmvt',
  meteo:           'date',
  fidelite_jour:   'date',
};

function int(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

const config = {
  cron:            process.env.SYNC_CRON || '30 7 * * *',
  timeZone:        process.env.SYNC_TZ || 'Europe/Paris',
  port:            int('SYNC_DASHBOARD_PORT', 3002),

  // Tables source exclues (en plus de sync_log, traitée à part → source_sync_log)
  excludeTables:   new Set(parseList(process.env.EXCLUDE_TABLES)),
  windowTables:    process.env.WINDOW_TABLES
    ? parseWindowTables(process.env.WINDOW_TABLES)
    : DEFAULT_WINDOW_TABLES,
  recentDays:      int('WINDOW_RECENT_DAYS', 10),

  // Attente de la fin de la sync Debian (ligne sync_log '_run' = 'running')
  waitPollMs:      int('DEBIAN_WAIT_POLL_MIN', 2) * 60 * 1000,
  waitMaxMs:       int('DEBIAN_WAIT_MAX_MIN', 180) * 60 * 1000,

  // Garde-fou volume : source < 50 % de la destination (si destination > 100 lignes) → table ignorée
  volumeMinRatio:  0.5,
  volumeMinRows:   100,

  fetchSize:       5000,

  dashboardUser:   process.env.DASHBOARD_USER || '',
  dashboardPass:   process.env.DASHBOARD_PASSWORD || '',
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || '',

  // Clé du verrou consultatif (pg_try_advisory_lock) côté destination — constante
  lockKey:         4646535901,
};

module.exports = { config, DEFAULT_WINDOW_TABLES };
