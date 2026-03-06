// agents/writeValidateAgent.js — ReplyMate Pro v5.0
// CALL 4 — Agent 6 (Writer) + Agent 7 (Validator) combined
// Model: GPT-4o  |  Writes the reply then immediately self-validates.
// If confidence < 70, automatically retries once with the specific fix instruction.
// Human touch is baked in at the prompt level — zero extra cost.

const { callOpenAIJSON } = require('./writerModels');

// ── Extract seller's actual writing style from thread history ─────────────
function extractSellerVoice(threadMessages) {
  if (!Array.isArray(threadMessages) || threadMessages.length === 0) return null;

  const msgs = threadMessages
    .filter(m => (m.role || '').toLowerCase() === 'seller')
    .map(m => (m.text || '').trim())
    .filter(t => t.length > 15);

  if (msgs.length === 0) return null;

  const traits = [];

  // Opening style
  const openings = msgs.map(m => m.match(/^(Hi|Hello|Dear|Hey|Good\s+\w+)[,\s]+(\w+)?/i)?.[0]).filter(Boolean);
  if (openings.length) traits.push(`Opens messages with: "${openings[0]}"`);

  // Sign-off style
  const signoffs = msgs.map(m => m.match(/(Kind regards|Best regards|Many thanks|Warm regards|Thanks|Cheers|Take care|Speak soon)[,\s\n]+\w*/i)?.[0]).filter(Boolean);
  if (signoffs.length) traits.push(`Signs off with: "${signoffs[0]}"`);

  // Message length
  const avgLen = msgs.reduce((s, m) => s + m.length, 0) / msgs.length;
  if (avgLen < 80)   traits.push('Writes SHORT messages — punchy, gets to the point, never rambles');
  else if (avgLen > 280) traits.push('Writes DETAILED messages — thorough, covers everything, multiple sentences per point');
  else               traits.push('Writes moderate-length messages — clear and complete but not verbose');

  // Tone formality
  const hasSlang   = msgs.some(m => /\b(gonna|wanna|kinda|hey|yep|nope|yeah|cheers)\b/i.test(m));
  const hasFormal  = msgs.some(m => /\b(sincerely|hereby|kindly note|please be advised)\b/i.test(m));
  if (hasSlang)   traits.push('Uses casual, conversational language — friendly not formal');
  else if (hasFormal) traits.push('Uses formal, polished language');
  else            traits.push('Uses natural professional language — neither stiff nor casual');

  // Names
  if (msgs.some(m => /^(Hi|Hello|Dear)\s+[A-Z][a-z]+/i.test(m)))
    traits.push('Addresses buyers by their first name');

  // Contractions
  if (msgs.some(m => /\b(I'll|we'll|I'm|we're|you'll|it's|that's|don't|can't|won't)\b/.test(m)))
    traits.push('Uses natural contractions — sounds human, not robotic');

  // Emoji
  if (msgs.some(m => /[\u{1F300}-\u{1F9FF}]/u.test(m)))
    traits.push('Occasionally uses emoji to add warmth');

  // Short fragments
  const firstLines = msgs.map(m => m.split('\n')[0].trim());
  if (firstLines.some(l => l.split(' ').length <= 4 && l.endsWith('.')))
    traits.push('Uses short punchy sentence fragments for emphasis');

  return traits.length > 0 ? traits : null;
}

