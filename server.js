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
// SERIES STATE — persistent across restarts
// ─────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'series_state.json');
const EPISODES_PER_SERIES = 12;

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {}
  return null;
}

function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { console.error('[State] Save failed:', e.message); }
}

function createNewSeries(seriesIndex) {
  const categories = ['horror', 'adventure', 'mystery', 'thriller', 'fantasy', 'science fiction', 'superhero', 'motivation'];
  const voices     = [
    { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh',    desc: 'deep narrator' },
    { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel',  desc: 'calm clear' },
    { id: 'VR6AewLTigWG4xSOukaG', name: 'Arnold',  desc: 'strong intense' },
    { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella',   desc: 'warm soft' },
    { id: 'yoZ06aMxZJJ28mfd3POQ', name: 'Sam',     desc: 'raspy intense' },
  ];

  const category     = categories[seriesIndex % categories.length];
  const voice        = voices[seriesIndex % voices.length];
  const characterSeed = Math.floor(Math.random() * 999999);

  return {
    seriesIndex,
    seriesNumber:   seriesIndex + 1,
    category,
    voice,
    characterSeed,
    characterDesign: null,   // set after ep1 generated
    seriesName:      null,   // set after ep1 generated
    currentEpisode:  1,
    episodeSummaries: [],    // grows each episode
    createdAt: new Date().toISOString()
  };
}

let seriesState = loadState();
if (!seriesState) { seriesState = createNewSeries(0); saveState(seriesState); }

// ─────────────────────────────────────────────
// CATEGORIES / ART / CAPTIONS / MUSIC
// ─────────────────────────────────────────────
const CATEGORY_ART_STYLE = {
  'horror':          { name: 'Dark Anime',       prompt: 'dark anime style, dramatic lighting, glowing eyes, detailed shading, cinematic moody atmosphere, sharp lines, gothic' },
  'thriller':        { name: 'Dark Anime',       prompt: 'dark anime style, dramatic lighting, intense expression, detailed shading, cinematic, sharp lines, suspense atmosphere' },
  'mystery':         { name: 'Noir Anime',       prompt: 'dark noir anime style, moody shadows, muted colors with single neon accent, mysterious atmosphere, detailed linework' },
  'adventure':       { name: 'Anime Manga',      prompt: 'vibrant anime manga style, big expressive eyes, dynamic action pose, bright saturated colors, energy lines, detailed shading, epic' },
  'superhero':       { name: 'Comic Book Hero',  prompt: 'american comic book style, bold ink outlines, dynamic hero pose, halftone shading, primary colors, superhero aesthetic' },
  'motivation':      { name: 'Anime Manga',      prompt: 'inspirational anime style, determined expression, glowing aura, dynamic pose, vibrant colors, motivational energy' },
  'mindset':         { name: 'Anime Manga',      prompt: 'inspirational anime style, focused determined expression, glowing aura, vibrant colors, motivational energy' },
  'comedy':          { name: 'Chibi Cartoon',    prompt: 'chibi cartoon style, cute oversized head, tiny body, big sparkly eyes, bold black outlines, flat bright colors, kawaii' },
  'kids':            { name: 'Storybook',        prompt: 'childrens storybook illustration, watercolor textures, soft pastel colors, whimsical cute characters, gentle lines' },
  'romance':         { name: 'Shojo Anime',      prompt: 'shojo anime style, soft sparkly background, large beautiful eyes, pastel colors, floral accents, emotional expression' },
  'fantasy':         { name: 'Fantasy Art',      prompt: 'fantasy illustration, painterly style, magical glowing effects, rich jewel colors, detailed ornate costume, epic background' },
  'folklore':        { name: 'Fantasy Art',      prompt: 'traditional folklore illustration, painterly warm colors, mythical atmosphere, detailed costume, ancient aesthetic' },
  'science fiction': { name: 'Cyberpunk Anime',  prompt: 'cyberpunk anime style, neon glowing colors, futuristic setting, holographic effects, detailed tech costume, dark neon background' },
  'historical':      { name: 'Retro Cartoon',    prompt: 'classic retro cartoon style, warm muted colors, vintage illustration, detailed period costume, storybook quality' },
  'nature':          { name: 'Watercolor',       prompt: 'soft watercolor illustration, natural earth tones, gentle brushwork, lush green background, peaceful atmosphere' },
  'life lesson':     { name: 'Pixar 3D',         prompt: 'pixar 3d animation style, smooth surfaces, expressive cartoon face, warm colorful background, disney quality render' },
};

const FONT_BOLD    = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_OBLIQUE = '/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf';
const FONT_MONO    = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf';

const ALL_CAPTION_STYLES = {
  'Beast':         { name: 'Beast',         fontfile: FONT_BOLD,    fontsize: 82, fontcolor: 'white',     borderw: 8, bordercolor: 'black',      box: false, position: 'lower' },
  'Red Highlight': { name: 'Red Highlight', fontfile: FONT_BOLD,    fontsize: 64, fontcolor: 'white',     borderw: 3, bordercolor: 'black@0.8',  box: true, boxcolor: '0xE6194B@0.85', boxborderw: 16, position: 'lower' },
  'Sleek Dark':    { name: 'Sleek Dark',    fontfile: FONT_BOLD,    fontsize: 54, fontcolor: 'white',     borderw: 2, bordercolor: 'black@0.9',  box: true, boxcolor: 'black@0.55', boxborderw: 14, position: 'lower' },
  'Purple Pop':    { name: 'Purple Pop',    fontfile: FONT_BOLD,    fontsize: 60, fontcolor: 'white',     borderw: 2, bordercolor: 'black@0.7',  box: true, boxcolor: '0x7C3AED@0.85', boxborderw: 16, position: 'lower' },
  'Majestic':      { name: 'Majestic',      fontfile: FONT_OBLIQUE, fontsize: 58, fontcolor: '0xFFE9B0', borderw: 4, bordercolor: 'black@0.85', box: false, position: 'lower' },
  'Neon Green':    { name: 'Neon Green',    fontfile: FONT_MONO,    fontsize: 48, fontcolor: '0x39FF88', borderw: 2, bordercolor: 'black@0.8',  box: true, boxcolor: 'black@0.6', boxborderw: 12, position: 'lower' },
  'Bold White':    { name: 'Bold White',    fontfile: FONT_BOLD,    fontsize: 70, fontcolor: 'white',     borderw: 6, bordercolor: 'black@0.95', box: false, position: 'lower' },
  'Gold':          { name: 'Gold',          fontfile: FONT_BOLD,    fontsize: 62, fontcolor: '0xFFD700', borderw: 4, bordercolor: 'black@0.9',  box: false, position: 'lower' },
  'Pink Cute':     { name: 'Pink Cute',     fontfile: FONT_OBLIQUE, fontsize: 56, fontcolor: '0xFF69B4', borderw: 3, bordercolor: 'white@0.8',  box: true, boxcolor: 'white@0.2', boxborderw: 12, position: 'lower' },
  'Cyan Sci-Fi':   { name: 'Cyan Sci-Fi',   fontfile: FONT_MONO,    fontsize: 50, fontcolor: '0x00FFFF', borderw: 2, bordercolor: '0x0000FF@0.7', box: true, boxcolor: 'black@0.7', boxborderw: 12, position: 'lower' },
};

const CATEGORY_CAPTION = {
  'horror': 'Beast', 'thriller': 'Red Highlight', 'mystery': 'Sleek Dark',
  'adventure': 'Bold White', 'superhero': 'Beast', 'motivation': 'Gold',
  'mindset': 'Gold', 'comedy': 'Purple Pop', 'kids': 'Pink Cute',
  'romance': 'Majestic', 'fantasy': 'Majestic', 'folklore': 'Majestic',
  'science fiction': 'Cyan Sci-Fi', 'historical': 'Bold White',
  'nature': 'Sleek Dark', 'life lesson': 'Gold',
};

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

cron.schedule('0 0 * * *', () => { dailyCount = 0; console.log('[VidForge] Daily count reset!'); });
cron.schedule('*/96 * * * *', () => {
  if (dailyCount < DAILY_LIMIT) runPostingCycle();
  else console.log('[Cron] Daily limit reached.');
});

// ─────────────────────────────────────────────
// STEP 1 — GROQ: Episode Script with series memory
// ─────────────────────────────────────────────
async function generateEpisodeScript(state) {
  const { category, currentEpisode, characterDesign, seriesName, episodeSummaries, voice } = state;
  const artStyle   = CATEGORY_ART_STYLE[category] || CATEGORY_ART_STYLE['adventure'];
  const isFirstEp  = currentEpisode === 1;
  const isLastEp   = currentEpisode === EPISODES_PER_SERIES;
  const prevSummary = episodeSummaries.length > 0 ? episodeSummaries[episodeSummaries.length - 1] : null;

  const seriesContext = isFirstEp ? '' : `
SERIES NAME: "${seriesName}"
MAIN CHARACTER: ${characterDesign}
EPISODE NUMBER: ${currentEpisode} of ${EPISODES_PER_SERIES}
PREVIOUS EPISODE SUMMARY: ${prevSummary}
STORY SO FAR: ${episodeSummaries.slice(-3).join(' → ')}

Rules for continuity:
- Continue EXACTLY where the last episode ended
- Reference what happened before naturally
- Show character GROWTH from episode 1
- Build tension toward the series finale (episode ${EPISODES_PER_SERIES})`;

  const endingInstruction = isLastEp
    ? 'This is the SERIES FINALE — give an epic satisfying ending but hint at a new adventure beginning'
    : `End on a CLIFFHANGER that makes viewers desperate for Episode ${currentEpisode + 1}`;

  const prompt = `Create Episode ${currentEpisode} of a viral ${category} cartoon series for YouTube Shorts/Instagram Reels.
${seriesContext}

Art style: ${artStyle.name} — ${artStyle.prompt}

Story Rules:
- ${isFirstEp ? 'Introduce the main character dramatically — make them instantly iconic and memorable' : 'Continue the story naturally from the previous episode'}
- Hook the viewer in the FIRST 2 seconds
- Each scene builds on the previous — rising tension
- ${endingInstruction}
- Narration: natural, conversational, emotional — like a storyteller around a campfire
- Captions: max 4 words, ALL CAPS, ENGLISH ONLY, NO special chars, NO symbols, NO punctuation

Return ONLY this exact JSON, no markdown:
{
  "series_name": "${isFirstEp ? 'Create an epic series name (2-3 words max)' : seriesName}",
  "title": "Ep ${currentEpisode} title under 40 chars",
  "character_design": "${isFirstEp ? 'Detailed visual description: species, body type, colors, outfit, unique features — be very specific for image consistency' : characterDesign}",
  "episode_summary": "2 sentence summary of what happens in THIS episode (for next episode context)",
  "description": "Engaging 2 sentence YouTube description with emojis and episode number",
  "hashtags": "#cartoon #shorts #viral #anime #episode${currentEpisode} #${category.replace(/ /g, '')} #series #fyp #trending #animation",
  "recap_line": "${isFirstEp ? '' : 'One sentence recap of previous episode starting with: Last time...'}",
  "end_card": "Subscribe for Episode ${currentEpisode + 1} — dropping in 96 minutes",
  "scenes": [
    { "narration": "${isFirstEp ? 'Epic hook introducing the character and world' : 'Continue story — reference previous episode naturally'}", "caption": "HOOK WORDS", "emotion": "character emotion pose action background for scene 1" },
    { "narration": "Build tension — something unexpected happens", "caption": "BUILD WORDS", "emotion": "character emotion pose action background for scene 2" },
    { "narration": "Climax — the most dramatic moment of this episode", "caption": "CLIMAX WORDS", "emotion": "character emotion pose action background for scene 3" },
    { "narration": "${isLastEp ? 'Epic finale moment' : 'Cliffhanger — end mid-action, leave viewers shocked'}", "caption": "ENDING WORDS", "emotion": "character emotion pose action background for scene 4" }
  ]
}`;

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 1600, temperature: 0.9 },
    { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
  );

  const text   = response.data.choices[0].message.content;
  const script = JSON.parse(text.replace(/```json|```/g, '').trim());

  // Build image prompts with character consistency
  script.artStyle = artStyle;
  script.scenes = script.scenes.map(scene => ({
    ...scene,
    image_prompt: `${artStyle.prompt}, ${script.character_design}, ${scene.emotion}, vertical 9:16 portrait, no text, no watermark, high quality, detailed, vibrant`
  }));

  return script;
}

// ─────────────────────────────────────────────
// STEP 2 — CF WORKERS AI: flux-1-schnell only
// ─────────────────────────────────────────────
async function generateCartoonImage(prompt, outputPath, seed) {
  if (CF_ACCOUNTS.length > 0) {
    for (let i = 0; i < CF_ACCOUNTS.length; i++) {
      const account = CF_ACCOUNTS[cfAccountIndex % CF_ACCOUNTS.length];
      cfAccountIndex++;
      try {
        console.log(`[Image] CF Account ${i + 1}/${CF_ACCOUNTS.length} — flux-1-schnell`);
        const response = await axios.post(
          `https://api.cloudflare.com/client/v4/accounts/${account.id}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
          { prompt, steps: 4, seed },
          { headers: { 'Authorization': `Bearer ${account.token}`, 'Content-Type': 'application/json' }, timeout: 90000 }
        );
        const b64 = response.data?.result?.image || response.data?.image;
        if (b64 && b64.length > 1000) {
          fs.writeFileSync(outputPath, Buffer.from(b64, 'base64'));
          console.log(`[Image] CF ✅ (Account ${i + 1})`);
          return;
        }
      } catch (err) {
        const msg = err.response?.data?.errors?.[0]?.message || err.message;
        console.log(`[Image] CF Account ${i + 1} failed: ${msg.substring(0, 80)}`);
        if (msg.includes('daily free allocation') || msg.includes('10,000 neurons')) break;
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
// Uses series-specific voice
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

  // Google TTS fallback
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(cleanText)}&tl=en&client=tw-ob&ttsspeed=0.85`;
  const response = await axios({ method: 'GET', url, responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } });
  fs.writeFileSync(outputPath, Buffer.from(response.data));
  console.log('[Voice] Google TTS ✅');
}

// ─────────────────────────────────────────────
// STEP 4 — WHISPER: Word timestamps via Groq
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
    console.log(`[Whisper] ${words.length} word timestamps ✅`);
    return words;
  } catch (err) {
    console.log(`[Whisper] Failed: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────
// STEP 5 — FFMPEG: Scene with FIXED word-sync captions
// FIXED: strict gap between chunks, no overlap
// FIXED: all captions at bottom (lower third)
// ─────────────────────────────────────────────
function cleanText(t) {
  return t.toUpperCase()
    .replace(/[^\x41-\x5A\x61-\x7A\x30-\x39\x20]/g, '') // only letters, numbers, spaces
    .replace(/\s+/g, ' ')
    .substring(0, 30)
    .trim();
}

function escFF(t) { return t.replace(/\\/g, '\\\\').replace(/'/g, '').replace(/:/g, '\\:'); }

function makeDrawtext(text, style, startT, endT) {
  const t = escFF(cleanText(text));
  if (!t) return null;
  // lower third position — consistent across all styles
  const y = 'h*0.82';
  let f = `drawtext=text='${t}':fontsize=${style.fontsize}:fontcolor=${style.fontcolor}:fontfile='${style.fontfile}':x=(w-text_w)/2:y=${y}:borderw=${style.borderw}:bordercolor=${style.bordercolor}:enable='between(t,${startT.toFixed(3)},${endT.toFixed(3)})'`;
  if (style.box) f += `:box=1:boxcolor=${style.boxcolor}:boxborderw=${style.boxborderw}`;
  return f;
}

async function buildSceneVideo(imgPath, audioPath, caption, outputPath, duration, style, wordTimestamps) {
  const fadeOut = Math.max(duration - 0.3, 0);
  let textFilters = [];

  if (wordTimestamps && wordTimestamps.length > 0) {
    // Group into chunks of 2-3 words
    // FIXED: endTime = next chunk startTime - 0.05s gap (no overlap!)
    const chunks = [];
    let i = 0;
    while (i < wordTimestamps.length) {
      const chunk = wordTimestamps.slice(i, Math.min(i + 3, wordTimestamps.length));
      chunks.push({
        text: chunk.map(w => w.word).join(' '),
        start: chunk[0].start,
        end: chunk[chunk.length - 1].end
      });
      i += 3;
    }

    // Apply gap between chunks
    for (let j = 0; j < chunks.length; j++) {
      const startT = Math.max(chunks[j].start - 0.05, 0);
      // End strictly before next chunk starts (50ms gap)
      const nextStart = j + 1 < chunks.length ? chunks[j + 1].start : duration;
      const endT = Math.min(chunks[j].end + 0.1, nextStart - 0.05, duration);
      const f = makeDrawtext(chunks[j].text, style, startT, endT);
      if (f) textFilters.push(f);
    }
    console.log(`[Caption] Word-sync: ${wordTimestamps.length} words → ${chunks.length} chunks ✅`);
  } else {
    // Static caption fallback
    const clean = cleanText(caption);
    const words = clean.split(' ');
    let line1 = clean, line2 = '';
    if (words.length > 3) {
      const mid = Math.ceil(words.length / 2);
      line1 = words.slice(0, mid).join(' ');
      line2 = words.slice(mid).join(' ');
    }
    const f1 = makeDrawtext(line1, style, 0.3, duration - 0.2);
    if (f1) textFilters.push(f1);
    if (line2) {
      // line2 slightly lower
      const t = escFF(cleanText(line2));
      if (t) {
        let f2 = `drawtext=text='${t}':fontsize=${style.fontsize}:fontcolor=${style.fontcolor}:fontfile='${style.fontfile}':x=(w-text_w)/2:y=h*0.89:borderw=${style.borderw}:bordercolor=${style.bordercolor}:enable='between(t,0.3,${(duration - 0.2).toFixed(3)})'`;
        if (style.box) f2 += `:box=1:boxcolor=${style.boxcolor}:boxborderw=${style.boxborderw}`;
        textFilters.push(f2);
      }
    }
  }

  const textPart = textFilters.length > 0 ? ',' + textFilters.join(',') : '';

  // Zoom/pan effect for dynamic feel
  const zoomFilter = `zoompan=z='min(zoom+0.0008,1.05)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=768x1344:fps=24`;

  const vf = `scale=768:1344:force_original_aspect_ratio=decrease,pad=768:1344:(ow-iw)/2:(oh-ih)/2:black,${zoomFilter}${textPart},fade=t=in:st=0:d=0.3,fade=t=out:st=${fadeOut}:d=0.3`;

  await runFFmpeg([
    '-loop', '1', '-i', imgPath,
    '-i', audioPath,
    '-c:v', 'libx264', '-preset', 'ultrafast',
    '-c:a', 'aac', '-b:a', '192k',
    '-pix_fmt', 'yuv420p',
    '-t', String(duration),
    '-vf', vf,
    '-y', outputPath
  ]);
  console.log(`[FFmpeg] Scene done ✅`);
}

// ─────────────────────────────────────────────
// STEP 6 — STITCH: FIXED music gap between scenes
// FIXED: music loaded ONCE, mixed with full concat video
// No re-encode of video — seamless joins
// ─────────────────────────────────────────────
async function stitchFinalVideo(sceneVideos, tempDir, outputPath, category) {
  const concatFile = path.join(tempDir, 'concat.txt');
  fs.writeFileSync(concatFile, sceneVideos.map(v => `file '${v}'`).join('\n'));
  const tempConcat = path.join(tempDir, 'raw.mp4');

  // Concat scenes — re-encode for seamless joins (fixes music gap!)
  await runFFmpeg([
    '-f', 'concat', '-safe', '0', '-i', concatFile,
    '-c:v', 'libx264', '-preset', 'ultrafast',
    '-c:a', 'aac', '-b:a', '192k',
    '-pix_fmt', 'yuv420p',
    '-y', tempConcat
  ]);

  const musicPath = getMusicPath(category);
  if (musicPath) {
    try {
      const dur = await runFFprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', tempConcat]);
      const durNum = parseFloat(dur);
      await runFFmpeg([
        '-i', tempConcat,
        '-stream_loop', '-1', '-i', musicPath,
        '-filter_complex', `[1:a]volume=0.13,afade=t=in:st=0:d=1,afade=t=out:st=${Math.max(durNum - 1.5, 0)}:d=1.5[bg];[0:a]volume=1.0[voice];[voice][bg]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
        '-map', '0:v', '-map', '[aout]',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-t', String(durNum),
        '-y', outputPath
      ]);
      console.log('[Music] Mixed ✅');
      return;
    } catch (e) { console.log('[Music] Mix failed:', e.message); }
  }
  fs.copyFileSync(tempConcat, outputPath);
}

// ─────────────────────────────────────────────
// STEP 7 — YOUTUBE UPLOAD
// ─────────────────────────────────────────────
async function uploadToYouTube(videoPath, title, description, hashtags, seriesName, episodeNum) {
  const oauth2Client = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI);
  oauth2Client.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  const fullTitle = `${seriesName} | Ep ${episodeNum} 🔥 | ${title}`.substring(0, 100);
  const fullDesc  = `${description}\n\n📺 Episode ${episodeNum} of ${EPISODES_PER_SERIES}\n🔔 Subscribe for Ep ${episodeNum + 1} — dropping soon!\n\n${hashtags}`;

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
// STEP 8 — INSTAGRAM POST
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

  // Check if we need a new series
  if (seriesState.currentEpisode > EPISODES_PER_SERIES) {
    console.log(`\n🎬 [VidForge] Series complete! Starting new series...`);
    seriesState = createNewSeries(seriesState.seriesIndex + 1);
    saveState(seriesState);
  }

  const { category, voice, characterSeed, currentEpisode, seriesNumber } = seriesState;
  const artStyle     = CATEGORY_ART_STYLE[category] || CATEGORY_ART_STYLE['adventure'];
  const captionStyle = ALL_CAPTION_STYLES[CATEGORY_CAPTION[category]] || ALL_CAPTION_STYLES['Bold White'];

  console.log(`\n🎬 [VidForge v12] Series ${seriesNumber} | Episode ${currentEpisode}/${EPISODES_PER_SERIES}`);
  console.log(`🎭 Category: ${category} | 🎨 Style: ${artStyle.name}`);
  console.log(`🎙️  Voice: ${voice.name} (${voice.desc}) | ✏️  Caption: ${captionStyle.name}`);
  console.log(`🎵 Music: ${CATEGORY_MUSIC[category]} | 📊 Daily: ${dailyCount}/${DAILY_LIMIT}\n`);

  const tempDir = path.join('/tmp', `vidforge_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const results = { episode: currentEpisode, series: seriesState.seriesName, youtube: null, instagram: null, error: null };

  try {
    // 1. Generate episode script
    console.log('[VidForge] Writing episode script...');
    const script = await generateEpisodeScript(seriesState);

    // Save series name + character from episode 1
    if (currentEpisode === 1) {
      seriesState.seriesName      = script.series_name;
      seriesState.characterDesign = script.character_design;
    }

    console.log(`[VidForge] "${script.series_name}" | Ep ${currentEpisode}: ${script.title}`);

    // 2. Add recap voice for ep 2+
    const allNarrations = [];
    if (currentEpisode > 1 && script.recap_line) {
      allNarrations.push({ text: script.recap_line, isRecap: true });
    }
    script.scenes.forEach(s => allNarrations.push({ text: s.narration, isRecap: false }));

    // 3. Generate images + voices in parallel per scene
    const sceneDurations  = [];
    const wordTimestamps  = [];
    const sceneAudioPaths = [];

    for (let i = 0; i < script.scenes.length; i++) {
      const scene     = script.scenes[i];
      const imgPath   = path.join(tempDir, `image_${i}.png`);
      const audioPath = path.join(tempDir, `voice_${i}.mp3`);

      console.log(`\n[VidForge] Scene ${i + 1}/4: "${cleanText(scene.caption)}"`);

      await Promise.all([
        generateCartoonImage(scene.image_prompt, imgPath, characterSeed + i),
        generateVoice(scene.narration, audioPath, voice.id)
      ]);

      const timestamps = await getWordTimestamps(audioPath);
      wordTimestamps.push(timestamps);

      let duration = 5;
      try {
        const d = await runFFprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath]);
        duration = Math.max(parseFloat(d) + 0.6, 3.5);
      } catch (e) {}
      sceneDurations.push(duration);
      sceneAudioPaths.push(audioPath);
      console.log(`[VidForge] Scene ${i + 1} ready (${duration.toFixed(1)}s)`);
    }

    // 4. Build scene videos
    console.log(`\n[VidForge] Building scenes with "${captionStyle.name}" captions...`);
    const sceneVideos = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const sceneOut = path.join(tempDir, `scene_${i}.mp4`);
      await buildSceneVideo(
        path.join(tempDir, `image_${i}.png`),
        sceneAudioPaths[i],
        script.scenes[i].caption,
        sceneOut,
        sceneDurations[i],
        captionStyle,
        wordTimestamps[i]
      );
      sceneVideos.push(sceneOut);
    }

    // 5. Stitch with seamless music
    console.log('\n[VidForge] Stitching with theme music...');
    const videoPath = path.join(tempDir, 'final.mp4');
    await stitchFinalVideo(sceneVideos, tempDir, videoPath, category);

    // 6. Upload
    const igCaption = `${script.series_name} | Episode ${currentEpisode} 🔥\n\n${script.description}\n\n⚡ ${script.end_card}\n\n${script.hashtags}`;

    try {
      console.log('\n[VidForge] Uploading to YouTube...');
      const ytId = await uploadToYouTube(videoPath, script.title, script.description, script.hashtags, script.series_name, currentEpisode);
      results.youtube = `https://youtube.com/watch?v=${ytId}`;
      console.log(`[VidForge] YouTube ✅ ${results.youtube}`);
    } catch (err) { console.error('[VidForge] YouTube ❌', err.message); results.youtubeError = err.message; }

    try {
      if (results.youtube) {
        console.log('[VidForge] Posting to Instagram...');
        results.instagram = await postToInstagram(results.youtube, igCaption);
        console.log('[VidForge] Instagram ✅');
      }
    } catch (err) { console.error('[VidForge] Instagram ❌', err.message); }

    // 7. Update series state
    seriesState.episodeSummaries.push(script.episode_summary);
    seriesState.currentEpisode++;
    if (currentEpisode === 1) {
      seriesState.seriesName      = script.series_name;
      seriesState.characterDesign = script.character_design;
    }
    saveState(seriesState);

    console.log(`\n🎉 Series ${seriesNumber} | Ep ${currentEpisode} DONE! (${dailyCount}/${DAILY_LIMIT} today)`);
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
app.get('/', (req, res) => res.json({ app: 'VidForge AI', version: '12.0.0', status: 'running' }));

app.get('/status', (req, res) => res.json({
  version: '12.0.0',
  dailyCount: `${dailyCount}/${DAILY_LIMIT}`,
  series: {
    number:    seriesState.seriesNumber,
    name:      seriesState.seriesName || 'Generating...',
    category:  seriesState.category,
    episode:   `${seriesState.currentEpisode}/${EPISODES_PER_SERIES}`,
    voice:     seriesState.voice.name,
  },
  cfAccounts:  CF_ACCOUNTS.length,
  elevenlabs:  !!ELEVENLABS_API_KEY,
  groq:        !!GROQ_API_KEY,
  youtube:     !!YOUTUBE_REFRESH_TOKEN,
  instagram:   !!INSTAGRAM_ACCESS_TOKEN,
  timestamp:   new Date().toISOString()
}));

app.post('/generate', async (req, res) => {
  if (dailyCount >= DAILY_LIMIT) return res.json({ message: 'Daily limit reached!' });
  res.json({ message: `🎬 Generating Episode ${seriesState.currentEpisode} of ${seriesState.seriesName || 'new series'}!` });
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
    const acc = CF_ACCOUNTS[0];
    const prompt = req.query.prompt || 'anime cartoon hero character, vibrant colors, epic pose, 9:16';
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
  console.log(`\n🚀 VidForge AI v12.0 — Series Engine + Word-Sync + ElevenLabs + Theme Music`);
  console.log(`📺 Series ${seriesState.seriesNumber} | Ep ${seriesState.currentEpisode}/${EPISODES_PER_SERIES} | Category: ${seriesState.category}`);
  console.log(`🎙️  Voice: ${seriesState.voice.name} | ☁️  CF Accounts: ${CF_ACCOUNTS.length}`);
  console.log(`⏰ Every 96 min = 15 videos/day\n`);
});

module.exports = app;

if (RENDER_URL) {
  setInterval(() => { axios.get(`${RENDER_URL}/status`).catch(() => {}); console.log('[KeepAlive] Ping sent!'); }, 10 * 60 * 1000);
  console.log('[KeepAlive] Active');
}
