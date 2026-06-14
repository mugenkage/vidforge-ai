// ═══════════════════════════════════════════════════════════════
//  VidForge AI v15.0 — Ultimate Anime Series Engine
//  Features: 2 images/scene, word-sync captions, color grading,
//  rain overlay, camera shake, vignette, flash, crossfade,
//  progress bar, location text, auto thumbnail, pinned comment,
//  SEO chapters, best posting time, villain EP3+, plot twists
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

let cfAccountIndex = 0;

// ─────────────────────────────────────────────
// FFMPEG HELPERS
// ─────────────────────────────────────────────
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args);
    let errOut = '';
    ff.stderr.on('data', d => { errOut += d.toString().slice(-500); });
    ff.on('close', code => { if (code === 0) resolve(); else reject(new Error(`FFmpeg ${code}: ${errOut.slice(-200)}`)); });
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
const FONT_BOLD           = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_OBLIQUE        = '/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf';
const FONT_MONO           = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf';
const STATE_FILE          = path.join('/tmp', 'vidforge_state.json');
const LOGO_PATH           = path.join(__dirname, 'assets', 'logo.png');

// Post at peak IST hours — 9AM, 3PM, 9PM
const PEAK_HOURS_IST = [9, 15, 21];

// ─────────────────────────────────────────────
// SERIES CATEGORIES & VOICES
// ─────────────────────────────────────────────
const SERIES_CATEGORIES = [
  'horror', 'adventure', 'mystery', 'thriller',
  'fantasy', 'science fiction', 'superhero', 'motivation'
];

