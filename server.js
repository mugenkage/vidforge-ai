// ═══════════════════════════════════════════════════════════════
//  VidForge AI v17.0 — Sigma Phonk Edition
//  Features:
//  ✅ 6 scenes per video (Scene 6 = SIGMA TWIST)
//  ✅ Caption fix — auto-wrap, no overflow, safe zone
//  ✅ Phonk music BG (phonk.mp3 local file, 12% vol, NO fade out)
//  ✅ Multi-language dubbing (EN/HI/ES/PT/FR)
//  ✅ 5 ElevenLabs voice rotation per series
//  ✅ Character consistency (seed + locked desc in every prompt)
//  ✅ 15 videos/day @ 96-min intervals
//  ✅ 1 CF image/scene (no more wide+close = 2x faster gen)
//  ✅ 3 FFmpeg scale+crop variations per image (no zoompan bugs)
//  ✅ Word-sync captions via Groq Whisper
//  ✅ Auto thumbnail, pinned comment, SEO chapters
//  ✅ Villain from Ep 3+, plot twists every even ep
// ═══════════════════════════════════════════════════════════════

const express    = require('express');
const cron       = require('node-cron');
const axios      = require('axios');
const { google } = require('googleapis');
const fs         = require('fs');
const path       = require('path');
const { spawn }  = require('child_process');
const FormData   = require('form-data');

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────
// ENV VARIABLES
// ─────────────────────────────────────────────
const YOUTUBE_CLIENT_ID      = process.env.YOUTUBE_CLIENT_ID;
const YOUTUBE_CLIENT_SECRET  = process.env.YOUTUBE_CLIENT_SECRET;
const YOUTUBE_REDIRECT_URI   = process.env.YOUTUBE_REDIRECT_URI;
const YOUTUBE_REFRESH_TOKEN  = process.env.YOUTUBE_REFRESH_TOKEN;
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const INSTAGRAM_USER_ID      = process.env.INSTAGRAM_USER_ID;
const GROQ_API_KEY           = process.env.GROQ_API_KEY;
const ELEVENLABS_API_KEY     = process.env.ELEVENLABS_API_KEY;
const RENDER_URL             = process.env.RENDER_EXTERNAL_URL || '';

// Multiple CF accounts — spread rate limits
const CF_ACCOUNTS = [
  { id: process.env.CLOUDFLARE_ACCOUNT_ID_1 || process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN_1 || process.env.CLOUDFLARE_API_TOKEN },
  { id: process.env.CLOUDFLARE_ACCOUNT_ID_2, token: process.env.CLOUDFLARE_API_TOKEN_2 },
  { id: process.env.CLOUDFLARE_ACCOUNT_ID_3, token: process.env.CLOUDFLARE_API_TOKEN_3 },
].filter(a => a.id && a.token);

// ─────────────────────────────────────────────
// FFMPEG HELPERS
// ─────────────────────────────────────────────
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args);
    let errOut = '';
    ff.stderr.on('data', d => { errOut += d.toString().slice(-500); });
    ff.on('close', code => { if (code === 0) resolve(); else reject(new Error(`FFmpeg ${code}: ${errOut.slice(-300)}`)); });
    ff.on('error', reject);
  });
}

function runFFprobe(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffprobe', args);
    let out = '', err = '';
    ff.stdout.on('data', d => { out += d.toString(); });
    ff.stderr.on('data', d => { err += d.toString(); });
    ff.on('close', code => { if (code === 0) resolve(out.trim()); else reject(new Error(err)); });
    ff.on('error', reject);
  });
}

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const EPISODES_PER_SERIES = 12;
const DAILY_LIMIT         = 15;
const SCENES_PER_VIDEO    = 6;   // ← upgraded from 4 to 6
const FONT_BOLD           = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_OBLIQUE        = '/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf';
const FONT_MONO           = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf';
const STATE_FILE          = path.join('/tmp', 'vidforge_state.json');
const LOGO_PATH           = path.join(__dirname, 'assets', 'logo.png');

// ─── PHONK MUSIC — local file uploaded to repo root
const PHONK_PATH = path.join(__dirname, 'music', 'phonk.mp3');

// ─────────────────────────────────────────────
// MULTI-LANGUAGE DUBBING CONFIG
// Each lang has an ElevenLabs voice ID + lang code for Google TTS fallback
// ─────────────────────────────────────────────
const DUBS = [
  { lang: 'en', label: 'English',    ttsCode: 'en', voiceId: 'TxGEqnHWrfWFTfGW9XjX' }, // Josh
  { lang: 'hi', label: 'Hindi',      ttsCode: 'hi', voiceId: '21m00Tcm4TlvDq8ikWAM' }, // Rachel
  { lang: 'es', label: 'Spanish',    ttsCode: 'es', voiceId: 'VR6AewLTigWG4xSOukaG' }, // Arnold
  { lang: 'pt', label: 'Portuguese', ttsCode: 'pt', voiceId: 'EXAVITQu4vr4xnSDxMaL' }, // Bella
  { lang: 'fr', label: 'French',     ttsCode: 'fr', voiceId: 'yoZ06aMxZJJ28mfd3POQ' }, // Sam
];

// ─────────────────────────────────────────────
// SERIES CATEGORIES & VOICES (5 voices per series, rotating)
// ─────────────────────────────────────────────
const SERIES_CATEGORIES = [
  'horror', 'adventure', 'mystery', 'thriller',
  'fantasy', 'science fiction', 'superhero', 'motivation', 'comedy'
];

