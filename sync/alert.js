'use strict';
/**
 * Alerte par webhook (Slack, Discord, Mattermost, ntfy… compatibles JSON).
 * Envoie {text, content} : Slack/Mattermost lisent "text", Discord lit "content".
 * Ne lève jamais d'exception.
 */
const { config } = require('./config');
const log = require('./logger');

async function sendAlert(message) {
  if (!config.alertWebhookUrl) return false;
  const text = String(message).slice(0, 1900); // Discord : 2000 caractères max
  try {
    const res = await fetch(config.alertWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, content: text }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      log.warn(`Alerte webhook : réponse HTTP ${res.status}`);
      return false;
    }
    log.info('Alerte envoyée');
    return true;
  } catch (err) {
    log.warn(`Alerte webhook impossible : ${err.message}`);
    return false;
  }
}

module.exports = { sendAlert };