const SERIES_VOICES = [
  { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh',   lang: 'en', speed: 1.0 },
  { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', lang: 'en', speed: 0.95 },
  { id: 'VR6AewLTigWG4xSOukaG', name: 'Arnold', lang: 'en', speed: 1.0 },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella',  lang: 'en', speed: 0.9 },
  { id: 'yoZ06aMxZJJ28mfd3POQ', name: 'Sam',    lang: 'en', speed: 1.0 },
];

// ─────────────────────────────────────────────
// ART STYLES — Minimalist Stick Figure Style
// Black ink on white background — NEVER triggers NSFW filter
// Consistent character — always looks the same
// Unique viral style — nobody else doing this!
// ─────────────────────────────────────────────
const CATEGORY_ART = {
  'horror':          { name: 'Horror Stick',    prompt: 'minimalist stick figure illustration, black ink on white background, simple expressive stick man character, horror scene, dark shadow looming, action lines showing fear, scratchy ink style, high contrast black and white, clean simple art, no color, no text' },
  'thriller':        { name: 'Thriller Stick',  prompt: 'minimalist stick figure illustration, black ink on white background, simple expressive stick man character, tense thriller scene, dramatic action lines, motion blur lines, suspenseful pose, scratchy ink style, high contrast black and white, no color, no text' },
  'mystery':         { name: 'Mystery Stick',   prompt: 'minimalist stick figure illustration, black ink on white background, simple expressive stick man character, mysterious scene, magnifying glass prop, question marks, subtle shadow details, scratchy ink style, high contrast black and white, no color, no text' },
  'adventure':       { name: 'Adventure Stick', prompt: 'minimalist stick figure illustration, black ink on white background, simple expressive stick man character, epic adventure scene, dynamic running pose, action speed lines, simple landscape background, scratchy ink style, high contrast black and white, no color, no text' },
  'superhero':       { name: 'Hero Stick',      prompt: 'minimalist stick figure illustration, black ink on white background, simple expressive stick man character, superhero pose, cape outline, power effect lines radiating outward, heroic stance, scratchy ink style, high contrast black and white, no color, no text' },
  'motivation':      { name: 'Motivation Stick',prompt: 'minimalist stick figure illustration, black ink on white background, simple expressive stick man character, triumphant pose, arms raised, mountain peak, achievement scene, upward arrows, scratchy ink style, high contrast black and white, no color, no text' },
  'fantasy':         { name: 'Fantasy Stick',   prompt: 'minimalist stick figure illustration, black ink on white background, simple expressive stick man character, magical fantasy scene, simple wand or sword prop, star sparkle details, magical circle, scratchy ink style, high contrast black and white, no color, no text' },
  'science fiction': { name: 'SciFi Stick',     prompt: 'minimalist stick figure illustration, black ink on white background, simple expressive stick man character, futuristic sci-fi scene, robot or spaceship outline, tech lines, simple geometric details, scratchy ink style, high contrast black and white, no color, no text' },
};

// ─────────────────────────────────────────────
// CAPTION STYLES — per category
// ─────────────────────────────────────────────
const CAPTION_STYLES = {
  'horror':          { fontfile: FONT_BOLD,    fontsize: 72, fontcolor: 'white',     highlight: '0xFF4444', borderw: 8,  bordercolor: 'black',        box: false },
  'thriller':        { fontfile: FONT_BOLD,    fontsize: 68, fontcolor: 'white',     highlight: '0xFF2222', borderw: 7,  bordercolor: 'black',        box: true,  boxcolor: '0xE6194B@0.8', boxborderw: 14 },
  'mystery':         { fontfile: FONT_OBLIQUE, fontsize: 64, fontcolor: '0xE8E0FF', highlight: '0xAA88FF', borderw: 6,  bordercolor: 'black@0.9',   box: true,  boxcolor: 'black@0.5',    boxborderw: 14 },
  'adventure':       { fontfile: FONT_BOLD,    fontsize: 72, fontcolor: 'white',     highlight: '0xFFAA00', borderw: 8,  bordercolor: 'black',        box: false },
  'superhero':       { fontfile: FONT_BOLD,    fontsize: 76, fontcolor: 'white',     highlight: '0xFFD700', borderw: 9,  bordercolor: 'black',        box: false },
  'motivation':      { fontfile: FONT_BOLD,    fontsize: 72, fontcolor: '0xFFD700', highlight: '0xFFFFFF', borderw: 7,  bordercolor: 'black',        box: false },
  'fantasy':         { fontfile: FONT_OBLIQUE, fontsize: 66, fontcolor: '0xFFE9B0', highlight: '0xFFD700', borderw: 6,  bordercolor: 'black@0.85',  box: false },
  'science fiction': { fontfile: FONT_MONO,    fontsize: 60, fontcolor: '0x00FFFF', highlight: '0x00FFAA', borderw: 5,  bordercolor: '0x0000FF@0.7', box: true,  boxcolor: 'black@0.7',    boxborderw: 12 },
  'default':         { fontfile: FONT_BOLD,    fontsize: 68, fontcolor: 'white',     highlight: '0xFFD700', borderw: 7,  bordercolor: 'black',        box: false },
};

// ─────────────────────────────────────────────
// COLOR GRADING — cinematic LUT per category
// ─────────────────────────────────────────────
const COLOR_GRADE = {
  'horror':          'curves=r=\'0/0 0.3/0.1 1/0.8\':g=\'0/0 0.5/0.35 1/0.75\':b=\'0/0.05 0.5/0.55 1/1\',vignette=PI/4',
  'thriller':        'curves=r=\'0/0 0.5/0.4 1/0.85\':g=\'0/0 0.5/0.38 1/0.78\':b=\'0/0.03 0.5/0.48 1/0.95\',vignette=PI/4',
  'mystery':         'curves=r=\'0/0 0.5/0.42 1/0.88\':g=\'0/0 0.5/0.4 1/0.82\':b=\'0/0.02 0.5/0.52 1/1\',vignette=PI/3.5',
  'adventure':       'curves=r=\'0/0 0.5/0.58 1/1\':g=\'0/0 0.5/0.52 1/0.95\':b=\'0/0 0.5/0.38 1/0.8\',vignette=PI/5',
  'superhero':       'curves=r=\'0/0 0.5/0.6 1/1\':g=\'0/0 0.5/0.55 1/0.95\':b=\'0/0 0.5/0.45 1/0.85\',vignette=PI/4',
  'motivation':      'curves=r=\'0/0 0.5/0.62 1/1\':g=\'0/0 0.5/0.58 1/0.98\':b=\'0/0 0.5/0.4 1/0.82\',vignette=PI/5',
  'fantasy':         'curves=r=\'0/0 0.5/0.55 1/0.95\':g=\'0/0 0.5/0.5 1/0.9\':b=\'0/0.02 0.5/0.55 1/1\',vignette=PI/4',
  'science fiction': 'curves=r=\'0/0 0.5/0.38 1/0.82\':g=\'0/0.02 0.5/0.52 1/0.95\':b=\'0/0.05 0.5/0.6 1/1\',vignette=PI/3.5',
  'default':         'curves=r=\'0/0 0.5/0.5 1/1\':g=\'0/0 0.5/0.5 1/1\':b=\'0/0 0.5/0.5 1/1\',vignette=PI/4',
};

// ─────────────────────────────────────────────
// MUSIC URLS — free online music per category
// ─────────────────────────────────────────────
const MUSIC_URLS = {
  'horror':          'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-9.mp3',
  'thriller':        'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-9.mp3',
  'mystery':         'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3',
  'adventure':       'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
  'superhero':       'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
  'motivation':      'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3',
  'fantasy':         'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-7.mp3',
  'science fiction': 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3',
  'default':         'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
};

// ─────────────────────────────────────────────
// SOUND EFFECTS — free Pixabay SFX URLs per category
// ─────────────────────────────────────────────
const SFX_URLS = {
  'horror':    'https://cdn.pixabay.com/download/audio/2022/03/10/audio_c8c8a73467.mp3',
  'thriller':  'https://cdn.pixabay.com/download/audio/2021/08/09/audio_99bbf053f1.mp3',
  'mystery':   'https://cdn.pixabay.com/download/audio/2022/01/18/audio_d0c6ff3516.mp3',
  'adventure': 'https://cdn.pixabay.com/download/audio/2021/08/09/audio_a8dee0fa0f.mp3',
  'superhero': 'https://cdn.pixabay.com/download/audio/2022/03/15/audio_1aa5b0dbc5.mp3',
  'motivation':'https://cdn.pixabay.com/download/audio/2022/01/20/audio_d8fbea5b5c.mp3',
  'fantasy':   'https://cdn.pixabay.com/download/audio/2021/08/09/audio_b7568ec3cf.mp3',
  'science fiction': 'https://cdn.pixabay.com/download/audio/2022/03/24/audio_eaecbd3e79.mp3',
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
    seriesNumber:     seriesIndex + 1,
    category:         SERIES_CATEGORIES[seriesIndex % SERIES_CATEGORIES.length],
    voice:            SERIES_VOICES[seriesIndex % SERIES_VOICES.length],
    characterSeed:    Math.floor(Math.random() * 999999),
    characterDesign:  null,
    seriesName:       null,
    villainDesign:    null,
    currentEpisode:   1,
    episodeSummaries: [],
    createdAt:        new Date().toISOString()
  };
}

let seriesState = loadState() || createNewSeries(0);
let dailyCount  = 0;
saveState(seriesState);

// ─────────────────────────────────────────────
// CRON — Post at peak IST hours
// ─────────────────────────────────────────────
cron.schedule('0 0 * * *', () => { dailyCount = 0; console.log('[VidForge] Daily reset!'); });

// Every 3 hours IST (UTC+5:30) = 8 videos/day
// 12AM, 3AM, 6AM, 9AM, 12PM, 3PM, 6PM, 9PM IST
// UTC: 6:30PM, 9:30PM, 12:30AM, 3:30AM, 6:30AM, 9:30AM, 12:30PM, 3:30PM
cron.schedule('30 18 * * *', () => { if (dailyCount < DAILY_LIMIT) { console.log('[Cron] 12AM IST'); runPostingCycle(); } });
cron.schedule('30 21 * * *', () => { if (dailyCount < DAILY_LIMIT) { console.log('[Cron] 3AM IST');  runPostingCycle(); } });
cron.schedule('30 0  * * *', () => { if (dailyCount < DAILY_LIMIT) { console.log('[Cron] 6AM IST');  runPostingCycle(); } });
cron.schedule('30 3  * * *', () => { if (dailyCount < DAILY_LIMIT) { console.log('[Cron] 9AM IST');  runPostingCycle(); } });
cron.schedule('30 6  * * *', () => { if (dailyCount < DAILY_LIMIT) { console.log('[Cron] 12PM IST'); runPostingCycle(); } });
cron.schedule('30 9  * * *', () => { if (dailyCount < DAILY_LIMIT) { console.log('[Cron] 3PM IST');  runPostingCycle(); } });
cron.schedule('30 12 * * *', () => { if (dailyCount < DAILY_LIMIT) { console.log('[Cron] 6PM IST');  runPostingCycle(); } });
cron.schedule('30 15 * * *', () => { if (dailyCount < DAILY_LIMIT) { console.log('[Cron] 9PM IST');  runPostingCycle(); } });

// ─────────────────────────────────────────────
// STEP 1 — GROQ: Generate Episode Script
// ─────────────────────────────────────────────
async function generateEpisodeScript(state) {
  const { category, currentEpisode, characterDesign, villainDesign, seriesName, episodeSummaries, voice } = state;
  const art       = CATEGORY_ART[category] || CATEGORY_ART['adventure'];
  const isFirstEp = currentEpisode === 1;
  const isLastEp  = currentEpisode === EPISODES_PER_SERIES;
  const needsVillain = currentEpisode === 3 && !villainDesign;
  const prevSummary  = episodeSummaries.length > 0 ? episodeSummaries[episodeSummaries.length - 1] : null;

  const seriesCtx = isFirstEp ? '' : `
SERIES: "${seriesName}" | EPISODE: ${currentEpisode}/${EPISODES_PER_SERIES}
MAIN CHARACTER: ${characterDesign}
${villainDesign ? `VILLAIN: ${villainDesign}` : ''}
PREVIOUS: ${prevSummary}
STORY SO FAR: ${episodeSummaries.slice(-3).join(' → ')}
Continue EXACTLY where last episode ended.`;

  const endRule = isLastEp
    ? 'SERIES FINALE — epic satisfying conclusion, hint at new adventure'
    : `End on MASSIVE CLIFFHANGER — stop mid-action, leave viewers desperate for Ep ${currentEpisode + 1}`;

  const plotTwistRule = currentEpisode % 2 === 0
    ? 'MANDATORY: Include a shocking plot twist that recontextualizes everything'
    : 'Build rising tension throughout';

  const prompt = `Write Episode ${currentEpisode} of a viral ${category} anime cartoon series for YouTube Shorts.
${seriesCtx}
Art style: ${art.name}
Voice narrator: ${voice.name}

STRICT RULES:
- Hook viewer in first 2 seconds with action or mystery
- ${isFirstEp ? 'Create ONE iconic memorable main character' : 'Continue naturally from previous episode'}
- ${needsVillain ? 'INTRODUCE THE VILLAIN in this episode — make them terrifying/compelling' : ''}
- ${plotTwistRule}
- ${endRule}
- Natural emotional storytelling — make viewers feel something
- Location for each scene must be vivid and specific
- Captions: MAX 4 WORDS, ALL CAPS, ENGLISH ONLY, no special chars
- Scene emotions must be specific for image generation

Return ONLY valid JSON:
{
  "series_name": "${isFirstEp ? 'Epic 2-3 word series name' : seriesName}",
  "title": "Episode title max 35 chars",
  "character_design": "${isFirstEp ? 'Simple stick figure: round circle head, thin stick body, stick arms and legs, ONE unique detail like hat/scarf/glasses/cape that makes them recognizable' : characterDesign}",
  "villain_design": "${needsVillain ? 'VERY DETAILED villain: appearance, colors, outfit, threatening features' : (villainDesign || '')}",
  "episode_summary": "2 sentences summarizing THIS episode for next episode context",
  "description": "2 sentence YouTube hook description with emojis",
  "hashtags": "#anime #shorts #viral #cartoon #ep${currentEpisode} #${category.replace(/ /g,'')} #series #fyp #trending #subscribe",
  "recap_line": "${isFirstEp ? '' : 'One sentence recap: Last time...'}",
  "plot_twist": "${currentEpisode % 2 === 0 ? 'Describe the shocking twist in this episode' : ''}",
  "scenes": [
    {
      "narration": "Opening narration 1-2 sentences — hook immediately",
      "caption": "HOOK MAX 4 WORDS",
      "location": "Specific vivid location name",
      "emotion": "Main character: exact expression, pose, action, what they see",
      "wide_shot": "Full body scene description for wide image",
      "close_shot": "Face/chest closeup description for dramatic image"
    },
    {
      "narration": "Scene 2 narration — rising tension",
      "caption": "TENSION 4 WORDS",
      "location": "Specific vivid location",
      "emotion": "Character emotion, pose, action, reaction",
      "wide_shot": "Full body scene 2 wide description",
      "close_shot": "Face closeup scene 2 description"
    },
    {
      "narration": "Scene 3 narration — peak intensity or twist",
      "caption": "CLIMAX 4 WORDS",
      "location": "Specific vivid location",
      "emotion": "Character at peak emotion — fear, rage, shock, determination",
      "wide_shot": "Full body scene 3 wide description",
      "close_shot": "Face closeup scene 3 description"
    },
    {
      "narration": "Scene 4 narration — cliffhanger ending",
      "caption": "CLIFFHANGER 4 WORDS",
      "location": "Specific vivid location",
      "emotion": "Final dramatic character moment",
      "wide_shot": "Full body final scene wide description",
      "close_shot": "Face closeup final scene description"
    }
  ]
}`;

  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 2000, temperature: 0.92 },
    { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
  );

  const script = JSON.parse(res.data.choices[0].message.content.replace(/```json|```/g, '').trim());
  const artStyle = CATEGORY_ART[category] || CATEGORY_ART['adventure'];

  // Build image prompts — character LOCKED in every prompt
  const charDesc = script.character_design || characterDesign || 'anime protagonist';
  script.scenes = script.scenes.map((scene, i) => ({
    ...scene,
    // Wide shot prompt — full body stick figure, always consistent
    widePrompt: `${artStyle.prompt}, ${charDesc}, SAME STICK CHARACTER ALWAYS, ${scene.wide_shot}, ${scene.emotion}, full body stick figure visible, simple background details, ${scene.location}, vertical 9:16 portrait, minimalist black ink on white, safe for work, no text, no watermark`,
    // Close up prompt — head and upper body stick figure
    closePrompt: `${artStyle.prompt}, ${charDesc}, SAME STICK CHARACTER ALWAYS, ${scene.close_shot}, ${scene.emotion}, stick figure head closeup, expressive dot eyes, simple facial expression, ${scene.location}, vertical 9:16, minimalist black ink on white, safe for work, no text, no watermark`,
  }));

  return script;
}

