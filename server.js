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
// SERIES STATE — stored in Render env var to persist restarts
// ─────────────────────────────────────────────
const EPISODES_PER_SERIES = 12;
const LOGO_PATH = path.join(__dirname, 'assets', 'logo.png');

const SERIES_CATEGORIES = ['horror', 'adventure', 'mystery', 'thriller', 'fantasy', 'science fiction', 'superhero', 'motivation'];
const SERIES_VOICES = [
  { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh',   desc: 'deep narrator' },
  { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', desc: 'calm clear' },
  { id: 'VR6AewLTigWG4xSOukaG', name: 'Arnold', desc: 'strong intense' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella',  desc: 'warm soft' },
  { id: 'yoZ06aMxZJJ28mfd3POQ', name: 'Sam',    desc: 'raspy intense' },
];

// State stored in memory + JSON file (best effort persistence)
const STATE_FILE = path.join('/tmp', 'vidforge_series.json');

function loadState() {
  // Try env var first (survives redeploys if set manually)
  if (process.env.SERIES_STATE) {
    try { return JSON.parse(process.env.SERIES_STATE); } catch (e) {}
  }
  // Try file
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {}
  return null;
}

function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) {}
  // Also save to a persistent location if available
  try {
    const persistPath = path.join(__dirname, 'series_state.json');
    fs.writeFileSync(persistPath, JSON.stringify(state, null, 2));
  } catch (e) {}
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
    currentEpisode:   1,
    episodeSummaries: [],
    createdAt:        new Date().toISOString()
  };
}

let seriesState = loadState() || createNewSeries(0);
saveState(seriesState);

// ─────────────────────────────────────────────
// ART STYLES — NSFW safe (no trigger words)
// ─────────────────────────────────────────────
const CATEGORY_ART_STYLE = {
  'horror':          { name: 'Dramatic Anime',   prompt: 'dramatic cinematic anime style, intense glowing eyes, detailed shading, mysterious powerful atmosphere, sharp lines, expressive character' },
  'thriller':        { name: 'Dramatic Anime',   prompt: 'dramatic cinematic anime style, intense focused expression, detailed shading, suspenseful atmosphere, sharp clean lines, powerful character' },
  'mystery':         { name: 'Noir Anime',       prompt: 'cinematic noir anime style, moody dramatic shadows, muted palette with single vivid accent color, mysterious atmosphere, detailed linework' },
  'adventure':       { name: 'Anime Manga',      prompt: 'vibrant anime manga style, large expressive eyes, dynamic action pose, bright saturated colors, speed energy lines, detailed shading, epic' },
  'superhero':       { name: 'Comic Hero',       prompt: 'american comic book style, bold ink outlines, dynamic powerful pose, halftone shading, primary bold colors, heroic aesthetic, dramatic lighting' },
  'motivation':      { name: 'Anime Manga',      prompt: 'inspirational anime style, determined fierce expression, glowing golden aura, dynamic powerful pose, vibrant warm colors, motivational energy' },
  'mindset':         { name: 'Anime Manga',      prompt: 'inspirational anime style, focused fierce expression, glowing aura, vibrant colors, motivational energy, clean sharp linework' },
  'comedy':          { name: 'Chibi Cartoon',    prompt: 'chibi cartoon style, oversized round head, tiny body, huge sparkly eyes, bold black outlines, flat bright colors, kawaii, exaggerated funny expression' },
  'kids':            { name: 'Storybook',        prompt: 'childrens storybook illustration, soft watercolor textures, pastel colors, whimsical cute characters, gentle lines, fairy tale aesthetic' },
  'romance':         { name: 'Shojo Anime',      prompt: 'shojo anime style, soft glowing background, large beautiful expressive eyes, pastel colors, floral accents, warm emotional expression' },
  'fantasy':         { name: 'Fantasy Art',      prompt: 'epic fantasy illustration, painterly style, magical glowing effects, rich jewel colors, detailed ornate costume, cinematic lighting' },
  'folklore':        { name: 'Fantasy Art',      prompt: 'traditional folklore illustration, painterly warm colors, mythical magical atmosphere, detailed cultural costume, ancient aesthetic' },
  'science fiction': { name: 'Cyberpunk Anime',  prompt: 'cyberpunk anime style, vivid neon accent colors, futuristic setting, holographic effects, detailed tech outfit, dramatic atmospheric background' },
  'historical':      { name: 'Retro Cartoon',    prompt: 'classic retro cartoon style, warm muted colors, vintage illustration aesthetic, detailed period costume, nostalgic storybook quality' },
  'nature':          { name: 'Watercolor',       prompt: 'soft watercolor illustration, natural earth tones, expressive brushwork, lush background, peaceful serene atmosphere, detailed nature elements' },
  'life lesson':     { name: 'Pixar 3D',         prompt: 'pixar 3d animation style, smooth surfaces, highly expressive cartoon face, warm colorful background, disney quality lighting, emotional expression' },
};

