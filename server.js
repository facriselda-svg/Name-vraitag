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
