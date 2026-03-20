'use strict';
const express = require('express');
const { getDst } = require('./db');
const { TABLES } = require('./tables');

const app  = express();
const PORT = process.env.SYNC_DASHBOARD_PORT || 3002;

const TABLES_ORDER = TABLES.map(t => t.name);
const TABLES_TOTAL = TABLES_ORDER.length;

const state = {
  running:  false,
  progress: null,
};

const logBuffer = [];
function pushLog(msg, level = 'info') {
  logBuffer.push({ ts: new Date().toISOString(), msg, level });
  if (logBuffer.length > 300) logBuffer.shift();
}

const _log = console.log.bind(console);
const _err = console.error.bind(console);
console.log   = (...a) => { pushLog(a.join(' '), 'info');  _log(...a); };
console.error = (...a) => { pushLog(a.join(' '), 'error'); _err(...a); };

function setProgress(tableName, index) {
  state.progress = {
    current:   tableName,
    index,
    total:     TABLES_TOTAL,
    pct:       Math.round((index / TABLES_TOTAL) * 100),
    startedAt: state.progress?.startedAt || new Date().toISOString(),
  };
}
function clearProgress() { state.progress = null; }

let syncAllFn = null;
function registerSyncFn(fn) { syncAllFn = fn; }
function setSyncRunning(val) { state.running = val; }
function isSyncRunning()     { return state.running; }

app.use(express.json());

