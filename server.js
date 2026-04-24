const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

const emailLogs = {};

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

// ✅ Known bots/proxies ignore karo
const BOT_AGENTS = [
  'googleimageproxy', 'ggpht.com', 'googlebot',
  'yahoo! slurp', 'bingbot', 'duckduckbot',
  'facebookexternalhit', 'twitterbot', 'linkedinbot',
  'ms-office', 'preview', 'prefetch'
];

function isBot(ua) {
  const u = (ua || '').toLowerCase();
  return BOT_AGENTS.some(b => u.includes(b));
}

function getDevice(ua) {
  if (!ua) return '💻 Desktop';
  if (ua.includes('iPhone')) return '📱 iPhone';
  if (ua.includes('Android')) return '📱 Android';
  if (ua.includes('iPad')) return '📱 iPad';
  if (ua.includes('Mobile')) return '📱 Mobile';
  if (ua.includes('Windows')) return '💻 Windows';
  if (ua.includes('Mac')) return '💻 Mac';
  return '💻 Desktop';
}

app.get('/register', (req, res) => {
  const { id, subject, to } = req.query;
  if (id) {
    emailLogs[id] = {
      subject: subject || 'No Subject',
      to: to || 'Unknown',
      sentAt: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      sentTimestamp: Date.now(),
      opens: []
    };
    console.log(`📝 Registered: ${subject} → ${to}`);
  }
  res.json({ success: true });
});

app.get('/pixel/:id', (req, res) => {
  const { id } = req.params;
  const ua = req.headers['user-agent'] || '';
  const ip = req.headers['x-forwarded-for'] || req.ip;

  if (emailLogs[id]) {
    const timeSinceSent = Date.now() - (emailLogs[id].sentTimestamp || 0);
    const bot = isBot(ua);
    const tooSoon = timeSinceSent < 8000; // 8 second grace — Outlook preview ignore

    if (bot) {
      console.log(`🤖 Bot ignored: ${ua.substring(0, 50)}`);
    } else if (tooSoon) {
      console.log(`⚡ Too soon (${Math.round(timeSinceSent/1000)}s) — Outlook preview ignored`);
    } else {
      // ✅ Real open!
      emailLogs[id].opens.push({
        time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        device: getDevice(ua),
        ip: ip ? ip.split(',')[0].trim() : 'Unknown'
      });
      console.log(`📬 REAL Open! → ${emailLogs[id].to} | ${getDevice(ua)}`);
    }
  }

  res.set({
    'Content-Type': 'image/png',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.send(PIXEL);
});

app.get('/status/:id', (req, res) => {
  res.json(emailLogs[req.params.id] || { opens: [] });
});

app.get('/dashboard', (req, res) => {
  let rows = '';
  const entries = Object.entries(emailLogs).reverse();

  if (entries.length === 0) {
    rows = `<tr><td colspan="6" style="text-align:center;padding:30px;color:#888">Koi email track nahi hui abhi tak 📭</td></tr>`;
  } else {
    for (const [id, data] of entries) {
      const opened = data.opens.length > 0;
      const lastOpen = opened ? data.opens[data.opens.length - 1].time : '—';
      const device = opened ? data.opens[data.opens.length - 1].device : '—';
      rows += `<tr>
        <td>${data.subject}</td>
        <td>${data.to}</td>
        <td>${data.sentAt}</td>
        <td><span style="background:${opened ? '#22c55e' : '#ef4444'};color:white;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:600">
          ${opened ? `✅ Opened (${data.opens.length}x)` : '❌ Not Opened'}
        </span></td>
        <td>${lastOpen}</td>
        <td>${device}</td>
      </tr>`;
    }
  }

  const total = Object.keys(emailLogs).length;
  const openedCount = Object.values(emailLogs).filter(e => e.opens.length > 0).length;
  const notOpened = total - openedCount;

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>📧 Email Tracker</title>
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
    td{padding:13px 16px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#444}
    tr:last-child td{border-bottom:none}
    tr:hover td{background:#fafafa}
  </style>
</head>
<body>
  <div class="header">
    <div><h1>📧 Email Tracker Dashboard</h1><p>Auto refresh every 15s • Bots filtered automatically</p></div>
    <div class="badge">🔄 Live</div>
  </div>
  <div class="stats">
    <div class="stat"><div class="stat-num">${total}</div><div class="stat-label">Total Tracked</div></div>
    <div class="stat"><div class="stat-num" style="color:#22c55e">${openedCount}</div><div class="stat-label">✅ Opened</div></div>
    <div class="stat"><div class="stat-num" style="color:#ef4444">${notOpened}</div><div class="stat-label">❌ Not Opened</div></div>
    <div class="stat"><div class="stat-num" style="color:#f59e0b">${total > 0 ? Math.round(openedCount/total*100) : 0}%</div><div class="stat-label">Open Rate</div></div>
  </div>
  <div class="card">
    <table>
      <tr><th>Subject</th><th>Sent To</th><th>Sent At</th><th>Status</th><th>Last Opened</th><th>Device</th></tr>
      ${rows}
    </table>
  </div>
</body>
</html>`);
});

app.get('/', (req, res) => res.send('✅ Email Tracker Server is Running!'));
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
