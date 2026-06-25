// VraiTag™ — Server
// Serves the app + proxies Google Gemini API securely + PayMongo payments + Expert Review

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const app = express();

app.use(express.json({ limit: '30mb' }));

// Serve the main HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── GEMINI PROXY ────────────────────────────────────────────────────────────

function toGeminiParts(content) {
  if (typeof content === 'string') return [{ text: content }];
  if (Array.isArray(content)) {
    return content.map(block => {
      if (block.type === 'text') return { text: block.text };
      if (block.type === 'image') {
        return {
          inline_data: {
            mime_type: block.source.media_type || 'image/jpeg',
            data: block.source.data,
          }
        };
      }
      return { text: '' };
    });
  }
  return [{ text: String(content) }];
}

function toGeminiContents(messages) {
  return messages.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: toGeminiParts(msg.content),
  }));
}

function toAnthropicResponse(geminiData) {
  const candidate = geminiData.candidates && geminiData.candidates[0];
  const text = candidate
    ? candidate.content.parts.map(p => p.text || '').join('')
    : '';
  return {
    id: 'gemini-' + Date.now(),
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: 'gemini-2.0-flash',
    stop_reason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

app.post('/api/claude', async (req, res) => {
  const apiKey = process.env.GEMINI_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_KEY not configured in Render Environment Variables.' });
  }
  try {
    const { messages, max_tokens, system } = req.body;
    const allMessages = system
      ? [{ role: 'user', content: `System instructions: ${system}` }, { role: 'assistant', content: 'Understood.' }, ...messages]
      : messages;
    const geminiBody = {
      contents: toGeminiContents(allMessages),
      generationConfig: { maxOutputTokens: max_tokens || 1200, temperature: 0.4 },
    };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
    });
    const geminiData = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: geminiData.error?.message || 'Gemini API error' });
    }
    res.json(toAnthropicResponse(geminiData));
  } catch (err) {
    res.status(500).json({ error: 'Proxy failed', message: err.message });
  }
});

// ─── PAYMONGO CHECKOUT ───────────────────────────────────────────────────────

const PLANS = {
  starter:  { amount: 24900, name: 'VraiTag™ Starter',        desc: '15 scans/month + AI report' },
  basic:    { amount: 49900, name: 'VraiTag™ Basic',           desc: '30 scans/month + AI certificate + download' },
  pro:      { amount: 79900, name: 'VraiTag™ Pro',             desc: 'Unlimited scans + AI certificate + priority support' },
  business: { amount: 149900, name: 'VraiTag™ Business',       desc: 'Unlimited + branded certificates + reseller badge' },
  expert:   { amount: 49900, name: 'VraiTag™ Expert Review',   desc: 'Human expert authentication — 1 bag + official certificate' },
  expert3:  { amount: 119900, name: 'VraiTag™ Expert Bundle',  desc: '3 human expert reviews + certificates (save ₱30)' },
};

app.post('/api/create-checkout', async (req, res) => {
  const secretKey = process.env.PAYMONGO_SECRET_KEY;
  if (!secretKey) {
    return res.status(500).json({ error: 'PAYMONGO_SECRET_KEY not configured.' });
  }
  const { plan, email } = req.body;
  const selected = PLANS[plan];
  if (!selected) return res.status(400).json({ error: 'Invalid plan: ' + plan });

  try {
    const auth = Buffer.from(secretKey + ':').toString('base64');
    const baseUrl = process.env.APP_URL || 'https://vraitag.onrender.com';
    const body = {
      data: {
        attributes: {
          send_email_receipt: true,
          show_description: true,
          show_line_items: true,
          line_items: [{
            currency: 'PHP',
            amount: selected.amount,
            description: selected.desc,
            name: selected.name,
            quantity: 1,
          }],
          payment_method_types: ['gcash', 'paymaya', 'card', 'grab_pay', 'dob'],
          success_url: `${baseUrl}/?payment=success&plan=${plan}`,
          cancel_url: `${baseUrl}/?payment=cancelled`,
          description: selected.desc,
          ...(email ? { billing: { email } } : {}),
        }
      }
    };

    const response = await fetch('https://api.paymongo.com/v1/checkout_sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      const msg = data.errors?.[0]?.detail || JSON.stringify(data);
      return res.status(response.status).json({ error: msg });
    }
    const checkoutUrl = data.data?.attributes?.checkout_url;
    res.json({ url: checkoutUrl, sessionId: data.data?.id });
  } catch (err) {
    res.status(500).json({ error: 'Checkout creation failed', message: err.message });
  }
});

