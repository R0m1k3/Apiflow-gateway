'use strict';
/**
 * Stratégies de copie des données source → destination.
 *
 * - full   : BEGIN; DELETE FROM; INSERT de toutes les lignes; COMMIT (une seule transaction
 *            destination : les lecteurs ne voient jamais une table vide ou partielle).
 * - window : signature (nb lignes + somme des hash) par mois des deux côtés, puis pour
 *            chaque mois différent : BEGIN; DELETE du mois; INSERT depuis la source; COMMIT.
 *            Les N derniers jours sont toujours rechargés.
 *
 * Lecture source par curseur serveur (FETCH par lots) : jamais une table entière en RAM.
 * Les valeurs transitent en texte brut (pas de conversion JS) : aucune perte de précision
 * sur les timestamps, numeric, bigint, bytea, tableaux…
 */
const { config } = require('./config');
const log = require('./logger');
const {
  qt, buildSelect, buildInsert, insertChunkSize,
  buildSignatureQuery, signatureMap, signatureTotal, diffMonths,
  monthCondition, recentCondition, cutoffDate,
} = require('./sql');

// Désactive tous les parseurs de types de node-postgres : chaque valeur reste la chaîne PG
const RAW_TYPES = { getTypeParser: () => v => v };

let cursorSeq = 0;

/**
 * Copie les lignes d'un SELECT source vers une table destination.
 * src doit être dans une transaction (DECLARE CURSOR l'exige).
 */
async function streamRows(src, dst, srcTable, dstTable, cols, where) {
  const cursor = `ff_cur_${++cursorSeq}`;
  const chunk = insertChunkSize(cols.length);
  await src.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR ${buildSelect(srcTable, cols, where)}`);
  let total = 0;
  let insertSql = null;
  let insertRows = 0;
  try {
    for (;;) {
      const res = await src.query({ text: `FETCH ${config.fetchSize} FROM ${cursor}`, rowMode: 'array', types: RAW_TYPES });
      const rows = res.rows;
      if (!rows.length) break;
      for (let i = 0; i < rows.length; i += chunk) {
        const part = rows.slice(i, i + chunk);
        if (part.length !== insertRows) {
          insertSql = buildInsert(dstTable, cols, part.length);
          insertRows = part.length;
        }
        await dst.query(insertSql, part.flat());
      }
      total += rows.length;
    }
  } finally {
    await src.query(`CLOSE ${cursor}`).catch(() => {});
  }
  return total;
}

async function count(client, table) {
  const { rows } = await client.query(`SELECT count(*)::bigint AS n FROM ${qt(table)}`);
  return Number(rows[0].n);
}

function volumeGuard(srcCount, dstCount, force) {
  if (force) return null;
  if (dstCount > config.volumeMinRows && srcCount < dstCount * config.volumeMinRatio) {
    return `garde-fou volume : source ${srcCount} lignes < 50 % de la destination (${dstCount}) — table non copiée (relancer en mode forcé si c'est voulu)`;
  }
  return null;
}

/** Exécute fn dans une transaction destination (ROLLBACK en cas d'erreur). */
async function inDstTx(dst, fn) {
  await dst.query('BEGIN');
  try {
    // Ne pas rester bloqué indéfiniment derrière un lecteur long (et bloquer les suivants)
    await dst.query("SET LOCAL lock_timeout = '60s'");
    const r = await fn();
    await dst.query('COMMIT');
    return r;
  } catch (err) {
    await dst.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/**
 * Copie complète transactionnelle.
 * Retourne { rows, detail } ou lève une erreur (dont le garde-fou volume).
 */
async function copyFull(src, dst, srcTable, dstTable, cols, force) {
  const srcCount = await count(src, srcTable);
  const dstCount = await count(dst, dstTable);
  const guard = volumeGuard(srcCount, dstCount, force);
  if (guard) throw new Error(guard);
  const rows = await inDstTx(dst, async () => {
    // DELETE (et non TRUNCATE) : les lecteurs continuent de voir l'ancienne version (MVCC)
    // au lieu d'être bloqués par un verrou ACCESS EXCLUSIVE ; l'autovacuum récupère l'espace.
    await dst.query(`DELETE FROM ${qt(dstTable)}`);
    return streamRows(src, dst, srcTable, dstTable, cols, null);
  });
  return { rows, detail: `copie complète (${dstCount} -> ${rows} lignes)` };
}

/** Recharge les lignes vérifiant `where` (DELETE + INSERT dans une transaction). */
async function reloadSlice(src, dst, table, cols, where) {
  return inDstTx(dst, async () => {
    await dst.query(`DELETE FROM ${qt(table)} WHERE ${where}`);
    return streamRows(src, dst, table, table, cols, where);
  });
}

/**
 * Copie par fenêtre de dates (tables de mouvements volumineuses).
 * Retourne { rows, detail }.
 */
async function copyWindow(src, dst, table, cols, dateCol, force) {
  if (force) {
    const r = await copyFull(src, dst, table, table, cols, true);
    return { rows: r.rows, detail: `mode forcé : ${r.detail}` };
  }
  const sigSql = buildSignatureQuery(table, cols, dateCol);
  const srcSig = signatureMap((await src.query(sigSql)).rows);
  let dstSig = signatureMap((await dst.query(sigSql)).rows);

  const guard = volumeGuard(signatureTotal(srcSig), signatureTotal(dstSig), false);
  if (guard) throw new Error(guard);

  // 1. Fenêtre glissante : les N derniers jours sont toujours rechargés
  const cutoff = cutoffDate(config.recentDays, config.timeZone);
  let rows = await reloadSlice(src, dst, table, cols, recentCondition(dateCol, cutoff));
  const recentRows = rows;

  // 2. Mois dont la signature diffère (nouvelles colonnes, corrections, suppressions…)
  dstSig = signatureMap((await dst.query(sigSql)).rows);
  const months = diffMonths(srcSig, dstSig);
  for (const month of months) {
    const n = await reloadSlice(src, dst, table, cols, monthCondition(dateCol, month));
    log.info(`[${table}] mois ${month} rechargé (${n} lignes)`);
    rows += n;
  }
  return {
    rows,
    detail: `${recentRows} lignes depuis le ${cutoff} + ${months.length} mois rechargé(s)` +
      (months.length ? ` (${months.slice(0, 6).join(', ')}${months.length > 6 ? '…' : ''})` : ''),
  };
}

module.exports = { copyFull, copyWindow, streamRows, volumeGuard, RAW_TYPES };
