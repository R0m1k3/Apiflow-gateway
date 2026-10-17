'use strict';
/**
 * Orchestration d'une exécution : verrou, attente de la sync Debian, miroir du schéma,
 * copie table par table, journalisation dans sync_log (destination), alerte.
 */
const { config } = require('./config');
const log = require('./logger');
const { getSrc, getDst } = require('./db');
const { readCatalog, mirrorTable, ensureTrgm, mirrorIndexes, ensureDstSyncLog } = require('./schema');
const { copyFull, copyWindow } = require('./copy');
const { sendAlert } = require('./alert');
const { qt } = require('./sql');

const SOURCE_SYNC_LOG = 'sync_log';         // table source traitée à part
const DST_SOURCE_SYNC_LOG = 'source_sync_log';

// État partagé avec le dashboard
const state = {
  running: false,
  force: false,
  phase: null,         // 'verrou' | 'attente Debian' | 'schéma' | 'copie' | null
  progress: null,      // { current, index, total, startedAt }
  lastRun: null,       // { startedAt, finishedAt, force, status, tables: [...] }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function writeLog(dst, entry) {
  await dst.query(
    `INSERT INTO ${qt('sync_log')} (table_name, last_sync, rows_synced, status, error_msg, strategy, duration_ms, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (table_name) DO UPDATE SET
       last_sync = EXCLUDED.last_sync, rows_synced = EXCLUDED.rows_synced, status = EXCLUDED.status,
       error_msg = EXCLUDED.error_msg, strategy = EXCLUDED.strategy,
       duration_ms = EXCLUDED.duration_ms, detail = EXCLUDED.detail`,
    // Date JS : stockée correctement en TIMESTAMP (heure locale du conteneur, TZ=Europe/Paris) comme en TIMESTAMPTZ
    [entry.table, new Date(), Math.min(entry.rows ?? 0, 2147483647), entry.status, entry.error ?? null,
      entry.strategy ?? null, entry.durationMs ?? null, entry.detail ?? null],
  );
}

/**
 * Attend que la sync Debian soit terminée (ligne sync_log '_run' ≠ 'running').
 * Retourne 'ok' | 'absent' | 'timeout'.
 */
async function waitForDebian() {
  const src = getSrc();
  const deadline = Date.now() + config.waitMaxMs;
  let first = true;
  for (;;) {
    let status;
    try {
      const { rows } = await src.query(`SELECT status FROM ${qt(SOURCE_SYNC_LOG)} WHERE table_name = '_run'`);
      if (!rows.length) return 'absent';
      status = rows[0].status;
    } catch (err) {
      if (err.code === '42P01') return 'absent'; // sync_log inexistante côté source
      throw err;
    }
    if (status !== 'running') return 'ok';
    if (Date.now() >= deadline) return 'timeout';
    if (first) log.info(`Sync Debian en cours — attente (contrôle toutes les ${config.waitPollMs / 60000} min, max ${config.waitMaxMs / 60000} min)`);
    first = false;
    await sleep(Math.min(config.waitPollMs, Math.max(1000, deadline - Date.now())));
  }
}

/** Liste ordonnée des copies à effectuer : [{ src, dstName, strategy, dateCol }]. */
function planTables(srcCatalog) {
  const plan = [];
  for (const name of [...srcCatalog.keys()].sort()) {
    if (name === SOURCE_SYNC_LOG || config.excludeTables.has(name)) continue;
    const t = srcCatalog.get(name);
    const dateCol = config.windowTables[name];
    if (dateCol && t.columns.some(c => c.name === dateCol)) {
      plan.push({ src: t, dstName: name, strategy: 'window', dateCol });
    } else {
      if (dateCol) log.warn(`[${name}] colonne ${dateCol} absente de la source — copie complète`);
      plan.push({ src: t, dstName: name, strategy: 'full' });
    }
  }
  if (srcCatalog.has(SOURCE_SYNC_LOG) && !config.excludeTables.has(SOURCE_SYNC_LOG)) {
    plan.push({ src: srcCatalog.get(SOURCE_SYNC_LOG), dstName: DST_SOURCE_SYNC_LOG, strategy: 'full' });
  }
  return plan;
}

async function syncOne(item, ctx) {
  const { src: srcTable, dstName, strategy, dateCol } = item;
  const started = Date.now();
  const entry = { table: dstName, strategy, rows: 0, status: 'ok', error: null, detail: null };
  const srcClient = await getSrc().connect();
  const dstClient = await getDst().connect();
  try {
    const warnings = await mirrorTable(dstClient, srcTable, dstName, ctx.dstCatalog);
    // Instantané cohérent de la source pour toute la table (comptage, signatures, curseurs)
    await srcClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const r = strategy === 'window'
        ? await copyWindow(srcClient, dstClient, srcTable.name, srcTable.columns, dateCol, ctx.force)
        : await copyFull(srcClient, dstClient, srcTable.name, dstName, srcTable.columns, ctx.force);
      entry.rows = r.rows;
      entry.detail = r.detail;
    } finally {
      await srcClient.query('COMMIT').catch(() => {});
    }
    warnings.push(...await mirrorIndexes(dstClient, srcTable, dstName, ctx.dstCatalog, ctx.trgmOk));
    if (warnings.length) entry.detail = `${entry.detail} | ${warnings.length} avertissement(s) : ${warnings.join(' ; ')}`;
    log.info(`[${dstName}] OK — ${entry.detail}`);
  } catch (err) {
    entry.status = 'error';
    entry.error = err.message;
    log.error(`[${dstName}] ERREUR : ${err.message}`);
  } finally {
    srcClient.release();
    dstClient.release();
  }
  entry.durationMs = Date.now() - started;
  await writeLog(getDst(), entry).catch(e => log.error(`[${dstName}] écriture sync_log impossible : ${e.message}`));
  return entry;
}