// ─── STRUCTURED AI ANALYSIS (Python + google-genai) ─────────────────────────

app.post('/api/analyze', async (req, res) => {
  const { image, mimeType } = req.body; // image = base64 string
  if (!image) return res.status(400).json({ error: 'No image provided' });

  // Write base64 image to a temp file
  const ext = (mimeType || 'image/jpeg').split('/')[1] || 'jpg';
  const tmpPath = path.join(os.tmpdir(), `vraitag_${Date.now()}.${ext}`);
  try {
    fs.writeFileSync(tmpPath, Buffer.from(image, 'base64'));
  } catch (e) {
    return res.status(500).json({ error: 'Failed to save image', message: e.message });
  }

  // Call analyze.py
  const py = spawn('python3', [path.join(__dirname, 'analyze.py'), tmpPath], {
    env: { ...process.env },
  });

  let stdout = '';
  let stderr = '';
  py.stdout.on('data', d => { stdout += d.toString(); });
  py.stderr.on('data', d => { stderr += d.toString(); });

  py.on('close', (code) => {
    // Clean up temp file
    try { fs.unlinkSync(tmpPath); } catch (_) {}

    if (code !== 0) {
      console.error('[analyze.py error]', stderr);
      return res.status(500).json({ error: 'Analysis failed', details: stderr.substring(0, 300) });
    }
    try {
      const result = JSON.parse(stdout);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: 'Invalid JSON from analyzer', raw: stdout.substring(0, 300) });
    }
  });
});

// ─── MATERIAL CARE PROTOCOL ──────────────────────────────────────────────────

app.post('/api/care', async (req, res) => {
  const { image, mimeType } = req.body;
  if (!image) return res.status(400).json({ error: 'No image provided' });

  const ext = (mimeType || 'image/jpeg').split('/')[1] || 'jpg';
  const tmpPath = path.join(os.tmpdir(), `vraitag_care_${Date.now()}.${ext}`);
  try {
    fs.writeFileSync(tmpPath, Buffer.from(image, 'base64'));
  } catch (e) {
    return res.status(500).json({ error: 'Failed to save image', message: e.message });
  }

  const py = spawn('python3', [path.join(__dirname, 'analyze.py'), '--care', tmpPath], {
    env: { ...process.env },
  });
  let stdout = '', stderr = '';
  py.stdout.on('data', d => { stdout += d.toString(); });
  py.stderr.on('data', d => { stderr += d.toString(); });
  py.on('close', (code) => {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    if (code !== 0) return res.status(500).json({ error: 'Care analysis failed', details: stderr.substring(0, 300) });
    try { res.json(JSON.parse(stdout)); }
    catch (e) { res.status(500).json({ error: 'Invalid JSON from care analyzer', raw: stdout.substring(0, 300) }); }
  });
});

// ─── MULTI-IMAGE AUDIT (silhouette + date code) ───────────────────────────────

app.post('/api/analyze/multi', async (req, res) => {
  const { silhouette, datecode, mimeType } = req.body;
  if (!silhouette || !datecode) return res.status(400).json({ error: 'Both silhouette and datecode images required' });

  const ext = (mimeType || 'image/jpeg').split('/')[1] || 'jpg';
  const ts = Date.now();
  const sPath = path.join(os.tmpdir(), `vraitag_sil_${ts}.${ext}`);
  const dPath = path.join(os.tmpdir(), `vraitag_dc_${ts}.${ext}`);
  try {
    fs.writeFileSync(sPath, Buffer.from(silhouette, 'base64'));
    fs.writeFileSync(dPath, Buffer.from(datecode, 'base64'));
  } catch (e) {
    return res.status(500).json({ error: 'Failed to save images', message: e.message });
  }

  const py = spawn('python3', [path.join(__dirname, 'analyze.py'), sPath, dPath], {
    env: { ...process.env },
  });
  let stdout = '', stderr = '';
  py.stdout.on('data', d => { stdout += d.toString(); });
  py.stderr.on('data', d => { stderr += d.toString(); });
  py.on('close', (code) => {
    try { fs.unlinkSync(sPath); } catch (_) {}
    try { fs.unlinkSync(dPath); } catch (_) {}
    if (code !== 0) return res.status(500).json({ error: 'Multi-image analysis failed', details: stderr.substring(0, 300) });
    try { res.json(JSON.parse(stdout)); }
    catch (e) { res.status(500).json({ error: 'Invalid JSON from analyzer', raw: stdout.substring(0, 300) }); }
  });
});

