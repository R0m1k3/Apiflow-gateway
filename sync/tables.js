'use strict';
// Définition des tables à synchroniser PG Debian → PG Hostinger
// pk: [] = full refresh (TRUNCATE + INSERT), sinon ON CONFLICT DO UPDATE

const TABLES = [
  // Référentiel
  { name: 'nomenclature',        pk: ['no_id'] },
  { name: 'gammes',              pk: ['no_id'] },
  { name: 'saisons',             pk: ['no_id'] },
  // Articles
  { name: 'articles',            pk: ['no_id'] },
  { name: 'article_infosup',     pk: ['artnoid'] },
  { name: 'art_gtin',            pk: ['idarticle', 'gtin'] },
  { name: 'art_gamme_saison',    pk: ['artnoid', 'idgamme', 'idsaison'] },
  // Fournisseurs
  { name: 'fouadr1',             pk: ['code', 'sit_code'] },
  { name: 'artfou1',             pk: ['no_id'] },
  { name: 'artfou2',             pk: ['idartfou1'] },
  // Stock & prix
  { name: 'cube_pa',             pk: ['artnoid'] },
  { name: 'cube_pv',             pk: ['artnoid', 'site'] },
  { name: 'cube_stock',          pk: ['artnoid', 'site'] },
  // Mouvements (sans PK → full refresh)
  { name: 'mvtart',              pk: [] },
  { name: 'mvtreg',              pk: [] },
  // Ranking
  { name: 'ranking',             pk: ['gencod', 'site'] },
  // Commandes
  { name: 'cdefou_reception',    pk: ['no_id'] },
  { name: 'cdefou_vivant',       pk: ['cdefou_ligne_com_no_id', 'artfou1_no_id'] },
  { name: 'cdefou_receplig',     pk: ['no_id'] },
];

module.exports = { TABLES };