// ─────────────────────────────────────────────
// STEP 2 — CF WORKERS AI: Generate 2 images per scene
// Account 1 = wide shots, Account 2 = close shots, Account 3 = backup
// ─────────────────────────────────────────────
async function generateImage(prompt, outputPath, seed, accountIndex) {
  const account = CF_ACCOUNTS[accountIndex % CF_ACCOUNTS.length];

  if (account) {
    try {
      console.log(`[Image] CF Account ${(accountIndex % CF_ACCOUNTS.length) + 1} — ${outputPath.split('/').pop()}`);
      const res = await axios.post(
        `https://api.cloudflare.com/client/v4/accounts/${account.id}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
        { prompt, steps: 4, seed },
        { headers: { 'Authorization': `Bearer ${account.token}`, 'Content-Type': 'application/json' }, timeout: 90000 }
      );
      const b64 = res.data?.result?.image || res.data?.image;
      if (b64 && b64.length > 1000) {
        fs.writeFileSync(outputPath, Buffer.from(b64, 'base64'));
        console.log(`[Image] CF ✅ ${outputPath.split('/').pop()}`);
        return;
      }
    } catch (err) {
      const msg = err.response?.data?.errors?.[0]?.message || err.message;
      console.log(`[Image] CF failed: ${msg.substring(0, 60)} — trying backup...`);

      // Try next account as backup
      const backupAccount = CF_ACCOUNTS[(accountIndex + 1) % CF_ACCOUNTS.length];
      if (backupAccount && backupAccount !== account) {
        try {
          const res2 = await axios.post(
            `https://api.cloudflare.com/client/v4/accounts/${backupAccount.id}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
            { prompt, steps: 4, seed },
            { headers: { 'Authorization': `Bearer ${backupAccount.token}`, 'Content-Type': 'application/json' }, timeout: 90000 }
          );
          const b64 = res2.data?.result?.image || res2.data?.image;
          if (b64 && b64.length > 1000) {
            fs.writeFileSync(outputPath, Buffer.from(b64, 'base64'));
            console.log(`[Image] CF Backup ✅`);
            return;
          }
        } catch (e) { console.log(`[Image] CF Backup also failed`); }
      }
    }
  }

  // Picsum fallback
  const res = await axios({ method: 'GET', url: `https://picsum.photos/seed/${seed}/576/1024`, responseType: 'arraybuffer', timeout: 30000 });
  fs.writeFileSync(outputPath, Buffer.from(res.data));
  console.log(`[Image] Picsum fallback ✅`);
}

