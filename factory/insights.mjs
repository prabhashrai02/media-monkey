/*
 * insights.mjs — the feedback loop. Pulls per-reel performance from the
 * official API (instagram_business_manage_insights scope) and appends one
 * JSONL row per media per run to insights/history.jsonl, so performance over
 * time is diffable and future topic selection can learn from it.
 *
 *   node factory/insights.mjs            # prints table, appends history
 *   node factory/insights.mjs --summary  # also prints a markdown summary
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const env = { ...process.env };
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) env[m[1]] = m[2];
  }
}

const TOKEN = env.IG_ACCESS_TOKEN;
if (!TOKEN) {
  console.error('IG_ACCESS_TOKEN missing');
  process.exit(1);
}
const G = `https://graph.instagram.com/${process.env.IG_API_VERSION || 'v21.0'}`;

async function gget(path, params = {}) {
  const q = new URLSearchParams({ ...params, access_token: TOKEN });
  const r = await fetch(`${G}/${path}?${q}`);
  const j = await r.json();
  if (j.error) throw new Error(path + ': ' + JSON.stringify(j.error).slice(0, 200));
  return j;
}

const me = await gget('me', { fields: 'user_id,username,followers_count,media_count' });
const media = await gget('me/media', {
  fields: 'id,caption,media_type,permalink,timestamp,like_count,comments_count',
  limit: 30,
});

const rows = [];
for (const m of media.data || []) {
  if (m.media_type !== 'VIDEO' && m.media_type !== 'REELS') continue;
  let views = null, reach = null, saved = null, shares = null, avgWatchMs = null;
  try {
    const ins = await gget(m.id + '/insights', { metric: 'views,reach,saved,shares,ig_reels_avg_watch_time' });
    for (const d of ins.data || []) {
      const v = d.values?.[0]?.value ?? null;
      if (d.name === 'views') views = v;
      if (d.name === 'reach') reach = v;
      if (d.name === 'saved') saved = v;
      if (d.name === 'shares') shares = v;
      if (d.name === 'ig_reels_avg_watch_time') avgWatchMs = v;
    }
  } catch (e) {
    // some metrics 400 on very fresh media; keep what we have
  }
  rows.push({
    at: new Date().toISOString().slice(0, 10),
    id: m.id,
    posted: (m.timestamp || '').slice(0, 10),
    hook: (m.caption || '').split('\n')[0].slice(0, 70),
    views, reach, likes: m.like_count ?? null, comments: m.comments_count ?? null,
    saved, shares, avgWatchMs,
    permalink: m.permalink,
  });
}

mkdirSync(join(ROOT, 'insights'), { recursive: true });
for (const r of rows) appendFileSync(join(ROOT, 'insights', 'history.jsonl'), JSON.stringify(r) + '\n');

console.log(`@${me.username} · ${me.followers_count} followers · ${me.media_count} posts`);
for (const r of rows.slice(0, 15)) {
  console.log(
    [r.posted, String(r.views ?? '-').padStart(6), 'views', String(r.likes ?? '-').padStart(4), 'likes', '·', r.hook].join(' ')
  );
}

if (process.argv.includes('--summary')) {
  const top = [...rows].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 3);
  console.log('\n## weekly summary');
  console.log(`followers: ${me.followers_count} · tracked reels: ${rows.length}`);
  console.log('top by views:');
  for (const t of top) console.log(`- ${t.views ?? 0} views · ${t.hook} · ${t.permalink}`);
}
