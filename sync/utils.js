'use strict';

/**
 * Upsert en masse dans PG destination (chunks de 500 lignes).
 * Les colonnes sont déduites dynamiquement des lignes source.
 */
async function batchUpsert(pg, table, rows, pk) {
  if (!rows.length) return 0;
  const cols  = Object.keys(rows[0]);
  const CHUNK = 500;
  let total   = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk  = rows.slice(i, i + CHUNK);
    const values = [];
    const placeholders = chunk.map((row, ri) => {
      const ph = cols.map((col, ci) => {
        values.push(row[col] ?? null);
        return `$${ri * cols.length + ci + 1}`;
      });
      return `(${ph.join(', ')})`;
    });
    const updateCols = cols.filter(c => !pk.includes(c));
    const updateSet  = updateCols.length
      ? updateCols.map(c => `${c} = EXCLUDED.${c}`).join(', ')
      : `${pk[0]} = EXCLUDED.${pk[0]}`; // fallback si toutes les cols sont PK

    const sql = `
      INSERT INTO ${table} (${cols.join(', ')})
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (${pk.join(', ')}) DO UPDATE SET ${updateSet}
    `;
    await pg.query(sql, values);
    total += chunk.length;
  }
  return total;
}

/**
 * Full refresh : TRUNCATE puis INSERT en masse.
 */
async function fullRefresh(pg, table, rows) {
  await pg.query(`TRUNCATE TABLE ${table} CASCADE`);
  if (!rows.length) return 0;

  const cols  = Object.keys(rows[0]);
  const CHUNK = 500;
  let total   = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk  = rows.slice(i, i + CHUNK);
    const values = [];
    const placeholders = chunk.map((row, ri) => {
      const ph = cols.map((col, ci) => {
        values.push(row[col] ?? null);
        return `$${ri * cols.length + ci + 1}`;
      });
      return `(${ph.join(', ')})`;
    });
    await pg.query(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${placeholders.join(', ')}`,
      values
    );
    total += chunk.length;
  }
  return total;
}

async function logSync(pg, tableName, rowsSynced, status, errorMsg = null) {
  await pg.query(`
    INSERT INTO sync_log (table_name, last_sync, rows_synced, status, error_msg)
    VALUES ($1, NOW(), $2, $3, $4)
    ON CONFLICT (table_name) DO UPDATE SET
      last_sync   = NOW(),
      rows_synced = $2,
      status      = $3,
      error_msg   = $4
  `, [tableName, rowsSynced, status, errorMsg]);
}

async function getLastSync(pg, tableName) {
  const res = await pg.query(
    `SELECT last_sync FROM sync_log WHERE table_name = $1 AND status = 'ok'`,
    [tableName]
  );
  return res.rows[0]?.last_sync || null;
}

module.exports = { batchUpsert, fullRefresh, logSync, getLastSync };
