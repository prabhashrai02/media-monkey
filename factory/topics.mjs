// Story discovery for FINALYST reels.
//
// No categories, no keyword lists, no rotation, no backlog. Gemini searches the
// live web (google_search grounding) with no subject in mind and returns the
// stories that are genuinely worth explaining right now. This file only
// applies the selection rules to that answer: recency, evidence, novelty,
// then the strongest composite score wins.
//
// Everything rendered is appended to the history file (restored from the
// reels branch on CI) and a story that matches one already there is dropped.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gemini } from './llm.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
// out/ is gitignored; CI restores the channel's memory from the reels branch
// before rendering and MEDIAMONKEY_HISTORY points at that copy.
const HISTORY_FILE = process.env.MEDIAMONKEY_HISTORY || path.join(ROOT, 'out', 'history.json');

const FRESH_HOURS = 6;
const MAX_HOURS = 24;
const REPEAT_OVERLAP = 0.6;

export function normalizeTopic(t) {
  return String(t).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function readHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; }
}

export function appendHistory(entry) {
  const hist = readHistory();
  hist.push({ ...entry, at: new Date().toISOString() });
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(hist, null, 2), 'utf8');
  return hist.length;
}

/** The story lines the account has already published, newest first. */
export function recentStories(n = 40) {
  return readHistory().slice(-n).reverse().map((h) => h.topic || h.hook).filter(Boolean);
}

const STOP = new Set('the a an and or of to in on at for with from as by is are was were be it its this that than then after before over into amid says said new about will could would may more less up down'.split(' '));
const contentWords = (s) => new Set(normalizeTopic(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w)));

/**
 * Same story under a different headline: the smaller headline's content words
 * mostly appear in the other. Compared on words, not on any keyword list.
 */
export function isRepeat(topic, history = readHistory()) {
  const a = contentWords(topic);
  if (!a.size) return false;
  for (const h of history.slice(-80)) {
    for (const prior of [h.topic, h.hook]) {
      if (!prior) continue;
      const b = contentWords(prior);
      if (!b.size) continue;
      if (normalizeTopic(prior) === normalizeTopic(topic)) return true;
      const shared = [...a].filter((w) => b.has(w)).length;
      if (Math.min(a.size, b.size) >= 3 && shared / Math.min(a.size, b.size) >= REPEAT_OVERLAP) return true;
    }
  }
  return false;
}

