#!/usr/bin/env node
// The orchestrator. story -> script -> tts -> assemble -> out/<date>/<slug>/.
//
//   node factory/make.mjs --auto                 # research the strongest story right now
//   node factory/make.mjs "story to cover"        # a story you name; sourced facts are researched
//   node factory/make.mjs --auto --batch 3       # three different stories
//   node factory/make.mjs --auto --dry           # script only, no render
//
// Flags: --auto --batch N --lang en|hi|mix --voice <kokoro id> --no-live
//        --dry (script only, no render)
//        --fresh / --no-fresh (record a brand new seeded physics background for
//        this reel, instead of drawing from the pool; default "auto" = fresh
//        whenever the capture still fits the per-reel time budget)
//        --bg <name-or-tier> force the background:
//          --bg physics | harvested | publicDomain   a whole tier
//          --bg rings | plinko                       a generator page (fresh
//                                                    seed, or that page's
//                                                    pool files if it cannot)
//          --bg rings-s2 | nasa-GSFC...              one specific file

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeScript, segmentsOf, slugify } from './script.mjs';
import { synthSegments } from './tts.mjs';
import { assemble } from './assemble.mjs';
import { supplyTopics, appendHistory, nextTopic, readHistory, briefFor } from './topics.mjs';
import { writeScenes, loadArt } from './explainer/scenes.mjs';
import { renderExplainer } from './explainer/render.mjs';
import { probeSummary, firstFrameInk } from './ffmpeg.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));

function parseArgs(argv) {
  const a = {
    topics: [], batch: 1, auto: false, lang: CONFIG.lang,
    voice: null, live: true, dry: false, fresh: null, bg: null,
    theme: (CONFIG.explainer && CONFIG.explainer.theme) || '',
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--auto') a.auto = true;
    else if (v === '--fresh') a.fresh = 'always';
    else if (v === '--no-fresh') a.fresh = 'never';
    else if (v === '--bg') a.bg = argv[++i];
    else if (v === '--format') a.format = argv[++i];
    else if (v === '--batch') a.batch = Math.max(1, Number(argv[++i]) || 1);
    else if (v === '--lang') a.lang = argv[++i];
    else if (v === '--voice') a.voice = argv[++i];
    else if (v === '--no-live') a.live = false;
    else if (v === '--dry') a.dry = true;
    else if (v === '--theme') a.theme = argv[++i] || '';  // diorama | paper ("" = the flat look)
    else if (!v.startsWith('--')) a.topics.push(v);
  }
  if (!a.topics.length) a.auto = true;
  return a;
}

const log = (s) => console.log(s);

// --- background selection -------------------------------------------------
// config.background.tiers is the house mix (physics .5 / harvested .35 /
// publicDomain .15). The roll happens HERE, not inside assemble, because the
// physics tier has two ways to satisfy itself: record a brand new seed for this
// reel (preferred: no two posts ever share a background) or draw from the pool.
// Fresh capture is frame-stepped, so it costs real wall clock and is only taken
// when the whole reel still lands inside background.freshBudgetSeconds.

/**
 * The channel is 100% explainer: every reel draws the mechanism it is talking
 * about. The old brainrot path (physics loop + karaoke over it) is gone, so
 * --format brainrot will fail on a missing background, which is intentional.
 */
function resolveFormat(explicit) {
  return explicit || CONFIG.format || 'explainer';
}