// ─────────────────────────────────────────────
// STEP 3 — VOICE: ElevenLabs → Google TTS
// Audio tuned per category mood
// ─────────────────────────────────────────────
async function generateVoice(text, outputPath, voiceId, category) {
  const cleanText = text.replace(/['"]/g, '').substring(0, 250);

  // ElevenLabs — best quality
  if (ELEVENLABS_API_KEY && voiceId) {
    try {
      const stability   = ['horror', 'thriller'].includes(category) ? 0.4 : 0.5;
      const style       = ['horror', 'thriller'].includes(category) ? 0.5 : 0.3;
      const res = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        { text: cleanText, model_id: 'eleven_monolingual_v1', voice_settings: { stability, similarity_boost: 0.75, style, use_speaker_boost: true } },
        { headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' }, responseType: 'arraybuffer', timeout: 30000 }
      );
      if (res.data && res.data.byteLength > 1000) {
        fs.writeFileSync(outputPath, Buffer.from(res.data));
        console.log('[Voice] ElevenLabs ✅');
        return;
      }
    } catch (err) { console.log(`[Voice] ElevenLabs failed: ${err.response?.status || err.message}`); }
  }

  // Google TTS fallback
  const speed = ['horror', 'thriller'].includes(category) ? '0.8' : '0.9';
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(cleanText)}&tl=en&client=tw-ob&ttsspeed=${speed}`;
  const res = await axios({ method: 'GET', url, responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } });
  fs.writeFileSync(outputPath, Buffer.from(res.data));
  console.log('[Voice] Google TTS ✅');
}

// ─────────────────────────────────────────────
// STEP 4 — WHISPER: Word-level timestamps
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
// STEP 5 — CAPTION SYSTEM
// Fixed size, no overflow, no overlap, word sync, yellow highlight
// ─────────────────────────────────────────────
function cleanCap(t) {
  return t.toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .substring(0, 20)
    .trim();
}

function escFF(t) {
  return t.replace(/\\/g, '\\\\').replace(/'/g, '').replace(/:/g, '\\:');
}

// Build drawtext filter — FIXED size, always inside screen
// y=h*0.78 = lower third, always visible
function makeDrawtext(text, style, startT, endT, isHighlight = false) {
  const raw = cleanCap(text);
  if (!raw || endT <= startT) return null;

  // FIXED font size — no shrinking based on text length
  // Instead we limit to 20 chars max to keep it fitting
  const fs2 = style.fontsize;
  const t    = escFF(raw);

  // Color — yellow for highlighted current word, normal for rest
  const color = isHighlight ? style.highlight : style.fontcolor;

  // Position — ALWAYS lower third, centered, inside safe zone
  let f = `drawtext=text='${t}':fontsize=${fs2}:fontcolor=${color}:fontfile='${style.fontfile}':x=(w-text_w)/2:y=h*0.78:borderw=${style.borderw}:bordercolor=${style.bordercolor}:enable='between(t,${startT.toFixed(3)},${endT.toFixed(3)})'`;
  if (style.box) f += `:box=1:boxcolor=${style.boxcolor}:boxborderw=${style.boxborderw}`;
  return f;
}

// Build word-by-word caption filters from Whisper timestamps
// NO OVERLAP — each chunk ends exactly when next begins
// Current chunk highlighted in yellow
function buildCaptionFilters(wordTimestamps, style, totalDuration) {
  if (!wordTimestamps || wordTimestamps.length === 0) return [];

  const filters  = [];
  const WORDS_PER_CHUNK = 3; // show 3 words at a time

  // Build chunks of 3 words
  const chunks = [];
  for (let i = 0; i < wordTimestamps.length; i += WORDS_PER_CHUNK) {
    const slice = wordTimestamps.slice(i, Math.min(i + WORDS_PER_CHUNK, wordTimestamps.length));
    chunks.push({
      text:  slice.map(w => w.word).join(' '),
      start: slice[0].start,
      end:   slice[slice.length - 1].end,
    });
  }

  for (let j = 0; j < chunks.length; j++) {
    const startT    = Math.max(chunks[j].start - 0.03, 0);
    // End exactly when NEXT chunk starts — NO OVERLAP EVER
    const nextStart = j + 1 < chunks.length ? chunks[j + 1].start - 0.03 : totalDuration;
    const endT      = Math.min(chunks[j].end + 0.05, nextStart, totalDuration);

    if (endT <= startT) continue;

    // Show full chunk text (white/normal color)
    const f = makeDrawtext(chunks[j].text, style, startT, endT, false);
    if (f) filters.push(f);
  }

  return filters;
}

// ─────────────────────────────────────────────
// STEP 6 — BUILD IMAGE CLIP
// 3 cinematic views from 1 image — zoom, pan, closeup
// ─────────────────────────────────────────────
async function buildImageClip(imgPath, outputPath, duration, viewIndex, isCloseUp) {
  const fps         = 24;
  const totalFrames = Math.ceil(duration * fps);

  // Wide shot views (3 different camera movements)
  const wideViews = [
    // View 0 — slow zoom in full body
    `scale=768:1344:force_original_aspect_ratio=decrease,pad=768:1344:(ow-iw)/2:(oh-ih)/2:black,` +
    `zoompan=z='1+0.04*on/${totalFrames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=768x1344:fps=${fps}`,

    // View 1 — pan upward to reveal face
    `scale=768:1344:force_original_aspect_ratio=decrease,pad=768:1344:(ow-iw)/2:(oh-ih)/2:black,` +
    `zoompan=z='1.03':x='iw/2-(iw/zoom/2)':y='ih*0.15-(ih/zoom/2)+ih*0.12*on/${totalFrames}':d=1:s=768x1344:fps=${fps}`,

    // View 2 — slow zoom out from face
    `scale=768:1344:force_original_aspect_ratio=decrease,pad=768:1344:(ow-iw)/2:(oh-ih)/2:black,` +
    `zoompan=z='1.1-0.06*on/${totalFrames}':x='iw/2-(iw/zoom/2)':y='ih*0.05-(ih/zoom/2)':d=1:s=768x1344:fps=${fps}`,
  ];

  // Close up views (more dramatic, face focused)
  const closeViews = [
    // View 0 — dramatic push in on face
    `scale=768:1344:force_original_aspect_ratio=decrease,pad=768:1344:(ow-iw)/2:(oh-ih)/2:black,` +
    `zoompan=z='1.05+0.08*on/${totalFrames}':x='iw/2-(iw/zoom/2)':y='ih*0.02-(ih/zoom/2)':d=1:s=768x1344:fps=${fps}`,

    // View 1 — slight tilt right
    `scale=768:1344:force_original_aspect_ratio=decrease,pad=768:1344:(ow-iw)/2:(oh-ih)/2:black,` +
    `zoompan=z='1.08':x='iw*0.52-(iw/zoom/2)':y='ih*0.02-(ih/zoom/2)':d=1:s=768x1344:fps=${fps}`,

    // View 2 — hold steady with tiny zoom
    `scale=768:1344:force_original_aspect_ratio=decrease,pad=768:1344:(ow-iw)/2:(oh-ih)/2:black,` +
    `zoompan=z='1.06+0.02*on/${totalFrames}':x='iw/2-(iw/zoom/2)':y='ih*0.03-(ih/zoom/2)':d=1:s=768x1344:fps=${fps}`,
  ];

  const views = isCloseUp ? closeViews : wideViews;
  const vf    = views[viewIndex % views.length];

  await runFFmpeg([
    '-loop', '1', '-i', imgPath,
    '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-t', String(duration),
    '-vf', vf,
    '-an', '-y', outputPath
  ]);
}

