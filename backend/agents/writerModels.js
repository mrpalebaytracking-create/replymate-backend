// backend/agents/writerModels.js
const fetch = require('node-fetch');

async function callOpenAI(systemPrompt, userMessage) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OpenAI API key not configured');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      max_tokens: 500,
      temperature: 0.7
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'OpenAI API error');

  const usage = data.usage || {};
  const cost = ((usage.prompt_tokens || 0) * 0.00000015) + ((usage.completion_tokens || 0) * 0.0000006);

  return {
    reply: data.choices[0].message.content.trim(),
    model: 'gpt-4o-mini',
    tokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
    cost: parseFloat(cost.toFixed(6))
  };
}

async function callAnthropic(systemPrompt, userMessage) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Anthropic API key not configured');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'Anthropic API error');

  const usage = data.usage || {};
  const cost = ((usage.input_tokens || 0) * 0.0000008) + ((usage.output_tokens || 0) * 0.000004);

  return {
    reply: data.content?.[0]?.text?.trim() || '',
    model: 'claude-3-5-haiku-20241022',
    tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    cost: parseFloat(cost.toFixed(6))
  };
}

module.exports = { callOpenAI, callAnthropic };
