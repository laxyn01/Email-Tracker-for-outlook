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

// Register email before sending
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
  }
  res.json({ success: true });
});

// Pixel tracking endpoint
app.get('/pixel/:id', (req, res) => {
  const { id } = req.params;

  if (emailLogs[id]) {
    const timeSinceSent = Date.now() - (emailLogs[id].sentTimestamp || 0);
    
    // ✅ FIX: Ignore opens within 60 seconds — Outlook preview pane ignore
    if (timeSinceSent > 60000) {
      emailLogs[id].opens.push({
        time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        device: req.headers['user-agent'] || 'Unknown'
      });
      console.log(`📬 Email opened! ID: ${id}`);
    } else {
      console.log(`⚡ Ignored preview load for ID: ${id} (${Math.round(timeSinceSent/1000)}s after send)`);
    }
  }

  res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
  res.send(PIXEL);
});

// Status endpoint
app.get('/status/:id', (req, res) => {
  res.json(emailLogs[req.params.id] || { opens: [] });
});

// Dashboard
app.get('/dashboard', (req, res) => {
  let rows = '';
  const entries = Object.entries(emailLogs).reverse();

  if (entries.length === 0) {
    rows = `<tr><td colspan="5" style="text-align:center;padding:30px;color:#888">Koi email track nahi hui abhi tak 📭</td></tr>`;
  } else {
    for (const [id, data] of entries) {
      const opened = data.opens.length > 0;
      const lastOpen = opened ? data.opens[data.opens.length - 1].time : '—';
      const openCount = data.opens.length;
      rows += `
        <tr>
          <td>${data.subject}</td>
          <td>${data.to}</td>
          <td>${data.sentAt}</td>
          <td>
            <span style="background:${opened ? '#22c55e' : '#ef4444'};color:white;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:600">
              ${opened ? `✅ Opened (${openCount}x)` : '❌ Not Opened'}
            </span>
          </td>
          <td>${lastOpen}</td>
        </tr>`;
    }
  }

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>📧 Email Tracker Dashboard</title>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="20">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #f0f4f8; padding: 30px; }
    .header { background: linear-gradient(135deg, #667eea, #764ba2); color: white; padding: 24px 30px; border-radius: 12px; margin-bottom: 24px; }
    .header h1 { font-size: 24px; margin-bottom: 4px; }
    .header p { opacity: 0.85; font-size: 14px; }
    .stats { display: flex; gap: 16px; margin-bottom: 20px; }
    .stat { background: white; border-radius: 10px; padding: 16px 20px; flex: 1; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
    .stat-num { font-size: 28px; font-weight: 700; color: #667eea; }
    .stat-label { font-size: 13px; color: #888; margin-top: 4px; }
    .card { background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    table { width: 100%; border-collapse: collapse; }
    th { background: #667eea; color: white; padding: 14px 16px; text-align: left; font-weight: 600; font-size: 14px; }
    td { padding: 13px 16px; border-bottom: 1px solid #f0f0f0; font-size: 14px; color: #444; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #fafafa; }
    .note { font-size: 12px; color: #999; margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>📧 Email Tracker Dashboard</h1>
    <p>Auto refresh every 20 seconds • Outlook preview opens are ignored (60s grace period)</p>
  </div>
  <div class="stats">
    <div class="stat">
      <div class="stat-num">${Object.keys(emailLogs).length}</div>
      <div class="stat-label">Total Tracked</div>
    </div>
    <div class="stat">
      <div class="stat-num">${Object.values(emailLogs).filter(e => e.opens.length > 0).length}</div>
      <div class="stat-label">Opened</div>
    </div>
    <div class="stat">
      <div class="stat-num">${Object.values(emailLogs).filter(e => e.opens.length === 0).length}</div>
      <div class="stat-label">Not Opened</div>
    </div>
  </div>
  <p class="note">⚡ Opens within 60 seconds of sending are ignored (Outlook preview filter)</p>
  <div class="card">
    <table>
      <tr>
        <th>Subject</th><th>Sent To</th><th>Sent At</th><th>Status</th><th>Last Opened</th>
      </tr>
      ${rows}
    </table>
  </div>
</body>
</html>`);
});

app.get('/', (req, res) => res.send('✅ Email Tracker Server is Running!'));
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
