'use strict';
const { Pool } = require('pg');

/**
 * Paramètres de session identiques des deux côtés : indispensables pour que
 * ROW(...)::text (signatures par mois) produise le même texte sur la source et la
 * destination (fuseau, format des dates/intervalles, précision des flottants).
 */
const SESSION_OPTIONS = [
  '-c TimeZone=UTC',
  '-c DateStyle=ISO',
  '-c IntervalStyle=postgres',
  '-c extra_float_digits=3',
  '-c bytea_output=hex',
].join(' ');

let srcPool = null;
let dstPool = null;

function makePool(prefix, max) {
  const required = ['HOST', 'DB', 'USER', 'PASS'];
  const missing = required.filter(k => !process.env[`${prefix}_${k}`]);
  if (missing.length) throw new Error(`Variables manquantes : ${missing.map(k => `${prefix}_${k}`).join(', ')}`);
  const pool = new Pool({
    host:     process.env[`${prefix}_HOST`],
    port:     parseInt(process.env[`${prefix}_PORT`], 10) || 5432,
    database: process.env[`${prefix}_DB`],
    user:     process.env[`${prefix}_USER`],
    password: process.env[`${prefix}_PASS`],
    max,
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 60000,
    keepAlive: true,
    application_name: 'ff_sync_hostinger',
    options: SESSION_OPTIONS,
  });
  // Une connexion inactive qui tombe (tunnel frp coupé…) ne doit pas tuer le process
  pool.on('error', err => console.error(`[pool ${prefix}] ${err.message}`));
  return pool;
}

/** Source : PostgreSQL Debian via le tunnel frps:15432 (lecture seule). */
function getSrc() {
  if (!srcPool) srcPool = makePool('SRC', 3);
  return srcPool;
}

/** Destination : PostgreSQL Hostinger (container postgres_db). */
function getDst() {
  if (!dstPool) dstPool = makePool('DST', 6);
  return dstPool;
}

async function closeAll() {
  const p = [];
  if (srcPool) { p.push(srcPool.end()); srcPool = null; }
  if (dstPool) { p.push(dstPool.end()); dstPool = null; }
  await Promise.allSettled(p);
}

module.exports = { getSrc, getDst, closeAll, SESSION_OPTIONS };