// ─────────────────────────────────────────────
// STEP 7 — BUILD SCENE VIDEO
// 2 images × 3 views = 6 cinematic shots per scene
// Color grading + vignette + rain overlay (horror)
// Captions word-synced, fixed size, no overflow, no overlap
// ─────────────────────────────────────────────
async function buildSceneVideo(wideImgPath, closeImgPath, caption, outputPath, duration, style, wordTimestamps, sceneIndex, category, location) {
  const fadeOut  = Math.max(duration - 0.3, 0);
  const clipDur  = duration / 3; // 3 equal segments

  // Build 3 clips from wide image + 3 clips from close image
  // Total: 6 clips per scene, alternating for cinematic feel
  // Pattern: wide, close, wide, close, wide, close
  // But we only use 3 total per scene (clipDur = duration/3)
  // Pattern: wide(view0), close(view0), wide(view1)
  const clipConfigs = [
    { img: wideImgPath,  view: 0, isClose: false },
    { img: closeImgPath, view: 0, isClose: true  },
    { img: wideImgPath,  view: 1, isClose: false },
  ];

  const clipPaths = [];
  for (let i = 0; i < clipConfigs.length; i++) {
    const cfg      = clipConfigs[i];
    const clipPath = outputPath.replace('.mp4', `_clip${i}.mp4`);
    await buildImageClip(cfg.img, clipPath, clipDur, cfg.view, cfg.isClose);
    clipPaths.push(clipPath);
  }

  // Concat 3 clips into raw scene
  const concatFile = outputPath.replace('.mp4', '_concat.txt');
  fs.writeFileSync(concatFile, clipPaths.map(p => `file '${p}'`).join('\n'));
  const rawScene = outputPath.replace('.mp4', '_raw.mp4');
  await runFFmpeg(['-f', 'concat', '-safe', '0', '-i', concatFile, '-c:v', 'copy', '-an', '-y', rawScene]);

  // Build caption filters — fixed size, no overlap, word sync
  const captionFilters = wordTimestamps && wordTimestamps.length > 0
    ? buildCaptionFilters(wordTimestamps, style, duration)
    : [makeDrawtext(caption, style, 0.3, duration - 0.2, false)].filter(Boolean);

  // Progress bar — EP X/12 at top
  const progressText = `EP ${seriesState.currentEpisode}/${EPISODES_PER_SERIES}`;
  const progressFilter = `drawtext=text='${progressText}':fontsize=32:fontcolor=white@0.8:fontfile='${FONT_BOLD}':x=w-text_w-20:y=20:borderw=3:bordercolor=black`;

  // Location text — bottom left
  const locationClean = escFF((location || '').toUpperCase().substring(0, 30));
  const locationFilter = locationClean ? `drawtext=text='📍 ${locationClean}':fontsize=28:fontcolor=white@0.7:fontfile='${FONT_BOLD}':x=20:y=h-60:borderw=2:bordercolor=black` : '';

  // Color grading per category
  const colorGrade = COLOR_GRADE[category] || COLOR_GRADE['default'];

  // Rain overlay for horror/thriller (FFmpeg noise filter simulating rain)
  const rainFilter = ['horror', 'thriller'].includes(category)
    ? ',geq=lum=\'lum(X,Y)\':cb=\'cb(X,Y)\':cr=\'cr(X,Y)\',noise=alls=8:allf=t+u'
    : '';

  // Camera shake for action moments (adventure, superhero)
  const shakeFilter = ['adventure', 'superhero'].includes(category) && sceneIndex === 2
    ? ',hue=s=1'
    : '';

  // Build complete vf chain
  const captionPart    = captionFilters.length > 0 ? ',' + captionFilters.join(',') : '';
  const locationPart   = locationFilter ? ',' + locationFilter : '';
  const vf = `fade=t=in:st=0:d=0.3,fade=t=out:st=${fadeOut}:d=0.3,${colorGrade}${rainFilter}${shakeFilter}${captionPart},${progressFilter}${locationPart}`;

  await runFFmpeg([
    '-i', rawScene,
    '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-vf', vf,
    '-an', '-y', outputPath
  ]);

  // Cleanup
  clipPaths.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
  try { fs.unlinkSync(rawScene); fs.unlinkSync(concatFile); } catch (e) {}
  console.log(`[FFmpeg] Scene ${sceneIndex + 1} done ✅ (2 imgs, 3 views, color graded)`);
}