app.get('/api/status', async (req, res) => {
  try {
    const dst = getDst();
    const { rows } = await dst.query(
      `SELECT table_name, last_sync, rows_synced, status, error_msg
       FROM sync_log ORDER BY table_name`
    );
    res.json({ running: state.running, progress: state.progress, tables: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 150;
  res.json(logBuffer.slice(-limit));
});

app.get('/api/next', (req, res) => {
  const now  = new Date();
  const next = new Date(now);
  next.setHours(5, 30, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  res.json({ next: next.toISOString() });
});

app.post('/api/sync/run', async (req, res) => {
  if (state.running) return res.status(409).json({ error: 'Sync déjà en cours' });
  if (!syncAllFn)    return res.status(500).json({ error: 'syncAll non enregistré' });
  res.json({ message: 'Sync lancée' });
  syncAllFn(true).catch(err => console.error('Erreur sync manuelle:', err.message));
});

app.get('/', (req, res) => res.send(HTML));

function startDashboard() {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Dashboard sync Hostinger : http://0.0.0.0:${PORT}`);
  });
}

module.exports = { startDashboard, registerSyncFn, setSyncRunning, isSyncRunning, setProgress, clearProgress };

const HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sync Hostinger</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
header{background:#1e293b;padding:1rem 2rem;display:flex;align-items:center;gap:1rem;border-bottom:1px solid #334155}
header h1{font-size:1.2rem;font-weight:700;color:#f8fafc}
.subtitle{font-size:.75rem;color:#64748b}
.badge{font-size:.75rem;padding:.25rem .6rem;border-radius:9999px;font-weight:600}
.badge.idle{background:#1e3a5f;color:#93c5fd}
.badge.running{background:#713f12;color:#fde68a;animation:pulse 1s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
main{padding:1.5rem 2rem;max-width:1100px;margin:0 auto}
.actions{display:flex;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:1.5rem}
button{padding:.55rem 1.3rem;border:none;border-radius:.5rem;cursor:pointer;font-weight:600;font-size:.85rem;transition:.15s}
#btnSync{background:#2563eb;color:#fff}
#btnSync:hover:not(:disabled){background:#1d4ed8}
#btnSync:disabled{opacity:.4;cursor:not-allowed}
#btnRefresh{background:#334155;color:#cbd5e1}
#btnRefresh:hover{background:#475569}
#nextSync{font-size:.8rem;color:#64748b;margin-left:auto}
#msg{font-size:.82rem;padding:.35rem .75rem;border-radius:.4rem;display:none}
#msg.ok{background:#14532d;color:#86efac;display:inline-block}
#msg.err{background:#450a0a;color:#fca5a5;display:inline-block}
#progressBox{background:#1e293b;border:1px solid #334155;border-radius:.75rem;padding:1rem 1.25rem;margin-bottom:1.5rem;display:none}
#progressBox.visible{display:block}
.progress-header{display:flex;justify-content:space-between;margin-bottom:.6rem;font-size:.85rem}
.progress-bar-bg{background:#0f172a;border-radius:9999px;height:12px;overflow:hidden}
.progress-bar-fill{height:100%;background:linear-gradient(90deg,#059669,#2563eb);border-radius:9999px;transition:width .5s ease}
.progress-detail{margin-top:.5rem;font-size:.78rem;color:#64748b}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem}
@media(max-width:700px){.grid{grid-template-columns:1fr}}
.card{background:#1e293b;border:1px solid #334155;border-radius:.75rem;overflow:hidden}
.card-header{padding:.65rem 1rem;background:#0f172a;border-bottom:1px solid #334155;font-size:.75rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#94a3b8}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th{padding:.55rem 1rem;text-align:left;color:#64748b;font-weight:500;border-bottom:1px solid #334155}
td{padding:.55rem 1rem;border-bottom:1px solid #1e293b}
tr:last-child td{border-bottom:none}
.ok{color:#4ade80}.err{color:#f87171}
.log-box{height:320px;overflow-y:auto;font-family:monospace;font-size:.76rem;padding:.75rem 1rem;background:#0a0f1e;color:#a5f3fc;line-height:1.7;user-select:text;cursor:text}
.log-line{white-space:pre-wrap;word-break:break-all}
.log-line.error{color:#f87171}
.ts{color:#475569;margin-right:.5rem}
#btnCopyLogs{background:#334155;color:#cbd5e1;font-size:.75rem;padding:.35rem .8rem}
#btnCopyLogs:hover{background:#475569}
#lastRefresh{font-size:.75rem;color:#475569}
</style>
</head>
<body>
<header>
  <h1>⚡ Sync Hostinger</h1>
  <span class="subtitle">PG Debian → PG Hostinger</span>
  <span id="statusBadge" class="badge idle">Idle</span>
  <span id="lastRefresh" style="margin-left:auto"></span>
</header>
<main>
  <div class="actions">
    <button id="btnSync" onclick="runSync()">▶ Lancer sync maintenant</button>
    <button id="btnRefresh" onclick="refresh()">↺ Rafraîchir</button>
    <span id="msg"></span>
    <span id="nextSync"></span>
  </div>

  <div id="progressBox">
    <div class="progress-header">
      <span id="progressLabel">Synchronisation en cours…</span>
      <span id="progressPct" style="font-weight:700;color:#93c5fd">0%</span>
    </div>
    <div class="progress-bar-bg">
      <div class="progress-bar-fill" id="progressBar" style="width:0%"></div>
    </div>
    <div class="progress-detail" id="progressDetail"></div>
  </div>

  <div class="grid">
    <div class="card" style="grid-column:1/-1">
      <div class="card-header">Statut des tables</div>
      <table>
        <thead><tr><th>Table</th><th>Dernière sync</th><th>Lignes</th><th>Statut</th></tr></thead>
        <tbody id="tableBody"><tr><td colspan="4" style="color:#475569;padding:1rem">Chargement…</td></tr></tbody>
      </table>
    </div>
    <div class="card" style="grid-column:1/-1">
      <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
        <span>Logs</span>
        <button id="btnCopyLogs" onclick="copyLogs()">Copier les logs</button>
      </div>
      <div class="log-box" id="logBox">Chargement…</div>
    </div>
  </div>
</main>
<script>
function fmtDate(iso){
  if(!iso) return '—';
  return new Date(iso).toLocaleString('fr-FR');
}
function renderProgress(progress, running){
  const box = document.getElementById('progressBox');
  if(!running || !progress){ box.classList.remove('visible'); return; }
  box.classList.add('visible');
  document.getElementById('progressBar').style.width   = progress.pct + '%';
  document.getElementById('progressPct').textContent   = progress.pct + '%';
  document.getElementById('progressLabel').textContent =
    'Sync en cours — table ' + progress.index + '/' + progress.total;
  const elapsed = Math.round((Date.now() - new Date(progress.startedAt)) / 1000);
  document.getElementById('progressDetail').textContent =
    'En cours : ' + progress.current + ' | Durée : ' + elapsed + 's';
}
function renderStatus(data){
  const badge = document.getElementById('statusBadge');
  badge.textContent = data.running ? 'En cours…' : 'Idle';
  badge.className   = 'badge ' + (data.running ? 'running' : 'idle');
  document.getElementById('btnSync').disabled = data.running;
  renderProgress(data.progress, data.running);
  if(!data.tables.length){
    document.getElementById('tableBody').innerHTML =
      '<tr><td colspan="4" style="color:#475569;padding:1rem">Aucune sync — cliquez sur Lancer sync maintenant</td></tr>';
    return;
  }
  document.getElementById('tableBody').innerHTML = data.tables.map(t => \`
    <tr>
      <td><strong>\${t.table_name}</strong></td>
      <td>\${fmtDate(t.last_sync)}</td>
      <td>\${t.rows_synced ?? '—'}</td>
      <td class="\${t.status==='ok'?'ok':'err'}">\${t.status ?? '—'}\${t.error_msg?' — '+t.error_msg:''}</td>
    </tr>
  \`).join('');
}
function renderLogs(logs){
  const box = document.getElementById('logBox');
  if(!logs.length){ box.textContent = 'Aucun log.'; return; }
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 10;
  box.innerHTML = logs.map(l => \`
    <div class="log-line \${l.level}">
      <span class="ts">\${new Date(l.ts).toLocaleTimeString('fr-FR')}</span>\${l.msg}
    </div>
  \`).join('');
  if(atBottom) box.scrollTop = box.scrollHeight;
}
async function refresh(){
  try{
    const [s, logs, next] = await Promise.all([
      fetch('/api/status').then(r=>r.json()),
      fetch('/api/logs?limit=150').then(r=>r.json()),
      fetch('/api/next').then(r=>r.json()),
    ]);
    renderStatus(s);
    renderLogs(logs);
    document.getElementById('nextSync').textContent = 'Prochaine sync auto : ' + fmtDate(next.next);
    document.getElementById('lastRefresh').textContent = 'Mis à jour ' + new Date().toLocaleTimeString('fr-FR');
  } catch(e){ console.error(e); }
}
function copyLogs(){
  const box  = document.getElementById('logBox');
  const text = Array.from(box.querySelectorAll('.log-line')).map(l => l.textContent).join('\\n');
  const btn  = document.getElementById('btnCopyLogs');
  function onSuccess(){ btn.textContent = 'Copié !'; setTimeout(() => { btn.textContent = 'Copier les logs'; }, 2000); }
  if(navigator.clipboard && window.isSecureContext){
    navigator.clipboard.writeText(text).then(onSuccess).catch(fallback);
  } else { fallback(); }
  function fallback(){
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    try{ document.execCommand('copy'); onSuccess(); } catch(e){ alert('Sélectionnez les logs et Ctrl+C'); }
    document.body.removeChild(ta);
  }
}
async function runSync(){
  const msg = document.getElementById('msg');
  msg.style.display = 'none';
  const r    = await fetch('/api/sync/run',{method:'POST'});
  const data = await r.json();
  msg.textContent = r.ok ? '✓ ' + data.message : '✗ ' + data.error;
  msg.className   = r.ok ? 'ok' : 'err';
  setTimeout(()=>{ msg.style.display='none'; }, 5000);
  setTimeout(refresh, 800);
}
let timer;
async function loop(){
  await refresh();
  const s = await fetch('/api/status').then(r=>r.json()).catch(()=>({}));
  timer = setTimeout(loop, s.running ? 3000 : 15000);
}
loop();
</script>
</body>
</html>`;