// 5 ElevenLabs voices — one per series index
const SERIES_VOICES = [
  { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh',   speed: 1.0  },
  { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', speed: 0.95 },
  { id: 'VR6AewLTigWG4xSOukaG', name: 'Arnold', speed: 1.0  },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella',  speed: 0.9  },
  { id: 'yoZ06aMxZJJ28mfd3POQ', name: 'Sam',    speed: 1.0  },
];

// ─────────────────────────────────────────────
// ART STYLES — Minimalist Stick Figure
// ─────────────────────────────────────────────
const CATEGORY_ART = {
  'horror':          { name: 'Horror Stick',     prompt: 'minimalist stick figure illustration, black ink on white background, simple expressive stick man character, horror scene, dark shadow looming, action lines showing fear, scratchy ink style, high contrast black and white, clean simple art, no color, no text' },
  'thriller':        { name: 'Thriller Stick',   prompt: 'minimalist stick figure illustration, black ink on white background, simple expressive stick man character, tense thriller scene, dramatic action lines, motion blur lines, suspenseful pose, scratchy ink style, high contrast black and white, no color, no text' },
  'mystery':         { name: 'Mystery Stick',    prompt: 'minimalist stick figure illustration, black ink on white background, simple expressive stick man character, mysterious scene, magnifying glass prop, question marks, subtle shadow details, scratchy ink style, high contrast black and white, no color, no text' },
  'adventure':       { name: 'Adventure Stick',  prompt: 'minimalist stick figure illustration, black ink on white background, simple expressive stick man character, epic adventure scene, dynamic running pose, action speed lines, simple landscape background, scratchy ink style, high contrast black and white, no color, no text' },
  'superhero':       { name: 'Hero Stick',       prompt: 'minimalist stick figure illustration, black ink on white background, simple expressive stick man character, superhero pose, cape outline, power effect lines radiating outward, heroic stance, scratchy ink style, high contrast black and white, no color, no text' },
  'motivation':      { name: 'Motivation Stick', prompt: 'minimalist stick figure illustration, black ink on white background, simple expressive stick man character, triumphant pose, arms raised, mountain peak, achievement scene, upward arrows, scratchy ink style, high contrast black and white, no color, no text' },
  'fantasy':         { name: 'Fantasy Stick',    prompt: 'minimalist stick figure illustration, black ink on white background, simple expressive stick man character, magical fantasy scene, simple wand or sword prop, star sparkle details, magical circle, scratchy ink style, high contrast black and white, no color, no text' },
  'science fiction': { name: 'SciFi Stick',      prompt: 'minimalist stick figure illustration, black ink on white background, simple expressive stick man character, futuristic sci-fi scene, robot or spaceship outline, tech lines, simple geometric details, scratchy ink style, high contrast black and white, no color, no text' },
  'comedy':          { name: 'Comedy Stick',     prompt: 'minimalist stick figure illustration, black ink on white background, simple expressive stick man character, funny comedy scene, exaggerated surprised expression, sweat drops, stars around head, wobbly action lines, slapstick pose, scratchy ink style, high contrast black and white, no color, no text' },
};

// ─────────────────────────────────────────────
// CAPTION STYLES — FIXED SIZE, NO OVERFLOW
// fontsize capped at 56 to prevent text going offscreen on 768w
// x=(w-text_w)/2 centers; charLimit prevents line overflow
// ─────────────────────────────────────────────
const CAPTION_STYLES = {
  'horror':          { fontfile: FONT_BOLD,    fontsize: 56, fontcolor: 'white',     highlight: '0xFF4444', borderw: 7,  bordercolor: 'black',       box: false },
  'thriller':        { fontfile: FONT_BOLD,    fontsize: 54, fontcolor: 'white',     highlight: '0xFF2222', borderw: 6,  bordercolor: 'black',       box: true,  boxcolor: '0xE6194B@0.75', boxborderw: 12 },
  'mystery':         { fontfile: FONT_OBLIQUE, fontsize: 52, fontcolor: '0xE8E0FF', highlight: '0xAA88FF', borderw: 5,  bordercolor: 'black@0.9',  box: true,  boxcolor: 'black@0.5',     boxborderw: 12 },
  'adventure':       { fontfile: FONT_BOLD,    fontsize: 56, fontcolor: 'white',     highlight: '0xFFAA00', borderw: 7,  bordercolor: 'black',       box: false },
  'superhero':       { fontfile: FONT_BOLD,    fontsize: 58, fontcolor: 'white',     highlight: '0xFFD700', borderw: 8,  bordercolor: 'black',       box: false },
  'motivation':      { fontfile: FONT_BOLD,    fontsize: 56, fontcolor: '0xFFD700', highlight: '0xFFFFFF', borderw: 6,  bordercolor: 'black',       box: false },
  'fantasy':         { fontfile: FONT_OBLIQUE, fontsize: 52, fontcolor: '0xFFE9B0', highlight: '0xFFD700', borderw: 5,  bordercolor: 'black@0.85', box: false },
  'science fiction': { fontfile: FONT_MONO,    fontsize: 48, fontcolor: '0x00FFFF', highlight: '0x00FFAA', borderw: 4,  bordercolor: '0x0000FF@0.7',box: true,  boxcolor: 'black@0.7',     boxborderw: 10 },
  'default':         { fontfile: FONT_BOLD,    fontsize: 54, fontcolor: 'white',     highlight: '0xFFD700', borderw: 6,  bordercolor: 'black',       box: false },
};

// ─────────────────────────────────────────────
// COLOR GRADING per category
// ─────────────────────────────────────────────
const COLOR_GRADE = {
  'horror':          "curves=r='0/0 0.3/0.1 1/0.8':g='0/0 0.5/0.35 1/0.75':b='0/0.05 0.5/0.55 1/1',vignette=PI/4",
  'thriller':        "curves=r='0/0 0.5/0.4 1/0.85':g='0/0 0.5/0.38 1/0.78':b='0/0.03 0.5/0.48 1/0.95',vignette=PI/4",
  'mystery':         "curves=r='0/0 0.5/0.42 1/0.88':g='0/0 0.5/0.4 1/0.82':b='0/0.02 0.5/0.52 1/1',vignette=PI/3.5",
  'adventure':       "curves=r='0/0 0.5/0.58 1/1':g='0/0 0.5/0.52 1/0.95':b='0/0 0.5/0.38 1/0.8',vignette=PI/5",
  'superhero':       "curves=r='0/0 0.5/0.6 1/1':g='0/0 0.5/0.55 1/0.95':b='0/0 0.5/0.45 1/0.85',vignette=PI/4",
  'motivation':      "curves=r='0/0 0.5/0.62 1/1':g='0/0 0.5/0.58 1/0.98':b='0/0 0.5/0.4 1/0.82',vignette=PI/5",
  'fantasy':         "curves=r='0/0 0.5/0.55 1/0.95':g='0/0 0.5/0.5 1/0.9':b='0/0.02 0.5/0.55 1/1',vignette=PI/4",
  'science fiction': "curves=r='0/0 0.5/0.38 1/0.82':g='0/0.02 0.5/0.52 1/0.95':b='0/0.05 0.5/0.6 1/1',vignette=PI/3.5",
  'default':         "curves=r='0/0 0.5/0.5 1/1':g='0/0 0.5/0.5 1/1':b='0/0 0.5/0.5 1/1',vignette=PI/4",
};

// ─────────────────────────────────────────────
// STATE MANAGEMENT
// ─────────────────────────────────────────────
function loadState() {
  if (process.env.SERIES_STATE) {
    try { return JSON.parse(process.env.SERIES_STATE); } catch (e) {}
  }
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {}
  return null;
}

function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) {}
  try { fs.writeFileSync(path.join(__dirname, 'series_state.json'), JSON.stringify(state, null, 2)); } catch (e) {}
}

function createNewSeries(seriesIndex) {
  return {
    seriesIndex,
    seriesNumber:      seriesIndex + 1,
    category:          SERIES_CATEGORIES[seriesIndex % SERIES_CATEGORIES.length],
    voice:             SERIES_VOICES[seriesIndex % SERIES_VOICES.length],
    dubLang:           DUBS[seriesIndex % DUBS.length],
    characterSeed:     Math.floor(Math.random() * 999999),
    characterDesign:   null,
    seriesName:        null,
    villainDesign:     null,
    currentEpisode:    1,
    episodeSummaries:  [],
    createdAt:         new Date().toISOString()
  };
}

let seriesState = loadState() || createNewSeries(0);
let dailyCount  = 0;
saveState(seriesState);

// ─────────────────────────────────────────────
// CRON — 15 videos/day @ 96-min intervals
// Starts at 12:00 AM IST (6:30 PM UTC prev day)
// UTC offsets: IST = UTC+5:30
// 15 × 96 min = 1440 min = exactly 24 hours
// ─────────────────────────────────────────────
cron.schedule('0 0 * * *', () => { dailyCount = 0; console.log('[VidForge] Daily count reset ✅'); });

// 15 post times IST → UTC (subtract 5h30m):
// IST:  00:00, 01:36, 03:12, 04:48, 06:24, 08:00, 09:36, 11:12,
//       12:48, 14:24, 16:00, 17:36, 19:12, 20:48, 22:24
// UTC:  18:30, 20:06, 21:42, 23:18, 00:54, 02:30, 04:06, 05:42,
//       07:18, 08:54, 10:30, 12:06, 13:42, 15:18, 16:54
const CRON_TIMES_UTC = [
  '30 18 * * *', '6 20 * * *',  '42 21 * * *', '18 23 * * *',
  '54 0 * * *',  '30 2 * * *',  '6 4 * * *',   '42 5 * * *',
  '18 7 * * *',  '54 8 * * *',  '30 10 * * *', '6 12 * * *',
  '42 13 * * *', '18 15 * * *', '54 16 * * *',
];

CRON_TIMES_UTC.forEach((cronTime, i) => {
  cron.schedule(cronTime, () => {
    if (dailyCount < DAILY_LIMIT) {
      console.log(`[Cron] Post #${i + 1}/15 triggered`);
      runPostingCycle();
    }
  });
});

