export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
 
  const { prompt, lang } = req.body;
 
  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt' });
  }
 
  const anthropicKey = process.env.ANTHROPIC_KEY;
  if (!anthropicKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }
 
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: 'You are a senior property intelligence analyst at Parcela. Generate professional, data-driven reports with the authority of a private bank research note. Use clear headings, be specific, and be honest about risks.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
 
    const data = await response.json();
 
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Anthropic API error' });
    }
 
    return res.status(200).json({ text: data.content[0].text });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
