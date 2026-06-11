'use strict';

const { DEFAULT_MODELS } = require('./settings');

function buildPrompt(summary) {
  return `You are a careful macOS storage-cleanup expert. A user scanned their Mac's home folder with a storage manager app. Analyze the scan summary and propose a cleanup plan.

SCAN SUMMARY (JSON):
${JSON.stringify(summary)}

Respond with ONLY a JSON object (no markdown fences, no prose around it) of this exact shape:
{
  "headline": "one sentence: where the space is actually going",
  "observations": ["2-5 short, specific insights about THIS user's storage"],
  "recommendations": [
    {
      "title": "short action title",
      "why": "1-2 sentences: what this is and why it is safe (or not) to remove",
      "risk": "safe" | "caution" | "risky",
      "paths": ["absolute paths copied EXACTLY from the summary, when applicable"],
      "estimatedBytes": 123456789,
      "how": "how to do it, e.g. 'Select and move to Trash in this app' or a command like 'docker system prune -a'"
    }
  ],
  "warnings": ["things the user should NOT delete and why"]
}

Rules:
- Only reference paths that literally appear in the summary. Never invent or guess paths.
- Prefer caches, build artifacts, installers, old archives/disk images, and stale large files.
- Suggesting removal of unused third-party applications (from the "applications" list) is allowed — tell the user to remove them via Finder or the app's uninstaller, and never suggest removing apps they appear to use regularly.
- Never recommend deleting personal documents, photo libraries, mail data, or app settings unless the summary clearly shows something redundant (and say why).
- Order recommendations by reclaimable space, largest first. Give 4-8 recommendations.
- estimatedBytes must be a number (bytes), derived from sizes in the summary.`;
}

async function callAnthropic({ apiKey, model, prompt }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: 3000, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Anthropic API error (${res.status}): ${data?.error?.message || res.statusText}`);
  }
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  if (!text) throw new Error('The model returned an empty response.');
  return text;
}

async function callOpenAI({ apiKey, model, prompt }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`OpenAI API error (${res.status}): ${data?.error?.message || res.statusText}`);
  }
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('The model returned an empty response.');
  return text;
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON found');
  return JSON.parse(text.slice(start, end + 1));
}

async function analyze({ provider, apiKey, model, summary }) {
  const chosenModel = (model && model.trim()) || DEFAULT_MODELS[provider] || DEFAULT_MODELS.anthropic;
  const prompt = buildPrompt(summary);
  const call = provider === 'openai' ? callOpenAI : callAnthropic;
  const text = await call({ apiKey, model: chosenModel, prompt });

  let parsed;
  try {
    parsed = extractJson(text);
  } catch {
    // Model didn't return clean JSON — surface the raw text rather than failing.
    parsed = { headline: '', observations: [], recommendations: [], warnings: [], rawText: text };
  }
  return {
    model: chosenModel,
    headline: typeof parsed.headline === 'string' ? parsed.headline : '',
    observations: Array.isArray(parsed.observations) ? parsed.observations.filter((s) => typeof s === 'string') : [],
    recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter((s) => typeof s === 'string') : [],
    rawText: typeof parsed.rawText === 'string' ? parsed.rawText : undefined,
  };
}

module.exports = { analyze };