// 1 image per scene — 3 subtle FFmpeg crops for cinematic variety
// No extra CF calls needed

// ─────────────────────────────────────────────
// CAPTION STYLES
// ─────────────────────────────────────────────
const FONT_BOLD    = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_OBLIQUE = '/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf';
const FONT_MONO    = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf';

const ALL_CAPTION_STYLES = {
  'Beast':         { name: 'Beast',         fontfile: FONT_BOLD,    fontsize: 80, fontcolor: 'white',     borderw: 8, bordercolor: 'black',        box: false },
  'Red Highlight': { name: 'Red Highlight', fontfile: FONT_BOLD,    fontsize: 62, fontcolor: 'white',     borderw: 3, bordercolor: 'black@0.8',    box: true,  boxcolor: '0xE6194B@0.85', boxborderw: 16 },
  'Sleek Dark':    { name: 'Sleek Dark',    fontfile: FONT_BOLD,    fontsize: 52, fontcolor: 'white',     borderw: 2, bordercolor: 'black@0.9',    box: true,  boxcolor: 'black@0.55',    boxborderw: 14 },
  'Purple Pop':    { name: 'Purple Pop',    fontfile: FONT_BOLD,    fontsize: 58, fontcolor: 'white',     borderw: 2, bordercolor: 'black@0.7',    box: true,  boxcolor: '0x7C3AED@0.85', boxborderw: 16 },
  'Majestic':      { name: 'Majestic',      fontfile: FONT_OBLIQUE, fontsize: 56, fontcolor: '0xFFE9B0', borderw: 4, bordercolor: 'black@0.85',   box: false },
  'Bold White':    { name: 'Bold White',    fontfile: FONT_BOLD,    fontsize: 68, fontcolor: 'white',     borderw: 6, bordercolor: 'black@0.95',   box: false },
  'Gold':          { name: 'Gold',          fontfile: FONT_BOLD,    fontsize: 60, fontcolor: '0xFFD700', borderw: 4, bordercolor: 'black@0.9',    box: false },
  'Pink Cute':     { name: 'Pink Cute',     fontfile: FONT_OBLIQUE, fontsize: 54, fontcolor: '0xFF69B4', borderw: 3, bordercolor: 'white@0.8',    box: true,  boxcolor: 'white@0.2',     boxborderw: 12 },
  'Cyan Sci-Fi':   { name: 'Cyan Sci-Fi',   fontfile: FONT_MONO,    fontsize: 48, fontcolor: '0x00FFFF', borderw: 2, bordercolor: '0x0000FF@0.7', box: true,  boxcolor: 'black@0.7',     boxborderw: 12 },
  'Neon Green':    { name: 'Neon Green',    fontfile: FONT_MONO,    fontsize: 46, fontcolor: '0x39FF88', borderw: 2, bordercolor: 'black@0.8',    box: true,  boxcolor: 'black@0.6',     boxborderw: 12 },
};

const CATEGORY_CAPTION = {
  'horror': 'Beast', 'thriller': 'Red Highlight', 'mystery': 'Sleek Dark',
  'adventure': 'Bold White', 'superhero': 'Beast', 'motivation': 'Gold',
  'mindset': 'Gold', 'comedy': 'Purple Pop', 'kids': 'Pink Cute',
  'romance': 'Majestic', 'fantasy': 'Majestic', 'folklore': 'Majestic',
  'science fiction': 'Cyan Sci-Fi', 'historical': 'Bold White',
  'nature': 'Sleek Dark', 'life lesson': 'Gold',
};

// ─────────────────────────────────────────────
// MUSIC
// ─────────────────────────────────────────────
const CATEGORY_MUSIC = {
  'horror': 'dark.mp3', 'thriller': 'dark.mp3', 'mystery': 'dark.mp3',
  'adventure': 'adventure.mp3', 'superhero': 'adventure.mp3',
  'motivation': 'motivation.mp3', 'mindset': 'motivation.mp3',
  'comedy': 'comedy.mp3', 'kids': 'kids.mp3',
  'romance': 'romance.mp3', 'folklore': 'romance.mp3',
  'fantasy': 'fantasy.mp3', 'nature': 'fantasy.mp3',
  'science fiction': 'scifi.mp3',
  'historical': 'emotional.mp3', 'life lesson': 'emotional.mp3',
};

function getMusicPath(category) {
  const file = CATEGORY_MUSIC[category] || 'general.mp3';
  const p = path.join(__dirname, 'music', file);
  if (fs.existsSync(p)) return p;
  const g = path.join(__dirname, 'music', 'general.mp3');
  if (fs.existsSync(g)) return g;
  return null;
}

let dailyCount    = 0;
const DAILY_LIMIT = 15;
let cfAccountIndex = 0;

