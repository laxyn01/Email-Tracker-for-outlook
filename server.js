const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// ── PERSISTENT STORAGE ──────────────────────────────────────────────────────
// Saves to disk so data survives Render.com restarts (free tier)
const DATA_FILE = path.join(__dirname, 'email_logs.json');

function loadLogs() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch(e) {
    console.error('Failed to load logs:', e.message);
  }
  return {};
}

function saveLogs() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(emailLogs, null, 2));
  } catch(e) {
    console.error('Failed to save logs:', e.message);
  }
}

let emailLogs = loadLogs();
console.log(`📂 Loaded ${Object.keys(emailLogs).length} existing email records.`);

// ── 1x1 TRANSPARENT PNG ─────────────────────────────────────────────────────
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

// ── BOT / PROXY DETECTION ───────────────────────────────────────────────────
// These are known email security scanners, image proxies, and crawlers.
// They pre-fetch images without a human opening the email.
const BOT_AGENTS = [
  // Google
  'googleimageproxy', 'ggpht.com', 'googlebot', 'google-images',
  // Microsoft (Outlook Safe Links, Exchange Online Protection)
  'microsoft url defense', 'mimecast', 'proofpoint',
  // Yahoo / AOL
  'yahoo! slurp', 'yahooimages', 'aol',
  // Other crawlers
  'bingbot', 'duckduckbot', 'facebookexternalhit', 'twitterbot',
  'linkedinbot', 'slackbot', 'whatsapp', 'telegrambot',
  // Generic indicators
  'preview', 'prefetch', 'scanner', 'safelinks', 'protection',
  'barracuda', 'sophos', 'symantec', 'ironport'
];

function isBot(ua) {
  const u = (ua || '').toLowerCase();
  return BOT_AGENTS.some(b => u.includes(b));
}

// ── NOTE on "ms-office": We removed it from BOT_AGENTS intentionally.
// When a real user opens email in Outlook desktop, the User-Agent DOES contain
// "Microsoft Office" — blocking it would filter real opens. 
// We handle Outlook's "sent folder preview" problem via the grace period.

function getDevice(ua) {
  if (!ua) return '💻 Desktop';
  const u = ua.toLowerCase();
  if (u.includes('iphone'))  return '📱 iPhone';
  if (u.includes('android')) return '📱 Android';
  if (u.includes('ipad'))    return '📱 iPad';
  if (u.includes('mobile'))  return '📱 Mobile';
  if (u.includes('windows')) return '💻 Windows';
  if (u.includes('macintosh') || u.includes('mac os')) return '💻 Mac';
  return '💻 Desktop';
}

function getClient(ua) {
  if (!ua) return 'Unknown';
  const u = ua.toLowerCase();
  if (u.includes('gmail'))               return 'Gmail';
  if (u.includes('outlook') || u.includes('microsoft office')) return 'Outlook';
  if (u.includes('apple mail'))          return 'Apple Mail';
  if (u.includes('thunderbird'))         return 'Thunderbird';
  if (u.includes('yahoomail'))           return 'Yahoo Mail';
  return 'Unknown';
}

function nowIST() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

// ── ROUTES ───────────────────────────────────────────────────────────────────

// Register email before sending
app.get('/register', (req, res) => {
  const { id, subject, to } = req.query;
  if (!id) return res.json({ success: false, error: 'No ID provided' });

  emailLogs[id] = {
    subject: subject || 'No Subject',
    to:      to      || 'Unknown',
    sentAt:  nowIST(),
    sentTimestamp: Date.now(),
    opens: []
  };

  saveLogs();
  console.log(`📝 Registered: "${subject}" → ${to} [${id}]`);
  res.json({ success: true });
});

// Tracking pixel endpoint
app.get('/pixel/:id', (req, res) => {
  // Always serve pixel first — never block the response
  res.set({
    'Content-Type':  'image/png',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma':        'no-cache',
    'Expires':       '0'
  });
  res.send(PIXEL);

  // ── Process open asynchronously after responding ──────────────────────────
  const { id } = req.params;
  const ua     = req.headers['user-agent'] || '';
  const ip     = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown';
  const cleanIp = ip.split(',')[0].trim();

  if (!emailLogs[id]) {
    // Unknown ID — could be old email from before server restart
    // Log it anyway as unregistered open
    emailLogs[id] = {
      subject: 'Unknown (pre-restart)',
      to:      'Unknown',
      sentAt:  '?',
      sentTimestamp: 0,
      opens: []
    };
  }

  const record         = emailLogs[id];
  const timeSinceSent  = Date.now() - (record.sentTimestamp || 0);
  const bot            = isBot(ua);

  // ── Grace period: only for very fast hits (Outlook Sent folder preview)
  // Using 5s — tight enough to catch real mobile opens, still filters auto-preview.
  // Outlook preview pane fires within 0-2 seconds of /register being called.
  const GRACE_MS = 5000;
  const tooSoon  = record.sentTimestamp > 0 && timeSinceSent < GRACE_MS;

  if (bot) {
    console.log(`🤖 Bot filtered [${id}]: ${ua.substring(0, 80)}`);
    return;
  }

  if (tooSoon) {
    console.log(`⚡ Grace period hit [${id}] ${Math.round(timeSinceSent/1000)}s — likely Outlook preview`);
    return;
  }

  // ── Duplicate open detection: ignore same IP within 30 seconds ────────────
  const recentOpen = record.opens.find(o => {
    return o.ip === cleanIp && (Date.now() - (o.timestamp || 0)) < 30000;
  });
  if (recentOpen) {
    console.log(`♻️ Duplicate open ignored [${id}] from ${cleanIp}`);
    return;
  }

  // ── Real open! ────────────────────────────────────────────────────────────
  record.opens.push({
    time:      nowIST(),
    timestamp: Date.now(),
    device:    getDevice(ua),
    client:    getClient(ua),
    ip:        cleanIp,
    ua:        ua.substring(0, 120)
  });

  saveLogs();
  console.log(`📬 OPEN! "${record.subject}" → ${record.to} | ${getDevice(ua)} | ${getClient(ua)} | IP: ${cleanIp}`);
});

