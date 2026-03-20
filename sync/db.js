'use strict';
const { Pool } = require('pg');

let srcPool = null;
let dstPool = null;

function getSrc() {
  if (!srcPool) {
    srcPool = new Pool({
      host:     process.env.SRC_HOST,
      port:     parseInt(process.env.SRC_PORT) || 5432,
      database: process.env.SRC_DB,
      user:     process.env.SRC_USER,
      password: process.env.SRC_PASS,
      max: 3,
      connectionTimeoutMillis: 10000,
    });
  }
  return srcPool;
}

function getDst() {
  if (!dstPool) {
    dstPool = new Pool({
      host:     process.env.DST_HOST,
      port:     parseInt(process.env.DST_PORT) || 5432,
      database: process.env.DST_DB,
      user:     process.env.DST_USER,
      password: process.env.DST_PASS,
      max: 5,
    });
  }
  return dstPool;
}

async function closeAll() {
  if (srcPool) { await srcPool.end(); srcPool = null; }
  if (dstPool) { await dstPool.end(); dstPool = null; }
}

module.exports = { getSrc, getDst, closeAll };