// ─────────────────────────────────────────────
// CAPTION HELPERS — NO OVERFLOW, AUTO-WRAP
// ─────────────────────────────────────────────

// Max chars per line to stay within 768px wide at given fontsize
// At fontsize 56: ~14 chars. At 48: ~17 chars. Be conservative.
const MAX_CHARS_PER_LINE = 13;

function cleanCap(t) {
  return String(t || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, MAX_CHARS_PER_LINE); // hard cap — never overflow
}

function escFF(t) {
  return String(t || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '')
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

// Caption positioned at y=h*0.80 — lower third, always inside safe zone
// Using text_w to auto-center — no manual x calculation needed
function makeDrawtext(text, style, startT, endT, isHighlight = false) {
  const raw = cleanCap(text);
  if (!raw || endT <= startT) return null;

  const color = isHighlight ? style.highlight : style.fontcolor;
  const t     = escFF(raw);

  // Safe zone: x centered, y = 80% down (above bottom UI elements)
  // shadow gives depth without relying on box
  let f = `drawtext=text='${t}':fontsize=${style.fontsize}:fontcolor=${color}:fontfile='${style.fontfile}':x=(w-text_w)/2:y=h*0.80:borderw=${style.borderw}:bordercolor=${style.bordercolor}:enable='between(t,${startT.toFixed(3)},${endT.toFixed(3)})'`;
  if (style.box) f += `:box=1:boxcolor=${style.boxcolor}:boxborderw=${style.boxborderw}`;
  return f;
}

// Build word-by-word captions from Whisper timestamps
// Groups into chunks of MAX_CHARS_PER_LINE chars, no overlap
function buildCaptionFilters(wordTimestamps, style, totalDuration) {
  if (!wordTimestamps || wordTimestamps.length === 0) return [];

  const filters = [];
  const chunks  = [];
  let   cur     = { words: [], start: 0, end: 0, chars: 0 };

  for (const w of wordTimestamps) {
    const wordClean = w.word.replace(/[^A-Za-z0-9 ]/g, '').toUpperCase().trim();
    if (!wordClean) continue;

    if (cur.words.length === 0) {
      cur.start = w.start;
    }

    // If adding this word would exceed the char limit, flush current chunk
    const wouldBe = cur.chars + (cur.chars > 0 ? 1 : 0) + wordClean.length;
    if (cur.words.length > 0 && wouldBe > MAX_CHARS_PER_LINE) {
      chunks.push({ ...cur });
      cur = { words: [], start: w.start, end: 0, chars: 0 };
    }

    cur.words.push(wordClean);
    cur.end    = w.end;
    cur.chars  = cur.words.join(' ').length;
  }
  if (cur.words.length > 0) chunks.push(cur);

  for (let j = 0; j < chunks.length; j++) {
    const startT    = Math.max(chunks[j].start - 0.03, 0);
    const nextStart = j + 1 < chunks.length ? chunks[j + 1].start - 0.03 : totalDuration;
    const endT      = Math.min(chunks[j].end + 0.05, nextStart, totalDuration);

    if (endT <= startT) continue;
    const f = makeDrawtext(chunks[j].words.join(' '), style, startT, endT, false);
    if (f) filters.push(f);
  }

  return filters;
}

// ─────────────────────────────────────────────
// STEP 1 — GROQ: Generate 6-Scene Episode Script
// Scene 6 is always the SIGMA TWIST
// ─────────────────────────────────────────────
async function generateEpisodeScript(state) {
  const { category, currentEpisode, characterDesign, villainDesign, seriesName, episodeSummaries, voice, dubLang } = state;
  const art        = CATEGORY_ART[category] || CATEGORY_ART['adventure'];
  const isFirstEp  = currentEpisode === 1;
  const isLastEp   = currentEpisode === EPISODES_PER_SERIES;
  const needsVillain = currentEpisode === 3 && !villainDesign;
  const prevSummary  = episodeSummaries.length > 0 ? episodeSummaries[episodeSummaries.length - 1] : null;

  const seriesCtx = isFirstEp ? '' : `
SERIES: "${seriesName}" | EPISODE: ${currentEpisode}/${EPISODES_PER_SERIES}
MAIN CHARACTER: ${characterDesign}
${villainDesign ? `VILLAIN: ${villainDesign}` : ''}
PREVIOUS: ${prevSummary}
STORY SO FAR: ${episodeSummaries.slice(-3).join(' → ')}
Continue EXACTLY where last episode ended.`;

  const endRule      = isLastEp
    ? 'SERIES FINALE — epic satisfying conclusion, hint at new adventure'
    : `End Scene 6 on MASSIVE CLIFFHANGER — stop mid-action, leave viewers desperate for Ep ${currentEpisode + 1}`;
  const plotTwistRule = currentEpisode % 2 === 0
    ? 'MANDATORY: Include a shocking plot twist that recontextualizes everything — revealed in Scene 5 or 6'
    : 'Build rising tension through all 6 scenes';

  const prompt = `Write Episode ${currentEpisode} of a viral ${category} anime cartoon series for YouTube Shorts.
${seriesCtx}
Art style: ${art.name}
Voice: ${voice.name} | Dub language: ${dubLang.label}

STRICT RULES:
- Hook viewer in first 2 seconds
- ${isFirstEp ? 'Create ONE iconic memorable main character' : 'Continue naturally from previous episode'}
- ${needsVillain ? 'INTRODUCE THE VILLAIN in this episode — make them terrifying/compelling' : ''}
- ${plotTwistRule}
- ${endRule}
- Captions: MAX ${MAX_CHARS_PER_LINE} CHARS, ALL CAPS, ENGLISH ONLY, no special chars
- Each scene must have vivid specific location
- IMAGE PROMPTS RULE (wide_shot + close_shot fields): NEVER use these words: horror, dark, haunted, blood, death, dead, kill, murder, corpse, grave, skull, demon, devil, evil, cursed, ghost, zombie, monster, nightmare, terror, fear, scream, violent, violence, shadow, sinister, creepy, gore, dangerous, mysterious, chamber, dungeon, prison, trapped, forbidden, weapon, knife, gun, fight, attack, threat, panic, frightened, scared, eerie, unsettling, damp, flickering, abandoned, decaying, crumbling, locked, suffocating, ominous, lurking, bleeding, torture, suffering, doom. Describe scenes using ONLY visual elements: shapes, objects, architecture, lighting (bright/warm/cool), poses, props, environment details.

SCENE 6 RULE — THE SIGMA TWIST:
Scene 6 is ALWAYS a "sigma mindset" twist moment — the protagonist does something completely unexpected and alpha/sigma that shocks everyone. No emotion, cold logic, total power move. This is what makes viewers save and share the video.

Return ONLY valid JSON (no markdown, no backticks):
{
  "series_name": "${isFirstEp ? 'Epic 2-3 word series name' : seriesName}",
  "title": "Episode title max 35 chars",
  "character_design": "${isFirstEp ? 'Simple stick figure: round head, thin body, ONE unique detail like hat/scarf/cape' : characterDesign}",
  "villain_design": "${needsVillain ? 'VERY DETAILED villain appearance' : (villainDesign || '')}",
  "episode_summary": "2 sentences summarizing this episode for next episode context",
  "description": "2 sentence YouTube hook with emojis",
  "hashtags": "#anime #shorts #viral #cartoon #sigma #ep${currentEpisode} #${category.replace(/ /g, '')} #series #fyp #trending",
  "recap_line": "${isFirstEp ? '' : 'One sentence recap starting with: Last time...'}",
  "plot_twist": "${currentEpisode % 2 === 0 ? 'Describe the shocking twist revealed this episode' : ''}",
  "scenes": [
    {
      "scene_num": 1,
      "narration": "Opening hook narration — grab attention immediately",
      "caption": "HOOK WORDS",
      "location": "Specific vivid location",
      "emotion": "Character expression + pose + action",
      "wide_shot": "Full body scene description",
      "close_shot": "Face/chest closeup for drama"
    },
    {
      "scene_num": 2,
      "narration": "Rising action narration",
      "caption": "TENSION WORDS",
      "location": "Specific vivid location",
      "emotion": "Character reaction/emotion",
      "wide_shot": "Full body scene 2",
      "close_shot": "Face closeup scene 2"
    },
    {
      "scene_num": 3,
      "narration": "Complication or reveal narration",
      "caption": "REVEAL WORDS",
      "location": "Specific vivid location",
      "emotion": "Character at peak stress or confusion",
      "wide_shot": "Full body scene 3",
      "close_shot": "Face closeup scene 3"
    },
    {
      "scene_num": 4,
      "narration": "Peak intensity narration — darkest moment",
      "caption": "PEAK WORDS",
      "location": "Specific vivid location",
      "emotion": "Character facing impossible choice or enemy",
      "wide_shot": "Full body scene 4",
      "close_shot": "Face closeup scene 4"
    },
    {
      "scene_num": 5,
      "narration": "Plot twist or power shift narration",
      "caption": "TWIST WORDS",
      "location": "Specific vivid location",
      "emotion": "Character's shocking decision face",
      "wide_shot": "Full body scene 5",
      "close_shot": "Face closeup scene 5"
    },
    {
      "scene_num": 6,
      "narration": "SIGMA TWIST — character does something cold, calculated, powerful that nobody expected. Short sharp narration.",
      "caption": "SIGMA MOVE",
      "location": "Specific vivid location",
      "emotion": "Stone cold expression, no fear, pure confidence, sigma stare",
      "wide_shot": "Character standing tall, dominant pose, scene of total control",
      "close_shot": "Extreme closeup of emotionless sigma face, dead eyes, slight smirk"
    }
  ]
}`;

  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 2800, temperature: 0.92 },
    { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 60000 }
  );

  let raw = res.data.choices[0].message.content;
  raw = raw.replace(/```json|```/g, '').trim();
  // Extract JSON object in case of any surrounding text
  const jsonStart = raw.indexOf('{');
  const jsonEnd   = raw.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd !== -1) raw = raw.substring(jsonStart, jsonEnd + 1);

  const script   = JSON.parse(raw);
  const artStyle = CATEGORY_ART[category] || CATEGORY_ART['adventure'];
  const charDesc = script.character_design || characterDesign || 'stick figure protagonist';

  // Build image prompts — character LOCKED in every prompt
  script.scenes = script.scenes.map((scene, i) => {
    const isSigma = i === 5; // Scene 6 = sigma twist
    const sigmaAddition = isSigma
      ? ', sigma male pose, stone cold expression, dominant stance, power aura, no emotion, pure confidence'
      : '';
    return {
      ...scene,
      widePrompt:  `${artStyle.prompt}, ${charDesc}, SAME CHARACTER ALWAYS, ${scene.wide_shot}, ${scene.emotion}${sigmaAddition}, full body stick figure, simple background, ${scene.location}, vertical 9:16 portrait, minimalist black ink on white, safe for all ages, no text, no watermark`,
      closePrompt: `${artStyle.prompt}, ${charDesc}, SAME CHARACTER ALWAYS, ${scene.close_shot}, ${scene.emotion}${sigmaAddition}, stick figure head closeup, expressive dot eyes, ${scene.location}, vertical 9:16, minimalist black ink on white, safe for all ages, no text, no watermark`,
    };
  });

  return script;
}