async function makeOne(topicEntry, args, index, count) {
  const topic = topicEntry.topic;
  const t0 = Date.now();
  log(`\n[${index + 1}/${count}] ${topic}   (source: ${topicEntry.source || 'cli'})`);

  // One voice, two visual treatments: the persona and the topic depth are the
  // same either way, so the format is just how this mechanism is best shown.
  const format = resolveFormat(args.format);
  log(`  format: ${format}, theme: ${args.theme || 'paper'}`);

  // A story named by hand has no research behind it yet; gather sourced facts
  // so the writer is never left to recall figures from memory.
  let brief = topicEntry.brief || null;
  if (!brief && args.live) {
    try { brief = await briefFor(topic); } catch (e) { log(`  research brief unavailable: ${e.message.slice(0, 100)}`); }
  }
  const script = await writeScript(topic, { lang: args.lang, log, brief });
  const segments0 = segmentsOf(script);
  if (args.dry) {
    log(JSON.stringify(script, null, 2));
    return { script, dry: true };
  }

  // local date, not UTC: the owner posts by their calendar day
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  let slug = script.slug || slugify(topic);
  let outDir = path.join(ROOT, 'out', date, slug);
  let n = 2;
  while (fs.existsSync(path.join(outDir, 'reel.mp4'))) {
    outDir = path.join(ROOT, 'out', date, `${slug}-${n++}`);
  }
  slug = path.basename(outDir);

  const segments = await synthSegments(segments0, path.join(outDir, 'segments'), {
    voice: args.voice || CONFIG.voice,
    log,
  });

  let bg;
  let artSlug = null;
  {
    // The scene IS the content here, so it replaces the background entirely and
    // is timed to the narration rather than looped under it.
    const board = await writeScenes(topic, script, {
      // the real narration length of each beat decides how many scenes it gets
      beatDurations: segments.filter((s) => s.kind === 'beat').map((s) => s.duration),
      episode: 'FINALYST',
      handle: CONFIG.handle || '',
      theme: args.theme === 'diorama' ? 'diorama' : '',
      // the house art library, minus the pictures the last ten reels already used
      art: loadArt(),
      recentArt: readHistory().slice(-10).map((h) => h.art).filter(Boolean),
      log,
    });
    artSlug = board.artSlug || null;
    bg = await renderExplainer({
      board,
      segments,
      outFile: path.join(outDir, 'scene.mp4'),
      log,
    });
    fs.writeFileSync(path.join(outDir, 'scenes.json'), JSON.stringify(board, null, 2));
    fs.writeFileSync(path.join(outDir, 'script.json'), JSON.stringify(script, null, 2));
  }

  const isExplainer = format === 'explainer';
  const res = await assemble({
    script,
    segments,
    outDir,
    bg,
    // the light scene needs dark words in a bar, not white words with a black rim
    subtitle: isExplainer ? CONFIG.explainerSubtitle : undefined,
    grade: isExplainer ? false : undefined,
    log,
  });

  const probe = probeSummary(res.video);
  const v = probe.streams.find((s) => s.codec_type === 'video');
  const a = probe.streams.find((s) => s.codec_type === 'audio');
  if (!v || !a) throw new Error('rendered reel is missing a video or audio stream');
  // The profile grid cover comes from the opening frame, so a reel that starts
  // on a blank page is a dead thumbnail no matter how good the rest is.
  // the grid cover is the frame the publisher names (coverMs), so that is the
  // frame that must not be blank
  const coverAt = (bg.coverMs || 0) / 1000;
  const ink = firstFrameInk(res.video, coverAt);
  if (ink < 0.005) {
    log(`  WARNING: cover frame at ${coverAt.toFixed(2)}s is blank (${(ink * 100).toFixed(2)}% ink). ` +
        'The grid thumbnail will be empty.');
  } else {
    log(`  cover frame ${coverAt.toFixed(2)}s, ${(ink * 100).toFixed(1)}% ink`);
  }

  if (v.width !== CONFIG.video.width || v.height !== CONFIG.video.height) {
    throw new Error(`rendered reel is ${v.width}x${v.height}, expected 1080x1920`);
  }

  appendHistory({
    slug, topic, hook: script.hook, source: topicEntry.source || 'cli',
    sources: brief ? [...new Set(brief.facts.map((f) => f.source))].slice(0, 6) : [],
    targetSeconds: script.targetSeconds || null,
    seconds: +Number(probe.format.duration).toFixed(1), lang: args.lang,
    ...(artSlug ? { art: artSlug } : {}),
  });

  const secs = (Date.now() - t0) / 1000;
  log(`  OK ${path.relative(ROOT, res.video)}`);
  log(`     ${v.codec_name} ${v.width}x${v.height} @${v.r_frame_rate} ${v.pix_fmt} + ${a.codec_name} ${a.sample_rate}Hz x${a.channels}, ${Number(probe.format.duration).toFixed(2)}s, ${(Number(probe.format.size) / 1e6).toFixed(1)} MB`);
  log(`     rendered in ${secs.toFixed(1)}s (${(secs / 60).toFixed(2)} min)`);
  return { script, ...res, probe, seconds: secs, outDir };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();

  let entries;
  if (args.auto) {
    // one search ranks distinct stories, so a batch never repeats a story
    entries = args.batch === 1 ? [await nextTopic({ log })] : (await supplyTopics(args.batch, { log })).topics;
  } else {
    // explicit topics first; a larger --batch is topped up from the supply
    entries = args.topics.slice(0, args.batch).map((t) => ({ topic: t, source: 'cli' }));
    if (entries.length < args.batch) {
      const { topics } = await supplyTopics(args.batch - entries.length, { log });
      entries.push(...topics);
    }
  }
  if (!entries.length) throw new Error('no topics to render');

  const done = [];
  const failed = [];
  for (let i = 0; i < entries.length; i++) {
    try {
      done.push(await makeOne(entries[i], args, i, entries.length));
    } catch (e) {
      failed.push({ topic: entries[i].topic, error: e.message });
      log(`  FAILED: ${e.message}`);
    }
  }

  const total = (Date.now() - started) / 1000;
  log(`\n${done.length}/${entries.length} reels in ${(total / 60).toFixed(2)} min` +
      (done.length ? ` (${(total / 60 / done.length).toFixed(2)} min each)` : ''));
  for (const d of done) if (!d.dry) log(`  ${path.relative(ROOT, d.video)}`);
  for (const f of failed) log(`  failed: ${f.topic} :: ${f.error}`);
  if (!done.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`\nfatal: ${e.message}`);
  process.exitCode = 1;
});
