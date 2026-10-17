'use strict';
/**
 * Miroir automatique du schéma source → destination.
 * Aucune liste de tables ni schéma écrit à la main : tout est lu dans pg_catalog
 * à chaque exécution. On ne supprime jamais rien côté destination.
 */
const log = require('./logger');
const {
  qt, buildCreateTable, buildAddColumn, buildAddPrimaryKey,
  indexDefIfNotExists, needsTrgm,
} = require('./sql');

const COLUMNS_SQL = `
SELECT c.relname AS table_name, a.attname AS name,
       pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
       a.attnotnull AS notnull
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c     ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')
  AND NOT c.relispartition
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY c.relname, a.attnum`;

const PK_SQL = `
SELECT c.relname AS table_name,
       array_agg(a.attname::text ORDER BY k.ord) AS pk
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class c     ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
WHERE n.nspname = 'public' AND con.contype = 'p'
GROUP BY c.relname`;

// Index hors clé primaire (les index des contraintes UNIQUE deviennent des index uniques)
const INDEXES_SQL = `
SELECT i.tablename AS table_name, i.indexname AS name, i.indexdef AS def
FROM pg_catalog.pg_indexes i
JOIN pg_catalog.pg_namespace n ON n.nspname = i.schemaname
JOIN pg_catalog.pg_class ic    ON ic.relname = i.indexname AND ic.relnamespace = n.oid
JOIN pg_catalog.pg_index x     ON x.indexrelid = ic.oid
WHERE i.schemaname = 'public' AND NOT x.indisprimary
ORDER BY i.tablename, i.indexname`;

/**
 * Lit le catalogue d'une base : Map table → { name, columns:[{name,type,notnull}], pk:[], indexes:[{name,def}] }.
 */
async function readCatalog(client) {
  const tables = new Map();
  const { rows: cols } = await client.query(COLUMNS_SQL);
  for (const r of cols) {
    if (!tables.has(r.table_name)) tables.set(r.table_name, { name: r.table_name, columns: [], pk: [], indexes: [] });
    tables.get(r.table_name).columns.push({ name: r.name, type: r.type, notnull: r.notnull });
  }
  const { rows: pks } = await client.query(PK_SQL);
  for (const r of pks) if (tables.has(r.table_name)) tables.get(r.table_name).pk = r.pk;
  const { rows: idx } = await client.query(INDEXES_SQL);
  for (const r of idx) if (tables.has(r.table_name)) tables.get(r.table_name).indexes.push({ name: r.name, def: r.def });
  return tables;
}

/**
 * Crée la table destination si absente, ajoute les colonnes manquantes,
 * signale (sans modifier) les colonnes de type différent.
 * Retourne la liste des avertissements.
 */
async function mirrorTable(dst, srcTable, dstName, dstCatalog) {
  const warnings = [];
  const existing = dstCatalog.get(dstName);
  if (!existing) {
    await dst.query(buildCreateTable(dstName, srcTable.columns, srcTable.pk));
    log.info(`[${dstName}] table créée (${srcTable.columns.length} colonnes)`);
    dstCatalog.set(dstName, {
      name: dstName,
      columns: srcTable.columns.map(c => ({ ...c })),
      pk: [...srcTable.pk],
      indexes: [],
    });
    return warnings;
  }
  const dstCols = new Map(existing.columns.map(c => [c.name, c]));
  for (const col of srcTable.columns) {
    const d = dstCols.get(col.name);
    if (!d) {
      await dst.query(buildAddColumn(dstName, col));
      existing.columns.push({ name: col.name, type: col.type, notnull: false });
      log.info(`[${dstName}] colonne ajoutée : ${col.name} ${col.type}`);
    } else if (d.type !== col.type) {
      const w = `type différent pour ${col.name} : source ${col.type} / destination ${d.type} (non modifié)`;
      warnings.push(w);
      log.warn(`[${dstName}] ${w}`);
    }
  }
  return warnings;
}

/** Tente CREATE EXTENSION pg_trgm si un index source en a besoin. Retourne true si disponible. */
async function ensureTrgm(dst, srcCatalog) {
  const needed = [...srcCatalog.values()].some(t => t.indexes.some(i => needsTrgm(i.def)));
  if (!needed) return true;
  try {
    await dst.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    return true;
  } catch (err) {
    log.warn(`pg_trgm indisponible sur la destination (${err.message}) — index trigrammes ignorés`);
    return false;
  }
}

/**
 * Après la copie des données : crée les index manquants (même nom, IF NOT EXISTS)
 * et la clé primaire si la destination n'en a pas. Les échecs sont des avertissements.
 * Les index ne sont reproduits que si le nom de table est identique (pas pour source_sync_log).
 */
async function mirrorIndexes(dst, srcTable, dstName, dstCatalog, trgmOk) {
  const warnings = [];
  const existing = dstCatalog.get(dstName);
  if (srcTable.pk.length && existing && !existing.pk.length) {
    try {
      await dst.query(buildAddPrimaryKey(dstName, srcTable.pk));
      existing.pk = [...srcTable.pk];
      log.info(`[${dstName}] clé primaire ajoutée (${srcTable.pk.join(', ')})`);
    } catch (err) {
      const w = `clé primaire (${srcTable.pk.join(', ')}) non ajoutée : ${err.message}`;
      warnings.push(w);
      log.warn(`[${dstName}] ${w}`);
    }
  }
  if (dstName !== srcTable.name) return warnings;
  const have = new Set((existing?.indexes || []).map(i => i.name));
  for (const idx of srcTable.indexes) {
    if (have.has(idx.name)) continue;
    if (!trgmOk && needsTrgm(idx.def)) {
      warnings.push(`index ${idx.name} ignoré (pg_trgm indisponible)`);
      continue;
    }
    try {
      await dst.query(indexDefIfNotExists(idx.def));
      existing?.indexes.push({ name: idx.name, def: idx.def });
      log.info(`[${dstName}] index ${idx.name} OK`);
    } catch (err) {
      const w = `index ${idx.name} non créé : ${err.message}`;
      warnings.push(w);
      log.warn(`[${dstName}] ${w}`);
    }
  }
  return warnings;
}

/** Table de suivi côté destination (mêmes colonnes que la source + colonnes de détail). */
async function ensureDstSyncLog(dst) {
  await dst.query(`CREATE TABLE IF NOT EXISTS ${qt('sync_log')} (
    table_name  TEXT PRIMARY KEY,
    last_sync   TIMESTAMP,
    rows_synced INTEGER,
    status      TEXT,
    error_msg   TEXT
  )`);
  for (const [name, type] of [['strategy', 'TEXT'], ['duration_ms', 'INTEGER'], ['detail', 'TEXT']]) {
    await dst.query(`ALTER TABLE ${qt('sync_log')} ADD COLUMN IF NOT EXISTS "${name}" ${type}`);
  }
}

module.exports = { readCatalog, mirrorTable, ensureTrgm, mirrorIndexes, ensureDstSyncLog };