// ─── EXPERT REVIEW REQUESTS ───────────────────────────────────────────────────
const expertRequests = [];

app.post('/api/expert-review', async (req, res) => {
  const { email, brand, model, aiScore, aiResult, notes, sessionId } = req.body;
  const request = {
    id: 'EX-' + Date.now(),
    email: email || 'anonymous',
    brand, model, aiScore, aiResult, notes, sessionId,
    submittedAt: new Date().toISOString(),
    status: 'pending',
  };
  expertRequests.push(request);
  console.log(`[Expert Review] New request: ${request.id} | ${brand} ${model} | AI Score: ${aiScore}% | ${email}`);
  res.json({ success: true, requestId: request.id, message: 'Request received. Expert will review within 24-48 hours.' });
});

// Admin dashboard HTML page
app.get('/admin', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VraiTag™ Admin</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',sans-serif;background:#0D1B2A;color:#FAFAF7;min-height:100vh}
  .header{background:#0a1520;border-bottom:2px solid #C9A84C;padding:18px 32px;display:flex;align-items:center;gap:12px}
  .logo{font-size:22px;font-weight:700;color:#C9A84C;letter-spacing:1px}
  .subtitle{font-size:13px;color:#aaa}
  .container{max-width:900px;margin:40px auto;padding:0 24px}
  .login-box{background:#0a1520;border:1px solid #C9A84C33;border-radius:12px;padding:40px;max-width:380px;margin:80px auto;text-align:center}
  .login-box h2{color:#C9A84C;margin-bottom:8px}
  .login-box p{color:#aaa;font-size:14px;margin-bottom:24px}
  input[type=password]{width:100%;padding:12px 16px;border-radius:8px;border:1px solid #C9A84C55;background:#0D1B2A;color:#fff;font-size:15px;margin-bottom:16px;outline:none}
  input[type=password]:focus{border-color:#C9A84C}
  button{width:100%;padding:12px;background:#C9A84C;color:#0D1B2A;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;letter-spacing:0.5px}
  button:hover{background:#D4AF37}
  .error-msg{color:#ff6b6b;font-size:13px;margin-top:10px;display:none}
  .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:32px}
  .stat{background:#0a1520;border:1px solid #C9A84C33;border-radius:10px;padding:20px;text-align:center}
  .stat-num{font-size:32px;font-weight:700;color:#C9A84C}
  .stat-label{font-size:12px;color:#aaa;margin-top:4px;text-transform:uppercase;letter-spacing:0.5px}
  table{width:100%;border-collapse:collapse;background:#0a1520;border-radius:10px;overflow:hidden}
  th{background:#C9A84C;color:#0D1B2A;padding:12px 16px;text-align:left;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px}
  td{padding:12px 16px;border-bottom:1px solid #ffffff10;font-size:14px;vertical-align:top}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#ffffff06}
  .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700}
  .badge-pending{background:#C9A84C22;color:#C9A84C;border:1px solid #C9A84C55}
  .score{font-weight:700;color:#C9A84C}
  .empty{text-align:center;padding:60px;color:#aaa}
  .refresh-btn{background:transparent;border:1px solid #C9A84C55;color:#C9A84C;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:13px;float:right;margin-bottom:16px;width:auto}
  .refresh-btn:hover{background:#C9A84C22}
  h2.section{color:#C9A84C;margin-bottom:16px;font-size:18px;display:inline-block}
  .logout{float:right;background:transparent;border:1px solid #ffffff22;color:#aaa;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:12px;width:auto}
  .logout:hover{border-color:#ff6b6b;color:#ff6b6b}
  #dashboard{display:none}
</style>
</head>
<body>
<div class="header">
  <div>
    <div class="logo">VraiTag™ Admin</div>
    <div class="subtitle">Expert Review Management</div>
  </div>
  <button class="logout" id="logoutBtn" style="margin-left:auto;display:none" onclick="logout()">Log Out</button>
</div>

<div id="loginSection">
  <div class="login-box">
    <h2>🔐 Admin Login</h2>
    <p>Enter your admin password to access the dashboard</p>
    <input type="password" id="passInput" placeholder="Password" onkeydown="if(event.key==='Enter')login()">
    <button onclick="login()">Login</button>
    <div class="error-msg" id="errMsg">❌ Incorrect password. Try again.</div>
  </div>
</div>

<div id="dashboard" class="container">
  <div class="stats" id="statsRow"></div>
  <div style="overflow:hidden;margin-bottom:8px">
    <h2 class="section">Expert Review Requests</h2>
    <button class="refresh-btn" onclick="loadData()">⟳ Refresh</button>
  </div>
  <div id="tableWrap"></div>
</div>

<script>
let savedPass = '';

async function login() {
  const pass = document.getElementById('passInput').value.trim();
  if (!pass) return;
  try {
    const r = await fetch('/admin/reviews', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({p: pass})
    });
    const data = await r.json();
    if (r.status === 401) {
      document.getElementById('errMsg').style.display = 'block';
      return;
    }
    savedPass = pass;
    document.getElementById('loginSection').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';
    document.getElementById('logoutBtn').style.display = 'inline-block';
    renderDashboard(data);
  } catch(e) {
    document.getElementById('errMsg').style.display = 'block';
  }
}

async function loadData() {
  const r = await fetch('/admin/reviews', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({p: savedPass})
  });
  const data = await r.json();
  renderDashboard(data);
}

function renderDashboard(data) {
  const reqs = data.requests || [];
  const pending = reqs.filter(r => r.status === 'pending').length;
  document.getElementById('statsRow').innerHTML = \`
    <div class="stat"><div class="stat-num">\${data.total}</div><div class="stat-label">Total Requests</div></div>
    <div class="stat"><div class="stat-num">\${pending}</div><div class="stat-label">Pending Review</div></div>
    <div class="stat"><div class="stat-num">\${reqs.length > 0 ? Math.round(reqs.reduce((a,r)=>a+(r.aiScore||0),0)/reqs.length) : 0}%</div><div class="stat-label">Avg AI Score</div></div>
  \`;
  if (reqs.length === 0) {
    document.getElementById('tableWrap').innerHTML = '<div class="empty">No expert review requests yet.</div>';
    return;
  }
  document.getElementById('tableWrap').innerHTML = \`
    <table>
      <thead><tr><th>Date</th><th>Brand / Model</th><th>Customer Email</th><th>AI Score</th><th>Status</th></tr></thead>
      <tbody>\${reqs.map(r => \`
        <tr>
          <td>\${new Date(r.timestamp).toLocaleString('en-PH',{dateStyle:'medium',timeStyle:'short'})}</td>
          <td><strong>\${r.brand||'—'}</strong><br><small style="color:#aaa">\${r.model||'—'}</small></td>
          <td><a href="mailto:\${r.email||''}" style="color:#C9A84C">\${r.email||'—'}</a></td>
          <td class="score">\${r.aiScore||0}%</td>
          <td><span class="badge badge-pending">\${r.status||'pending'}</span></td>
        </tr>
      \`).join('')}</tbody>
    </table>
  \`;
}

function logout() {
  savedPass = '';
  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('loginSection').style.display = 'block';
  document.getElementById('logoutBtn').style.display = 'none';
  document.getElementById('passInput').value = '';
  document.getElementById('errMsg').style.display = 'none';
}
</script>
</body>
</html>`);
});

// Admin data endpoint — accepts POST with password in body
app.post('/admin/reviews', (req, res) => {
  const pass = req.body.p;
  const adminPass = process.env.ADMIN_PASS || 'vraitag2025admin';
  if (pass !== adminPass) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ total: expertRequests.length, requests: expertRequests });
});

// Legacy GET endpoint (kept for backward compatibility)
app.get('/admin/reviews', (req, res) => {
  const pass = req.query.p;
  const adminPass = process.env.ADMIN_PASS || 'vraitag2025admin';
  if (pass !== adminPass) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ total: expertRequests.length, requests: expertRequests });
});

app.get('/api/plans', (req, res) => {
  res.json(Object.entries(PLANS).map(([id, p]) => ({
    id, name: p.name, amount: p.amount,
    amountFormatted: '₱' + (p.amount / 100).toLocaleString('en-PH', { minimumFractionDigits: 0 }),
    desc: p.desc,
  })));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`VraiTag™ running on port ${PORT} — Gemini AI + PayMongo payments`);
});