// Status check for a single email
app.get('/status/:id', (req, res) => {
  const record = emailLogs[req.params.id];
  if (!record) return res.json({ opens: [], error: 'Not found' });
  res.json(record);
});

// Dashboard
app.get('/dashboard', (req, res) => {
  const entries = Object.entries(emailLogs)
    .sort((a, b) => (b[1].sentTimestamp || 0) - (a[1].sentTimestamp || 0));

  let rows = '';
  if (entries.length === 0) {
    rows = `<tr><td colspan="7" style="text-align:center;padding:30px;color:#888">No emails tracked yet 📭</td></tr>`;
  } else {
    for (const [id, data] of entries) {
      const opened   = data.opens.length > 0;
      const lastOpen = opened ? data.opens[data.opens.length - 1] : null;
      const allOpens = data.opens.map(o =>
        `<div style="font-size:11px;color:#555;margin-bottom:2px">• ${o.time} — ${o.device} ${o.client ? '(' + o.client + ')' : ''} — ${o.ip}</div>`
      ).join('');

      rows += `<tr>
        <td style="font-weight:600">${escHtml(data.subject)}</td>
        <td>${escHtml(data.to)}</td>
        <td style="font-size:12px;color:#888">${data.sentAt}</td>
        <td>
          <span style="background:${opened ? '#22c55e' : '#ef4444'};color:white;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600;white-space:nowrap">
            ${opened ? `✅ ${data.opens.length}x opened` : '❌ Not opened'}
          </span>
        </td>
        <td style="font-size:12px">${lastOpen ? lastOpen.time : '—'}</td>
        <td style="font-size:12px">${lastOpen ? lastOpen.device : '—'}</td>
        <td style="font-size:11px;color:#666">${allOpens || '—'}</td>
      </tr>`;
    }
  }

  const total       = entries.length;
  const openedCount = entries.filter(([,e]) => e.opens.length > 0).length;
  const notOpened   = total - openedCount;
  const rate        = total > 0 ? Math.round(openedCount / total * 100) : 0;

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>📧 Email Tracker Dashboard</title>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="15">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',sans-serif;background:#f0f4f8;padding:30px}
    .header{background:linear-gradient(135deg,#667eea,#764ba2);color:white;padding:24px 30px;border-radius:12px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:center}
    .header h1{font-size:22px}
    .header p{opacity:.8;font-size:13px;margin-top:4px}
    .badge{background:rgba(255,255,255,.2);padding:6px 14px;border-radius:20px;font-size:12px}
    .stats{display:flex;gap:16px;margin-bottom:20px}
    .stat{background:white;border-radius:10px;padding:16px 20px;flex:1;box-shadow:0 2px 8px rgba(0,0,0,.06);text-align:center}
    .stat-num{font-size:32px;font-weight:700;color:#667eea}
    .stat-label{font-size:13px;color:#888;margin-top:4px}
    .card{background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}
    table{width:100%;border-collapse:collapse}
    th{background:#667eea;color:white;padding:14px 16px;text-align:left;font-weight:600;font-size:13px}
    td{padding:12px 16px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#444;vertical-align:top}
    tr:last-child td{border-bottom:none}
    tr:hover td{background:#fafafa}
    .note{text-align:center;color:#999;font-size:12px;margin-top:16px}
  </style>
</head>
<body>
  <div class="header">
    <div><h1>📧 Email Tracker Dashboard</h1><p>Auto-refresh every 15s • Bots & proxies filtered • Data persisted to disk</p></div>
    <div class="badge">🔄 Live</div>
  </div>
  <div class="stats">
    <div class="stat"><div class="stat-num">${total}</div><div class="stat-label">Total Tracked</div></div>
    <div class="stat"><div class="stat-num" style="color:#22c55e">${openedCount}</div><div class="stat-label">✅ Opened</div></div>
    <div class="stat"><div class="stat-num" style="color:#ef4444">${notOpened}</div><div class="stat-label">❌ Not Opened</div></div>
    <div class="stat"><div class="stat-num" style="color:#f59e0b">${rate}%</div><div class="stat-label">Open Rate</div></div>
  </div>
  <div class="card">
    <table>
      <tr>
        <th>Subject</th><th>Sent To</th><th>Sent At</th>
        <th>Status</th><th>Last Opened</th><th>Device</th><th>All Opens</th>
      </tr>
      ${rows}
    </table>
  </div>
  <p class="note">Newest emails shown first. Data saved to disk — survives server restarts.</p>
</body>
</html>`);
});

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

app.get('/', (req, res) => res.send('✅ Email Tracker Server is Running!'));

app.listen(PORT, () => console.log(`🚀 Server started on port ${PORT}`));
