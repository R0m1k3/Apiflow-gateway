'use strict';
// Dashboard sync Hostinger — toutes les données dynamiques passent par textContent (pas d'innerHTML).

const $ = id => document.getElementById(id);

function el(tag, opts = {}, children = []) {
  const e = document.createElement(tag);
  if (opts.className) e.className = opts.className;
  if (opts.text != null) e.textContent = String(opts.text);
  if (opts.title) e.title = String(opts.title);
  if (opts.colSpan) e.colSpan = opts.colSpan;
  for (const c of children) e.appendChild(c);
  return e;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleString('fr-FR');
}
function fmtDuration(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + (s % 60) + ' s';
}
function fmtInt(n) {
  return n == null ? '—' : Number(n).toLocaleString('fr-FR');
}

function renderProgress(data) {
  const box = $('progressBox');
  if (!data.running) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const p = data.progress;
  const pct = p ? Math.round((p.index / p.total) * 100) : 0;
  $('progressBar').style.width = pct + '%';
  $('progressPct').textContent = pct + '%';
  $('progressLabel').textContent = 'Sync ' + (data.force ? 'FORCÉE ' : '') + 'en cours — ' +
    (data.phase || '') + (p ? ' — table ' + p.index + '/' + p.total : '');
  $('progressDetail').textContent = p
    ? 'En cours : ' + p.current + ' | Durée : ' + fmtDuration(Date.now() - new Date(p.startedAt))
    : '';
}

function renderRunInfo(data) {
  const run = data.tables.find(t => t.table_name === '_run');
  const box = $('runInfo');
  box.textContent = '';
  if (data.dbError) {
    box.appendChild(el('span', { className: 'st-error', text: 'Erreur : ' + data.dbError }));
    return;
  }
  if (!run) { box.textContent = 'Aucune exécution enregistrée.'; return; }
  box.appendChild(el('span', { text: 'Dernière exécution : ' }));
  box.appendChild(el('strong', { className: 'st-' + run.status, text: run.status }));
  box.appendChild(el('span', { text: ' — ' + fmtDate(run.last_sync) + ' — ' + fmtDuration(run.duration_ms) + ' — ' + (run.detail || '') }));
  if (run.error_msg) box.appendChild(el('div', { className: 'st-error', text: 'Tables en erreur : ' + run.error_msg }));
}

function renderTables(data) {
  const body = $('tableBody');
  body.textContent = '';
  const rows = data.tables.filter(t => t.table_name !== '_run');
  if (!rows.length) {
    body.appendChild(el('tr', {}, [el('td', { colSpan: 7, text: 'Aucune table synchronisée pour le moment.' })]));
    return;
  }
  for (const t of rows) {
    const status = t.status || '—';
    body.appendChild(el('tr', {}, [
      el('td', {}, [el('strong', { text: t.table_name })]),
      el('td', {}, [el('span', { className: 'strat ' + (t.strategy || ''), text: t.strategy || '—' })]),
      el('td', { text: fmtDate(t.last_sync) }),
      el('td', { className: 'num', text: fmtInt(t.rows_synced) }),
      el('td', { className: 'num', text: fmtDuration(t.duration_ms) }),
      el('td', { className: 'st-' + status, text: status }),
      el('td', { className: 'detail', text: t.error_msg || t.detail || '' }),
    ]));
  }
}

function renderStatus(data) {
  const badge = $('statusBadge');
  badge.textContent = data.running ? 'En cours…' : 'Inactif';
  badge.className = 'badge ' + (data.running ? 'running' : 'idle');
  $('btnSync').disabled = data.running;
  $('btnForce').disabled = data.running;
  renderProgress(data);
  renderRunInfo(data);
  renderTables(data);
}

function renderLogs(logs) {
  const box = $('logBox');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 10;
  box.textContent = '';
  if (!logs.length) { box.textContent = 'Aucun log.'; return; }
  for (const l of logs) {
    const line = el('div', { className: 'log-line ' + (['info', 'warn', 'error'].includes(l.level) ? l.level : '') });
    line.appendChild(el('span', { className: 'ts', text: new Date(l.ts).toLocaleTimeString('fr-FR') }));
    line.appendChild(document.createTextNode(l.msg));
    box.appendChild(line);
  }
  if (atBottom) box.scrollTop = box.scrollHeight;
}

async function getJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(url + ' : HTTP ' + r.status);
  return r.json();
}

let lastStatus = null;
async function refresh() {
  try {
    const [s, logs, next] = await Promise.all([getJson('/api/status'), getJson('/api/logs?limit=200'), getJson('/api/next')]);
    lastStatus = s;
    renderStatus(s);
    renderLogs(logs);
    $('nextSync').textContent = 'Prochaine sync auto : ' + fmtDate(next.next) + ' (' + next.cron + ', ' + next.timeZone + ')';
    $('lastRefresh').textContent = 'Mis à jour ' + new Date().toLocaleTimeString('fr-FR');
  } catch (e) {
    console.error(e);
  }
}

function showMsg(ok, text) {
  const msg = $('msg');
  msg.textContent = text;
  msg.className = ok ? 'ok' : 'err';
  setTimeout(() => msg.classList.add('hidden'), 6000);
}

async function runSync(force) {
  if (force && !confirm('Forcer la sync ?\n\nLe garde-fou de volume sera ignoré et les tables de mouvements (mvtart, mvtreg…) seront entièrement rechargées. Cela peut prendre longtemps.')) return;
  try {
    const r = await fetch('/api/sync/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-By': 'ff-dashboard' },
      body: JSON.stringify({ force: !!force }),
    });
    const data = await r.json().catch(() => ({}));
    showMsg(r.ok, r.ok ? data.message : (data.error || 'HTTP ' + r.status));
  } catch (e) {
    showMsg(false, e.message);
  }
  setTimeout(refresh, 800);
}

function copyLogs() {
  const text = Array.from($('logBox').querySelectorAll('.log-line')).map(l => l.textContent).join('\n');
  const btn = $('btnCopyLogs');
  const done = () => { btn.textContent = 'Copié !'; setTimeout(() => { btn.textContent = 'Copier les logs'; }, 2000); };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(() => alert('Copie impossible : sélectionnez les logs puis Ctrl+C'));
  } else {
    alert('Copie impossible hors HTTPS : sélectionnez les logs puis Ctrl+C');
  }
}

$('btnSync').addEventListener('click', () => runSync(false));
$('btnForce').addEventListener('click', () => runSync(true));
$('btnRefresh').addEventListener('click', refresh);
$('btnCopyLogs').addEventListener('click', copyLogs);

async function loop() {
  await refresh();
  setTimeout(loop, lastStatus && lastStatus.running ? 3000 : 15000);
}
loop();
