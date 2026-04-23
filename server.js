const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// In-memory storage
const emailLogs = {};

// 1x1 Transparent PNG Pixel
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

// CORS headers
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
      opens: []
    };
  }
  res.json({ success: true });
});

// Pixel tracking endpoint
app.get('/pixel/:id', (req, res) => {
  const { id } = req.params;

  if (!emailLogs[id]) {
    emailLogs[id] = { subject: 'Unknown', to: 'Unknown', sentAt: 'Unknown', opens: [] };
  }

  emailLogs[id].opens.push({
    time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    device: req.headers['user-agent'] || 'Unknown'
  });

  console.log(`📬 Email opened! ID: ${id} | Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);

  res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
  res.send(PIXEL);
});

// Get status of single email
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
      rows += `
        <tr>
          <td>${data.subject}</td>
          <td>${data.to}</td>
          <td>${data.sentAt}</td>
          <td>
            <span style="background:${opened ? '#22c55e' : '#ef4444'};color:white;padding:3px 10px;border-radius:20px;font-size:13px">
              ${opened ? `✅ Opened (${data.opens.length}x)` : '❌ Not Opened'}
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
    .card { background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    table { width: 100%; border-collapse: collapse; }
    th { background: #667eea; color: white; padding: 14px 16px; text-align: left; font-weight: 600; font-size: 14px; }
    td { padding: 13px 16px; border-bottom: 1px solid #f0f0f0; font-size: 14px; color: #444; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #fafafa; }
    .refresh { font-size: 12px; color: #888; margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>📧 Email Tracker Dashboard</h1>
    <p>Real-time tracking — Auto refresh every 20 seconds</p>
  </div>
  <p class="refresh">Total tracked: ${Object.keys(emailLogs).length} emails</p>
  <div class="card">
    <table>
      <tr>
        <th>Subject</th>
        <th>Sent To</th>
        <th>Sent At</th>
        <th>Status</th>
        <th>Last Opened</th>
      </tr>
      ${rows}
    </table>
  </div>
</body>
</html>`);
});

app.get('/', (req, res) => res.send('✅ Email Tracker Server is Running!'));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
