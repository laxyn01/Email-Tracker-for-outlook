/**
 * Email Tracker Server v3 — Outlook Desktop Edition
 *
 * Core problem solved:
 * Outlook desktop's reading pane fires the pixel from the SENDER's machine
 * the moment they click the sent email. We fix this by:
 *   1. Recording the sender's public IP at /register time
 *   2. Ignoring ALL pixel hits from that same IP
 *   3. Filtering all known bot/proxy UAs
 *   4. Deduplicating same-IP hits within 2 minutes
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3000;

const DATA_FILE = path.join(__dirname, 'email_logs.json');
function loadLogs() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch(e) { console.error('Load error:', e.message); }
  return {};
}
function saveLogs() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(emailLogs, null, 2)); }
  catch(e) { console.error('Save error:', e.message); }
}
let emailLogs = loadLogs();
console.log('Loaded ' + Object.keys(emailLogs).length + ' records.');

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

const BOT_UA = [
  'googleimageproxy','ggpht','googlebot',
  'yahoo! slurp','bingbot','duckduckbot',
  'facebookexternalhit','twitterbot','linkedinbot','slackbot',
  'mimecast','proofpoint','barracuda','ironport','symantec','sophos',
  'microsoft url defense','safelinks',
  'preview','prefetch','headless','phantomjs','selenium',
];
function isBot(ua) {
  const u = (ua||'').toLowerCase();
  return BOT_UA.some(b => u.includes(b));
}

function getIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

function getDevice(ua) {
  if (!ua) return 'Desktop';
  if (/iPhone/i.test(ua))    return 'iPhone';
  if (/Android/i.test(ua))   return 'Android';
  if (/iPad/i.test(ua))      return 'iPad';
  if (/Windows/i.test(ua))   return 'Windows PC';
  if (/Macintosh/i.test(ua)) return 'Mac';
  return 'Desktop';
}

function getClient(ua) {
  if (!ua) return 'Unknown';
  if (/GSA|Gmail/i.test(ua))               return 'Gmail';
  if (/Outlook|microsoft office/i.test(ua)) return 'Outlook';
  if (/Apple Mail/i.test(ua))               return 'Apple Mail';
  if (/Thunderbird/i.test(ua))              return 'Thunderbird';
  return 'Webmail/Other';
}

function nowIST() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// REGISTER — records sender IP so we can exclude it from pixel hits
app.get('/register', (req, res) => {
  const { id, subject, to } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const senderIP = getIP(req);
  emailLogs[id] = {
    subject: subject || 'No Subject',
    to: to || 'Unknown',
    sentAt: nowIST(),
    sentTimestamp: Date.now(),
    senderIP: senderIP,
    opens: [],
    ignoredHits: [],
  };
  saveLogs();
  console.log('Registered [' + id + '] senderIP=' + senderIP + ' subject=' + subject);
  res.json({ ok: true, senderIP: senderIP });
});

// PIXEL — handles both /pixel/ID and /pixel/ID.gif
function handlePixel(req, res) {
  res.set({
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.end(PIXEL);

  setImmediate(() => {
    const id  = req.params.id;
    const ua  = req.headers['user-agent'] || '';
    const ip  = getIP(req);
    const now = Date.now();

    if (!emailLogs[id]) {
      emailLogs[id] = { subject:'?', to:'?', sentAt:'?', sentTimestamp:0, senderIP:'', opens:[], ignoredHits:[] };
    }
    const rec = emailLogs[id];
    if (!rec.ignoredHits) rec.ignoredHits = [];

    function ignore(reason) {
      rec.ignoredHits.push({ time: nowIST(), ip, ua: ua.slice(0,120), reason });
      saveLogs();
      console.log('IGNORED [' + id + '] reason=' + reason + ' ip=' + ip);
    }

    // Rule 1: Known bot/proxy UA
    if (isBot(ua)) return ignore('bot-ua');

    // Rule 2: Sender's own IP — this is the main fix for Outlook desktop.
    // Outlook reading pane loads images from sender's machine with sender's IP.
    if (rec.senderIP && ip === rec.senderIP) return ignore('sender-ip');

    // Rule 3: Dedup — same IP within 2 minutes
    const isDup = rec.opens.some(o => o.ip === ip && (now - (o.ts||0)) < 120000);
    if (isDup) return ignore('dedup-2min');

    // Real open
    const open = {
      ts: now,
      time: nowIST(),
      device: getDevice(ua),
      client: getClient(ua),
      ip: ip,
      ua: ua.slice(0, 150),
    };
    rec.opens.push(open);
    saveLogs();
    console.log('OPEN #' + rec.opens.length + ' [' + id + '] ' + rec.subject + ' | ' + open.device + ' | ' + ip);
  });
}

app.get('/pixel/:id.gif', handlePixel);
app.get('/pixel/:id',     handlePixel);

// STATUS — polled by taskpane
app.get('/status/:id', (req, res) => {
  const r = emailLogs[req.params.id];
  if (!r) return res.json({ found: false });
  res.json({ found: true, subject: r.subject, to: r.to, sentAt: r.sentAt, openCount: r.opens.length, opens: r.opens });
});

// DEBUG — shows ignored hits for diagnosing issues
app.get('/debug/:id', (req, res) => {
  const r = emailLogs[req.params.id];
  if (!r) return res.json({ error: 'Not found' });
  res.json(r);
});

// DASHBOARD
app.get('/dashboard', (req, res) => {
  const entries = Object.entries(emailLogs).sort((a,b) => (b[1].sentTimestamp||0) - (a[1].sentTimestamp||0));
  const total = entries.length;
  const opened = entries.filter(([,e]) => e.opens.length > 0).length;
  const rate = total > 0 ? Math.round(opened/total*100) : 0;

  const rows = !total
    ? '<tr><td colspan="6" class="empty">No emails tracked yet. Open Outlook, compose, click Track.</td></tr>'
    : entries.map(([id, d]) => {
        const isOpened = d.opens.length > 0;
        const last = isOpened ? d.opens[d.opens.length-1] : null;
        const openRows = d.opens.map((o,i) =>
          '<div class="orow"><span class="n">#'+(i+1)+'</span><span>'+esc(o.time)+'</span><span class="chip">'+esc(o.device)+'</span><span class="chip blue">'+esc(o.client)+'</span><span class="ip">'+esc(o.ip)+'</span></div>'
        ).join('') || '<span class="dim">—</span>';
        const ignored = (d.ignoredHits||[]).length;
        return '<tr><td class="subj">'+esc(d.subject)+'</td><td class="sm">'+esc(d.to)+'</td><td class="sm grey">'+esc(d.sentAt)+'</td>'
          +'<td><span class="badge '+(isOpened?'g':'r')+'">'+(isOpened?'✅ '+d.opens.length+'× opened':'❌ Not opened')+'</span>'
          +(ignored?'<br><span class="dim">'+ignored+' hits filtered</span>':'')+'</td>'
          +'<td class="sm">'+(last?esc(last.time):'—')+'</td>'
          +'<td class="opens">'+openRows+'</td></tr>';
      }).join('');

  res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>Email Tracker</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#f0f4ff;color:#222}
.hdr{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;padding:22px 30px;display:flex;justify-content:space-between;align-items:center}
.hdr h1{font-size:19px;font-weight:700}.hdr p{font-size:12px;opacity:.75;margin-top:3px}
.live{background:rgba(255,255,255,.15);border-radius:20px;padding:4px 13px;font-size:12px;font-weight:700}
.wrap{padding:24px 30px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:22px}
.stat{background:#fff;border-radius:12px;padding:16px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.07)}
.sn{font-size:34px;font-weight:800;color:#667eea}.sn.g{color:#22c55e}.sn.r{color:#ef4444}.sn.a{color:#f59e0b}
.sl{font-size:12px;color:#999;margin-top:3px}
.card{background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08)}
table{width:100%;border-collapse:collapse}
thead tr{background:linear-gradient(135deg,#667eea,#764ba2)}
th{color:#fff;padding:12px 15px;text-align:left;font-size:12px;font-weight:600}
td{padding:11px 15px;border-bottom:1px solid #f3f3f8;vertical-align:top}
tr:last-child td{border-bottom:none}tr:hover td{background:#fafbff}
.subj{font-weight:600;font-size:13px}.sm{font-size:12px}.grey{color:#888}
.empty{text-align:center;padding:40px;color:#aaa;font-size:14px}
.badge{display:inline-block;padding:3px 11px;border-radius:20px;font-size:12px;font-weight:700;white-space:nowrap}
.badge.g{background:#dcfce7;color:#14532d}.badge.r{background:#fee2e2;color:#991b1b}
.opens{min-width:260px}
.orow{display:flex;align-items:center;gap:7px;font-size:11px;margin-bottom:3px;flex-wrap:wrap}
.n{background:#667eea;color:#fff;border-radius:10px;padding:0 7px;font-weight:700;font-size:10px}
.chip{background:#f3f4f6;border-radius:5px;padding:1px 7px;font-size:11px}
.blue{background:#ede9fe;color:#5b21b6}.ip{color:#bbb;font-family:monospace;font-size:10px}
.dim{color:#bbb;font-size:11px}
</style></head><body>
<div class="hdr">
  <div><h1>📧 Email Tracker — Outlook Desktop</h1>
  <p>Auto-refresh 10s · Sender IP filtered · Bots filtered · Persisted to disk</p></div>
  <div class="live">🔴 LIVE</div>
</div>
<div class="wrap">
  <div class="stats">
    <div class="stat"><div class="sn">${total}</div><div class="sl">Total Tracked</div></div>
    <div class="stat"><div class="sn g">${opened}</div><div class="sl">✅ Opened</div></div>
    <div class="stat"><div class="sn r">${total-opened}</div><div class="sl">❌ Not Opened</div></div>
    <div class="stat"><div class="sn a">${rate}%</div><div class="sl">Open Rate</div></div>
  </div>
  <div class="card"><table>
    <thead><tr><th>Subject</th><th>Sent To</th><th>Sent At</th><th>Status</th><th>Last Opened</th><th>Opens Detail</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</div>
</body></html>`);
});

app.get('/', (req, res) => res.send('Email Tracker v3 running'));
app.listen(PORT, () => console.log('Server on :' + PORT));
