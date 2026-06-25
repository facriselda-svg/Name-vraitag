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

// ─── SALES TRACKING ──────────────────────────────────────────────────────────
const salesRecords = [];

app.post('/api/track-sale', (req, res) => {
  const { user, email, plan, amount, amountPHP, method, status, date } = req.body;
  const sale = {
    id: 'SALE-' + Date.now(),
    user: user || 'Unknown',
    email: email || '—',
    plan: plan || '—',
    amount: amount || 0,
    amountPHP: amountPHP || 0,
    method: method || 'PayMongo',
    status: status || 'Pending',
    date: date || new Date().toISOString(),
    timestamp: new Date().toISOString(),
  };
  // Update existing record if same email+plan already pending
  const existing = salesRecords.find(s => s.email === email && s.plan === plan && s.status === 'Pending');
  if (existing) {
    existing.status = status || existing.status;
  } else {
    salesRecords.push(sale);
  }
  console.log(`[Sale] ${sale.status} | ${email} | ${plan} | ₱${amountPHP}`);
  res.json({ success: true, id: sale.id });
});

app.post('/api/update-sale', (req, res) => {
  const { email, plan, status } = req.body;
  const sale = salesRecords.find(s => s.email === email && s.plan === plan);
  if (sale) { sale.status = status || 'Paid'; }
  res.json({ success: true });
});

