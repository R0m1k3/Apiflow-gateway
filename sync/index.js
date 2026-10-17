'use strict';
/**
 * Point d'entrée du service ff_sync_hostinger.
 *
 *   node index.js           → dashboard + cron (SYNC_CRON, fuseau SYNC_TZ)
 *   node index.js --once    → une exécution normale puis sortie
 *   node index.js --force   → une exécution forcée (garde-fou volume ignoré,
 *                             tables "fenêtre" rechargées entièrement) puis sortie
 *
 * Le verrou consultatif PostgreSQL empêche toute exécution concurrente,
 * y compris entre le service et une commande `docker exec … node index.js --once`.
 */
const cron = require('node-cron');
const { config } = require('./config');
const log = require('./logger');
const { closeAll } = require('./db');
const { runSync } = require('./sync');
const { startDashboard, registerSyncFn, registerNextRunFn } = require('./server');

const args = process.argv.slice(2);
const force = args.includes('--force');
const once = force || args.includes('--once');

if (once) {
  runSync({ force, trigger: 'cli' })
    .then(async r => {
      await closeAll();
      process.exit(r.skipped || r.status === 'ok' ? 0 : 1);
    })
    .catch(async err => {
      log.error(`Erreur fatale : ${err.message}`);
      await closeAll();
      process.exit(1);
    });
} else {
  if (!cron.validate(config.cron)) {
    log.error(`SYNC_CRON invalide : "${config.cron}"`);
    process.exit(1);
  }
  registerSyncFn(runSync);
  const task = cron.schedule(
    config.cron,
    () => runSync({ force: false, trigger: 'cron' }).catch(err => log.error(`Sync cron : ${err.message}`)),
    { timezone: config.timeZone, name: 'ff-sync', noOverlap: true },
  );
  registerNextRunFn(() => task.getNextRun());
  const server = startDashboard();
  log.info(`Service sync Hostinger démarré — cron "${config.cron}" (${config.timeZone}), prochaine exécution ${task.getNextRun()?.toISOString() ?? '?'}`);

  const shutdown = sig => {
    log.info(`${sig} reçu — arrêt (une transaction en cours est annulée par PostgreSQL)`);
    task.stop();
    server.close();
    closeAll().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