async function writeValidateAgent({
  user,
  latestBuyerMessage,
  threadMessages,
  reasoning,
  classification,
  risk,
  dataFetch
}) {
  const sign         = user.signature_name || user.name || 'The Seller';
  const biz          = user.business_name  || 'our store';
  const sellerVoice  = extractSellerVoice(threadMessages);

  // Previous seller openings — Writer must not repeat these
  const prevOpenings = Array.isArray(threadMessages)
    ? threadMessages
        .filter(m => (m.role || '').toLowerCase() === 'seller')
        .map(m => (m.text || '').trim().split('\n')[0].trim())
        .filter(Boolean)
        .slice(-4)
    : [];

  const voiceBlock = sellerVoice
    ? `\nSELLER'S ACTUAL WRITING VOICE — MIRROR THIS PRECISELY:\n${sellerVoice.map(t => `  • ${t}`).join('\n')}\n`
    : '';

  // Warmth level instruction based on relationship score
  const warmthMap = {
    cold_professional: 'professional and helpful — no excessive warmth, keep it efficient',
    warm_professional: 'warm and professional — friendly but not overly familiar',
    friendly:          'friendly and personable — this buyer knows the seller slightly, reflect that',
    personal:          'personal and warm — ongoing conversation with good rapport, let that show naturally'
  };
  const warmthInstruction = warmthMap[reasoning.conversationWarmth] || warmthMap['warm_professional'];

  const systemPrompt = `You are writing a customer service reply for ${biz}, an eBay seller.
You write AS ${sign} — you ARE this person, not an assistant writing on their behalf.
${voiceBlock}
━━━ HUMAN TOUCH RULES — NON-NEGOTIABLE ━━━
1. EMOTIONAL ACKNOWLEDGMENT FIRST — before any solution, acknowledge the feeling. "Sorry to hear that" before "here's the tracking."
2. TIME-ANCHORING — use phrases that imply you just took action RIGHT NOW for this buyer. "I've just checked", "I'm looking at this now", "I've just pulled up your order."
3. CONTROLLED IMPERFECTION — real humans use contractions (I'll, it's, we're), start sentences with "And" or "But", use occasional fragments. Avoid perfectly polished paragraphs.
4. SPECIFIC NOT GENERIC — every reply must reference something specific: the item name, the carrier, the wait time. Never write something that could have been copy-pasted.
5. REGISTER MATCHING — mirror the buyer's formality level. Casual buyer → more casual reply. Formal buyer → stay measured. Never be warmer than the conversation has earned.
6. ONE GENUINE INTEREST SIGNAL — one natural phrase that shows you care about THEIR specific situation. "Hope it arrives in time for your plans" or "Let me know how you get on with it."
7. VARY SIGN-OFF — match the conversation warmth. Not always "Best regards." Sometimes just "Thanks," or "Speak soon," or simply the name.
8. NEVER repeat an opening phrase used earlier in this conversation.

━━━ ABSOLUTE RULES ━━━
• Never suggest off-eBay communication (no WhatsApp, email, phone, PayPal direct)
• Never admit fault, liability, or responsibility
• Never invent tracking numbers, order details, or delivery dates
• Never make promises you cannot keep
• Never use words on the do-not-say list
• Always end with the seller's signature: ${sign}

After writing the reply, immediately validate it. Return both as JSON.
RETURN ONLY valid JSON. No markdown, no explanation.`;

  const factsBlock = (reasoning.factsToWeaveIn || []).length > 0
    ? reasoning.factsToWeaveIn.map(f => `  • ${f}`).join('\n')
    : '  • No specific eBay data available — write from general knowledge only';

  const doBlock   = (reasoning.doList   || []).map(d => `  ✓ ${d}`).join('\n') || '  ✓ Be helpful and professional';
  const dontBlock = (reasoning.dontList || []).map(d => `  ✗ ${d}`).join('\n') || '  ✗ Do not admit fault';
  const avoidBlock = (risk.doNotSayList || []).length > 0
    ? risk.doNotSayList.join(', ')
    : 'none specific';

  const conflictBlock = (reasoning.conflictResolutions || []).length > 0
    ? `CONFLICT RESOLUTIONS (apply these exactly):\n${reasoning.conflictResolutions.map(c => `  → ${c}`).join('\n')}`
    : '';

  const prevOpeningBlock = prevOpenings.length > 0
    ? `PREVIOUS SELLER OPENINGS — DO NOT REPEAT THESE:\n${prevOpenings.map(o => `  • "${o}"`).join('\n')}`
    : '';

  const userPrompt = `BUYER'S MESSAGE:
"${latestBuyerMessage}"

━━━ STRATEGY BRIEF ━━━
${reasoning.strategyBrief || 'Write a professional, helpful reply addressing the buyer\'s concern.'}

━━━ WRITE TO THESE PRIORITIES (in order) ━━━
${(reasoning.priorityList || ['Address the buyer\'s concern professionally']).map((p, i) => `${i + 1}. ${p}`).join('\n')}

━━━ TONE AND LENGTH ━━━
Tone: ${reasoning.toneCalibration || user.reply_tone || 'professional'}
Length: ${reasoning.targetLength || 'medium'}
Warmth: ${warmthInstruction}
Buyer emotional need: ${reasoning.buyerEmotionalNeed || 'a helpful response'}
Opening: ${reasoning.openingInstruction || 'Acknowledge the buyer\'s message warmly'}
Closing: ${reasoning.closingInstruction || 'Offer further help and sign off'}

━━━ SELLER ACTION PHRASE TO OPEN WITH ━━━
"${reasoning.sellerActionPhrase || 'Thank you for your message'}" — weave this in naturally at the start.

━━━ FACTS TO REFERENCE (use these naturally, do not just list them) ━━━
${factsBlock}

━━━ DO ━━━
${doBlock}

━━━ DO NOT ━━━
${dontBlock}

━━━ NEVER USE THESE WORDS/PHRASES ━━━
${avoidBlock}

${conflictBlock}

${prevOpeningBlock}

BUYER'S LANGUAGE: ${classification.languageStyle} | BUYER'S TONE: ${classification.buyerTone}

━━━ YOUR TASK ━━━
Write the reply AS ${sign}. Be specific, be human, be helpful.
Then validate it against the checklist.

Return this exact JSON:
{
  "reply": "<the complete reply ready to send — natural line breaks, human voice, ends with signature>",
  "validation": {
    "allIntentsAddressed": <boolean — are all buyer concerns in the message addressed?>,
    "factuallyAccurate": <boolean — does the reply contain zero invented facts?>,
    "toneMatch": <boolean — does the tone match the brief?>,
    "noLiabilityLanguage": <boolean — zero admissions, zero unsafe promises?>,
    "noOffPlatform": <boolean — zero off-eBay communication suggestions?>,
    "humanFeeling": <boolean — does this feel like a real human wrote it, not AI?>,
    "avoidsDoNotSayList": <boolean — none of the forbidden words/phrases appear?>,
    "sendConfidence": <integer 0-100 — overall confidence this reply is excellent and safe to send>,
    "flags": [<specific issues found — empty array if none>],
    "humanReviewRequired": <boolean — true if any significant issue found>,
    "improvementNote": "<null or ONE specific improvement if sendConfidence is below 80>"
  }
}`;

  const runWrite = async (prompt) => {
    const result = await callOpenAIJSON(systemPrompt, prompt, 'gpt-4o', 1400);
    return result;
  };

  try {
    const result  = await runWrite(userPrompt);
    const parsed  = result.parsed;
    let totalCost   = result.cost;
    let totalTokens = result.tokens;
    let wasRetried  = false;

    // ── Auto-retry if confidence is low and there's a specific fix ────────
    if (
      parsed.validation &&
      parsed.validation.sendConfidence < 72 &&
      parsed.validation.improvementNote
    ) {
      console.log(`[writeValidateAgent] Low confidence (${parsed.validation.sendConfidence}), retrying with fix: ${parsed.validation.improvementNote}`);
      try {
        const retryPrompt = `${userPrompt}

━━━ RETRY INSTRUCTION ━━━
Your previous attempt had this specific issue: "${parsed.validation.improvementNote}"
Fix ONLY that issue. Keep everything else. Return the same JSON format.`;

        const retry = await runWrite(retryPrompt);
        totalCost   += retry.cost;
        totalTokens += retry.tokens;
        wasRetried   = true;

        return {
          ok:         true,
          reply:      retry.parsed.reply,
          validation: retry.parsed.validation,
          model:      'gpt-4o',
          tokens:     totalTokens,
          cost:       totalCost,
          wasRetried
        };
      } catch (retryErr) {
        console.warn('[writeValidateAgent] Retry failed, returning original:', retryErr.message);
      }
    }

    return {
      ok:         true,
      reply:      parsed.reply,
      validation: parsed.validation,
      model:      'gpt-4o',
      tokens:     totalTokens,
      cost:       totalCost,
      wasRetried
    };

  } catch (err) {
    console.error('[writeValidateAgent] failed:', err.message);
    throw err;
  }
}

module.exports = { writeValidateAgent };
