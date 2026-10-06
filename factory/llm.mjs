// Gemini REST client. No SDK on purpose: one fetch, one env var, no surface.
// Key comes from mediamonkey/.env (GEMINI_API_KEY=...), never from a flag.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let loaded = false;
export function loadEnv() {
  if (loaded) return;
  loaded = true;
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const val = m[2].replace(/^["']|["']$/g, '');
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
}

export function apiKey() {
  loadEnv();
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error('GEMINI_API_KEY missing: put it in mediamonkey/.env');
  return k;
}

/**
 * One Gemini generateContent call.
 * @param {object} o
 * @param {string} o.prompt        user turn
 * @param {string} [o.system]      system instruction
 * @param {string} [o.model]
 * @param {number} [o.temperature]
 * @param {boolean} [o.json]       ask for application/json back
 * @param {Array}  [o.tools]       e.g. [{ google_search: {} }] for grounding.
 *                                 Cannot be combined with json: the grounded
 *                                 response comes back as prose-wrapped JSON.
 * @returns {Promise<string>} the model's text
 */
export async function gemini({
  prompt,
  system,
  model = 'gemini-3.5-flash-lite',
  temperature = 0.95,
  json = false,
  tools = null,
  timeoutMs = 60000,
  maxOutputTokens = 4096,
  // gemini-2.5 spends "thinking" tokens out of the SAME budget as the answer, so
  // a long structured prompt can return JSON truncated mid-object. Extraction
  // tasks set this to 0: no thinking, whole budget for the payload.
  thinkingBudget = null,
}) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      topP: 0.95,
      maxOutputTokens,
      ...(thinkingBudget !== null ? { thinkingConfig: { thinkingBudget } } : {}),
      ...(json && !tools ? { responseMimeType: 'application/json' } : {}),
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools) body.tools = tools;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey(),
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 400);
    throw new Error(`gemini ${res.status}: ${detail}`);
  }
  const data = await res.json();
  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts || [])
    .map((p) => p.text || '')
    .join('')
    .trim();
  if (!text) {
    throw new Error(
      `gemini returned no text (finishReason=${cand?.finishReason || 'none'})`,
    );
  }
  return text;
}
