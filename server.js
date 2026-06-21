// VraiTag™ — Server
// Serves the app + proxies Google Gemini API securely (free tier)

const express = require('express');
const path = require('path');
const app = express();

app.use(express.json({ limit: '20mb' }));

// Serve the main HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Convert Anthropic message content → Gemini parts array
function toGeminiParts(content) {
  if (typeof content === 'string') {
    return [{ text: content }];
  }
  if (Array.isArray(content)) {
    return content.map(block => {
      if (block.type === 'text') {
        return { text: block.text };
      }
      if (block.type === 'image') {
        // Anthropic base64 image → Gemini inline_data
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

// Convert Anthropic messages array → Gemini contents array
function toGeminiContents(messages) {
  return messages.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: toGeminiParts(msg.content),
  }));
}

// Convert Gemini response → Anthropic response shape
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
    model: 'gemini-1.5-flash',
    stop_reason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

// API proxy — accepts Anthropic format, calls Gemini, returns Anthropic format
app.post('/api/claude', async (req, res) => {
  const apiKey = process.env.GEMINI_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: 'API key not configured. Add GEMINI_KEY in Render Environment Variables.'
    });
  }

  try {
    const { messages, max_tokens, system } = req.body;

    // Prepend system prompt as first user message if present
    const allMessages = system
      ? [{ role: 'user', content: `System instructions: ${system}` }, { role: 'assistant', content: 'Understood.' }, ...messages]
      : messages;

    const geminiBody = {
      contents: toGeminiContents(allMessages),
      generationConfig: {
        maxOutputTokens: max_tokens || 1024,
        temperature: 0.7,
      },
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
    });

    const geminiData = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: geminiData.error?.message || 'Gemini API error',
      });
    }

    res.json(toAnthropicResponse(geminiData));
  } catch (err) {
    res.status(500).json({ error: 'Proxy failed', message: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`VraiTag™ running on port ${PORT} (Gemini free tier)`);
});