/**
 * Lance une synchronisation complète.
 * force = ignorer le garde-fou volume + rechargement complet des tables "fenêtre".
 * Retourne { skipped } | { status, tables }.
 */
async function runSync({ force = false, trigger = 'manuel' } = {}) {
  if (state.running) {
    log.warn('Sync déjà en cours dans ce process — demande ignorée');
    return { skipped: 'running' };
  }
  state.running = true;
  state.force = force;
  state.phase = 'verrou';
  state.progress = null;
  const startedAt = new Date();
  const results = [];
  let lockClient = null;
  let locked = false;
  let fatal = null;

  try {
    lockClient = await getDst().connect();
    const { rows } = await lockClient.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [config.lockKey]);
    locked = rows[0].ok;
    if (!locked) {
      log.warn('Une autre synchronisation détient le verrou (autre process) — exécution ignorée');
      return { skipped: 'locked' };
    }
    log.info(`=== SYNC START (${trigger}${force ? ', FORCÉE' : ''}) ===`);
    await ensureDstSyncLog(lockClient);
    await writeLog(lockClient, { table: '_run', status: 'running', strategy: force ? 'force' : trigger, detail: `démarrée ${startedAt.toISOString()}` });

    state.phase = 'attente Debian';
    const wait = await waitForDebian();
    if (wait === 'timeout') {
      const msg = `Sync Debian toujours "running" après ${config.waitMaxMs / 60000} min — copie lancée quand même`;
      log.error(msg);
      await sendAlert(`[ff_sync_hostinger] ${msg}`);
    }

    state.phase = 'schéma';
    const srcCatalog = await readCatalog(getSrc());
    const dstCatalog = await readCatalog(lockClient);
    const trgmOk = await ensureTrgm(lockClient, srcCatalog);
    const plan = planTables(srcCatalog);
    log.info(`${plan.length} tables à synchroniser (${plan.filter(p => p.strategy === 'window').length} par fenêtre)`);

    state.phase = 'copie';
    const ctx = { force, dstCatalog, trgmOk };
    for (let i = 0; i < plan.length; i++) {
      state.progress = { current: plan[i].dstName, index: i + 1, total: plan.length, startedAt: startedAt.toISOString() };
      results.push(await syncOne(plan[i], ctx));
    }
  } catch (err) {
    fatal = err;
    log.error(`ERREUR FATALE : ${err.message}`);
  } finally {
    const failed = results.filter(r => r.status !== 'ok');
    if (locked) {
      const status = fatal || failed.length ? 'error' : 'ok';
      const detail = fatal
        ? `erreur fatale : ${fatal.message}`
        : `${results.length} tables, ${failed.length} en erreur`;
      await writeLog(lockClient, {
        table: '_run', status, strategy: force ? 'force' : trigger,
        rows: results.reduce((s, r) => s + (r.rows || 0), 0),
        error: fatal ? fatal.message : failed.length ? failed.map(f => f.table).join(', ') : null,
        durationMs: Date.now() - startedAt.getTime(), detail,
      }).catch(e => log.error(`écriture _run impossible : ${e.message}`));
      await lockClient.query('SELECT pg_advisory_unlock($1::bigint)', [config.lockKey]).catch(() => {});
      if (fatal || failed.length) {
        const lines = failed.slice(0, 15).map(f => `• ${f.table} : ${f.error}`);
        await sendAlert(
          `[ff_sync_hostinger] Sync ${fatal ? 'en échec' : 'terminée avec erreurs'} — ${detail}` +
          (lines.length ? `\n${lines.join('\n')}` : ''),
        );
      }
      log.info(`=== SYNC FIN en ${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)} s — ${detail} ===`);
      state.lastRun = {
        startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
        force, trigger, status: fatal || failed.length ? 'error' : 'ok', tables: results,
      };
    } else if (fatal) {
      await sendAlert(`[ff_sync_hostinger] Sync impossible : ${fatal.message}`);
    }
    if (lockClient) lockClient.release();
    state.running = false;
    state.phase = null;
    state.progress = null;
  }
  return { status: fatal || results.some(r => r.status !== 'ok') ? 'error' : 'ok', tables: results };
}

module.exports = { runSync, state, planTables, waitForDebian };
