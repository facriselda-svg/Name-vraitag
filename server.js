// VraiTag™ — Replit Server
// Serves the app + proxies Anthropic API securely

const express = require('express');
const path = require('path');
const app = express();

app.use(express.json({ limit: '10mb' }));

// Serve the main HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Secure Anthropic API proxy — key stays server-side only
app.post('/api/claude', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: 'API key not configured. Add ANTHROPIC_KEY in Replit Secrets.'
    });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.text();
    res.status(response.status).set('Content-Type', 'application/json').send(data);
  } catch (err) {
    res.status(500).json({ error: 'Proxy failed', message: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`VraiTag™ running at http://0.0.0.0:${PORT}`);
});
