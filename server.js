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
    .sort((a, b) => (b[1].sentTimestamp || 0) - (a[1].sentTimestamp || 0));
  const total  = entries.length;
  const opened = entries.filter(([, e]) => e.opens.length > 0).length;
  const rate   = total > 0 ? Math.round(opened / total * 100) : 0;

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
        return `<tr>
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
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#eef1fb;color:#1a1a2e}
.hdr{background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;padding:22px 32px;display:flex;justify-content:space-between;align-items:center}
.hdr h1{font-size:18px;font-weight:700}.hdr p{font-size:11px;opacity:.7;margin-top:4px}
.live{background:rgba(255,255,255,.15);border-radius:20px;padding:4px 14px;font-size:11px;font-weight:700;display:flex;align-items:center;gap:6px}
.dot{width:7px;height:7px;background:#4ade80;border-radius:50%;animation:pulse 1.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.wrap{padding:24px 32px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:22px}
.stat{background:#fff;border-radius:14px;padding:18px;text-align:center;box-shadow:0 2px 12px rgba(79,70,229,.08)}
.sn{font-size:36px;font-weight:800;color:#4f46e5}.sn.g{color:#16a34a}.sn.r{color:#dc2626}.sn.a{color:#d97706}
.sl{font-size:11px;color:#9ca3af;margin-top:4px;font-weight:500}
.card{background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 16px rgba(79,70,229,.1)}
table{width:100%;border-collapse:collapse}
thead tr{background:linear-gradient(135deg,#4f46e5,#7c3aed)}
th{color:#fff;padding:12px 16px;text-align:left;font-size:11px;font-weight:600;letter-spacing:.5px;text-transform:uppercase}
td{padding:12px 16px;border-bottom:1px solid #f3f4f6;vertical-align:top;font-size:12px}
tr:last-child td{border-bottom:none}tr:hover td{background:#fafbff}
.subj{font-weight:600;font-size:13px;color:#1a1a2e}.sm{font-size:11px}.grey{color:#9ca3af}
.empty{text-align:center;padding:50px;color:#9ca3af;font-size:13px}
.badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:700;white-space:nowrap}
.badge.g{background:#dcfce7;color:#15803d}.badge.r{background:#fee2e2;color:#b91c1c}
.orow{display:flex;align-items:center;gap:6px;font-size:10px;margin-bottom:4px;flex-wrap:wrap}
.n{background:#4f46e5;color:#fff;border-radius:10px;padding:1px 7px;font-weight:700;font-size:9px}
.chip{background:#f3f4f6;border-radius:5px;padding:1px 7px;font-size:10px;color:#374151}
.blue{background:#ede9fe;color:#6d28d9}.ip{color:#d1d5db;font-family:monospace;font-size:9px}
.dim{color:#d1d5db;font-size:10px}
.foot{text-align:center;padding:16px;color:#9ca3af;font-size:11px}
</style></head><body>
<div class="hdr">
  <div><h1>📧 Email Tracker Dashboard</h1>
  <p>Auto-refresh every 15s • Bots &amp; proxies filtered • Data persisted to disk</p></div>
  <div class="live"><span class="dot"></span> Live</div>
</div>
<div class="wrap">
  <div class="stats">
    <div class="stat"><div class="sn">${total}</div><div class="sl">Total Tracked</div></div>
    <div class="stat"><div class="sn g">${opened}</div><div class="sl">✅ Opened</div></div>
    <div class="stat"><div class="sn r">${total-opened}</div><div class="sl">❌ Not Opened</div></div>
    <div class="stat"><div class="sn a">${rate}%</div><div class="sl">Open Rate</div></div>
  </div>
  <div class="card"><table>
    <thead><tr>
      <th>Subject</th><th>Sent To</th><th>Sent At</th>
      <th>Status</th><th>Last Opened</th><th>Device</th><th>All Opens</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</div>
<div class="foot">Newest emails shown first. Data saved to disk — survives server restarts.</div>
</body></html>`);
});

app.get('/', (req, res) => res.send('Email Tracker v5 running. Go to /dashboard'));
app.listen(PORT, () => console.log('[Server] Running on port', PORT));
