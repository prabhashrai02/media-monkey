# FINALYST reels: spec

Automated short Instagram Reels for @finalyst.ai. Independent of the FINALYST
carousel pipeline: separate repo, separate history, no shared code.

## Flow (factory/)

1. `topics.mjs`: Gemini with google_search searches current financial news with
   no predefined category, keyword list, rotation or backlog. Candidates must be
   under 24 hours old (last 6 hours scored higher), carry at least one sourced
   fact, and not match a story already in the history. Highest composite of
   reach, significance, explainability, hook and evidence wins.
2. `script.mjs`: writes a 3 to 5 beat script from the research brief (hook, what
   happened, why it matters, impact, what to watch, CTA), 19 to 36 spoken
   seconds with a per-reel target of 22 to 33. A grounded fact check flags
   wrong prices, percentages, dates, quotes and unsupported causes; flagged
   beats are rewritten. Handle is forced to `@finalyst.ai`; hashtags are
   story-derived, max 5; caption ends with "Not investment advice."
3. `tts.mjs` (Kokoro) then `explainer/scenes.mjs` (storyboard using chart, stat,
   compare, flow, list, stack, card) then `explainer/render.mjs` and `assemble.mjs`
   (ffmpeg). Output is 1080x1920 at 30 fps.
4. `.github/workflows/reel.yml`: render, optional YouTube, stage on the `reels`
   branch, prepare the Instagram container, wait for the slot, publish with
   `publish.mjs`, record the media id in `state/history.json`.

## Rules

- Never invent prices, percentages, dates, quotes, market reactions or causes.
- No buy or sell calls, no guaranteed returns, no personal advice.
- Canonical handle: `@finalyst.ai` only.

## Configuration

- Secrets: `GEMINI_API_KEY`, `IG_ACCESS_TOKEN`, `IG_USER_ID` (never committed).
- Optional repository variable `IG_API_VERSION` (default `v23.0`).
- `factory/topics.json` is no longer read.

## Commands

- `npm test`: scene renderer self-test.
- `npm run topics`: print the ranked stories without rendering.
- `node factory/make.mjs --auto --dry`: research and write the script only.
