'use strict';
const cron = require('node-cron');
const { getSrc, getDst, closeAll } = require('./db');
const { batchUpsert, fullRefresh, logSync } = require('./utils');
const { TABLES } = require('./tables');
const {
  startDashboard, registerSyncFn,
  setSyncRunning, isSyncRunning,
  setProgress, clearProgress,
} = require('./server');

const forceMode = process.argv.includes('--force');

async function syncTable(src, dst, table, pk) {
  const { rows } = await src.query(`SELECT * FROM ${table}`);
  if (!rows.length) {
    await logSync(dst, table, 0, 'ok');
    console.log(`[${table}] 0 lignes (table vide)`);
    return 0;
  }

  let count;
  if (pk.length === 0) {
    count = await fullRefresh(dst, table, rows);
  } else {
    count = await batchUpsert(dst, table, rows, pk);
  }
  await logSync(dst, table, count, 'ok');
  console.log(`[${table}] ${count} lignes`);
  return count;
}

async function syncAll(force = false) {
  if (isSyncRunning()) {
    console.log('Sync déjà en cours — ignorée.');
    return;
  }
  setSyncRunning(true);
  clearProgress();
  const start = Date.now();
  console.log(`\n=== SYNC START ${new Date().toISOString()} ===`);

  const src = getSrc();
  const dst = getDst();

  try {
    for (let i = 0; i < TABLES.length; i++) {
      const { name, pk } = TABLES[i];
      setProgress(name, i + 1);
      console.log(`[${i + 1}/${TABLES.length}] Sync ${name}…`);
      try {
        await syncTable(src, dst, name, pk);
      } catch (err) {
        await logSync(dst, name, 0, 'error', err.message).catch(() => {});
        console.error(`[${name}] ERREUR: ${err.message}`);
      }
    }
  } finally {
    setSyncRunning(false);
    clearProgress();
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`=== SYNC DONE en ${elapsed}s ===\n`);
}

registerSyncFn(syncAll);

if (forceMode) {
  console.log('Mode force : sync complète en cours...');
  syncAll(true)
    .then(() => closeAll())
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Erreur fatale sync:', err.message);
      process.exit(1);
    });
} else {
  startDashboard();
  console.log('Service sync Hostinger démarré — cron: 30 3 * * * (3h30 chaque nuit)');
  cron.schedule('30 3 * * *', () => {
    syncAll(false).catch(err => console.error('Erreur cron sync:', err.message));
  });
}