cron.schedule('0 0 * * *', () => { dailyCount = 0; console.log('[VidForge] Daily reset!'); });
cron.schedule('*/96 * * * *', () => {
  if (dailyCount < DAILY_LIMIT) runPostingCycle();
  else console.log('[Cron] Daily limit reached.');
});

// ─────────────────────────────────────────────
// STEP 1 — GROQ: Episode Script
// ─────────────────────────────────────────────
async function generateEpisodeScript(state) {
  const { category, currentEpisode, characterDesign, seriesName, episodeSummaries } = state;
  const artStyle  = CATEGORY_ART_STYLE[category] || CATEGORY_ART_STYLE['adventure'];
  const isFirstEp = currentEpisode === 1;
  const isLastEp  = currentEpisode === EPISODES_PER_SERIES;
  const prevSummary = episodeSummaries.length > 0 ? episodeSummaries[episodeSummaries.length - 1] : null;

  const seriesContext = isFirstEp ? '' : `
SERIES: "${seriesName}" | EPISODE: ${currentEpisode}/${EPISODES_PER_SERIES}
CHARACTER: ${characterDesign}
PREVIOUS EPISODE: ${prevSummary}
STORY SO FAR: ${episodeSummaries.slice(-3).join(' → ')}
Continue EXACTLY where last episode ended. Show character growth. Build toward finale.`;

  const endingRule = isLastEp
    ? 'SERIES FINALE — epic satisfying conclusion, hint at new adventure'
    : `End on CLIFFHANGER — stop mid-action, leave viewers desperate for Ep ${currentEpisode + 1}`;

  const prompt = `Write Episode ${currentEpisode} of a viral ${category} cartoon series for YouTube Shorts.
${seriesContext}
Art style: ${artStyle.name}

Rules:
- ${isFirstEp ? 'Introduce ONE iconic main character — make them instantly memorable' : 'Continue naturally from previous episode'}
- Hook viewer in first 2 seconds
- Rising tension each scene
- ${endingRule}
- Natural conversational storytelling voice
- Captions: MAX 4 WORDS, ALL CAPS, ENGLISH LETTERS AND SPACES ONLY

Return ONLY JSON, no markdown:
{
  "series_name": "${isFirstEp ? 'Epic 2-3 word series name' : seriesName}",
  "title": "Episode title under 35 chars",
  "character_design": "${isFirstEp ? 'Precise character: species, colors, outfit, unique features — very specific' : characterDesign}",
  "episode_summary": "2 sentence summary of THIS episode for next episode context",
  "description": "2 sentence YouTube description with emojis",
  "hashtags": "#cartoon #shorts #viral #anime #ep${currentEpisode} #${category.replace(/ /g, '')} #series #fyp #trending",
  "recap_line": "${isFirstEp ? '' : 'One sentence recap starting with: Last time...'}",
  "scenes": [
    { "narration": "Scene 1 narration", "caption": "HOOK", "emotion": "character emotion, pose, action, background" },
    { "narration": "Scene 2 narration", "caption": "BUILD", "emotion": "character emotion, pose, action, background" },
    { "narration": "Scene 3 narration", "caption": "CLIMAX", "emotion": "character emotion, pose, action, background" },
    { "narration": "Scene 4 narration", "caption": "CLIFFHANGER", "emotion": "character emotion, pose, action, background" }
  ]
}`;

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 1600, temperature: 0.9 },
    { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
  );

  const script = JSON.parse(response.data.choices[0].message.content.replace(/```json|```/g, '').trim());
  script.artStyle = artStyle;

  // Build 1 image prompt per scene — character centered, full body for best crop results
  script.scenes = script.scenes.map((scene, i) => ({
    ...scene,
    imagePrompt: `${artStyle.prompt}, ${script.character_design}, ${scene.emotion}, full body character centered in frame, detailed background, vertical 9:16 portrait, no text, no watermark, vibrant, high quality`
  }));

  return script;
}