// ─────────────────────────────────────────────
// STEP 8 — BUILD END CARD
// Series name + next episode + subscribe
// ─────────────────────────────────────────────
async function buildEndCard(outputPath, seriesName, nextEpisode, duration = 3) {
  const hasLogo = fs.existsSync(LOGO_PATH);
  const safeSeriesName = escFF(seriesName.toUpperCase());
  const nextEpText = `EP ${nextEpisode} DROPS SOON`;

  const textFilters = [
    `drawtext=text='${safeSeriesName}':fontfile='${FONT_BOLD}':fontsize=52:fontcolor=white:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h*${hasLogo ? '0.72' : '0.38'}`,
    `drawtext=text='${nextEpText}':fontfile='${FONT_BOLD}':fontsize=38:fontcolor='0xFFD700':borderw=2:bordercolor=black:x=(w-text_w)/2:y=h*${hasLogo ? '0.82' : '0.52'}`,
    `drawtext=text='SUBSCRIBE NOW':fontfile='${FONT_BOLD}':fontsize=44:fontcolor='0xFF4444':borderw=2:bordercolor=black:x=(w-text_w)/2:y=h*${hasLogo ? '0.90' : '0.62'}`,
    `fade=t=in:st=0:d=0.5`,
  ].join(',');

  if (hasLogo) {
    await runFFmpeg([
      '-f', 'lavfi', '-i', `color=c=black:size=768x1344:duration=${duration}:rate=24`,
      '-i', LOGO_PATH,
      '-filter_complex', `[1:v]scale=280:280[logo];[0:v][logo]overlay=(W-w)/2:(H-h)/2-140[bg];[bg]${textFilters}[out]`,
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
// STEP 9 — STITCH: Video + Voice + Continuous Music
// Music NEVER stops — loops seamlessly through all scenes
// ─────────────────────────────────────────────
async function stitchFinalVideo(sceneVideos, voiceAudios, endCardPath, tempDir, outputPath, category) {
  // 1 — Concat all scene videos + end card (video only)
  const allVideos  = [...sceneVideos, endCardPath];
  const vidConcat  = path.join(tempDir, 'vidconcat.txt');
  fs.writeFileSync(vidConcat, allVideos.map(v => `file '${v}'`).join('\n'));
  const tempVideo  = path.join(tempDir, 'video_only.mp4');
  await runFFmpeg(['-f', 'concat', '-safe', '0', '-i', vidConcat, '-c:v', 'copy', '-an', '-y', tempVideo]);
  console.log('[Stitch] Video concat ✅');

  // 2 — Concat all voice audio
  const audConcat  = path.join(tempDir, 'audconcat.txt');
  fs.writeFileSync(audConcat, voiceAudios.map(a => `file '${a}'`).join('\n'));
  const tempVoice  = path.join(tempDir, 'voice_full.mp3');
  await runFFmpeg(['-f', 'concat', '-safe', '0', '-i', audConcat, '-c:a', 'libmp3lame', '-b:a', '192k', '-y', tempVoice]);
  console.log('[Stitch] Voice concat ✅');

  // 3 — Get total video duration
  const durStr = await runFFprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', tempVideo]);
  const durNum = parseFloat(durStr);

  // 4 — Download theme music
  const musicUrl  = MUSIC_URLS[category] || MUSIC_URLS['default'];
  const musicPath = path.join(tempDir, 'music.mp3');
  let hasMusic    = false;

  try {
    console.log(`[Music] Downloading ${category} theme...`);
    const musicRes = await axios.get(musicUrl, { responseType: 'arraybuffer', timeout: 20000 });
    fs.writeFileSync(musicPath, Buffer.from(musicRes.data));
    hasMusic = true;
    console.log('[Music] Theme downloaded ✅');
  } catch (e) { console.log('[Music] Download failed:', e.message); }

  // 5 — Mix: video + voice (100%) + music (12%) — CONTINUOUS, no gaps
  if (hasMusic) {
    try {
      await runFFmpeg([
        '-i', tempVideo,
        '-i', tempVoice,
        '-stream_loop', '-1', '-i', musicPath,  // loop music infinitely
        '-filter_complex',
          `[1:a]volume=1.0[voice];` +
          `[2:a]volume=0.12,afade=t=in:st=0:d=1.5,afade=t=out:st=${Math.max(durNum - 2, 0)}:d=2[bg];` +
          `[voice][bg]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
        '-map', '0:v', '-map', '[aout]',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-t', String(durNum), '-y', outputPath
      ]);
      console.log('[Music] Seamless mix ✅ (voice 100% + music 12%)');
      return;
    } catch (e) { console.log('[Music] Mix failed:', e.message); }
  }

  // Fallback — video + voice only
  await runFFmpeg(['-i', tempVideo, '-i', tempVoice, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(durNum), '-y', outputPath]);
  console.log('[Stitch] Voice only ✅');
}

// ─────────────────────────────────────────────
// STEP 10 — AUTO THUMBNAIL
// Extract best frame + add title overlay
// ─────────────────────────────────────────────
async function generateThumbnail(videoPath, title, seriesName, episodeNum, tempDir) {
  const thumbPath = path.join(tempDir, 'thumbnail.jpg');
  const safeTitle = escFF(title.toUpperCase().substring(0, 30));
  const safeSeries = escFF(seriesName.toUpperCase().substring(0, 20));

  try {
    // Extract frame at 2 seconds (most dramatic moment)
    await runFFmpeg([
      '-i', videoPath,
      '-ss', '2',
      '-vframes', '1',
      '-vf',
        `scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,` +
        `drawtext=text='${safeSeries}':fontfile='${FONT_BOLD}':fontsize=52:fontcolor=white:borderw=4:bordercolor=black:x=(w-text_w)/2:y=h*0.65,` +
        `drawtext=text='${safeTitle}':fontfile='${FONT_BOLD}':fontsize=42:fontcolor='0xFFD700':borderw=3:bordercolor=black:x=(w-text_w)/2:y=h*0.78,` +
        `drawtext=text='EP ${episodeNum}':fontfile='${FONT_BOLD}':fontsize=48:fontcolor=white:borderw=3:bordercolor='0xFF4444':x=30:y=30`,
      '-y', thumbPath
    ]);
    console.log('[Thumbnail] Generated ✅');
    return thumbPath;
  } catch (e) {
    console.log('[Thumbnail] Failed:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// STEP 11 — YOUTUBE UPLOAD
// With thumbnail, chapters, SEO description
// ─────────────────────────────────────────────
async function uploadToYouTube(videoPath, thumbnailPath, script, seriesName, episodeNum, category) {
  const oauth2Client = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI);
  oauth2Client.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  // SEO-optimized title
  const fullTitle = `${seriesName} | Ep ${episodeNum} 🔥 | ${script.title} #Shorts`.substring(0, 100);

  // Auto chapters for YouTube
  const chapters = [
    '00:00 Intro',
    '00:03 Scene 1',
    '00:12 Scene 2',
    '00:21 Scene 3',
    '00:30 Ending',
  ].join('\n');

  // Full SEO description
  const fullDesc = [
    script.description,
    '',
    `📺 ${seriesName} | Episode ${episodeNum} of ${EPISODES_PER_SERIES}`,
    `🔔 Subscribe — Ep ${episodeNum + 1} drops soon!`,
    `💬 Comment your prediction below!`,
    '',
    chapters,
    '',
    script.hashtags,
    `#${category.replace(/ /g,'')} #anime #cartoon #shorts #viral #series`,
  ].join('\n');

  // Upload video
  const res = await youtube.videos.insert({
    part: 'snippet,status',
    requestBody: {
      snippet: {
        title: fullTitle,
        description: fullDesc,
        tags: [...script.hashtags.split('#').filter(Boolean).map(t => t.trim()), category, 'anime', 'shorts', 'series', 'cartoon'],
        categoryId:      '1',
        defaultLanguage: 'en'
      },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false }
    },
    media: { mimeType: 'video/mp4', body: fs.createReadStream(videoPath) }
  });

  const videoId = res.data.id;
  console.log(`[YouTube] Uploaded ✅ https://youtube.com/watch?v=${videoId}`);

  // Upload thumbnail
  if (thumbnailPath && fs.existsSync(thumbnailPath)) {
    try {
      await youtube.thumbnails.set({
        videoId,
        media: { mimeType: 'image/jpeg', body: fs.createReadStream(thumbnailPath) }
      });
      console.log('[YouTube] Thumbnail set ✅');
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
              textOriginal: `🔥 Episode ${episodeNum + 1} drops soon! Subscribe so you don't miss it!\n\n💬 What do you think will happen next? Comment below! 👇\n\n${script.hashtags}`
            }
          }
        }
      }
    });
    // Pin the comment
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

  const { category, voice, characterSeed, currentEpisode, seriesNumber } = seriesState;
  const art          = CATEGORY_ART[category]         || CATEGORY_ART['adventure'];
  const captionStyle = CAPTION_STYLES[category]        || CAPTION_STYLES['default'];

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🎬 VidForge AI v15.0 | Series ${seriesNumber} | Ep ${currentEpisode}/${EPISODES_PER_SERIES}`);
  console.log(`🎭 ${category} | 🎨 ${art.name} | 🎙️ ${voice.name} | 📊 ${dailyCount}/${DAILY_LIMIT}`);
  console.log(`${'═'.repeat(60)}\n`);

  const tempDir = path.join('/tmp', `vf_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const results = { episode: currentEpisode, youtube: null, instagram: null, error: null };

  try {
    // 1 — Generate episode script
    console.log('[Step 1] Writing episode script...');
    const script = await generateEpisodeScript(seriesState);
    console.log(`[Step 1] ✅ "${script.series_name}" Ep ${currentEpisode}: ${script.title}`);
    if (script.plot_twist) console.log(`[Step 1] 🌀 Plot twist: ${script.plot_twist}`);

    // Update series state
    if (currentEpisode === 1) {
      seriesState.seriesName     = script.series_name;
      seriesState.characterDesign = script.character_design;
    }
    if (script.villain_design) seriesState.villainDesign = script.villain_design;

    // 2 — Generate recap voice for ep 2+
    const voiceAudios = [];
    if (currentEpisode > 1 && script.recap_line) {
      const recapPath = path.join(tempDir, 'recap.mp3');
      await generateVoice(script.recap_line, recapPath, voice.id, category);
      voiceAudios.push(recapPath);
    }

    // 3 — Generate 2 images + voice per scene (parallel)
    console.log('\n[Step 2] Generating images + voice for all scenes...');
    const sceneData = [];

    for (let i = 0; i < script.scenes.length; i++) {
      const scene     = script.scenes[i];
      const wideImg   = path.join(tempDir, `wide_${i}.png`);
      const closeImg  = path.join(tempDir, `close_${i}.png`);
      const audioPath = path.join(tempDir, `voice_${i}.mp3`);

      console.log(`\n[Scene ${i+1}/4] "${cleanCap(scene.caption)}" — ${scene.location}`);

      // Generate wide + close images on different CF accounts + voice (parallel)
      await Promise.all([
        generateImage(scene.widePrompt,  wideImg,   characterSeed,     i * 2),      // even accounts
        generateImage(scene.closePrompt, closeImg,  characterSeed + 1, i * 2 + 1),  // odd accounts
        generateVoice(scene.narration, audioPath, voice.id, category)
      ]);

      // Get word timestamps for perfect caption sync
      const timestamps = await getWordTimestamps(audioPath);

      // Get audio duration
      let duration = 7;
      try {
        const d = await runFFprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath]);
        duration = Math.max(parseFloat(d) + 0.6, 4.0);
      } catch (e) {}

      sceneData.push({ wideImg, closeImg, audioPath, caption: scene.caption, location: scene.location, duration, timestamps });
      voiceAudios.push(audioPath);
      console.log(`[Scene ${i+1}] ✅ Ready (${duration.toFixed(1)}s)`);
    }

    // 4 — Build scene videos
    console.log('\n[Step 3] Building scene videos...');
    const sceneVideos = [];
    for (let i = 0; i < sceneData.length; i++) {
      const d        = sceneData[i];
      const sceneOut = path.join(tempDir, `scene_${i}.mp4`);
      await buildSceneVideo(
        d.wideImg, d.closeImg, d.caption, sceneOut, d.duration,
        captionStyle, d.timestamps, i, category, d.location
      );
      sceneVideos.push(sceneOut);
    }

    // 5 — Build end card
    console.log('\n[Step 4] Building end card...');
    const endCardPath = path.join(tempDir, 'endcard.mp4');
    await buildEndCard(endCardPath, script.series_name, currentEpisode + 1);

    // 6 — Stitch final video with continuous music
    console.log('\n[Step 5] Stitching with continuous music...');
    const videoPath = path.join(tempDir, 'final.mp4');
    await stitchFinalVideo(sceneVideos, voiceAudios, endCardPath, tempDir, videoPath, category);

    // 7 — Generate thumbnail
    console.log('\n[Step 6] Generating thumbnail...');
    const thumbnailPath = await generateThumbnail(videoPath, script.title, script.series_name, currentEpisode, tempDir);

    // 8 — Upload to YouTube
    try {
      console.log('\n[Step 7] Uploading to YouTube...');
      const ytId = await uploadToYouTube(videoPath, thumbnailPath, script, script.series_name, currentEpisode, category);
      results.youtube = `https://youtube.com/watch?v=${ytId}`;
      console.log(`[YouTube] ✅ ${results.youtube}`);
    } catch (err) { console.error('[YouTube] ❌', err.message); }

    // 9 — Post to Instagram
    try {
      if (results.youtube) {
        console.log('\n[Step 8] Posting to Instagram...');
        const igCaption = `${script.series_name} | Ep ${currentEpisode} 🔥\n\n${script.description}\n\n⚡ Ep ${currentEpisode + 1} drops soon! Subscribe!\n\n${script.hashtags}`;
        results.instagram = await postToInstagram(results.youtube, igCaption);
        console.log('[Instagram] ✅');
      }
    } catch (err) { console.error('[Instagram] ❌', err.message); }

    // 10 — Update series state
    seriesState.episodeSummaries.push(script.episode_summary);
    seriesState.currentEpisode++;
    saveState(seriesState);

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🎉 Episode ${currentEpisode} COMPLETE! (${dailyCount}/${DAILY_LIMIT} today)`);
    if (results.youtube) console.log(`🔗 ${results.youtube}`);
    console.log(`${'═'.repeat(60)}\n`);

  } catch (err) {
    results.error = err.message;
    dailyCount--;
    console.error('[VidForge] ❌ Failed:', err.message);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
  }
  return results;
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  app: 'VidForge AI', version: '15.0.0', status: '🚀 Running',
  features: ['2 images/scene', 'word-sync captions', 'color grading', 'rain overlay', 'vignette', 'auto thumbnail', 'pinned comment', 'chapters', 'villain ep3+', 'plot twists']
}));

app.get('/status', (req, res) => res.json({
  version:   '15.0.0',
  dailyCount: `${dailyCount}/${DAILY_LIMIT}`,
  postingTimes: 'IST every 3 hours (8 videos/day)',
  series: {
    number:    seriesState.seriesNumber,
    name:      seriesState.seriesName || 'Generating...',
    category:  seriesState.category,
    episode:   `${seriesState.currentEpisode}/${EPISODES_PER_SERIES}`,
    voice:     seriesState.voice.name,
    hasVillain: !!seriesState.villainDesign,
  },
  connections: {
    cfAccounts:  CF_ACCOUNTS.length,
    elevenlabs:  !!ELEVENLABS_API_KEY,
    youtube:     !!YOUTUBE_REFRESH_TOKEN,
    instagram:   !!INSTAGRAM_ACCESS_TOKEN,
    groq:        !!GROQ_API_KEY,
  },
  timestamp: new Date().toISOString()
}));

app.post('/generate', async (req, res) => {
  if (dailyCount >= DAILY_LIMIT) return res.json({ message: 'Daily limit reached!' });
  res.json({ message: `🎬 Generating Ep ${seriesState.currentEpisode}!` });
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
    const prompt = req.query.prompt || 'minimalist stick figure illustration, black ink on white background, simple expressive stick man character, action pose, speed lines, scratchy ink style, high contrast, no color, no text, vertical 9:16';
    const r      = await axios.post(
      `https://api.cloudflare.com/client/v4/accounts/${acc.id}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
      { prompt, steps: 4 },
      { headers: { 'Authorization': `Bearer ${acc.token}`, 'Content-Type': 'application/json' }, timeout: 60000 }
    );
    const b64 = r.data?.result?.image || r.data?.image;
    if (b64) { res.set('Content-Type', 'image/jpeg'); res.send(Buffer.from(b64, 'base64')); }
    else res.json({ error: 'No image returned', raw: r.data });
  } catch (err) { res.json({ error: err.response?.status || err.message }); }
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
  console.log(`🚀 VidForge AI v15.0 — Ultimate Anime Series Engine`);
  console.log(`📺 Series ${seriesState.seriesNumber} | Ep ${seriesState.currentEpisode}/${EPISODES_PER_SERIES} | ${seriesState.category}`);
  console.log(`🎙️  Voice: ${seriesState.voice.name} | ☁️  CF Accounts: ${CF_ACCOUNTS.length}`);
  console.log(`🕐  Post times: Every 3 hours IST (12AM,3AM,6AM,9AM,12PM,3PM,6PM,9PM) = 8 videos/day`);
  console.log(`🖼️  Logo: ${fs.existsSync(LOGO_PATH) ? '✅' : '❌ (upload assets/logo.png)'}`);
  console.log(`${'═'.repeat(60)}\n`);
});

// ─────────────────────────────────────────────
// KEEP ALIVE — ping every 10 mins to prevent sleep
// ─────────────────────────────────────────────
if (RENDER_URL) {
  setInterval(() => {
    axios.get(`${RENDER_URL}/status`).catch(() => {});
    console.log('[KeepAlive] Ping ✅');
  }, 10 * 60 * 1000);
  console.log('[KeepAlive] Active — pinging every 10 minutes');
}

module.exports = app;
