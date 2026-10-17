'use strict';
// Tests des fonctions pures de génération SQL : `npm test` (node --test, sans base de données).
const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../sql');

test('qi échappe les guillemets', () => {
  assert.equal(s.qi('mvtart'), '"mvtart"');
  assert.equal(s.qi('a"b'), '"a""b"');
});

test('buildCreateTable : colonnes ordonnées, NOT NULL, PK', () => {
  const sql = s.buildCreateTable('mvtart', [
    { name: 'no_id', type: 'bigint', notnull: true },
    { name: 'datmvt', type: 'timestamp without time zone', notnull: false },
    { name: 'qte', type: 'numeric(12,4)', notnull: false },
  ], ['no_id']);
  assert.equal(sql,
    'CREATE TABLE IF NOT EXISTS public."mvtart" (\n' +
    '  "no_id" bigint NOT NULL,\n' +
    '  "datmvt" timestamp without time zone,\n' +
    '  "qte" numeric(12,4),\n' +
    '  PRIMARY KEY ("no_id")\n)');
  assert.ok(!s.buildCreateTable('t', [{ name: 'a', type: 'text' }], []).includes('PRIMARY KEY'));
});

test('buildAddColumn est idempotent et nullable', () => {
  assert.equal(s.buildAddColumn('articles', { name: 'artcentrale', type: 'text', notnull: true }),
    'ALTER TABLE public."articles" ADD COLUMN IF NOT EXISTS "artcentrale" text');
});

test('indexDefIfNotExists', () => {
  assert.equal(s.indexDefIfNotExists('CREATE INDEX idx_a ON public.articles USING btree (codein)'),
    'CREATE INDEX IF NOT EXISTS idx_a ON public.articles USING btree (codein)');
  assert.equal(s.indexDefIfNotExists('CREATE UNIQUE INDEX u ON public.t USING btree (a, b)'),
    'CREATE UNIQUE INDEX IF NOT EXISTS u ON public.t USING btree (a, b)');
  assert.equal(s.indexDefIfNotExists('CREATE INDEX IF NOT EXISTS x ON public.t (a)'),
    'CREATE INDEX IF NOT EXISTS x ON public.t (a)');
  assert.throws(() => s.indexDefIfNotExists('DROP TABLE x'));
});

test('needsTrgm', () => {
  assert.ok(s.needsTrgm('CREATE INDEX i ON public.a USING gin (libelle1 gin_trgm_ops)'));
  assert.ok(!s.needsTrgm('CREATE INDEX i ON public.a USING btree (libelle1)'));
});

test('buildSignatureQuery : colonnes explicites dans l\'ordre source', () => {
  const sql = s.buildSignatureQuery('mvtart', [{ name: 'no_id' }, { name: 'datmvt' }], 'datmvt');
  assert.match(sql, /date_trunc\('month', "datmvt"\)/);
  assert.match(sql, /hashtext\(ROW\("no_id", "datmvt"\)::text\)::bigint/);
  assert.match(sql, /FROM public\."mvtart"\nGROUP BY 1$/);
});

test('signatures : diff, total, mois NULL', () => {
  const src = s.signatureMap([
    { m: '2026-08-01', n: '10', h: '123' },
    { m: '2026-09-01', n: '5', h: '7' },
    { m: null, n: '1', h: '9' },
  ]);
  const dst = s.signatureMap([
    { m: '2026-08-01', n: '10', h: '123' },
    { m: '2026-09-01', n: '5', h: '8' },
    { m: '2026-07-01', n: '3', h: '1' },
  ]);
  assert.deepEqual(s.diffMonths(src, dst), ['2026-07-01', '2026-09-01', s.NULL_MONTH]);
  assert.equal(s.signatureTotal(src), 16);
});

test('monthCondition / nextMonth / recentCondition', () => {
  assert.equal(s.nextMonth('2026-12-01'), '2027-01-01');
  assert.equal(s.nextMonth('2026-02-01'), '2026-03-01');
  assert.equal(s.monthCondition('datmvt', '2026-12-01'), `"datmvt" >= '2026-12-01' AND "datmvt" < '2027-01-01'`);
  assert.equal(s.monthCondition('datmvt', s.NULL_MONTH), '"datmvt" IS NULL');
  assert.equal(s.recentCondition('date', '2026-10-07'), `"date" >= '2026-10-07'`);
  assert.throws(() => s.monthCondition('d', "2026-01-01'; DROP TABLE x; --"));
});

test('buildInsert / insertChunkSize', () => {
  assert.equal(s.buildInsert('t', [{ name: 'a' }, { name: 'b' }], 2),
    'INSERT INTO public."t" ("a", "b") VALUES ($1,$2),($3,$4)');
  assert.equal(s.insertChunkSize(30), 2000);
  assert.equal(s.insertChunkSize(100000), 1);
  assert.ok(s.insertChunkSize(7) * 7 <= 65535);
});

test('parseWindowTables / parseList', () => {
  assert.deepEqual(s.parseWindowTables('mvtart:datmvt, meteo:date'), { mvtart: 'datmvt', meteo: 'date' });
  assert.throws(() => s.parseWindowTables('mvtart'));
  assert.deepEqual(s.parseList(' a, ,b '), ['a', 'b']);
  assert.deepEqual(s.parseList(undefined), []);
});

test('cutoffDate en Europe/Paris', () => {
  // 17/10/2026 23:30 UTC = 18/10/2026 01:30 à Paris
  assert.equal(s.cutoffDate(10, 'Europe/Paris', new Date('2026-10-17T23:30:00Z')), '2026-10-08');
  assert.equal(s.cutoffDate(0, 'Europe/Paris', new Date('2026-03-01T12:00:00Z')), '2026-03-01');
});