/** First balanced [...] in a string, ignoring brackets inside JSON strings. */
function balancedArray(s) {
  const start = s.indexOf('[');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

/**
 * Grounded generation cannot use responseMimeType=application/json, so the
 * answer arrives as prose-wrapped JSON. A successful JSON.parse is not the
 * test ("sources [1] and [2]" parses as an array of numbers): carrying a
 * topic is. Degrades from the whole array to object by object.
 * @returns {{list: Array, how: string}}
 */
export function parseTopicList(raw) {
  const text = String(raw).replace(/```(?:json)?/g, '');
  const usable = (v) => (Array.isArray(v)
    ? v.filter((o) => o && typeof o === 'object' && typeof o.topic === 'string' && o.topic.trim())
    : []);
  for (const [how, cand] of [
    ['balanced', balancedArray(text)],
    ['greedy', /\[[\s\S]*\]/.exec(text)?.[0]],
  ]) {
    if (!cand) continue;
    try {
      const list = usable(JSON.parse(cand));
      if (list.length) return { list, how };
    } catch { /* try the next strategy */ }
  }
  const objs = [];
  for (const m of text.matchAll(/\{(?:[^{}]|\{[^{}]*\})*\}/g)) {
    try { objs.push(JSON.parse(m[0])); } catch { /* skip just this one */ }
  }
  const fromObjs = usable(objs);
  if (fromObjs.length) return { list: fromObjs, how: 'per-object' };
  return { list: [], how: 'none' };
}

const num = (v, lo = 0, hi = 10) => Math.min(hi, Math.max(lo, Number(v) || 0));

function ageHours(o, now) {
  const t = Date.parse(o.publishedAt || '');
  if (Number.isFinite(t)) return Math.max(0, (now - t) / 3600000);
  const h = Number(o.hoursAgo);
  return Number.isFinite(h) && o.hoursAgo !== '' && o.hoursAgo != null ? h : null;
}

/**
 * Turn one raw candidate into a ranked, evidence-carrying story, or null when
 * it fails a hard rule (no topic, too old, no sourced fact).
 */
export function scoreCandidate(o, now = Date.now()) {
  const topic = String(o.topic || '').trim();
  const facts = (Array.isArray(o.facts) ? o.facts : [])
    .map((f) => ({ claim: String(f && f.claim || '').trim(), source: String(f && f.source || '').trim() }))
    .filter((f) => f.claim && f.source);
  const age = ageHours(o, now);
  if (!topic || !facts.length || age == null || age > MAX_HOURS) return null;
  const fresh = age <= FRESH_HOURS;
  const score = 3 * num(o.reach) + 3 * num(o.significance) + 2 * num(o.explainability) + 2 * num(o.hook)
    + (fresh ? 12 : 0) + Math.min(facts.length, 4);
  return {
    topic, why: String(o.why || '').trim(), source: 'live', score,
    ageHours: +age.toFixed(1), fresh,
    brief: { publishedAt: o.publishedAt || null, facts, angle: String(o.angle || '').trim() },
  };
}

function searchPrompt(count, recent) {
  const now = new Date();
  return (
    `Current date and time: ${now.toISOString()} (UTC).\n\n` +
    `You are the research desk of a premium financial-media account. Do not search for a ` +
    `predefined category. Determine what financial story is most worth explaining right now.\n\n` +
    `Search the current financial, business, market, economic and policy news broadly, and let ` +
    `the news itself decide the subject. It could be anything with real financial consequence. ` +
    `Look at what happened in the last ${FRESH_HOURS} hours first; only if that is thin, widen to the ` +
    `last ${MAX_HOURS} hours. Never go beyond ${MAX_HOURS} hours.\n\n` +
    `Return the ${count} strongest distinct stories, judged on:\n` +
    `- reach: how many people it matters to\n` +
    `- significance: real consequence for markets, money, companies, consumers or the economy\n` +
    `- explainability: there is a clear "why this matters" beyond the headline\n` +
    `- hook: surprising, counterintuitive or consequential\n` +
    `- evidence: every fact is stated by a reliable source you actually found\n\n` +
    (recent.length
      ? `ALREADY COVERED by this account. Do not return these stories again, or the same story ` +
        `under another headline:\n${recent.map((r) => `- ${r}`).join('\n')}\n\n`
      : '') +
    `Rules: never invent a price, percentage, date, quote, market reaction or cause. A cause is ` +
    `only stated if a source states it. Facts must be quotable from the sources. No investment ` +
    `advice, no predictions presented as facts.\n\n` +
    `Return ONLY a JSON array, no prose:\n` +
    `[{"topic":"the story in one plain sentence, 8 to 16 words, no hashtags",\n` +
    `  "publishedAt":"ISO 8601 UTC time of the newest development",\n` +
    `  "why":"one line on why it matters to a broad audience",\n` +
    `  "angle":"the explanation that goes beyond the headline",\n` +
    `  "reach":1-10, "significance":1-10, "explainability":1-10, "hook":1-10,\n` +
    `  "facts":[{"claim":"a specific, checkable statement with its figure or date","source":"publisher name"}]}]`
  );
}

/**
 * Search the live web and return qualifying stories, best first.
 * @returns {Promise<Array<{topic, why, score, ageHours, fresh, brief, source}>>}
 */
export async function discoverStories(count = CONFIG.topics.liveCount || 8, opts = {}) {
  const log = opts.log || (() => {});
  const recent = opts.recent || recentStories(40);
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await gemini({
        prompt: searchPrompt(count, recent),
        model: opts.model || CONFIG.model,
        temperature: 0.4,
        tools: [{ google_search: {} }],
        timeoutMs: 120000,
        maxOutputTokens: 8192,
      });
      const { list, how } = parseTopicList(raw);
      if (!list.length) throw new Error(`no parseable stories (${raw.length} chars of prose)`);
      const now = Date.now();
      const history = readHistory();
      const scored = list.map((o) => scoreCandidate(o, now)).filter(Boolean);
      const novel = scored.filter((s) => !isRepeat(s.topic, history));
      log(`  research: ${list.length} candidates (parsed: ${how}), ${scored.length} fresh and sourced, ${novel.length} not covered before`);
      if (!novel.length) throw new Error('no qualifying story: everything found was stale, unsourced or already covered');
      return novel.sort((a, b) => b.score - a.score);
    } catch (e) {
      lastErr = e;
      log(`  research attempt ${attempt} failed: ${e.message}`);
    }
  }
  throw new Error(`story discovery failed: ${lastErr.message}`);
}

/**
 * Sourced facts for a topic the operator supplied by hand, so the script
 * writer is never left to recall numbers from memory.
 */
export async function briefFor(topic, opts = {}) {
  const prompt =
    `Current date and time: ${new Date().toISOString()} (UTC).\n` +
    `Research this financial story using web search: "${topic}"\n` +
    `Return ONLY JSON: {"publishedAt":"ISO time of the newest development","angle":"the explanation ` +
    `beyond the headline","facts":[{"claim":"specific checkable statement with its figure or date",` +
    `"source":"publisher name"}]}. 4 to 8 facts. Never invent a figure, date, quote or cause.`;
  const raw = await gemini({
    prompt, model: opts.model || CONFIG.model, temperature: 0.2,
    tools: [{ google_search: {} }], timeoutMs: 90000, maxOutputTokens: 4096,
  });
  const m = /\{[\s\S]*\}/.exec(raw.replace(/```(?:json)?/g, ''));
  const j = JSON.parse(m ? m[0] : '{}');
  const facts = (j.facts || []).filter((f) => f && f.claim && f.source);
  return facts.length ? { publishedAt: j.publishedAt || null, angle: j.angle || '', facts } : null;
}

/** make.mjs uses this to top up a batch beyond the topics given on the command line. */
export async function supplyTopics(n = 1, opts = {}) {
  const stories = await discoverStories(Math.max(n, CONFIG.topics.liveCount || 8), opts);
  return { topics: stories.slice(0, n), notes: [`google_search research: ${stories.length} qualifying stories`] };
}

/** What make.mjs calls in --auto mode: the single strongest story right now. */
export async function nextTopic(opts = {}) {
  const log = opts.log || (() => {});
  const [best] = (await supplyTopics(1, opts)).topics;
  log(`  story: ${best.topic} (${best.ageHours}h old, score ${best.score})${best.why ? `\n  why: ${best.why}` : ''}`);
  return best;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const stories = await discoverStories(Number(process.argv[2] || 8), { log: console.log });
  for (const s of stories) console.log(`- [${s.score}] ${s.ageHours}h  ${s.topic}${s.why ? `  (${s.why})` : ''}`);
}