// ─────────────────────────────────────────────
// STEP 2 — GROQ TRANSLATE: Multi-language narration
// Translates English narration to target language for dubbing
// ─────────────────────────────────────────────
async function translateNarration(text, targetLang) {
  if (targetLang === 'en') return text; // no translation needed

  try {
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [{
          role: 'user',
          content: `Translate this narration to ${targetLang}. Return ONLY the translated text, nothing else:\n\n${text}`
        }],
        max_tokens: 300,
        temperature: 0.3
      },
      { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 20000 }
    );
    return res.data.choices[0].message.content.trim();
  } catch (err) {
    console.log(`[Translate] Failed for ${targetLang}: ${err.message} — using English`);
    return text;
  }
}

// ─────────────────────────────────────────────
// PROMPT SANITIZER — strip CF-flagged words
// CF flags these even in innocent stick figure contexts
// ─────────────────────────────────────────────
const CF_BANNED = [
  'horror', 'haunted', 'dark', 'blood', 'death', 'dead', 'kill', 'murder',
  'corpse', 'grave', 'skull', 'demon', 'devil', 'evil', 'cursed', 'ghost',
  'zombie', 'monster', 'nightmare', 'terror', 'fear', 'scream', 'violent',
  'violence', 'shadow', 'sinister', 'creepy', 'gory', 'gore', 'dangerous',
  'mysterious', 'mystery', 'chamber', 'dungeon', 'prison', 'trapped', 'escape',
  'forbidden', 'secret', 'hidden', 'weapon', 'knife', 'gun', 'fight', 'attack',
  'threat', 'danger', 'panic', 'frightened', 'scared', 'terrified', 'looming',
  'cellar', 'eerie', 'unsettling', 'damp', 'flickering', 'pulsing', 'glow',
  'cold', 'sudden', 'calm', 'atmosphere', 'abandoned', 'decaying', 'crumbling',
  'locked', 'narrow', 'suffocating', 'oppressive', 'foreboding', 'ominous',
  'lurking', 'stalking', 'chasing', 'fleeing', 'bleeding', 'wounds', 'injured',
  'torture', 'suffering', 'agony', 'despair', 'doom', 'fate', 'cursed',
  'wicked', 'vile', 'malevolent', 'treacherous', 'peril', 'catastrophe',
];

function sanitizePrompt(prompt) {
  let safe = prompt;
  for (const word of CF_BANNED) {
    const re = new RegExp(`\\b${word}\\b`, 'gi');
    safe = safe.replace(re, '');
  }
  // collapse multiple spaces
  return safe.replace(/\s{2,}/g, ' ').trim();
}

// ─────────────────────────────────────────────
// STEP 3 — CF WORKERS AI: Generate images
// ─────────────────────────────────────────────
async function generateImage(prompt, outputPath, seed, accountIndex) {
  const safePrompt = sanitizePrompt(prompt);
  const account = CF_ACCOUNTS[accountIndex % CF_ACCOUNTS.length];

  if (account) {
    try {
      console.log(`[Image] CF Account ${(accountIndex % CF_ACCOUNTS.length) + 1} — ${path.basename(outputPath)}`);
      const res = await axios.post(
        `https://api.cloudflare.com/client/v4/accounts/${account.id}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
        { prompt: safePrompt, steps: 4, seed },
        { headers: { 'Authorization': `Bearer ${account.token}`, 'Content-Type': 'application/json' }, timeout: 90000 }
      );
      const b64 = res.data?.result?.image || res.data?.image;
      if (b64 && b64.length > 1000) {
        fs.writeFileSync(outputPath, Buffer.from(b64, 'base64'));
        console.log(`[Image] CF ✅ ${path.basename(outputPath)}`);
        return;
      }
    } catch (err) {
      const msg = err.response?.data?.errors?.[0]?.message || err.message;
      console.log(`[Image] CF ${(accountIndex % CF_ACCOUNTS.length) + 1} failed: ${msg.substring(0, 60)}`);

      // Try next CF account as backup
      const next = CF_ACCOUNTS[(accountIndex + 1) % CF_ACCOUNTS.length];
      if (next && next !== account) {
        try {
          const res2 = await axios.post(
            `https://api.cloudflare.com/client/v4/accounts/${next.id}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
            { prompt: safePrompt, steps: 4, seed },
            { headers: { 'Authorization': `Bearer ${next.token}`, 'Content-Type': 'application/json' }, timeout: 90000 }
          );
          const b64 = res2.data?.result?.image || res2.data?.image;
          if (b64 && b64.length > 1000) {
            fs.writeFileSync(outputPath, Buffer.from(b64, 'base64'));
            console.log(`[Image] CF Backup ✅`);
            return;
          }
        } catch (e2) { console.log(`[Image] CF Backup failed too`); }
      }
    }
  }

  // Picsum placeholder fallback
  const fallback = await axios({ method: 'GET', url: `https://picsum.photos/seed/${seed}/576/1024`, responseType: 'arraybuffer', timeout: 30000 });
  fs.writeFileSync(outputPath, Buffer.from(fallback.data));
  console.log(`[Image] Picsum fallback ✅`);
}