// ─────────────────────────────────────────────
// STEP 2 — CF WORKERS AI: Image (flux-1-schnell)
// Same characterSeed across ALL scenes for consistency
// ─────────────────────────────────────────────
async function generateCartoonImage(prompt, outputPath, seed) {
  if (CF_ACCOUNTS.length > 0) {
    for (let i = 0; i < CF_ACCOUNTS.length; i++) {
      const account = CF_ACCOUNTS[cfAccountIndex % CF_ACCOUNTS.length];
      cfAccountIndex++;
      try {
        console.log(`[Image] CF Account ${i + 1}/${CF_ACCOUNTS.length}`);
        const response = await axios.post(
          `https://api.cloudflare.com/client/v4/accounts/${account.id}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
          { prompt, steps: 4, seed },
          { headers: { 'Authorization': `Bearer ${account.token}`, 'Content-Type': 'application/json' }, timeout: 90000 }
        );
        const b64 = response.data?.result?.image || response.data?.image;
        if (b64 && b64.length > 1000) {
          fs.writeFileSync(outputPath, Buffer.from(b64, 'base64'));
          console.log(`[Image] CF ✅`);
          return;
        }
      } catch (err) {
        const msg = err.response?.data?.errors?.[0]?.message || err.message;
        console.log(`[Image] CF ${i + 1} failed: ${msg.substring(0, 80)}`);
        if (msg.includes('daily free allocation') || msg.includes('neurons')) break;
      }
    }
  }
  // Picsum fallback
  const res = await axios({ method: 'GET', url: `https://picsum.photos/seed/${seed}/576/1024`, responseType: 'arraybuffer', timeout: 30000 });
  fs.writeFileSync(outputPath, Buffer.from(res.data));
  console.log('[Image] Picsum fallback ✅');
}

// ─────────────────────────────────────────────
// STEP 3 — VOICE: ElevenLabs → Google TTS
// ─────────────────────────────────────────────
async function generateVoice(text, outputPath, voiceId) {
  const cleanText = text.replace(/['"]/g, '').substring(0, 250);

  if (ELEVENLABS_API_KEY && voiceId) {
    try {
      const response = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        { text: cleanText, model_id: 'eleven_monolingual_v1', voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true } },
        { headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' }, responseType: 'arraybuffer', timeout: 30000 }
      );
      if (response.data && response.data.byteLength > 1000) {
        fs.writeFileSync(outputPath, Buffer.from(response.data));
        console.log('[Voice] ElevenLabs ✅');
        return;
      }
    } catch (err) { console.log(`[Voice] ElevenLabs failed: ${err.response?.status || err.message}`); }
  }

  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(cleanText)}&tl=en&client=tw-ob&ttsspeed=0.85`;
  const response = await axios({ method: 'GET', url, responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } });
  fs.writeFileSync(outputPath, Buffer.from(response.data));
  console.log('[Voice] Google TTS ✅');
}

// ─────────────────────────────────────────────
// STEP 4 — WHISPER: Word timestamps
// ─────────────────────────────────────────────
async function getWordTimestamps(audioPath) {
  try {
    const form = new FormData();
    form.append('file', fs.createReadStream(audioPath), { filename: 'audio.mp3', contentType: 'audio/mpeg' });
    form.append('model', 'whisper-large-v3');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    form.append('language', 'en');
    const response = await axios.post(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      form,
      { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, ...form.getHeaders() }, timeout: 60000 }
    );
    const words = response.data?.words || [];
    console.log(`[Whisper] ${words.length} timestamps ✅`);
    return words;
  } catch (err) {
    console.log(`[Whisper] Failed: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────
// STEP 5 — FFMPEG: Caption helpers
// FIXED: no overflow, auto font-size, no overlap
// ─────────────────────────────────────────────
function cleanCaption(t) {
  return t.toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .substring(0, 25)
    .trim();
}

function escFF(t) { return t.replace(/\\/g, '\\\\').replace(/'/g, '').replace(/:/g, '\\:'); }

function makeDrawtext(text, style, startT, endT) {
  const raw = cleanCaption(text);
  if (!raw) return null;
  // Auto-shrink font for longer text
  let fs2 = style.fontsize;
  if (raw.length > 10) fs2 = Math.floor(fs2 * 0.85);
  if (raw.length > 16) fs2 = Math.floor(fs2 * 0.75);
  const t = escFF(raw);
  // Always centered, lower third, within safe zone
  let f = `drawtext=text='${t}':fontsize=${fs2}:fontcolor=${style.fontcolor}:fontfile='${style.fontfile}':x=(w-text_w)/2:y=h*0.82:borderw=${style.borderw}:bordercolor=${style.bordercolor}:enable='between(t,${startT.toFixed(3)},${endT.toFixed(3)})'`;
  if (style.box) f += `:box=1:boxcolor=${style.boxcolor}:boxborderw=${style.boxborderw}`;
  return f;
}

// ─────────────────────────────────────────────
// STEP 5b — Build single image clip (video only, no audio)
// Used for 3 clips per scene
// ─────────────────────────────────────────────
// 3 subtle crop views from 1 image — same character, different feel
// View 0: Full frame, very slow zoom in
// View 1: Slight pan up (5%) to show face more, gentle zoom
// View 2: Subtle zoom on upper body/face area (top 70% of frame)
async function buildImageClip(imgPath, outputPath, duration, viewIndex) {
  const fps = 24;
  const totalFrames = Math.ceil(duration * fps);

  const views = [
    // View 0 — Full frame, very slow zoom in (100% → 104%)
    `scale=768:1344:force_original_aspect_ratio=decrease,pad=768:1344:(ow-iw)/2:(oh-ih)/2:black,` +
    `zoompan=z='1+0.04*on/${totalFrames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=768x1344:fps=${fps}`,

    // View 1 — Slight upward shift + tiny zoom (shows face better)
    `scale=768:1344:force_original_aspect_ratio=decrease,pad=768:1344:(ow-iw)/2:(oh-ih)/2:black,` +
    `zoompan=z='1.04+0.02*on/${totalFrames}':x='iw/2-(iw/zoom/2)':y='ih*0.02-(ih/zoom/2)+ih*0.02*on/${totalFrames}':d=1:s=768x1344:fps=${fps}`,

    // View 2 — Subtle zoom into upper portion (face/chest area)
    `scale=768:1344:force_original_aspect_ratio=decrease,pad=768:1344:(ow-iw)/2:(oh-ih)/2:black,` +
    `zoompan=z='1.06+0.02*on/${totalFrames}':x='iw/2-(iw/zoom/2)':y='ih*0.05-(ih/zoom/2)':d=1:s=768x1344:fps=${fps}`,
  ];

  const vf = views[viewIndex % views.length];
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
// STEP 5c — Build scene: 3 images + captions (video only)
// ─────────────────────────────────────────────
async function buildSceneVideo(imgPath, caption, outputPath, duration, style, wordTimestamps, sceneIndex) {
  const fadeOut = Math.max(duration - 0.3, 0);
  const clipDur = duration / 3; // 3 views, equal duration each

  // Build 3 subtle crop views from same 1 image
  const clipPaths = [];
  for (let i = 0; i < 3; i++) {
    const clipPath = outputPath.replace('.mp4', `_clip${i}.mp4`);
    await buildImageClip(imgPath, clipPath, clipDur, i); // view 0, 1, 2
    clipPaths.push(clipPath);
  }

  // Concat image clips into scene video
  const concatFile = outputPath.replace('.mp4', '_concat.txt');
  fs.writeFileSync(concatFile, clipPaths.map(p => `file '${p}'`).join('\n'));
  const rawScene = outputPath.replace('.mp4', '_raw.mp4');
  await runFFmpeg(['-f', 'concat', '-safe', '0', '-i', concatFile, '-c:v', 'copy', '-an', '-y', rawScene]);

  // Build caption filters
  let textFilters = [];
  if (wordTimestamps && wordTimestamps.length > 0) {
    const chunks = [];
    let i = 0;
    while (i < wordTimestamps.length) {
      const chunk = wordTimestamps.slice(i, Math.min(i + 3, wordTimestamps.length));
      chunks.push({ text: chunk.map(w => w.word).join(' '), start: chunk[0].start, end: chunk[chunk.length - 1].end });
      i += 3;
    }
    for (let j = 0; j < chunks.length; j++) {
      const startT   = Math.max(chunks[j].start - 0.05, 0);
      const nextStart = j + 1 < chunks.length ? chunks[j + 1].start : duration;
      const endT     = Math.min(chunks[j].end + 0.08, nextStart - 0.05, duration);
      const f = makeDrawtext(chunks[j].text, style, startT, endT);
      if (f) textFilters.push(f);
    }
    console.log(`[Caption] ${chunks.length} chunks ✅`);
  } else {
    const f = makeDrawtext(caption, style, 0.3, duration - 0.2);
    if (f) textFilters.push(f);
  }

  // Add fade + captions to raw scene
  const textPart = textFilters.length > 0 ? ',' + textFilters.join(',') : '';
  const vf = `fade=t=in:st=0:d=0.3,fade=t=out:st=${fadeOut}:d=0.3${textPart}`;

  await runFFmpeg([
    '-i', rawScene,
    '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-vf', vf,
    '-an', '-y', outputPath
  ]);

  // Cleanup temp clips
  clipPaths.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
  try { fs.unlinkSync(rawScene); fs.unlinkSync(concatFile); } catch (e) {}

  console.log(`[FFmpeg] Scene ${sceneIndex + 1} done ✅`);
}

// ─────────────────────────────────────────────
// STEP 6 — End card with logo
// Last 3 seconds: dark overlay + logo + subscribe text
// ─────────────────────────────────────────────
async function buildEndCard(outputPath, seriesName, nextEpisode, duration = 3) {
  const hasLogo = fs.existsSync(LOGO_PATH);

  if (hasLogo) {
    // Black background + logo + text
    await runFFmpeg([
      '-f', 'lavfi', '-i', `color=c=black:size=768x1344:duration=${duration}:rate=24`,
      '-i', LOGO_PATH,
      '-filter_complex',
        `[1:v]scale=300:300[logo];` +
        `[0:v][logo]overlay=(W-w)/2:(H-h)/2-120[bg];` +
        `[bg]drawtext=text='${escFF(seriesName.toUpperCase())}':fontfile='${FONT_BOLD}':fontsize=52:fontcolor=white:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h*0.72,` +
        `drawtext=text='EP ${nextEpisode} DROPS IN 96 MINS':fontfile='${FONT_BOLD}':fontsize=38:fontcolor='0xFFD700':borderw=2:bordercolor=black:x=(w-text_w)/2:y=h*0.82,` +
        `drawtext=text='SUBSCRIBE NOW':fontfile='${FONT_BOLD}':fontsize=42:fontcolor='0xFF4444':borderw=2:bordercolor=black:x=(w-text_w)/2:y=h*0.90,` +
        `fade=t=in:st=0:d=0.5[out]`,
      '-map', '[out]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-an', '-y', outputPath
    ]);
  } else {
    // No logo — just text on black
    await runFFmpeg([
      '-f', 'lavfi', '-i', `color=c=black:size=768x1344:duration=${duration}:rate=24`,
      '-vf',
        `drawtext=text='${escFF(seriesName.toUpperCase())}':fontfile='${FONT_BOLD}':fontsize=56:fontcolor=white:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h*0.38,` +
        `drawtext=text='EP ${nextEpisode} DROPS IN 96 MINS':fontfile='${FONT_BOLD}':fontsize=40:fontcolor='0xFFD700':borderw=2:bordercolor=black:x=(w-text_w)/2:y=h*0.52,` +
        `drawtext=text='SUBSCRIBE NOW':fontfile='${FONT_BOLD}':fontsize=46:fontcolor='0xFF4444':borderw=2:bordercolor=black:x=(w-text_w)/2:y=h*0.62,` +
        `fade=t=in:st=0:d=0.5`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-an', '-y', outputPath
    ]);
  }
  console.log(`[EndCard] Built ✅ (logo: ${hasLogo})`);
}

// ─────────────────────────────────────────────
// STEP 7 — STITCH: Seamless — video + voice + music
// FIXED: music continuous, no gaps ever
// ─────────────────────────────────────────────
async function stitchFinalVideo(sceneVideos, voiceAudios, endCardPath, tempDir, outputPath, category) {
  // 1 — Concat all scene videos + end card (video only)
  const allVideos = [...sceneVideos, endCardPath];
  const vidConcatFile = path.join(tempDir, 'vidconcat.txt');
  fs.writeFileSync(vidConcatFile, allVideos.map(v => `file '${v}'`).join('\n'));
  const tempVideo = path.join(tempDir, 'video_only.mp4');
  await runFFmpeg(['-f', 'concat', '-safe', '0', '-i', vidConcatFile, '-c:v', 'copy', '-an', '-y', tempVideo]);
  console.log('[Stitch] Video concat ✅');

  // 2 — Concat all voice audio into one continuous track
  const audConcatFile = path.join(tempDir, 'audconcat.txt');
  fs.writeFileSync(audConcatFile, voiceAudios.map(a => `file '${a}'`).join('\n'));
  const tempVoice = path.join(tempDir, 'voice_full.mp3');
  await runFFmpeg(['-f', 'concat', '-safe', '0', '-i', audConcatFile, '-c:a', 'libmp3lame', '-b:a', '192k', '-y', tempVoice]);
  console.log('[Stitch] Voice concat ✅');

  // 3 — Get total video duration
  const dur    = await runFFprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', tempVideo]);
  const durNum = parseFloat(dur);

  // 4 — Mix: video + voice + looping music in ONE pass (no gaps possible)
  const musicPath = getMusicPath(category);
  if (musicPath) {
    try {
      await runFFmpeg([
        '-i', tempVideo,
        '-i', tempVoice,
        '-stream_loop', '-1', '-i', musicPath,
        '-filter_complex',
          `[1:a]volume=1.0[voice];` +
          `[2:a]volume=0.13,afade=t=in:st=0:d=1.5,afade=t=out:st=${Math.max(durNum - 2, 0)}:d=2[bg];` +
          `[voice][bg]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
        '-map', '0:v', '-map', '[aout]',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-t', String(durNum), '-y', outputPath
      ]);
      console.log('[Music] Seamless mix ✅');
      return;
    } catch (e) { console.log('[Music] Mix failed, voice only:', e.message); }
  }

  // Fallback: video + voice only
  await runFFmpeg(['-i', tempVideo, '-i', tempVoice, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(durNum), '-y', outputPath]);
  console.log('[Stitch] Voice only ✅');
}

// ─────────────────────────────────────────────
// STEP 8 — YOUTUBE
// ─────────────────────────────────────────────
async function uploadToYouTube(videoPath, title, description, hashtags, seriesName, episodeNum) {
  const oauth2Client = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI);
  oauth2Client.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  const fullTitle = `${seriesName} | Ep ${episodeNum} 🔥 | ${title}`.substring(0, 100);
  const fullDesc  = `${description}\n\n📺 Episode ${episodeNum} of ${EPISODES_PER_SERIES}\n🔔 Subscribe — Ep ${episodeNum + 1} drops soon!\n\n${hashtags}`;
  const res = await youtube.videos.insert({
    part: 'snippet,status',
    requestBody: {
      snippet: { title: fullTitle, description: fullDesc, tags: hashtags.split('#').filter(Boolean).map(t => t.trim()), categoryId: '1', defaultLanguage: 'en' },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false }
    },
    media: { mimeType: 'video/mp4', body: fs.createReadStream(videoPath) }
  });
  return res.data.id;
}

// ─────────────────────────────────────────────
// STEP 9 — INSTAGRAM
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

  if (seriesState.currentEpisode > EPISODES_PER_SERIES) {
    console.log('\n🎬 Series complete! Starting new series...');
    seriesState = createNewSeries(seriesState.seriesIndex + 1);
    saveState(seriesState);
  }

  const { category, voice, characterSeed, currentEpisode, seriesNumber } = seriesState;
  const artStyle     = CATEGORY_ART_STYLE[category] || CATEGORY_ART_STYLE['adventure'];
  const captionStyle = ALL_CAPTION_STYLES[CATEGORY_CAPTION[category]] || ALL_CAPTION_STYLES['Bold White'];

  console.log(`\n🎬 [VidForge v12.2] Series ${seriesNumber} | Episode ${currentEpisode}/${EPISODES_PER_SERIES}`);
  console.log(`🎭 ${category} | 🎨 ${artStyle.name} | 🎙️ ${voice.name} | ✏️ ${captionStyle.name}`);
  console.log(`🎵 ${CATEGORY_MUSIC[category] || 'general.mp3'} | 📊 ${dailyCount}/${DAILY_LIMIT}\n`);

  const tempDir = path.join('/tmp', `vf_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const results = { episode: currentEpisode, youtube: null, instagram: null, error: null };

  try {
    // 1. Script
    console.log('[VidForge] Writing episode script...');
    const script = await generateEpisodeScript(seriesState);
    if (currentEpisode === 1) {
      seriesState.seriesName      = script.series_name;
      seriesState.characterDesign = script.character_design;
    }
    console.log(`[VidForge] "${script.series_name}" Ep ${currentEpisode}: ${script.title}`);

    // 2. Generate recap audio for ep 2+
    const voiceAudios = [];
    if (currentEpisode > 1 && script.recap_line) {
      const recapPath = path.join(tempDir, 'recap.mp3');
      await generateVoice(script.recap_line, recapPath, voice.id);
      voiceAudios.push(recapPath);
      console.log('[VidForge] Recap audio ✅');
    }

    // 3. Generate 3 images per scene + voice per scene
    const sceneDurations  = [];
    const wordTimestamps  = [];
    const sceneImgPaths   = []; // single image path per scene

    for (let i = 0; i < script.scenes.length; i++) {
      const scene     = script.scenes[i];
      const audioPath = path.join(tempDir, `voice_${i}.mp3`);
      const imgPath   = path.join(tempDir, `img_${i}.png`);

      console.log(`\n[VidForge] Scene ${i + 1}/4: "${cleanCaption(scene.caption)}"`);

      // Generate 1 image + voice in parallel — 3 views made by FFmpeg from same image
      await Promise.all([
        generateCartoonImage(scene.imagePrompt, imgPath, characterSeed), // SAME seed all scenes
        generateVoice(scene.narration, audioPath, voice.id)
      ]);

      sceneImgPaths.push(imgPath); // single path not array
      voiceAudios.push(audioPath);

      const timestamps = await getWordTimestamps(audioPath);
      wordTimestamps.push(timestamps);

      let duration = 6;
      try {
        const d = await runFFprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath]);
        duration = Math.max(parseFloat(d) + 0.6, 4.0);
      } catch (e) {}
      sceneDurations.push(duration);
      console.log(`[VidForge] Scene ${i + 1} ready (${duration.toFixed(1)}s, 1 image → 3 views)`);
    }

    // 4. Build scene videos (video only, 3 images each)
    console.log(`\n[VidForge] Building scenes...`);
    const sceneVideos = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const sceneOut = path.join(tempDir, `scene_${i}.mp4`);
      await buildSceneVideo(
        sceneImgPaths[i],  // single image — 3 views made by FFmpeg
        script.scenes[i].caption,
        sceneOut,
        sceneDurations[i],
        captionStyle,
        wordTimestamps[i],
        i
      );
      sceneVideos.push(sceneOut);
    }

    // 5. Build end card
    console.log('[VidForge] Building end card...');
    const endCardPath = path.join(tempDir, 'endcard.mp4');
    await buildEndCard(endCardPath, script.series_name, currentEpisode + 1);

    // 6. Stitch everything — seamless music
    console.log('[VidForge] Stitching final video...');
    const videoPath = path.join(tempDir, 'final.mp4');
    await stitchFinalVideo(sceneVideos, voiceAudios, endCardPath, tempDir, videoPath, category);

    // 7. Upload
    const igCaption = `${script.series_name} | Episode ${currentEpisode} 🔥\n\n${script.description}\n\n⚡ Ep ${currentEpisode + 1} drops in 96 mins! Subscribe!\n\n${script.hashtags}`;

    try {
      console.log('\n[VidForge] Uploading to YouTube...');
      const ytId = await uploadToYouTube(videoPath, script.title, script.description, script.hashtags, script.series_name, currentEpisode);
      results.youtube = `https://youtube.com/watch?v=${ytId}`;
      console.log(`[VidForge] YouTube ✅ ${results.youtube}`);
    } catch (err) { console.error('[VidForge] YouTube ❌', err.message); }

    try {
      if (results.youtube) {
        console.log('[VidForge] Posting to Instagram...');
        results.instagram = await postToInstagram(results.youtube, igCaption);
        console.log('[VidForge] Instagram ✅');
      }
    } catch (err) { console.error('[VidForge] Instagram ❌', err.message); }

    // 8. Update series state
    seriesState.episodeSummaries.push(script.episode_summary);
    if (currentEpisode === 1) {
      seriesState.seriesName      = script.series_name;
      seriesState.characterDesign = script.character_design;
    }
    seriesState.currentEpisode++;
    saveState(seriesState);

    console.log(`\n🎉 Ep ${currentEpisode} DONE! (${dailyCount}/${DAILY_LIMIT} today)`);
    if (results.youtube) console.log(`🔗 ${results.youtube}\n`);

  } catch (err) {
    results.error = err.message; dailyCount--;
    console.error('[VidForge] ❌ Failed:', err.message);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
  }
  return results;
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────
app.get('/', (req, res) => res.json({ app: 'VidForge AI', version: '12.3.0', status: 'running' }));

app.get('/status', (req, res) => res.json({
  version: '12.3.0',
  dailyCount: `${dailyCount}/${DAILY_LIMIT}`,
  series: {
    number:   seriesState.seriesNumber,
    name:     seriesState.seriesName || 'Generating...',
    category: seriesState.category,
    episode:  `${seriesState.currentEpisode}/${EPISODES_PER_SERIES}`,
    voice:    seriesState.voice.name,
  },
  cfAccounts:  CF_ACCOUNTS.length,
  elevenlabs:  !!ELEVENLABS_API_KEY,
  logoExists:  fs.existsSync(LOGO_PATH),
  musicFiles:  Object.values(CATEGORY_MUSIC).filter((v, i, a) => a.indexOf(v) === i).map(f => ({
    file: f, exists: fs.existsSync(path.join(__dirname, 'music', f))
  })),
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
  res.json({ message: 'New series!', series: seriesState });
});

app.get('/series-state', (req, res) => res.json(seriesState));

app.get('/test-image', async (req, res) => {
  if (CF_ACCOUNTS.length === 0) return res.json({ error: 'No CF accounts' });
  try {
    const acc = CF_ACCOUNTS[0];
    const prompt = req.query.prompt || 'anime cartoon hero, vibrant colors, epic pose, 9:16 portrait';
    const response = await axios.post(
      `https://api.cloudflare.com/client/v4/accounts/${acc.id}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
      { prompt, steps: 4 },
      { headers: { 'Authorization': `Bearer ${acc.token}`, 'Content-Type': 'application/json' }, timeout: 60000 }
    );
    const b64 = response.data?.result?.image || response.data?.image;
    if (b64) { res.set('Content-Type', 'image/jpeg'); res.send(Buffer.from(b64, 'base64')); }
    else res.json({ error: 'No image', raw: response.data });
  } catch (err) { res.json({ error: err.response?.status || err.message, details: err.response?.data }); }
});

app.get('/auth/youtube', (req, res) => {
  const o = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI);
  res.redirect(o.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/youtube.upload'] }));
});

app.get('/auth/youtube/callback', async (req, res) => {
  const o = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI);
  const { tokens } = await o.getToken(req.query.code);
  res.json({ refresh_token: tokens.refresh_token });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
process.env.NODE_OPTIONS = '--max-old-space-size=460';
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 VidForge AI v12.3 — Series Engine + 3 Images/Scene + End Card + Seamless Music`);
  console.log(`📺 Series ${seriesState.seriesNumber} | Ep ${seriesState.currentEpisode}/${EPISODES_PER_SERIES} | ${seriesState.category}`);
  console.log(`🎙️ Voice: ${seriesState.voice.name} | ☁️ CF: ${CF_ACCOUNTS.length} accounts`);
  console.log(`🖼️ Logo: ${fs.existsSync(LOGO_PATH) ? '✅' : '❌ Upload assets/logo.png'}`);
  console.log(`⏰ Every 96 min = 15 videos/day\n`);
});

module.exports = app;

if (RENDER_URL) {
  setInterval(() => { axios.get(`${RENDER_URL}/status`).catch(() => {}); console.log('[KeepAlive] Ping!'); }, 10 * 60 * 1000);
  console.log('[KeepAlive] Active');
}
