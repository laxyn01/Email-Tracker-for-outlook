/**
 * Email Tracker Server v5 — REBUILT FROM SCRATCH
 *
 * WHAT WAS BROKEN IN v3/v4:
 *
 * 1. 'googleimageproxy' was in BOT_UA list — WRONG.
 *    Gmail proxies ALL images through googleimageproxy on behalf of the RECIPIENT.
 *    Blocking it means you block every Gmail open. It MUST be counted as a real open.
 *
 * 2. senderIP filter blocked everything on Render.com.
 *    Render sits behind a shared reverse proxy — every request (including /register)
 *    arrives from the SAME proxy IP. So senderIP === every pixel hit IP === everything blocked.
 *    Fix: TIME-BASED GRACE WINDOW. Outlook Desktop fires within 3-5s of send/preview.
 *    We ignore all hits within the first 10s of registration — catches Outlook auto-preview
 *    without blocking real recipients (nobody opens an email within 10s of it being sent).
 *
 * 3. '?' entries — item.to.getAsync() called before compose window resolved recipients.
 *    Fix: retry loop with timeout in taskpane.
 *
 * 4. Dedup window 2 min was causing real opens to be skipped.
 *    Fix: 30s dedup only — catches double-fires, not legitimate re-opens.
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3000;

// ── Persistence ───────────────────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'email_logs.json');
function loadLogs() {
  try {
    if (fs.existsSync(DATA_FILE))
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e) { console.error('Load error:', e.message); }
  return {};
}
function saveLogs() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(emailLogs, null, 2)); }
  catch(e) { console.error('Save error:', e.message); }
}
let emailLogs = loadLogs();
console.log('[Boot] Loaded', Object.keys(emailLogs).length, 'records');

// ── Transparent 1x1 GIF ───────────────────────────────────────────────────────
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

// ── UA Classification ─────────────────────────────────────────────────────────
// googleimageproxy = Gmail's image proxy = recipient opened in Gmail. ALLOW IT.
// Do NOT put it in BOT_SIGNATURES.
const GMAIL_PROXY = ['googleimageproxy', 'ggpht', 'google image proxy'];

// These are pure crawlers/scanners — block them
const BOT_SIGNATURES = [
  'googlebot', 'bingbot', 'yahoo! slurp', 'duckduckbot', 'yandexbot',
  'baidu', 'sogou', 'exabot', 'ia_archiver',
  'twitterbot', 'linkedinbot', 'slackbot', 'whatsapp', 'telegrambot',
  'facebookexternalhit', 'discordbot',
  'mimecast', 'proofpoint', 'barracuda', 'ironport', 'symantec', 'sophos',
  'microsoft url defense', 'safelinks', 'messagelabs', 'forcepoint', 'trend micro',
  'headlesschrome', 'phantomjs', 'selenium', 'puppeteer', 'playwright',
  'python-requests', 'curl/', 'wget/',
  'linkcheck', 'preview', 'prefetch',
];

function classifyUA(ua) {
  const u = (ua || '').toLowerCase();
  if (GMAIL_PROXY.some(s => u.includes(s))) return 'gmail-proxy'; // real Gmail open
  if (BOT_SIGNATURES.some(s => u.includes(s))) return 'bot';
  return 'real';
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

function getDevice(ua, uaClass) {
  if (uaClass === 'gmail-proxy') return 'Gmail Proxy';
  if (!ua) return 'Desktop';
  if (/iPhone/i.test(ua))    return 'iPhone';
  if (/Android/i.test(ua))   return 'Android';
  if (/iPad/i.test(ua))      return 'iPad';
  if (/Windows/i.test(ua))   return 'Windows PC';
  if (/Macintosh/i.test(ua)) return 'Mac';
  return 'Desktop';
}

function getClient(ua, uaClass) {
  if (uaClass === 'gmail-proxy') return 'Gmail';
  if (!ua) return 'Unknown';
  if (/GSA/i.test(ua) || /gmail/i.test(ua))     return 'Gmail App';
  if (/Outlook|microsoft office/i.test(ua))      return 'Outlook';
  if (/Apple Mail/i.test(ua))                    return 'Apple Mail';
  if (/Thunderbird/i.test(ua))                   return 'Thunderbird';
  if (/yahoo/i.test(ua))                         return 'Yahoo Mail';
  return 'Webmail/Other';
}

function nowIST() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

function esc(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── /ping — keeps Render free tier alive ──────────────────────────────────────
app.get('/ping', (req, res) => res.json({ ok: true, time: nowIST() }));

// ── /register ─────────────────────────────────────────────────────────────────
app.get('/register', (req, res) => {
  const { id, subject, to } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing id' });

  emailLogs[id] = {
    subject:       subject || 'No Subject',
    to:            to || 'Unknown',
    sentAt:        nowIST(),
    sentTimestamp: Date.now(),
    opens:         [],
    ignored:       [],
  };
  saveLogs();
  console.log('[Register]', id, '| to:', to, '| subject:', subject);
  res.json({ ok: true });
});

// ── /pixel ────────────────────────────────────────────────────────────────────
function handlePixel(req, res) {
  res.set({
    'Content-Type':  'image/gif',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma':        'no-cache',
    'Expires':       '0',
  });
  res.end(PIXEL);

  setImmediate(() => {
    const id  = req.params.id;
    const ua  = req.headers['user-agent'] || '';
    const ip  = getIP(req);
    const now = Date.now();

    if (!emailLogs[id]) {
      emailLogs[id] = {
        subject: 'Unknown (pre-restart)', to: 'Unknown',
        sentAt: '?', sentTimestamp: 0, opens: [], ignored: [],
      };
    }
    const rec = emailLogs[id];
    if (!rec.ignored) rec.ignored = [];

    function ignore(reason) {
      rec.ignored.push({ time: nowIST(), ip, ua: ua.slice(0,120), reason });
      saveLogs();
      console.log('[Ignored]', id, reason, ip, ua.slice(0,60));
    }

    const uaClass = classifyUA(ua);

    // Block pure bots
    if (uaClass === 'bot') return ignore('bot-ua');

    // TIME-BASED GRACE WINDOW (replaces broken senderIP filter)
    // Outlook Desktop fires pixel within ~3s when sender views Sent folder.
    // Ignore any hit in the first 10s after registration.
    const age = now - (rec.sentTimestamp || 0);
    if (age < 10000) return ignore('grace-window-10s');

    // Dedup: same IP within 30s (catches accidental double-fire only)
    const isDup = rec.opens.some(o => o.ip === ip && (now - (o.ts || 0)) < 30000);
    if (isDup) return ignore('dedup-30s');

    // Real open
    const open = {
      ts:     now,
      time:   nowIST(),
      device: getDevice(ua, uaClass),
      client: getClient(ua, uaClass),
      ip,
      ua: ua.slice(0, 150),
    };
    rec.opens.push(open);
    saveLogs();
    console.log('[OPEN] #' + rec.opens.length, id, '|', rec.subject, '|', open.client, '| ip:', ip);
  });
}

app.get('/pixel/:id.gif', handlePixel);
app.get('/pixel/:id',     handlePixel);

// ── /status/:id ───────────────────────────────────────────────────────────────
app.get('/status/:id', (req, res) => {
  const r = emailLogs[req.params.id];
  if (!r) return res.json({ found: false });
  res.json({
    found:     true,
    subject:   r.subject,
    to:        r.to,
    sentAt:    r.sentAt,
    openCount: r.opens.length,
    opens:     r.opens,
    ignored:   (r.ignored || []).length,
  });
});

// ── /debug/:id ────────────────────────────────────────────────────────────────
app.get('/debug/:id', (req, res) => {
  const r = emailLogs[req.params.id];
  if (!r) return res.json({ error: 'Not found' });
  res.json(r);
});

// ── /dashboard ────────────────────────────────────────────────────────────────
app.get('/dashboard', (req, res) => {
  const entries = Object.entries(emailLogs)
    .filter(([, e]) => e.subject !== 'Unknown (pre-restart)')
    .sort((a, b) => (b[1].sentTimestamp || 0) - (a[1].sentTimestamp || 0));
  const total  = entries.length;
  const opened = entries.filter(([, e]) => e.opens.length > 0).length;
  const rate   = total > 0 ? Math.round(opened / total * 100) : 0;
  const totalOpens = entries.reduce((s, [,e]) => s + e.opens.length, 0);

  // ── Chart data: opens per day for last 30 days ──
  const now30 = Date.now();
  const DAY   = 86400000;
  const chartDays = 30;
  const dayCounts = {};
  for (let i = 0; i < chartDays; i++) {
    const d = new Date(now30 - i * DAY);
    const key = d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day:'2-digit', month:'short' });
    dayCounts[key] = 0;
  }
  entries.forEach(([, e]) => {
    (e.opens || []).forEach(o => {
      const d = new Date(o.ts || 0);
      const key = d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day:'2-digit', month:'short' });
      if (key in dayCounts) dayCounts[key]++;
    });
  });
  const chartLabels = Object.keys(dayCounts).reverse();
  const chartValues = chartLabels.map(k => dayCounts[k]);

  // ── Top performing emails (by open count) ──
  const topEmails = [...entries]
    .filter(([, e]) => e.opens.length > 0)
    .sort((a, b) => b[1].opens.length - a[1].opens.length)
    .slice(0, 10);

  const topRows = topEmails.length === 0
    ? '<div class="empty-top">No opened emails yet.</div>'
    : topEmails.map(([id, d], i) => `
        <div class="top-row">
          <span class="top-num">${i+1}</span>
          <div class="top-info">
            <div class="top-subj">${esc(d.subject)}</div>
            <div class="top-to">${esc(d.to)}</div>
          </div>
          <span class="top-opens">${d.opens.length} open${d.opens.length>1?'s':''}</span>
        </div>`
    ).join('');

  // ── Main table rows ──
  const rows = !total
    ? '<tr><td colspan="7" class="empty">No emails tracked yet. Open Outlook, compose, click Track.</td></tr>'
    : entries.map(([id, d]) => {
        const isOpened = d.opens.length > 0;
        const last     = isOpened ? d.opens[d.opens.length - 1] : null;
        const ignored  = (d.ignored || []).length;
        const openRows = d.opens.map((o, i) =>
          `<div class="orow">
            <span class="n">#${i+1}</span>
            <span>${esc(o.time)}</span>
            <span class="chip">${esc(o.device)}</span>
            <span class="chip blue">${esc(o.client)}</span>
            <span class="ip">${esc(o.ip)}</span>
          </div>`
        ).join('') || '<span class="dim">—</span>';
        return `<tr class="erow" data-subj="${esc(d.subject.toLowerCase())}" data-to="${esc(d.to.toLowerCase())}" data-status="${isOpened?'opened':'not'}">
          <td class="subj">${esc(d.subject)}</td>
          <td class="sm">${esc(d.to)}</td>
          <td class="sm grey">${esc(d.sentAt)}</td>
          <td>
            <span class="badge ${isOpened ? 'g' : 'r'}">
              ${isOpened ? '✅ ' + d.opens.length + 'x opened' : '❌ Not opened'}
            </span>
            ${ignored ? `<br><span class="dim">${ignored} hits filtered</span>` : ''}
          </td>
          <td class="sm">${last ? esc(last.time) : '—'}</td>
          <td class="sm">${last ? esc(last.device) : '—'}</td>
          <td class="opens">${openRows}</td>
        </tr>`;
      }).join('');

  res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>Email Tracker</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#f4f6fb;color:#1a1a2e}

/* ── Header ── */
.hdr{background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;padding:18px 32px;display:flex;justify-content:space-between;align-items:center}
.hdr h1{font-size:17px;font-weight:700}.hdr p{font-size:11px;opacity:.65;margin-top:3px}
.live{background:rgba(255,255,255,.15);border-radius:20px;padding:4px 13px;font-size:11px;font-weight:700;display:flex;align-items:center;gap:6px}
.dot{width:7px;height:7px;background:#4ade80;border-radius:50%;animation:pulse 1.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

/* ── Layout ── */
.wrap{padding:22px 32px;max-width:1400px;margin:0 auto}
.section-title{font-size:14px;font-weight:700;color:#1a1a2e;margin-bottom:14px}
.section-sub{font-size:11px;color:#9ca3af;margin-top:2px;font-weight:400}

/* ── Stat cards ── */
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:24px}
.stat{background:#fff;border-radius:14px;padding:18px 20px;box-shadow:0 1px 8px rgba(79,70,229,.07);display:flex;align-items:center;gap:14px}
.stat-icon{width:42px;height:42px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
.ic-blue{background:#ede9fe}.ic-green{background:#dcfce7}.ic-red{background:#fee2e2}.ic-amber{background:#fef3c7}
.sn{font-size:28px;font-weight:800;color:#1a1a2e;line-height:1}
.sl{font-size:11px;color:#9ca3af;margin-top:3px}

/* ── Two-col charts row ── */
.charts-row{display:grid;grid-template-columns:1.6fr 1fr;gap:16px;margin-bottom:24px}
.chart-card{background:#fff;border-radius:14px;padding:20px;box-shadow:0 1px 8px rgba(79,70,229,.07)}
.chart-wrap{position:relative;height:180px;margin-top:12px}

/* ── Top emails ── */
.top-row{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #f3f4f6}
.top-row:last-child{border-bottom:none}
.top-num{width:24px;height:24px;background:#f3f4f6;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#6b7280;flex-shrink:0}
.top-info{flex:1;min-width:0}
.top-subj{font-size:12px;font-weight:600;color:#1a1a2e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.top-to{font-size:10px;color:#9ca3af;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.top-opens{font-size:11px;font-weight:700;color:#4f46e5;white-space:nowrap}
.empty-top{text-align:center;padding:30px;color:#9ca3af;font-size:12px}

/* ── Table card ── */
.card{background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 1px 8px rgba(79,70,229,.07);margin-bottom:16px}
.table-toolbar{display:flex;gap:10px;padding:14px 16px;border-bottom:1px solid #f3f4f6;align-items:center}
.search-wrap{flex:1;position:relative}
.search-wrap input{width:100%;padding:8px 12px 8px 34px;border:1.5px solid #e5e7eb;border-radius:8px;font-size:12px;outline:none;color:#374151}
.search-wrap input:focus{border-color:#4f46e5}
.search-icon{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:#9ca3af;font-size:13px}
select{padding:8px 12px;border:1.5px solid #e5e7eb;border-radius:8px;font-size:12px;color:#374151;outline:none;cursor:pointer}
select:focus{border-color:#4f46e5}
table{width:100%;border-collapse:collapse}
thead tr{background:linear-gradient(135deg,#4f46e5,#7c3aed)}
th{color:#fff;padding:11px 16px;text-align:left;font-size:10px;font-weight:600;letter-spacing:.6px;text-transform:uppercase}
td{padding:11px 16px;border-bottom:1px solid #f3f4f6;vertical-align:top;font-size:12px}
tr:last-child td{border-bottom:none}
tr.erow:hover td{background:#fafbff}
tr.erow.hidden{display:none}
.subj{font-weight:600;font-size:12px;color:#1a1a2e}.sm{font-size:11px}.grey{color:#9ca3af}
.empty{text-align:center;padding:50px;color:#9ca3af;font-size:13px}
.badge{display:inline-block;padding:3px 11px;border-radius:20px;font-size:11px;font-weight:700;white-space:nowrap}
.badge.g{background:#dcfce7;color:#15803d}.badge.r{background:#fee2e2;color:#b91c1c}
.orow{display:flex;align-items:center;gap:6px;font-size:10px;margin-bottom:3px;flex-wrap:wrap}
.n{background:#4f46e5;color:#fff;border-radius:10px;padding:1px 7px;font-weight:700;font-size:9px}
.chip{background:#f3f4f6;border-radius:5px;padding:1px 7px;font-size:10px;color:#374151}
.blue{background:#ede9fe;color:#6d28d9}.ip{color:#d1d5db;font-family:monospace;font-size:9px}
.dim{color:#d1d5db;font-size:10px}
.foot{text-align:center;padding:14px;color:#9ca3af;font-size:11px}
.no-results{display:none;text-align:center;padding:40px;color:#9ca3af;font-size:13px}
</style>
</head><body>

<div class="hdr">
  <div><h1>📧 Email Tracker Dashboard</h1>
  <p>Auto-refresh every 15s &nbsp;•&nbsp; Bots &amp; proxies filtered &nbsp;•&nbsp; Data persisted to disk</p></div>
  <div class="live"><span class="dot"></span> Live</div>
</div>

<div class="wrap">

  <!-- Stat Cards -->
  <div class="stats">
    <div class="stat">
      <div class="stat-icon ic-blue">📧</div>
      <div><div class="sn">${total}</div><div class="sl">Total Tracked</div></div>
    </div>
    <div class="stat">
      <div class="stat-icon ic-green">✅</div>
      <div><div class="sn" style="color:#16a34a">${opened}</div><div class="sl">Opened</div></div>
    </div>
    <div class="stat">
      <div class="stat-icon ic-red">❌</div>
      <div><div class="sn" style="color:#dc2626">${total - opened}</div><div class="sl">Not Opened</div></div>
    </div>
    <div class="stat">
      <div class="stat-icon ic-amber">📈</div>
      <div><div class="sn" style="color:#d97706">${rate}%</div><div class="sl">Open Rate</div></div>
    </div>
  </div>

  <!-- Charts Row -->
  <div class="charts-row">
    <div class="chart-card">
      <div class="section-title">Activity Trends <span class="section-sub">(Last 30 Days)</span></div>
      <div class="chart-wrap"><canvas id="trendChart"></canvas></div>
    </div>
    <div class="chart-card">
      <div class="section-title">Top Performing Emails <span class="section-sub">by opens</span></div>
      <div style="margin-top:8px">${topRows}</div>
    </div>
  </div>

  <!-- Tracked Emails Table -->
  <div class="section-title" style="margin-bottom:12px">
    All Tracked Emails
    <span class="section-sub">(${total} total)</span>
  </div>
  <div class="card">
    <div class="table-toolbar">
      <div class="search-wrap">
        <span class="search-icon">🔍</span>
        <input type="text" id="searchInput" placeholder="Search by subject or email..." oninput="filterTable()">
      </div>
      <select id="statusFilter" onchange="filterTable()">
        <option value="all">All Status</option>
        <option value="opened">Opened</option>
        <option value="not">Not Opened</option>
      </select>
    </div>
    <table>
      <thead><tr>
        <th>Subject</th><th>Sent To</th><th>Sent At</th>
        <th>Status</th><th>Last Opened</th><th>Device</th><th>All Opens</th>
      </tr></thead>
      <tbody id="tableBody">${rows}</tbody>
    </table>
    <div class="no-results" id="noResults">No emails match your search.</div>
  </div>

</div>
<div class="foot">Newest emails shown first. Data saved to disk — survives server restarts.</div>

<script>
// ── Trend Chart ───────────────────────────────────────────────────────────────
const labels = ${JSON.stringify(chartLabels)};
const values = ${JSON.stringify(chartValues)};
const ctx = document.getElementById('trendChart').getContext('2d');
new Chart(ctx, {
  type: 'line',
  data: {
    labels,
    datasets: [{
      label: 'Opens',
      data: values,
      borderColor: '#4f46e5',
      backgroundColor: 'rgba(79,70,229,0.08)',
      borderWidth: 2,
      pointRadius: 3,
      pointBackgroundColor: '#4f46e5',
      fill: true,
      tension: 0.4,
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: ctx => ctx.parsed.y + ' opens' } }
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { font: { size: 9 }, maxTicksLimit: 8, color: '#9ca3af' }
      },
      y: {
        beginAtZero: true,
        ticks: { stepSize: 1, font: { size: 9 }, color: '#9ca3af' },
        grid: { color: '#f3f4f6' }
      }
    }
  }
});

// ── Search + Filter ───────────────────────────────────────────────────────────
function filterTable() {
  const q      = document.getElementById('searchInput').value.toLowerCase().trim();
  const status = document.getElementById('statusFilter').value;
  const rows   = document.querySelectorAll('tr.erow');
  let visible  = 0;
  rows.forEach(r => {
    const matchQ = !q || r.dataset.subj.includes(q) || r.dataset.to.includes(q);
    const matchS = status === 'all' || r.dataset.status === status;
    const show   = matchQ && matchS;
    r.classList.toggle('hidden', !show);
    if (show) visible++;
  });
  document.getElementById('noResults').style.display = visible === 0 ? 'block' : 'none';
}
</script>
</body></html>`);
});

app.get('/', (req, res) => res.send('Email Tracker v5 running. Go to /dashboard'));
app.listen(PORT, () => console.log('[Server] Running on port', PORT));