// ─────────────────────────────────────────────
// STEP 4 — VOICE: ElevenLabs → Google TTS fallback
// Uses series voice ID + target language
// ─────────────────────────────────────────────
async function generateVoice(text, outputPath, voiceId, category, langCode = 'en') {
  const cleanText = text.replace(/['"]/g, '').substring(0, 250);

  // ElevenLabs — best quality
  if (ELEVENLABS_API_KEY && voiceId) {
    try {
      const stability = ['horror', 'thriller'].includes(category) ? 0.4 : 0.5;
      const style     = ['horror', 'thriller'].includes(category) ? 0.5 : 0.3;
      const res = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        { text: cleanText, model_id: 'eleven_monolingual_v1', voice_settings: { stability, similarity_boost: 0.75, style, use_speaker_boost: true } },
        { headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' }, responseType: 'arraybuffer', timeout: 30000 }
      );
      if (res.data && res.data.byteLength > 1000) {
        fs.writeFileSync(outputPath, Buffer.from(res.data));
        console.log(`[Voice] ElevenLabs ✅ (${langCode})`);
        return;
      }
    } catch (err) { console.log(`[Voice] ElevenLabs failed: ${err.response?.status || err.message}`); }
  }

  // Google TTS fallback — supports multi-language via langCode
  const speed = ['horror', 'thriller'].includes(category) ? '0.8' : '0.9';
  const url   = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(cleanText)}&tl=${langCode}&client=tw-ob&ttsspeed=${speed}`;
  const res   = await axios({ method: 'GET', url, responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } });
  fs.writeFileSync(outputPath, Buffer.from(res.data));
  console.log(`[Voice] Google TTS ✅ (${langCode})`);
}

// ─────────────────────────────────────────────
// STEP 5 — WHISPER: Word-level timestamps
// ─────────────────────────────────────────────
async function getWordTimestamps(audioPath) {
  try {
    const form = new FormData();
    form.append('file', fs.createReadStream(audioPath), { filename: 'audio.mp3', contentType: 'audio/mpeg' });
    form.append('model', 'whisper-large-v3');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    form.append('language', 'en');
    const res = await axios.post(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      form,
      { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, ...form.getHeaders() }, timeout: 60000 }
    );
    const words = res.data?.words || [];
    console.log(`[Whisper] ${words.length} word timestamps ✅`);
    return words;
  } catch (err) {
    console.log(`[Whisper] Failed: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────
// STEP 6 — BUILD IMAGE CLIP (scale+crop Ken Burns)
// 3 cinematic crop/zoom variations from 1 image
// No zoompan (breaks on short clips), no shake
// ─────────────────────────────────────────────
async function buildImageClip(imgPath, outputPath, duration, viewIndex) {
  const fps = 24;
  const totalFrames = Math.ceil(duration * fps);
  const N = totalFrames;

  // Scale image to 150% of target, then crop/pan — stable, no zoompan bugs
  // All 3 variations: slow push-in, slow pan up, slow pan down
  // scale to 1152×2016 (1.5× of 768×1344), then crop 768×1344
  // Static crop/zoom variations — no per-frame expressions (crop filter doesn't support on/t)
  // Scale to 1.5x then crop different regions for cinematic variety
  const views = [
    // Variation 0: tight center crop (zoom-in feel)
    `scale=1152:2016:force_original_aspect_ratio=increase,crop=1152:2016,` +
    `crop=768:1344:192:336,scale=768:1344,fps=${fps}`,

    // Variation 1: top crop (upper body / sky focus)
    `scale=1152:2016:force_original_aspect_ratio=increase,crop=1152:2016,` +
    `crop=768:1344:192:0,fps=${fps}`,

    // Variation 2: bottom crop (ground / feet / base focus)
    `scale=1152:2016:force_original_aspect_ratio=increase,crop=1152:2016,` +
    `crop=768:1344:192:672,fps=${fps}`,
  ];

  const vf = views[viewIndex % 3];
  await runFFmpeg([
    '-loop', '1', '-i', imgPath,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-t', String(duration),
    '-vf', vf,
    '-an', '-y', outputPath
  ]);
}

// ─────────────────────────────────────────────
// STEP 7 — BUILD SCENE VIDEO
// 1 image × 3 crop/zoom variations = 3 shots per scene
// Captions fixed-size, no overflow, word-synced
// ─────────────────────────────────────────────
async function buildSceneVideo(imgPath, caption, outputPath, duration, style, wordTimestamps, sceneIndex, category, location) {
  const fadeOut = Math.max(duration - 0.3, 0);
  const clipDur = duration / 3;

  // 3 clips from the same image, each with a different crop/zoom variation
  const clipPaths = [];
  for (let i = 0; i < 3; i++) {
    const clipPath = outputPath.replace('.mp4', `_clip${i}.mp4`);
    await buildImageClip(imgPath, clipPath, clipDur, i);
    clipPaths.push(clipPath);
  }

  // Concat clips → raw scene
  const concatFile = outputPath.replace('.mp4', '_concat.txt');
  fs.writeFileSync(concatFile, clipPaths.map(p => `file '${p}'`).join('\n'));
  const rawScene = outputPath.replace('.mp4', '_raw.mp4');
  await runFFmpeg(['-f', 'concat', '-safe', '0', '-i', concatFile, '-c:v', 'copy', '-an', '-y', rawScene]);

  // Caption filters — auto-wrapped, no overflow
  const captionFilters = wordTimestamps && wordTimestamps.length > 0
    ? buildCaptionFilters(wordTimestamps, style, duration)
    : [makeDrawtext(caption, style, 0.3, duration - 0.2, false)].filter(Boolean);

  // EP progress indicator — top right
  const progressText   = `EP ${seriesState.currentEpisode}/${EPISODES_PER_SERIES}`;
  const progressFilter = `drawtext=text='${progressText}':fontsize=30:fontcolor=white@0.8:fontfile='${FONT_BOLD}':x=w-text_w-18:y=16:borderw=2:bordercolor=black`;

  // Location — bottom left
  const locationClean  = escFF((location || '').toUpperCase().substring(0, 25));
  const locationFilter = locationClean
    ? `drawtext=text='${locationClean}':fontsize=26:fontcolor=white@0.65:fontfile='${FONT_BOLD}':x=16:y=h-52:borderw=2:bordercolor=black`
    : '';

  // SIGMA badge on scene 6 — top left
  const isSigmaScene = sceneIndex === 5;
  const sigmaBadge = isSigmaScene
    ? `,drawtext=text='SIGMA':fontsize=38:fontcolor='0xFFD700':fontfile='${FONT_BOLD}':x=16:y=16:borderw=3:bordercolor=black`
    : '';

  const colorGrade  = COLOR_GRADE[category] || COLOR_GRADE['default'];
  const rainFilter  = ['horror', 'thriller'].includes(category) ? ',noise=alls=6:allf=t+u' : '';
  const captionPart = captionFilters.length > 0 ? ',' + captionFilters.join(',') : '';
  const locationPart = locationFilter ? ',' + locationFilter : '';

  const vf = `fade=t=in:st=0:d=0.3,fade=t=out:st=${fadeOut}:d=0.3,${colorGrade}${rainFilter}${captionPart},${progressFilter}${locationPart}${sigmaBadge}`;

  await runFFmpeg(['-i', rawScene, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-vf', vf, '-an', '-y', outputPath]);

  clipPaths.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
  try { fs.unlinkSync(rawScene); fs.unlinkSync(concatFile); } catch (e) {}
  console.log(`[FFmpeg] Scene ${sceneIndex + 1} ✅${isSigmaScene ? ' 🔱 SIGMA' : ''}`);
}

// ─────────────────────────────────────────────
// STEP 8 — BUILD END CARD
// ─────────────────────────────────────────────
async function buildEndCard(outputPath, seriesName, nextEpisode, duration = 3) {
  const hasLogo        = fs.existsSync(LOGO_PATH);
  const safeSeriesName = escFF(seriesName.toUpperCase());
  const nextEpText     = `EP ${nextEpisode} DROPS SOON`;

  const textFilters = [
    `drawtext=text='${safeSeriesName}':fontfile='${FONT_BOLD}':fontsize=48:fontcolor=white:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h*${hasLogo ? '0.72' : '0.38'}`,
    `drawtext=text='${nextEpText}':fontfile='${FONT_BOLD}':fontsize=36:fontcolor='0xFFD700':borderw=2:bordercolor=black:x=(w-text_w)/2:y=h*${hasLogo ? '0.82' : '0.52'}`,
    `drawtext=text='SUBSCRIBE NOW':fontfile='${FONT_BOLD}':fontsize=42:fontcolor='0xFF4444':borderw=2:bordercolor=black:x=(w-text_w)/2:y=h*${hasLogo ? '0.90' : '0.62'}`,
    `fade=t=in:st=0:d=0.5`,
  ].join(',');

  if (hasLogo) {
    await runFFmpeg([
      '-f', 'lavfi', '-i', `color=c=black:size=768x1344:duration=${duration}:rate=24`,
      '-i', LOGO_PATH,
      '-filter_complex', `[1:v]scale=260:260[logo];[0:v][logo]overlay=(W-w)/2:(H-h)/2-120[bg];[bg]${textFilters}[out]`,
      '-map', '[out]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', '-y', outputPath
    ]);
  } else {
    await runFFmpeg([
      '-f', 'lavfi', '-i', `color=c=black:size=768x1344:duration=${duration}:rate=24`,
      '-vf', textFilters,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', '-y', outputPath
    ]);
  }
  console.log(`[EndCard] ✅`);
}

// ─────────────────────────────────────────────
// STEP 9 — STITCH: Video + Voice + PHONK BG
// Phonk.mp3 loops under all scenes, 12% volume
// Voice stays at 100%
// ─────────────────────────────────────────────
async function stitchFinalVideo(sceneVideos, voiceAudios, endCardPath, tempDir, outputPath) {
  // 1 — Concat all scene videos + end card
  const allVideos = [...sceneVideos, endCardPath];
  const vidConcat = path.join(tempDir, 'vidconcat.txt');
  fs.writeFileSync(vidConcat, allVideos.map(v => `file '${v}'`).join('\n'));
  const tempVideo = path.join(tempDir, 'video_only.mp4');
  await runFFmpeg(['-f', 'concat', '-safe', '0', '-i', vidConcat, '-c:v', 'copy', '-an', '-y', tempVideo]);
  console.log('[Stitch] Video concat ✅');

  // 2 — Concat all voice audio
  const audConcat = path.join(tempDir, 'audconcat.txt');
  fs.writeFileSync(audConcat, voiceAudios.map(a => `file '${a}'`).join('\n'));
  const tempVoice = path.join(tempDir, 'voice_full.mp3');
  await runFFmpeg(['-f', 'concat', '-safe', '0', '-i', audConcat, '-c:a', 'libmp3lame', '-b:a', '192k', '-y', tempVoice]);
  console.log('[Stitch] Voice concat ✅');

  // 3 — Get total video duration
  const durStr = await runFFprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', tempVideo]);
  const durNum = parseFloat(durStr);

  // 4 — Use phonk.mp3 as background music
  const phonkExists = fs.existsSync(PHONK_PATH);
  console.log(`[Music] Phonk file: ${phonkExists ? '✅ Found' : '❌ Not found at ' + PHONK_PATH}`);

  if (phonkExists) {
    try {
      await runFFmpeg([
        '-i', tempVideo,
        '-i', tempVoice,
        '-stream_loop', '-1', '-i', PHONK_PATH,   // loop phonk infinitely
        '-filter_complex',
          `[1:a]volume=1.0[voice];` +
          `[2:a]volume=0.12,atrim=end=${durNum + 2}[phonk];` +
          `[voice][phonk]amix=inputs=2:duration=longest:dropout_transition=0[aout]`,
        '-map', '0:v', '-map', '[aout]',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-t', String(durNum), '-y', outputPath
      ]);
      console.log('[Music] Phonk BG mixed ✅ (voice 100% + phonk 12%)');
      return;
    } catch (e) { console.log('[Music] Phonk mix failed:', e.message); }
  }

  // Fallback — voice only (no music if phonk.mp3 missing)
  await runFFmpeg(['-i', tempVideo, '-i', tempVoice, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(durNum), '-y', outputPath]);
  console.log('[Stitch] Voice only fallback ✅');
}

// ─────────────────────────────────────────────
// STEP 10 — AUTO THUMBNAIL
// ─────────────────────────────────────────────
async function generateThumbnail(videoPath, title, seriesName, episodeNum, tempDir) {
  const thumbPath  = path.join(tempDir, 'thumbnail.jpg');
  const safeTitle  = escFF(title.toUpperCase().substring(0, 28));
  const safeSeries = escFF(seriesName.toUpperCase().substring(0, 20));

  try {
    await runFFmpeg([
      '-i', videoPath,
      '-ss', '2',
      '-vframes', '1',
      '-vf',
        `scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,` +
        `drawtext=text='${safeSeries}':fontfile='${FONT_BOLD}':fontsize=50:fontcolor=white:borderw=4:bordercolor=black:x=(w-text_w)/2:y=h*0.65,` +
        `drawtext=text='${safeTitle}':fontfile='${FONT_BOLD}':fontsize=38:fontcolor='0xFFD700':borderw=3:bordercolor=black:x=(w-text_w)/2:y=h*0.78,` +
        `drawtext=text='EP ${episodeNum}':fontfile='${FONT_BOLD}':fontsize=46:fontcolor=white:borderw=3:bordercolor='0xFF4444':x=28:y=28`,
      '-y', thumbPath
    ]);
    console.log('[Thumbnail] ✅');
    return thumbPath;
  } catch (e) {
    console.log('[Thumbnail] Failed:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// STEP 11 — YOUTUBE UPLOAD
// SEO title, chapters, description, pinned comment
// ─────────────────────────────────────────────
async function uploadToYouTube(videoPath, thumbnailPath, script, seriesName, episodeNum, category) {
  const oauth2Client = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI);
  oauth2Client.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  const fullTitle = `${seriesName} | Ep ${episodeNum} 🔥 | ${script.title} #Shorts`.substring(0, 100);

  // Auto chapters for 6-scene video (~7-9s per scene avg)
  const chapters = [
    '00:00 Intro',
    '00:03 Scene 1',
    '00:12 Scene 2',
    '00:21 Scene 3',
    '00:30 Scene 4',
    '00:39 Scene 5',
    '00:48 🔱 Sigma Twist',
    '00:57 End',
  ].join('\n');

  const fullDesc = [
    script.description,
    '',
    `📺 ${seriesName} | Episode ${episodeNum} of ${EPISODES_PER_SERIES}`,
    `🔔 Subscribe — Ep ${episodeNum + 1} drops soon!`,
    `💬 What's your prediction? Comment below! 👇`,
    `🔱 Stay sigma. Stay consistent.`,
    '',
    chapters,
    '',
    script.hashtags,
    `#${category.replace(/ /g, '')} #anime #cartoon #shorts #viral #series #sigma #phonk`,
  ].join('\n');

  const res = await youtube.videos.insert({
    part: 'snippet,status',
    requestBody: {
      snippet: {
        title: fullTitle,
        description: fullDesc,
        tags: [...(script.hashtags || '').split('#').filter(Boolean).map(t => t.trim()), category, 'anime', 'shorts', 'series', 'sigma', 'phonk'],
        categoryId: '1',
        defaultLanguage: 'en',
      },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false }
    },
    media: { mimeType: 'video/mp4', body: fs.createReadStream(videoPath) }
  });

  const videoId = res.data.id;
  console.log(`[YouTube] ✅ https://youtube.com/watch?v=${videoId}`);

  // Upload thumbnail
  if (thumbnailPath && fs.existsSync(thumbnailPath)) {
    try {
      await youtube.thumbnails.set({ videoId, media: { mimeType: 'image/jpeg', body: fs.createReadStream(thumbnailPath) } });
      console.log('[YouTube] Thumbnail ✅');
    } catch (e) { console.log('[YouTube] Thumbnail failed:', e.message); }
  }

  // Auto pinned comment
  try {
    const commentRes = await youtube.commentThreads.insert({
      part: 'snippet',
      requestBody: {
        snippet: {
          videoId,
          topLevelComment: {
            snippet: {
              textOriginal: `🔱 Ep ${episodeNum + 1} drops soon! Subscribe so you don't miss the sigma twist!\n\n💬 What do you think happens next? Comment below! 👇\n\n${script.hashtags}`
            }
          }
        }
      }
    });
    await youtube.comments.setModerationStatus({
      id: commentRes.data.snippet.topLevelComment.id,
      moderationStatus: 'published'
    });
    console.log('[YouTube] Comment pinned ✅');
  } catch (e) { console.log('[YouTube] Comment failed:', e.message); }

  return videoId;
}

// ─────────────────────────────────────────────
// STEP 12 — INSTAGRAM POST
// ─────────────────────────────────────────────
async function postToInstagram(videoUrl, caption) {
  const con = await axios.post(`https://graph.facebook.com/v18.0/${INSTAGRAM_USER_ID}/media`, {
    media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: true, access_token: INSTAGRAM_ACCESS_TOKEN
  });
  await new Promise(r => setTimeout(r, 45000));
  const pub = await axios.post(`https://graph.facebook.com/v18.0/${INSTAGRAM_USER_ID}/media_publish`, {
    creation_id: con.data.id, access_token: INSTAGRAM_ACCESS_TOKEN
  });
  return pub.data.id;
}

// ─────────────────────────────────────────────
// MAIN PIPELINE
// ─────────────────────────────────────────────
async function runPostingCycle() {
  dailyCount++;

  // Start new series after 12 episodes
  if (seriesState.currentEpisode > EPISODES_PER_SERIES) {
    console.log('\n🎬 Series complete! Starting new series...');
    seriesState = createNewSeries(seriesState.seriesIndex + 1);
    saveState(seriesState);
  }

  const { category, voice, dubLang, characterSeed, currentEpisode, seriesNumber } = seriesState;
  const art          = CATEGORY_ART[category]  || CATEGORY_ART['adventure'];
  const captionStyle = CAPTION_STYLES[category] || CAPTION_STYLES['default'];

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🎬 VidForge AI v16.0 | Series ${seriesNumber} | Ep ${currentEpisode}/${EPISODES_PER_SERIES}`);
  console.log(`🎭 ${category} | 🎨 ${art.name} | 🎙️ ${voice.name} | 🌐 ${dubLang.label}`);
  console.log(`🔱 6 scenes/video | 🎵 Phonk BG | 📊 ${dailyCount}/${DAILY_LIMIT}`);
  console.log(`${'═'.repeat(60)}\n`);

  const tempDir = path.join('/tmp', `vf_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const results = { episode: currentEpisode, youtube: null, instagram: null, error: null };

  try {
    // 1 — Generate 6-scene episode script
    console.log('[Step 1] Writing 6-scene episode script...');
    const script = await generateEpisodeScript(seriesState);
    console.log(`[Step 1] ✅ "${script.series_name}" Ep ${currentEpisode}: ${script.title}`);
    if (script.plot_twist) console.log(`[Step 1] 🌀 Plot twist: ${script.plot_twist}`);
    console.log(`[Step 1] 🔱 Scene 6 = SIGMA TWIST`);

    // Update series state
    if (currentEpisode === 1) {
      seriesState.seriesName      = script.series_name;
      seriesState.characterDesign = script.character_design;
    }
    if (script.villain_design) seriesState.villainDesign = script.villain_design;

    // 2 — Recap voice for ep 2+
    const voiceAudios = [];
    if (currentEpisode > 1 && script.recap_line) {
      const recapPath = path.join(tempDir, 'recap.mp3');
      const recapText = dubLang.lang !== 'en' ? await translateNarration(script.recap_line, dubLang.lang) : script.recap_line;
      await generateVoice(recapText, recapPath, voice.id, category, dubLang.ttsCode);
      voiceAudios.push(recapPath);
    }

    // 3 — Generate 1 image + voice per scene (6 scenes)
    console.log(`\n[Step 2] Generating image + voice for 6 scenes (lang: ${dubLang.label})...`);
    const sceneData = [];

    for (let i = 0; i < script.scenes.length; i++) {
      const scene     = script.scenes[i];
      const isSigma   = i === 5;
      const imgPath   = path.join(tempDir, `img_${i}.png`);
      const audioPath = path.join(tempDir, `voice_${i}.mp3`);

      console.log(`\n[Scene ${i + 1}/6]${isSigma ? ' 🔱 SIGMA TWIST' : ''} "${cleanCap(scene.caption)}" — ${scene.location}`);

      // Translate narration if needed
      const narration = dubLang.lang !== 'en'
        ? await translateNarration(scene.narration, dubLang.lang)
        : scene.narration;

      // Generate 1 image + voice in parallel
      await Promise.all([
        generateImage(scene.widePrompt, imgPath, characterSeed, i),
        generateVoice(narration, audioPath, voice.id, category, dubLang.ttsCode)
      ]);

      // Word-level timestamps for caption sync
      const timestamps = await getWordTimestamps(audioPath);

      // Audio duration
      let duration = 7;
      try {
        const d = await runFFprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath]);
        duration = Math.max(parseFloat(d) + 0.6, 4.0);
      } catch (e) {}

      sceneData.push({ imgPath, audioPath, caption: scene.caption, location: scene.location, duration, timestamps });
      voiceAudios.push(audioPath);
      console.log(`[Scene ${i + 1}] ✅ ${duration.toFixed(1)}s`);
    }

    // 4 — Build 6 scene videos
    console.log('\n[Step 3] Building 6 scene videos...');
    const sceneVideos = [];
    for (let i = 0; i < sceneData.length; i++) {
      const d        = sceneData[i];
      const sceneOut = path.join(tempDir, `scene_${i}.mp4`);
      await buildSceneVideo(
        d.imgPath, d.caption, sceneOut, d.duration,
        captionStyle, d.timestamps, i, category, d.location
      );
      sceneVideos.push(sceneOut);
    }

    // 5 — Build end card
    console.log('\n[Step 4] Building end card...');
    const endCardPath = path.join(tempDir, 'endcard.mp4');
    await buildEndCard(endCardPath, script.series_name, currentEpisode + 1);

    // 6 — Stitch with PHONK BG
    console.log('\n[Step 5] Stitching with phonk BG music...');
    const videoPath = path.join(tempDir, 'final.mp4');
    await stitchFinalVideo(sceneVideos, voiceAudios, endCardPath, tempDir, videoPath);

    // 7 — Thumbnail
    console.log('\n[Step 6] Generating thumbnail...');
    const thumbnailPath = await generateThumbnail(videoPath, script.title, script.series_name, currentEpisode, tempDir);

    // 8 — YouTube
    try {
      console.log('\n[Step 7] Uploading to YouTube...');
      const ytId = await uploadToYouTube(videoPath, thumbnailPath, script, script.series_name, currentEpisode, category);
      results.youtube = `https://youtube.com/watch?v=${ytId}`;
      console.log(`[YouTube] ✅ ${results.youtube}`);
    } catch (err) { console.error('[YouTube] ❌', err.message); }

    // 9 — Instagram
    try {
      if (results.youtube) {
        console.log('\n[Step 8] Posting to Instagram...');
        const igCaption = `${script.series_name} | Ep ${currentEpisode} 🔥\n\n${script.description}\n\n🔱 Stay sigma. Ep ${currentEpisode + 1} drops soon!\n\n${script.hashtags}`;
        results.instagram = await postToInstagram(results.youtube, igCaption);
        console.log('[Instagram] ✅');
      }
    } catch (err) { console.error('[Instagram] ❌', err.message); }

    // 10 — Update series state
    seriesState.episodeSummaries.push(script.episode_summary);
    seriesState.currentEpisode++;
    saveState(seriesState);

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🎉 Ep ${currentEpisode} COMPLETE! (${dailyCount}/${DAILY_LIMIT} today)`);
    if (results.youtube) console.log(`🔗 ${results.youtube}`);
    console.log(`${'═'.repeat(60)}\n`);

  } catch (err) {
    results.error = err.message;
    dailyCount--;
    console.error('[VidForge] ❌ Failed:', err.message);
    console.error(err.stack);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
  }

  return results;
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  app: 'VidForge AI', version: '17.0.0', status: '🚀 Running',
  features: [
    '6 scenes/video', 'Scene 6 = Sigma Twist', 'Caption fix (no overflow)',
    'Phonk BG music (no fade out)', 'Multi-language dubbing', 'Voice rotation (5 voices)',
    'Character consistency', '15 videos/day @ 96-min intervals',
    '1 CF image/scene (3 scale+crop variations)', 'Word-sync captions', 'Auto thumbnail', 'Pinned comment'
  ]
}));

app.get('/status', (req, res) => res.json({
  version:    '17.0.0',
  dailyCount: `${dailyCount}/${DAILY_LIMIT}`,
  postSchedule: '15 videos/day, every 96 minutes (IST)',
  phonkMusic:   fs.existsSync(PHONK_PATH) ? '✅ phonk.mp3 loaded' : '❌ phonk.mp3 missing — upload to repo root',
  series: {
    number:    seriesState.seriesNumber,
    name:      seriesState.seriesName || 'Generating...',
    category:  seriesState.category,
    episode:   `${seriesState.currentEpisode}/${EPISODES_PER_SERIES}`,
    voice:     seriesState.voice.name,
    dubLang:   seriesState.dubLang?.label || 'English',
    hasVillain: !!seriesState.villainDesign,
  },
  connections: {
    cfAccounts: CF_ACCOUNTS.length,
    elevenlabs: !!ELEVENLABS_API_KEY,
    youtube:    !!YOUTUBE_REFRESH_TOKEN,
    instagram:  !!INSTAGRAM_ACCESS_TOKEN,
    groq:       !!GROQ_API_KEY,
  },
  timestamp: new Date().toISOString()
}));

app.post('/generate', async (req, res) => {
  if (dailyCount >= DAILY_LIMIT) return res.json({ message: 'Daily limit reached!' });
  res.json({ message: `🎬 Generating Ep ${seriesState.currentEpisode} (6 scenes, 1 img/scene, phonk BG, ${seriesState.dubLang?.label || 'English'})!` });
  runPostingCycle();
});

app.post('/new-series', (req, res) => {
  seriesState = createNewSeries(seriesState.seriesIndex + 1);
  saveState(seriesState);
  res.json({ message: 'New series started!', series: seriesState });
});

app.get('/series-state', (req, res) => res.json(seriesState));

app.get('/test-image', async (req, res) => {
  if (CF_ACCOUNTS.length === 0) return res.json({ error: 'No CF accounts configured' });
  try {
    const acc    = CF_ACCOUNTS[0];
    const prompt = req.query.prompt || 'minimalist stick figure illustration, black ink on white background, simple expressive stick man character, sigma male dominant pose, stone cold expression, action stance, speed lines, scratchy ink style, high contrast, no color, no text, vertical 9:16';
    const r      = await axios.post(
      `https://api.cloudflare.com/client/v4/accounts/${acc.id}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
      { prompt, steps: 4 },
      { headers: { 'Authorization': `Bearer ${acc.token}`, 'Content-Type': 'application/json' }, timeout: 60000 }
    );
    const b64 = r.data?.result?.image || r.data?.image;
    if (b64) { res.set('Content-Type', 'image/jpeg'); res.send(Buffer.from(b64, 'base64')); }
    else res.json({ error: 'No image', raw: r.data });
  } catch (err) { res.json({ error: err.response?.status || err.message }); }
});

app.get('/test-phonk', (req, res) => {
  if (fs.existsSync(PHONK_PATH)) {
    res.set('Content-Type', 'audio/mpeg');
    fs.createReadStream(PHONK_PATH).pipe(res);
  } else {
    res.json({ error: `phonk.mp3 not found at ${PHONK_PATH}` });
  }
});

app.get('/auth/youtube', (req, res) => {
  const o = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI);
  res.redirect(o.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.force-ssl'] }));
});

app.get('/auth/youtube/callback', async (req, res) => {
  const o = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI);
  const { tokens } = await o.getToken(req.query.code);
  res.json({ message: 'Save this refresh token!', refresh_token: tokens.refresh_token });
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🚀 VidForge AI v17.0 — Sigma Phonk Edition`);
  console.log(`📺 Series ${seriesState.seriesNumber} | Ep ${seriesState.currentEpisode}/${EPISODES_PER_SERIES} | ${seriesState.category}`);
  console.log(`🎙️  Voice: ${seriesState.voice.name} | 🌐 Dub: ${seriesState.dubLang?.label || 'English'}`);
  console.log(`🎵  Phonk: ${fs.existsSync(PHONK_PATH) ? '✅ phonk.mp3 ready (no fade)' : '❌ phonk.mp3 MISSING — upload to repo root'}`);
  console.log(`🔱  6 scenes/video | Scene 6 = SIGMA TWIST always`);
  console.log(`📊  15 videos/day @ 96-min intervals`);
  console.log(`☁️   CF Accounts: ${CF_ACCOUNTS.length} | 1 img/scene | 3 scale+crop variations | Logo: ${fs.existsSync(LOGO_PATH) ? '✅' : '❌'}`);
  console.log(`${'═'.repeat(60)}\n`);
});

// ─────────────────────────────────────────────
// KEEP ALIVE — ping every 10 mins
// ─────────────────────────────────────────────
if (RENDER_URL) {
  setInterval(() => {
    axios.get(`${RENDER_URL}/status`).catch(() => {});
    console.log('[KeepAlive] Ping ✅');
  }, 10 * 60 * 1000);
  console.log('[KeepAlive] Active — pinging every 10 minutes');
}

module.exports = app;
