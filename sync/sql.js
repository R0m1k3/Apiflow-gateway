'use strict';
/**
 * Fonctions pures de génération SQL (aucun accès base) — testées par test/sql.test.js.
 * Toutes les tables sont dans le schéma public, côté source comme côté destination.
 */

/** Quote un identifiant PostgreSQL ("nom" avec doublement des guillemets). */
function qi(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/** Nom qualifié public."table". */
function qt(table) {
  return 'public.' + qi(table);
}

/** Littéral SQL texte (échappement des apostrophes). */
function lit(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Littéral date 'YYYY-MM-DD' strictement validé (utilisé dans les DECLARE CURSOR). */
function dateLit(value) {
  if (!DATE_RE.test(String(value))) throw new Error(`Date invalide : ${value}`);
  return lit(value);
}

/** Liste de colonnes quotées, dans l'ordre fourni. */
function colList(cols) {
  return cols.map(c => qi(c.name ?? c)).join(', ');
}

/**
 * CREATE TABLE IF NOT EXISTS reproduisant colonnes (ordre, type exact, NOT NULL) et clé primaire.
 * Pas de DEFAULT (les séquences ne sont pas répliquées) ni de clé étrangère.
 * cols : [{ name, type, notnull }], pk : ['col', ...]
 */
function buildCreateTable(table, cols, pk = []) {
  const defs = cols.map(c => `  ${qi(c.name)} ${c.type}${c.notnull ? ' NOT NULL' : ''}`);
  if (pk.length) defs.push(`  PRIMARY KEY (${pk.map(qi).join(', ')})`);
  return `CREATE TABLE IF NOT EXISTS ${qt(table)} (\n${defs.join(',\n')}\n)`;
}

/**
 * Ajout d'une colonne manquante. Toujours NULLable : un NOT NULL sans DEFAULT
 * échouerait sur une table déjà remplie ; la colonne est remplie par la copie suivante.
 */
function buildAddColumn(table, col) {
  return `ALTER TABLE ${qt(table)} ADD COLUMN IF NOT EXISTS ${qi(col.name)} ${col.type}`;
}

function buildAddPrimaryKey(table, pk) {
  return `ALTER TABLE ${qt(table)} ADD PRIMARY KEY (${pk.map(qi).join(', ')})`;
}

/**
 * Transforme un pg_indexes.indexdef ("CREATE [UNIQUE] INDEX nom ON public.t USING ...")
 * en version idempotente avec IF NOT EXISTS (même nom d'index).
 */
function indexDefIfNotExists(indexdef) {
  const out = String(indexdef).replace(/^CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS )/i, (m, u) => `CREATE ${u || ''}INDEX IF NOT EXISTS `);
  if (out === indexdef && !/^CREATE (UNIQUE )?INDEX IF NOT EXISTS /i.test(indexdef)) {
    throw new Error(`Définition d'index inattendue : ${indexdef}`);
  }
  return out;
}

/** L'index nécessite-t-il l'extension pg_trgm ? */
function needsTrgm(indexdef) {
  return /\b(gin|gist)_trgm_ops\b/i.test(String(indexdef));
}

/**
 * Requête de signature par mois : nb de lignes + somme des hash de chaque ligne.
 * La liste de colonnes est explicite (ordre source) pour que source et destination
 * hachent exactement les mêmes colonnes, même si la destination a des colonnes en plus.
 * Résultat : m ('YYYY-MM-DD' ou NULL), n (texte), h (texte).
 */
function buildSignatureQuery(table, cols, dateCol, where = null) {
  const d = qi(dateCol);
  return `SELECT to_char(date_trunc('month', ${d}), 'YYYY-MM-DD') AS m,
       count(*)::text AS n,
       coalesce(sum(hashtext(ROW(${colList(cols)})::text)::bigint), 0)::text AS h
FROM ${qt(table)}${where ? `\nWHERE ${where}` : ''}
GROUP BY 1`;
}

const NULL_MONTH = 'NULL';

/** Convertit le résultat d'une requête de signature en Map mois → "n:h". */
function signatureMap(rows) {
  const map = new Map();
  for (const r of rows) map.set(r.m ?? NULL_MONTH, `${r.n}:${r.h}`);
  return map;
}

/** Total des lignes d'une Map de signatures. */
function signatureTotal(map) {
  let total = 0;
  for (const v of map.values()) total += Number(v.split(':')[0]);
  return total;
}

/** Mois dont la signature diffère, ou présents d'un seul côté (triés, NULL en premier). */
function diffMonths(srcMap, dstMap) {
  const keys = new Set([...srcMap.keys(), ...dstMap.keys()]);
  return [...keys].filter(k => srcMap.get(k) !== dstMap.get(k)).sort();
}

/** 1er jour du mois suivant ('YYYY-MM-01' → 'YYYY-MM-01'). */
function nextMonth(month) {
  if (!DATE_RE.test(month)) throw new Error(`Mois invalide : ${month}`);
  const [y, m] = month.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-01`;
}

/** Condition WHERE sélectionnant un mois (ou les dates NULL). */
function monthCondition(dateCol, month) {
  const d = qi(dateCol);
  if (month === NULL_MONTH) return `${d} IS NULL`;
  return `${d} >= ${dateLit(month)} AND ${d} < ${dateLit(nextMonth(month))}`;
}

/** Condition WHERE de la fenêtre glissante (date >= cutoff). */
function recentCondition(dateCol, cutoff) {
  return `${qi(dateCol)} >= ${dateLit(cutoff)}`;
}

/** Taille de lot d'INSERT : limite de 65535 paramètres par requête. */
function insertChunkSize(ncols) {
  return Math.max(1, Math.floor(60000 / ncols));
}

/** INSERT multi-lignes paramétré ($1..$n). */
function buildInsert(table, cols, nrows) {
  const n = cols.length;
  const tuples = new Array(nrows);
  for (let r = 0; r < nrows; r++) {
    const ph = new Array(n);
    for (let c = 0; c < n; c++) ph[c] = '$' + (r * n + c + 1);
    tuples[r] = '(' + ph.join(',') + ')';
  }
  return `INSERT INTO ${qt(table)} (${colList(cols)}) VALUES ${tuples.join(',')}`;
}

/** SELECT des colonnes source (ordre source) avec filtre optionnel. */
function buildSelect(table, cols, where = null) {
  return `SELECT ${colList(cols)} FROM ${qt(table)}${where ? ` WHERE ${where}` : ''}`;
}

/** "a,b , c" → ['a','b','c'] (espaces retirés, éléments vides ignorés). */
function parseList(value) {
  return String(value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/** "mvtart:datmvt,meteo:date" → { mvtart: 'datmvt', meteo: 'date' }. */
function parseWindowTables(value) {
  const out = {};
  for (const item of parseList(value)) {
    const [table, col] = item.split(':').map(s => (s || '').trim());
    if (!table || !col) throw new Error(`WINDOW_TABLES invalide : "${item}" (attendu table:colonne)`);
    out[table] = col;
  }
  return out;
}

/** Date 'YYYY-MM-DD' (fuseau donné) de "aujourd'hui - days". */
function cutoffDate(days, timeZone = 'Europe/Paris', now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = fmt.format(now); // en-CA → YYYY-MM-DD
  const [y, m, d] = today.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - days));
  return t.toISOString().slice(0, 10);
}

module.exports = {
  qi, qt, lit, dateLit, colList,
  buildCreateTable, buildAddColumn, buildAddPrimaryKey,
  indexDefIfNotExists, needsTrgm,
  buildSignatureQuery, signatureMap, signatureTotal, diffMonths, NULL_MONTH,
  nextMonth, monthCondition, recentCondition,
  insertChunkSize, buildInsert, buildSelect,
  parseList, parseWindowTables, cutoffDate,
};
