/*
 * publish.mjs — Instagram Reels publisher via the OFFICIAL Graph API.
 *
 * Free and sanctioned: business/creator accounts publish reels through
 * graph.facebook.com content publishing. No passwords, no private API.
 *
 *   node factory/publish.mjs --video-url <public mp4 url> --caption-file <path>
 *                             [--thumb-offset <ms>]
 *
 * Env: IG_USER_ID (the Instagram professional account id),
 *      IG_ACCESS_TOKEN (Instagram Login token with instagram_content_publish),
 *      IG_API_VERSION (optional, default v23.0).
 * Exits 0 with a notice when secrets are absent, so CI can run without them.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : null;
};

let IG_USER_ID = process.env.IG_USER_ID;
const TOKEN = process.env.IG_ACCESS_TOKEN;
const videoUrl = arg('--video-url');
const captionFile = arg('--caption-file');
// Instagram picks the grid cover itself if we do not name a frame, and its
// default has landed on frame 0, which was blank. Naming one is the reliable
// fix; the scene also draws its title card fully at t=0 as a second defence.
const thumbOffset = arg('--thumb-offset') || '1200';

if (!videoUrl) {
  console.error('usage: publish.mjs --video-url <url> [--caption-file <path>]');
  process.exit(2);
}
if (!TOKEN) {
  console.log('publish: IG_ACCESS_TOKEN not set — skipping (reel stays unpublished).');
  process.exit(0);
}

const caption = captionFile ? readFileSync(captionFile, 'utf8').trim().slice(0, 2190) : '';

// Two API flavors: tokens from "API setup with Instagram login" (IGAA...) talk to
// graph.instagram.com and can self-resolve their user id; classic Facebook-login
// page tokens talk to graph.facebook.com and need IG_USER_ID.
const IG_LOGIN = TOKEN.startsWith('IG') || process.env.IG_API === 'instagram';
const API_VERSION = process.env.IG_API_VERSION || 'v23.0';
const G = IG_LOGIN ? `https://graph.instagram.com/${API_VERSION}` : `https://graph.facebook.com/${API_VERSION}`;

async function gpost(path, params) {
  const body = new URLSearchParams({ ...params, access_token: TOKEN });
  const r = await fetch(`${G}/${path}`, { method: 'POST', body });
  const j = await r.json();
  if (j.error) throw new Error(path + ': ' + JSON.stringify(j.error));
  return j;
}

async function gget(path, params) {
  const q = new URLSearchParams({ ...params, access_token: TOKEN });
  const r = await fetch(`${G}/${path}?${q}`);
  const j = await r.json();
  if (j.error) throw new Error(path + ': ' + JSON.stringify(j.error));
  return j;
}

if (!IG_USER_ID) {
  const me = await gget('me', { fields: 'user_id,username,id' });
  IG_USER_ID = me.user_id || me.id;
  console.log('resolved account:', me.username || '?', IG_USER_ID);
}

/*
 * Three modes, so the post can go out exactly on its slot even though GitHub's
 * scheduler starts runs three to five hours late:
 *   --prepare --out f     create the container and wait for Meta's transcode,
 *                         write the container id to f, do NOT publish
 *   --container id        publish a prepared container (falls back to a fresh
 *                         create if it expired or errored)
 *   (neither)             create and publish in one go, the old behaviour
 * --publish-at <iso> waits until that moment before the publish call.
 * --id-file f writes the published media id to f, for the state record.
 */
const prepareOnly = args.includes('--prepare');
const outFile = arg('--out');
const prepared = arg('--container');
const publishAt = arg('--publish-at');
const idFile = arg('--id-file');

async function containerStatus(id) {
  try { return (await gget(id, { fields: 'status_code,status' })).status_code; } catch { return 'MISSING'; }
}

// Meta's transcode occasionally fails on a perfectly valid file (verified: the
// same URL that returned ERROR transcoded to FINISHED minutes later). So the
// whole create-and-poll cycle is retried before the run is called a failure.
const ATTEMPTS = 3;
let containerId = null;

if (prepared) {
  const st = await containerStatus(prepared);
  console.log(`prepared container ${prepared}: ${st}`);
  if (st === 'FINISHED') containerId = prepared;
  else console.log('  not usable, creating a fresh one');
}

for (let attempt = 1; attempt <= ATTEMPTS && !containerId; attempt++) {
  // 1. create the media container
  const container = await gpost(`${IG_USER_ID}/media`, {
    media_type: 'REELS',
    video_url: videoUrl,
    caption,
    share_to_feed: 'true',
    thumb_offset: thumbOffset,
  });
  console.log(`container (attempt ${attempt}/${ATTEMPTS}):`, container.id);

  // 2. poll until Meta finishes fetching/transcoding (up to ~5 min)
  let status = '';
  let detail = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const s = await gget(container.id, { fields: 'status_code,status' });
    status = s.status_code;
    if (status === 'FINISHED') break;
    if (status === 'ERROR' || status === 'EXPIRED') {
      detail = s;
      break;
    }
    if (i % 6 === 0) console.log('  status:', status);
  }

  if (status === 'FINISHED') {
    containerId = container.id;
    break;
  }

  const why = detail ? JSON.stringify(detail) : 'never finished (last: ' + status + ')';
  if (attempt === ATTEMPTS) throw new Error('container failed after ' + ATTEMPTS + ' attempts: ' + why);
  const backoff = 30 * attempt;
  console.log(`  transcode ${status}, retrying in ${backoff}s: ${why}`);
  await new Promise((r) => setTimeout(r, backoff * 1000));
}

if (prepareOnly) {
  if (outFile) writeFileSync(outFile, containerId);
  console.log('prepared container id:', containerId, '(not published)');
  process.exit(0);
}

// 3. wait for the slot, then publish
if (publishAt) {
  const ms = new Date(publishAt).getTime() - Date.now();
  if (ms > 0) {
    console.log(`waiting ${(ms / 60000).toFixed(1)} min for the ${publishAt} slot`);
    // sleep in chunks so the log shows the job is alive
    for (let left = ms; left > 0; left -= 600000) {
      await new Promise((r) => setTimeout(r, Math.min(left, 600000)));
      if (left > 600000) console.log(`  ${((left - 600000) / 60000).toFixed(0)} min to go`);
    }
  } else {
    console.log(`slot ${publishAt} already passed by ${(-ms / 60000).toFixed(1)} min, publishing now`);
  }
  // a prepared container can expire during a long wait; check once more
  if ((await containerStatus(containerId)) !== 'FINISHED') {
    throw new Error('container is no longer FINISHED after the wait; rerun without --container');
  }
}
const pub = await gpost(`${IG_USER_ID}/media_publish`, { creation_id: containerId });
console.log('published media id:', pub.id);
if (idFile) writeFileSync(idFile, pub.id);
