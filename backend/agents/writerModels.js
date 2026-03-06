// agents/writerModels.js — ReplyMate Pro v5.0
// Central AI call layer. Supports GPT-4o-mini and GPT-4o with JSON mode.
// All agents import from here — never call fetch directly in agent files.
const fetch = require('node-fetch');

// ── Pricing table ─────────────────────────────────────────────────────────
const PRICING = {
  'gpt-4o':      { input: 0.0000025,  output: 0.00001   },
  'gpt-4o-mini': { input: 0.00000015, output: 0.0000006 },
};

// ── Core call (internal) ──────────────────────────────────────────────────
async function _call({ model, systemPrompt, userMessage, maxTokens, jsonMode, temperature }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OpenAI API key not configured');

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userMessage  }
    ],
    max_tokens:  maxTokens,
    temperature: temperature ?? (jsonMode ? 0.1 : 0.7)
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body:    JSON.stringify(body)
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'OpenAI API error');

  const usage = data.usage || {};
  const p     = PRICING[model] || PRICING['gpt-4o-mini'];
  const cost  = ((usage.prompt_tokens || 0) * p.input) + ((usage.completion_tokens || 0) * p.output);

  return {
    text:   data.choices[0].message.content.trim(),
    model,
    tokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
    cost:   parseFloat(cost.toFixed(7))
  };
}

// ── JSON structured call — returns { ...result, parsed } ──────────────────
async function callOpenAIJSON(systemPrompt, userMessage, model = 'gpt-4o-mini', maxTokens = 1200) {
  const result = await _call({ model, systemPrompt, userMessage, maxTokens, jsonMode: true });
  let parsed;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    const cleaned = result.text.replace(/```json|```/g, '').trim();
    try { parsed = JSON.parse(cleaned); }
    catch (e) { throw new Error(`JSON parse failed. Model: ${model}. Raw: ${result.text.slice(0, 300)}`); }
  }
  return { ...result, parsed };
}

// ── Natural language reply — GPT-4o ───────────────────────────────────────
async function callOpenAIReply(systemPrompt, userMessage, maxTokens = 800) {
  const result = await _call({ model: 'gpt-4o', systemPrompt, userMessage, maxTokens, jsonMode: false, temperature: 0.7 });
  return { reply: result.text, model: 'gpt-4o', tokens: result.tokens, cost: result.cost };
}

/* ── Everything below this line is the ORIGINAL file kept for backward compat ── */


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

module.exports = { callOpenAIJSON, callOpenAIReply, callOpenAI, callAnthropic };
