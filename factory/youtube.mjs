/*
 * youtube.mjs — upload a finished reel to YouTube as a Short.
 *
 * A vertical video under three minutes is classified as a Short automatically,
 * so there is no separate Shorts endpoint: this is an ordinary resumable
 * videos.insert and YouTube does the rest.
 *
 *   node factory/youtube.mjs --file out/.../reel.mp4 --meta out/.../youtube.json
 *   node factory/youtube.mjs --file ... --title "..." --description-file ... --tags a,b
 *        [--privacy public|unlisted|private] [--dry-run]
 *
 * Env: YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN
 *      (mint the refresh token once with factory/youtube-auth.mjs)
 * Exits 0 with a notice when secrets are absent, so CI can run without them.
 *
 * Quota: videos.insert costs 1600 units against a default 10,000/day project
 * quota, so six uploads a day is the ceiling unless Google raises it. The
 * schedule posts four, which fits with room for one retry.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : null;
};
const has = (k) => args.includes(k);

const file = arg('--file');
const privacy = arg('--privacy') || 'public';
// YouTube can schedule natively: upload private with a publishAt and it goes
// public on the slot. It needs a little lead time, so a slot under fifteen
// minutes away is just published now.
const publishAtArg = arg('--publish-at');
const idFile = arg('--id-file');
const scheduleAt = publishAtArg && new Date(publishAtArg).getTime() - Date.now() > 15 * 60000
  ? new Date(publishAtArg).toISOString() : null;

// --meta points at the youtube.json the render wrote next to the reel, so CI
// does not have to pick JSON apart in shell. Explicit flags still win.
let meta = {};
const metaPath = arg('--meta');
if (metaPath) {
  if (!fs.existsSync(metaPath)) {
    console.error('youtube: no such meta file: ' + metaPath);
    process.exit(2);
  }
  meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
}
const metaDir = metaPath ? path.dirname(metaPath) : '.';

const title = arg('--title') || meta.title;
const descFile = arg('--description-file')
  || (meta.descriptionFile ? path.join(metaDir, meta.descriptionFile) : null);
const tags = (arg('--tags') || (meta.tags || []).join(','))
  .split(',').map((t) => t.trim()).filter(Boolean);

if (!file || !title) {
  console.error('usage: youtube.mjs --file <mp4> (--meta <youtube.json> | --title <text>)');
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error('youtube: no such file: ' + file);
  process.exit(2);
}

const CLIENT_ID = process.env.YT_CLIENT_ID;
const CLIENT_SECRET = process.env.YT_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.YT_REFRESH_TOKEN;
if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.log('youtube: YT_* secrets not set — skipping (reel stays unpublished on YouTube).');
  process.exit(0);
}

/**
 * YouTube rejects any description or title containing an ASCII angle bracket,
 * and says only "invalid video description" without naming the character. That
 * cost four days of uploads before it was traced to the model writing its
 * scenario bullets as "->" instead of an arrow.
 *
 * Comparisons like "p99 > 10ms" are legitimate content, so the brackets are
 * swapped for lookalikes that read identically rather than stripped.
 */
function ytSafe(s) {
  return String(s || '')
    .replace(/->/g, '\u2192').replace(/<-/g, '\u2190')
    .replace(/<=/g, '\u2264').replace(/>=/g, '\u2265')
    .replace(/</g, '\uFF1C').replace(/>/g, '\uFF1E');
}

/** YouTube truncates silently; better to trim deliberately and say so. */
function fit(s, max, what) {
  const t = String(s || '').trim();
  if (t.length <= max) return t;
  console.log(`youtube: ${what} trimmed from ${t.length} to ${max} chars`);
  return t.slice(0, max - 1).trimEnd() + '…';
}

const description = descFile && fs.existsSync(descFile)
  ? ytSafe(fit(fs.readFileSync(descFile, 'utf8'), 4900, 'description'))
  : '';

async function accessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const j = await r.json();
  if (!j.access_token) {
    throw new Error('token refresh failed: ' + JSON.stringify(j));
  }
  return j.access_token;
}

const body = {
  snippet: {
    title: ytSafe(fit(title, 100, 'title')),
    description,
    // total tag length is capped at 500 characters, not by count
    tags: tags.reduce((acc, t) => (acc.join('').length + t.length < 480 ? [...acc, t] : acc), []),
    categoryId: '25',                       // News & Politics
  },
  status: scheduleAt
    ? { privacyStatus: 'private', publishAt: scheduleAt, selfDeclaredMadeForKids: false }
    : { privacyStatus: privacy, selfDeclaredMadeForKids: false },
};

if (has('--dry-run')) {
  console.log('youtube dry run:', JSON.stringify({ file, ...body }, null, 2));
  process.exit(0);
}

const bytes = fs.statSync(file).size;
const token = await accessToken();

// 1. open a resumable session
const init = await fetch(
  'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
  {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'X-Upload-Content-Length': String(bytes),
      'X-Upload-Content-Type': 'video/mp4',
    },
    body: JSON.stringify(body),
  },
);
if (!init.ok) {
  throw new Error(`resumable init failed ${init.status}: ${await init.text()}`);
}
const session = init.headers.get('location');
if (!session) throw new Error('resumable init returned no upload URL');

// 2. send the bytes. One shot: a two minute reel is ~10MB, well inside the
// single-request limit, and chunking would only add failure modes.
console.log(`uploading ${(bytes / 1e6).toFixed(1)} MB as "${body.snippet.title}"`);
const put = await fetch(session, {
  method: 'PUT',
  headers: { 'content-type': 'video/mp4', 'content-length': String(bytes) },
  body: fs.readFileSync(file),
});
const res = await put.json();
if (!put.ok || !res.id) {
  throw new Error(`upload failed ${put.status}: ${JSON.stringify(res)}`);
}

console.log('youtube video id:', res.id);
if (scheduleAt) console.log('scheduled to go public at', scheduleAt);
if (idFile) fs.writeFileSync(idFile, res.id);
console.log('https://www.youtube.com/shorts/' + res.id);