// Admin dashboard HTML page — green/gold luxury theme
app.get('/admin', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VraiTag™ Admin</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Nunito:wght@400;600;700;800&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  :root{--green:#0f3d2a;--green-mid:#1A5C3A;--green-light:#e8f5ee;--gold:#C9A84C;--gold-bright:#D4AF37;--cream:#f8faf5}
  body{font-family:'Nunito',sans-serif;background:var(--cream);color:#1a1a1a;min-height:100vh}

  /* HEADER */
  .header{background:linear-gradient(135deg,var(--green) 0%,#0a2a1c 100%);border-bottom:3px solid var(--gold);padding:0;display:flex;align-items:stretch}
  .header-inner{display:flex;align-items:center;gap:16px;padding:14px 32px;flex:1}
  .header-img{width:54px;height:54px;border-radius:10px;object-fit:cover;border:2px solid var(--gold)44;flex-shrink:0}
  .logo{font-family:'Cormorant Garamond',serif;font-size:24px;font-weight:700;color:var(--gold);letter-spacing:1px;line-height:1.1}
  .subtitle{font-size:12px;color:#a8c4b0;margin-top:2px;letter-spacing:0.3px}
  .header-bags{display:flex;gap:6px;padding:10px 24px 10px 0;align-items:center}
  .bag-thumb{width:42px;height:42px;border-radius:8px;object-fit:cover;border:1.5px solid var(--gold)55;opacity:0.85}
  .bag-thumb:hover{opacity:1;border-color:var(--gold)}

  /* LOGIN */
  .login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,var(--green) 0%,#1a4a2e 60%,#0f2a1c 100%);padding:20px}
  .login-box{background:#fff;border-radius:16px;padding:44px 40px;max-width:400px;width:100%;text-align:center;box-shadow:0 24px 60px #00000040}
  .login-logo{font-family:'Cormorant Garamond',serif;font-size:28px;font-weight:700;color:var(--green);letter-spacing:1px;margin-bottom:4px}
  .login-img{width:100%;height:140px;object-fit:cover;border-radius:10px;margin-bottom:20px;border:2px solid var(--green-light)}
  .login-box h2{color:var(--green);font-size:18px;margin-bottom:6px}
  .login-box p{color:#666;font-size:14px;margin-bottom:22px}
  input[type=password]{width:100%;padding:13px 16px;border-radius:10px;border:1.5px solid #d0e8d8;background:#f8faf5;color:#1a1a1a;font-size:15px;margin-bottom:14px;outline:none;font-family:'Nunito',sans-serif}
  input[type=password]:focus{border-color:var(--green-mid);box-shadow:0 0 0 3px #1A5C3A18}
  .login-btn{width:100%;padding:13px;background:linear-gradient(135deg,var(--green-mid),var(--green));color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;font-family:'Nunito',sans-serif;letter-spacing:0.3px}
  .login-btn:hover{background:linear-gradient(135deg,#22704a,var(--green-mid))}
  .error-msg{color:#c0392b;font-size:13px;margin-top:10px;display:none;background:#fdecea;padding:8px 12px;border-radius:8px}

  /* DASHBOARD */
  .dash-wrap{min-height:calc(100vh - 83px);background:var(--cream)}
  .container{max-width:1000px;margin:0 auto;padding:28px 24px}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:28px}
  .stat{background:#fff;border:1.5px solid #d0e8d8;border-radius:12px;padding:20px 16px;text-align:center;box-shadow:0 2px 8px #0f3d2a0a}
  .stat-icon{font-size:22px;margin-bottom:6px}
  .stat-num{font-size:26px;font-weight:800;color:var(--green-mid)}
  .stat-num.gold{color:var(--gold-bright)}
  .stat-label{font-size:11px;color:#7a9a86;margin-top:3px;text-transform:uppercase;letter-spacing:0.5px;font-weight:700}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px #0f3d2a0a;border:1px solid #d0e8d8}
  th{background:linear-gradient(135deg,var(--green-mid),var(--green));color:#fff;padding:12px 14px;text-align:left;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px}
  td{padding:12px 14px;border-bottom:1px solid #e8f2ec;font-size:13px;vertical-align:middle;color:#2a3a2f}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#f0f8f3}
  .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700}
  .badge-pending{background:#fff8e8;color:#b8860b;border:1px solid var(--gold)55}
  .badge-paid{background:#e8f5ee;color:var(--green-mid);border:1px solid #1A5C3A55}
  .score{font-weight:800;color:var(--green-mid)}
  .gold-text{color:var(--gold-bright);font-weight:800}
  .empty{text-align:center;padding:60px;color:#9ab5a2;font-size:15px}
  .toolbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
  .toolbar h2{color:var(--green);font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:700}
  .refresh-btn{background:transparent;border:1.5px solid #1A5C3A55;color:var(--green-mid);padding:7px 18px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;font-family:'Nunito',sans-serif}
  .refresh-btn:hover{background:#e8f5ee}
  .logout-btn{background:transparent;border:1.5px solid #d0e8d8;color:#7a9a86;padding:7px 16px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;font-family:'Nunito',sans-serif}
  .logout-btn:hover{border-color:#c0392b;color:#c0392b}
  .tabs{display:flex;gap:6px;margin-bottom:24px;border-bottom:2px solid #d0e8d8}
  .tab{padding:10px 24px;border-radius:10px 10px 0 0;cursor:pointer;font-size:14px;font-weight:700;color:#7a9a86;border:1.5px solid transparent;border-bottom:none;margin-bottom:-2px;font-family:'Nunito',sans-serif;transition:all .15s}
  .tab.active{background:#fff;border-color:#d0e8d8;color:var(--green);border-bottom:2px solid #fff}
  .tab:hover:not(.active){color:var(--green-mid);background:#e8f5ee55}
  .pane{display:none}
  .pane.active{display:block}
  #dashboard{display:none}
  .hero-strip{display:flex;gap:8px;margin-bottom:22px;height:100px;border-radius:12px;overflow:hidden}
  .hero-strip img{flex:1;object-fit:cover;min-width:0}
</style>
</head>
<body>

<div id="loginSection" class="login-wrap">
  <div class="login-box">
    <div class="login-logo">VraiTag™</div>
    <img class="login-img" src="https://images.unsplash.com/photo-1548036328-c9fa89d128fa?w=800&q=85" alt="Luxury bags">
    <h2>Admin Dashboard</h2>
    <p>Enter your password to manage sales &amp; reviews</p>
    <input type="password" id="passInput" placeholder="Admin password" onkeydown="if(event.key==='Enter')login()">
    <button class="login-btn" onclick="login()">🔐 Login</button>
    <div class="error-msg" id="errMsg">❌ Incorrect password. Try again.</div>
  </div>
</div>

<div id="dashboard">
  <div class="header">
    <div class="header-inner">
      <img class="header-img" src="https://images.unsplash.com/photo-1591561954557-26941169b49e?w=200&q=80" alt="bag">
      <div>
        <div class="logo">VraiTag™ Admin</div>
        <div class="subtitle">Sales &amp; Expert Review Management</div>
      </div>
      <div style="margin-left:auto;display:flex;gap:8px;align-items:center">
        <button class="logout-btn" onclick="logout()">Log Out</button>
      </div>
    </div>
    <div class="header-bags">
      <img class="bag-thumb" src="https://images.unsplash.com/photo-1584917865442-de89df76afd3?w=100&q=80" alt="">
      <img class="bag-thumb" src="https://images.unsplash.com/photo-1566150905458-1bf1fb99d4d4?w=100&q=80" alt="">
      <img class="bag-thumb" src="https://images.unsplash.com/photo-1591348278863-a8fb3887e2aa?w=100&q=80" alt="">
    </div>
  </div>

  <div class="dash-wrap">
    <div class="container">
      <div class="stats" id="statsRow"></div>
      <div class="hero-strip">
        <img src="https://images.unsplash.com/photo-1548036328-c9fa89d128fa?w=600&q=80" alt="">
        <img src="https://images.unsplash.com/photo-1584917865442-de89df76afd3?w=600&q=80" alt="">
        <img src="https://images.unsplash.com/photo-1591561954557-26941169b49e?w=600&q=80" alt="">
        <img src="https://images.unsplash.com/photo-1566150905458-1bf1fb99d4d4?w=600&q=80" alt="">
      </div>
      <div class="tabs">
        <div class="tab active" onclick="switchTab('sales')">💰 Sales Report</div>
        <div class="tab" onclick="switchTab('reviews')">🔍 Expert Reviews</div>
      </div>
      <div id="pane-sales" class="pane active">
        <div class="toolbar"><h2>Sales Report</h2><button class="refresh-btn" onclick="loadData()">⟳ Refresh</button></div>
        <div id="salesTable"></div>
      </div>
      <div id="pane-reviews" class="pane">
        <div class="toolbar"><h2>Expert Review Requests</h2><button class="refresh-btn" onclick="loadData()">⟳ Refresh</button></div>
        <div id="reviewsTable"></div>
      </div>
    </div>
  </div>
</div>

<script>
let savedPass = '';

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('active',['sales','reviews'][i]===name));
  document.querySelectorAll('.pane').forEach(p=>p.classList.toggle('active',p.id==='pane-'+name));
}

async function login() {
  const pass = document.getElementById('passInput').value.trim();
  if (!pass) return;
  try {
    const r = await fetch('/admin/reviews', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p:pass})});
    const data = await r.json();
    if (r.status === 401) { document.getElementById('errMsg').style.display='block'; return; }
    savedPass = pass;
    document.getElementById('loginSection').style.display='none';
    document.getElementById('dashboard').style.display='block';
    renderDashboard(data);
  } catch(e) { document.getElementById('errMsg').style.display='block'; }
}

async function loadData() {
  const r = await fetch('/admin/reviews',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p:savedPass})});
  renderDashboard(await r.json());
}

function fmt(iso){try{return new Date(iso).toLocaleString('en-PH',{dateStyle:'medium',timeStyle:'short'});}catch(e){return iso||'—';}}

function renderDashboard(data) {
  const reviews = data.requests||[];
  const sales = data.sales||[];
  const paidSales = sales.filter(s=>s.status==='Paid');
  const totalRev = paidSales.reduce((a,s)=>a+(s.amountPHP||0),0);
  const pendingRev = reviews.filter(r=>r.status==='pending').length;
  const pendingSales = sales.filter(s=>s.status==='Pending').length;

  document.getElementById('statsRow').innerHTML=\`
    <div class="stat"><div class="stat-icon">💰</div><div class="stat-num gold">₱\${totalRev.toLocaleString()}</div><div class="stat-label">Total Revenue</div></div>
    <div class="stat"><div class="stat-icon">✅</div><div class="stat-num">\${paidSales.length}</div><div class="stat-label">Paid Transactions</div></div>
    <div class="stat"><div class="stat-icon">⏳</div><div class="stat-num">\${pendingSales}</div><div class="stat-label">Pending Orders</div></div>
    <div class="stat"><div class="stat-icon">🔍</div><div class="stat-num">\${pendingRev}</div><div class="stat-label">Expert Reviews</div></div>
  \`;

  document.getElementById('salesTable').innerHTML = sales.length===0
    ? '<div class="empty">🛍️ No sales yet — they will appear here as customers check out via PayMongo.</div>'
    : \`<table><thead><tr><th>Date</th><th>Customer</th><th>Email</th><th>Plan</th><th>Amount</th><th>Method</th><th>Status</th></tr></thead><tbody>
      \${sales.slice().reverse().map(s=>\`<tr>
        <td>\${fmt(s.timestamp)}</td>
        <td>\${s.user||'—'}</td>
        <td><a href="mailto:\${s.email}" style="color:var(--green-mid);font-weight:700">\${s.email||'—'}</a></td>
        <td><strong>\${s.plan||'—'}</strong></td>
        <td class="gold-text">₱\${(s.amountPHP||0).toLocaleString()}</td>
        <td>\${s.method||'PayMongo'}</td>
        <td><span class="badge \${s.status==='Paid'?'badge-paid':'badge-pending'}">\${s.status||'Pending'}</span></td>
      </tr>\`).join('')}</tbody></table>\`;

  document.getElementById('reviewsTable').innerHTML = reviews.length===0
    ? '<div class="empty">🔍 No expert review requests yet.</div>'
    : \`<table><thead><tr><th>Date</th><th>Brand / Model</th><th>Customer Email</th><th>AI Score</th><th>Status</th></tr></thead><tbody>
      \${reviews.slice().reverse().map(r=>\`<tr>
        <td>\${fmt(r.timestamp)}</td>
        <td><strong>\${r.brand||'—'}</strong><br><small style="color:#7a9a86">\${r.model||'—'}</small></td>
        <td><a href="mailto:\${r.email}" style="color:var(--green-mid);font-weight:700">\${r.email||'—'}</a></td>
        <td class="score">\${r.aiScore||0}%</td>
        <td><span class="badge badge-pending">\${r.status||'pending'}</span></td>
      </tr>\`).join('')}</tbody></table>\`;
}

function logout(){
  savedPass='';
  document.getElementById('dashboard').style.display='none';
  document.getElementById('loginSection').style.display='flex';
  document.getElementById('passInput').value='';
  document.getElementById('errMsg').style.display='none';
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
  res.json({ total: expertRequests.length, requests: expertRequests, sales: salesRecords });
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
