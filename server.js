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

// ✅ Bot/Proxy user agents jo ignore karne hain
const IGNORED_AGENTS = [
  'googleimageproxy',
  'googlebot',
  'ggpht.com',
  'yahoo! slurp',
  'bingbot',
  'duckduckbot',
  'facebookexternalhit',
  'twitterbot',
  'linkedinbot',
  'preview',
  'prefetch',
  'netseer',
  'outbound-article-filter',
  'ms-office',
  'apple mail',
  'thunderbird'
];

function isBot(userAgent) {
  const ua = (userAgent || '').toLowerCase();
  return IGNORED_AGENTS.some(bot => ua.includes(bot));
}

function getDevice(userAgent) {
  const ua = userAgent || '';
  if (ua.includes('iPhone')) return '📱 iPhone';
  if (ua.includes('Android')) return '📱 Android';
  if (ua.includes('Mobile')) return '📱 Mobile';
  if (ua.includes('iPad')) return '📱 iPad';
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
  const userAgent = req.headers['user-agent'] || '';

  if (emailLogs[id]) {
    if (isBot(userAgent)) {
      // ✅ Google/Yahoo proxy — ignore karo
      console.log(`🤖 Bot ignored: ${userAgent.substring(0, 60)}`);
    } else {
      // ✅ Real open — log karo
      emailLogs[id].opens.push({
        time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        device: getDevice(userAgent),
        ua: userAgent.substring(0, 80)
      });
      console.log(`📬 Real Open! ID: ${id} | Device: ${getDevice(userAgent)}`);
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
      rows += `
        <tr>
          <td>${data.subject}</td>
          <td>${data.to}</td>
          <td>${data.sentAt}</td>
          <td>
            <span style="background:${opened ? '#22c55e' : '#ef4444'};color:white;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:600">
              ${opened ? `✅ Opened (${data.opens.length}x)` : '❌ Not Opened'}
            </span>
          </td>
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
  <title>📧 Email Tracker Dashboard</title>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="15">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #f0f4f8; padding: 30px; }
    .header { background: linear-gradient(135deg, #667eea, #764ba2); color: white; padding: 24px 30px; border-radius: 12px; margin-bottom: 20px; display:flex; justify-content:space-between; align-items:center; }
    .header h1 { font-size: 22px; }
    .header p { opacity: 0.8; font-size: 13px; margin-top:4px; }
    .refresh-badge { background: rgba(255,255,255,0.2); padding: 6px 14px; border-radius: 20px; font-size: 12px; }
    .stats { display: flex; gap: 16px; margin-bottom: 20px; }
    .stat { background: white; border-radius: 10px; padding: 16px 20px; flex: 1; box-shadow: 0 2px 8px rgba(0,0,0,0.06); text-align:center; }
    .stat-num { font-size: 32px; font-weight: 700; color: #667eea; }
    .stat-num.green { color: #22c55e; }
    .stat-num.red { color: #ef4444; }
    .stat-label { font-size: 13px; color: #888; margin-top: 4px; }
    .card { background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    table { width: 100%; border-collapse: collapse; }
    th { background: #667eea; color: white; padding: 14px 16px; text-align: left; font-weight: 600; font-size: 13px; }
    td { padding: 13px 16px; border-bottom: 1px solid #f0f0f0; font-size: 13px; color: #444; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #fafafa; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>📧 Email Tracker Dashboard</h1>
      <p>Auto refresh every 15 seconds • Bots & proxies automatically filtered</p>
    </div>
    <div class="refresh-badge">🔄 Live</div>
  </div>
  <div class="stats">
    <div class="stat"><div class="stat-num">${total}</div><div class="stat-label">Total Tracked</div></div>
    <div class="stat"><div class="stat-num green">${openedCount}</div><div class="stat-label">✅ Opened</div></div>
    <div class="stat"><div class="stat-num red">${notOpened}</div><div class="stat-label">❌ Not Opened</div></div>
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
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
