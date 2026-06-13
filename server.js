const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const FormData = require('form-data');

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

// 3 rotating CF accounts
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
    ff.on('close', code => { if (code === 0) resolve(); else reject(new Error(`FFmpeg exited ${code}: ${errOut.slice(-300)}`)); });
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
// CATEGORIES
// ─────────────────────────────────────────────
const VIDEO_CATEGORIES = [
  'horror', 'adventure', 'mystery', 'motivation',
  'fantasy', 'thriller', 'comedy', 'kids',
  'romance', 'science fiction', 'historical', 'nature',
  'life lesson', 'mindset', 'folklore', 'superhero'
];

// ─────────────────────────────────────────────
// ART STYLES — matched per category
// ─────────────────────────────────────────────
const CATEGORY_ART_STYLE = {
  'horror':          { name: 'Dark Anime', prompt: 'dark anime style, dramatic lighting, glowing eyes, detailed shading, cinematic, moody atmosphere, sharp lines, gothic, expressive' },
  'thriller':        { name: 'Dark Anime', prompt: 'dark anime style, dramatic lighting, intense expression, detailed shading, cinematic, sharp lines, suspense atmosphere' },
  'mystery':         { name: 'Noir Anime', prompt: 'dark noir anime style, moody shadows, muted colors with single color accent, mysterious atmosphere, detailed linework, dramatic' },
  'adventure':       { name: 'Anime Manga', prompt: 'vibrant anime manga style, big expressive eyes, dynamic action pose, bright saturated colors, energy lines, detailed shading, epic' },
  'superhero':       { name: 'Comic Book Hero', prompt: 'american comic book style, bold ink outlines, dynamic hero pose, halftone shading, primary colors, superhero aesthetic, dramatic lighting' },
  'motivation':      { name: 'Anime Manga', prompt: 'inspirational anime style, determined expression, glowing aura, dynamic pose, vibrant colors, motivational energy, detailed shading' },
  'mindset':         { name: 'Anime Manga', prompt: 'inspirational anime style, focused determined expression, glowing aura, vibrant colors, motivational energy, clean sharp linework' },
  'comedy':          { name: 'Chibi Cartoon', prompt: 'chibi cartoon style, cute oversized head, tiny body, big sparkly eyes, bold black outlines, flat bright colors, kawaii, exaggerated funny expression' },
  'kids':            { name: 'Storybook', prompt: 'childrens storybook illustration style, watercolor textures, soft pastel colors, whimsical cute characters, gentle lines, fairy tale aesthetic' },
  'romance':         { name: 'Shojo Anime', prompt: 'shojo anime style, soft sparkly background, large beautiful eyes, pastel colors, floral accents, emotional expression, gentle warm lighting' },
  'fantasy':         { name: 'Storybook Fantasy', prompt: 'fantasy storybook illustration, painterly style, magical glowing effects, rich jewel colors, detailed ornate costume, epic magical background' },
  'folklore':        { name: 'Storybook Fantasy', prompt: 'traditional folklore illustration style, painterly warm colors, mythical atmosphere, detailed costume, ancient aesthetic, storytelling energy' },
  'science fiction': { name: 'Cyberpunk Anime', prompt: 'cyberpunk anime style, neon glowing colors, futuristic setting, holographic effects, detailed tech costume, dark background with neon accents' },
  'historical':      { name: 'Retro Cartoon', prompt: 'classic retro cartoon style, warm muted colors, vintage illustration feel, detailed period costume, storybook quality, nostalgic atmosphere' },
  'nature':          { name: 'Watercolor', prompt: 'soft watercolor illustration style, natural earth tones, gentle brushwork, lush green background, peaceful atmosphere, detailed nature elements' },
  'life lesson':     { name: 'Pixar 3D', prompt: 'pixar 3d animation style, smooth surfaces, expressive cartoon face, warm colorful background, disney quality render, emotional expression' },
};

// ─────────────────────────────────────────────
// CAPTION STYLES — matched per category
// ─────────────────────────────────────────────
const FONT_BOLD    = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_OBLIQUE = '/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf';
const FONT_MONO    = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf';

const ALL_CAPTION_STYLES = {
  'Beast':         { name: 'Beast',         fontfile: FONT_BOLD,    fontsize: 88, fontcolor: 'white',      borderw: 9, bordercolor: 'black',       box: false, position: 'center' },
  'Red Highlight': { name: 'Red Highlight', fontfile: FONT_BOLD,    fontsize: 68, fontcolor: 'white',      borderw: 3, bordercolor: 'black@0.8',   box: true, boxcolor: '0xE6194B@0.85', boxborderw: 18, position: 'center' },
  'Sleek Dark':    { name: 'Sleek Dark',    fontfile: FONT_BOLD,    fontsize: 56, fontcolor: 'white',      borderw: 2, bordercolor: 'black@0.9',   box: true, boxcolor: 'black@0.55', boxborderw: 16, position: 'lower' },
  'Purple Pop':    { name: 'Purple Pop',    fontfile: FONT_BOLD,    fontsize: 64, fontcolor: 'white',      borderw: 2, bordercolor: 'black@0.7',   box: true, boxcolor: '0x7C3AED@0.85', boxborderw: 18, position: 'center' },
  'Majestic':      { name: 'Majestic',      fontfile: FONT_OBLIQUE, fontsize: 62, fontcolor: '0xFFE9B0',  borderw: 4, bordercolor: 'black@0.85',  box: false, position: 'center' },
  'Neon Green':    { name: 'Neon Green',    fontfile: FONT_MONO,    fontsize: 50, fontcolor: '0x39FF88',  borderw: 2, bordercolor: 'black@0.8',   box: true, boxcolor: 'black@0.6', boxborderw: 12, position: 'lower' },
  'Bold White':    { name: 'Bold White',    fontfile: FONT_BOLD,    fontsize: 74, fontcolor: 'white',      borderw: 7, bordercolor: 'black@0.95',  box: false, position: 'center' },
  'Gold':          { name: 'Gold',          fontfile: FONT_BOLD,    fontsize: 66, fontcolor: '0xFFD700',  borderw: 4, bordercolor: 'black@0.9',   box: false, position: 'center' },
  'Pink Cute':     { name: 'Pink Cute',     fontfile: FONT_OBLIQUE, fontsize: 60, fontcolor: '0xFF69B4',  borderw: 3, bordercolor: 'white@0.8',   box: true, boxcolor: 'white@0.2', boxborderw: 14, position: 'lower' },
  'Cyan Sci-Fi':   { name: 'Cyan Sci-Fi',   fontfile: FONT_MONO,    fontsize: 52, fontcolor: '0x00FFFF',  borderw: 2, bordercolor: '0x0000FF@0.7', box: true, boxcolor: 'black@0.7', boxborderw: 14, position: 'lower' },
};

const CATEGORY_CAPTION = {
  'horror':          'Beast',
  'thriller':        'Red Highlight',
  'mystery':         'Sleek Dark',
  'adventure':       'Bold White',
  'superhero':       'Beast',
  'motivation':      'Gold',
  'mindset':         'Gold',
  'comedy':          'Purple Pop',
  'kids':            'Pink Cute',
  'romance':         'Majestic',
  'fantasy':         'Majestic',
  'folklore':        'Majestic',
  'science fiction': 'Cyan Sci-Fi',
  'historical':      'Bold White',
  'nature':          'Sleek Dark',
  'life lesson':     'Gold',
};

// ─────────────────────────────────────────────
// BACKGROUND MUSIC — local files from /music/
// ─────────────────────────────────────────────
const CATEGORY_MUSIC = {
  'horror':          'dark.mp3',
  'thriller':        'dark.mp3',
  'mystery':         'dark.mp3',
  'adventure':       'adventure.mp3',
  'superhero':       'adventure.mp3',
  'motivation':      'motivation.mp3',
  'mindset':         'motivation.mp3',
  'comedy':          'comedy.mp3',
  'kids':            'kids.mp3',
  'romance':         'romance.mp3',
  'folklore':        'romance.mp3',
  'fantasy':         'fantasy.mp3',
  'nature':          'fantasy.mp3',
  'science fiction': 'scifi.mp3',
  'historical':      'emotional.mp3',
  'life lesson':     'emotional.mp3',
};

function getMusicPath(category) {
  const file = CATEGORY_MUSIC[category] || 'general.mp3';
  const localPath = path.join(__dirname, 'music', file);
  if (fs.existsSync(localPath)) return localPath;
  // fallback to general
  const generalPath = path.join(__dirname, 'music', 'general.mp3');
  if (fs.existsSync(generalPath)) return generalPath;
  return null;
}

// ─────────────────────────────────────────────
// COUNTERS
// ─────────────────────────────────────────────
let categoryIndex = 0;
let cfAccountIndex = 0;
let dailyCount    = 0;
const DAILY_LIMIT = 15;

cron.schedule('0 0 * * *', () => { dailyCount = 0; console.log('[VidForge] Daily count reset!'); });
cron.schedule('*/96 * * * *', () => {
  if (dailyCount < DAILY_LIMIT) { console.log(`[Cron] Triggered! ${dailyCount}/${DAILY_LIMIT}`); runPostingCycle(); }
  else { console.log('[Cron] Daily limit reached.'); }
});

// ─────────────────────────────────────────────
// STEP 1 — GROQ: Story + Character + Scenes
// ─────────────────────────────────────────────
async function generateVideoScript(category, artStyle) {
  const prompt = `Create a viral ${category} cartoon story for Instagram Reels/YouTube Shorts.

Art style for ALL scenes: ${artStyle.name} — ${artStyle.prompt}

Rules:
- Design ONE consistent main character appearing in EVERY scene (same look/outfit/colors, only emotion/pose changes per scene)
- Each scene narration MUST match its image emotion exactly
- Captions: SHORT max 5 words, ALL CAPS, ENGLISH LETTERS ONLY, NO emojis, NO symbols, NO special characters
- Story arc: Hook -> Build-up -> Climax -> Twist/Ending
- Make it emotional, suspenseful and shareable
- Narration: conversational, natural speaking style, 1-2 sentences max per scene

Return ONLY this exact JSON, no markdown, no extra text:
{
  "title": "Episode title under 55 characters",
  "series": "Series name like Shadow Files or Toon Tales",
  "description": "2 sentence engaging caption with emojis",
  "hashtags": "#cartoon #shorts #viral #story #fyp #animation #${category.replace(/ /g, '')} #trending #episode #anime",
  "character_design": "Precise visual description of ONE main character: species, body type, colors, outfit, distinguishing features. Keep consistent across all scenes.",
  "scenes": [
    { "narration": "Hook opening that grabs attention immediately", "caption": "HOOK CAPTION", "emotion": "character emotion pose action and background for scene 1" },
    { "narration": "Build-up scene creating tension or curiosity", "caption": "BUILD CAPTION", "emotion": "character emotion pose action and background for scene 2" },
    { "narration": "Climax with the most dramatic moment", "caption": "CLIMAX CAPTION", "emotion": "character emotion pose action and background for scene 3" },
    { "narration": "Powerful twist ending that makes viewers want more", "caption": "ENDING CAPTION", "emotion": "character emotion pose action and background for scene 4" }
  ]
}`;

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 1400, temperature: 0.9 },
    { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
  );

  const text = response.data.choices[0].message.content;
  const script = JSON.parse(text.replace(/```json|```/g, '').trim());

  script.scenes = script.scenes.map(scene => ({
    ...scene,
    image_prompt: `${artStyle.prompt}, ${script.character_design}, ${scene.emotion}, vertical 9:16 portrait composition, no text, no watermark, no logo, high quality, detailed`
  }));

  return script;
}

// ─────────────────────────────────────────────
// STEP 2 — CF WORKERS AI: Image (flux-1-schnell only)
// with 3-account rotation + neuron exhaustion detection
// ─────────────────────────────────────────────
async function generateCartoonImage(prompt, outputPath, seed) {
  if (CF_ACCOUNTS.length > 0) {
    for (let accAttempt = 0; accAttempt < CF_ACCOUNTS.length; accAttempt++) {
      const account = CF_ACCOUNTS[cfAccountIndex % CF_ACCOUNTS.length];
      cfAccountIndex++;
      try {
        console.log(`[Image] CF Account ${accAttempt + 1}/${CF_ACCOUNTS.length} — flux-1-schnell`);
        const response = await axios.post(
          `https://api.cloudflare.com/client/v4/accounts/${account.id}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
          { prompt, steps: 4, seed },
          { headers: { 'Authorization': `Bearer ${account.token}`, 'Content-Type': 'application/json' }, timeout: 90000 }
        );
        const b64 = response.data?.result?.image || response.data?.image;
        if (b64 && b64.length > 1000) {
          fs.writeFileSync(outputPath, Buffer.from(b64, 'base64'));
          console.log(`[Image] CF ✅ (Account ${accAttempt + 1})`);
          return;
        }
        console.log(`[Image] CF empty response — trying next account`);
      } catch (err) {
        const status = err.response?.status || 0;
        const msg = err.response?.data?.errors?.[0]?.message || err.message;
        console.log(`[Image] CF Account ${accAttempt + 1} failed ${status}: ${msg.substring(0, 80)}`);
        if (msg.includes('daily free allocation') || msg.includes('10,000 neurons')) {
          console.log(`[Image] Account ${accAttempt + 1} neurons exhausted — switching account`);
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  // FALLBACK — Picsum
  try {
    const res = await axios({ method: 'GET', url: `https://picsum.photos/seed/${seed}/576/1024`, responseType: 'arraybuffer', timeout: 30000 });
    fs.writeFileSync(outputPath, Buffer.from(res.data));
    console.log('[Image] Picsum fallback ✅');
  } catch (e) { throw new Error('All image sources failed: ' + e.message); }
}

// ─────────────────────────────────────────────
// STEP 3 — VOICE: ElevenLabs → Google TTS fallback
// ─────────────────────────────────────────────
const ELEVENLABS_VOICE_ID = 'pNInz6obpgDQGcFmaJgB'; // Adam — clear storytelling voice

async function generateVoice(text, outputPath) {
  const cleanText = text.replace(/['"]/g, '').substring(0, 250);

  // Try ElevenLabs first
  if (ELEVENLABS_API_KEY) {
    try {
      console.log('[Voice] Trying ElevenLabs...');
      const response = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
        {
          text: cleanText,
          model_id: 'eleven_monolingual_v1',
          voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true }
        },
        {
          headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
          responseType: 'arraybuffer',
          timeout: 30000
        }
      );
      if (response.data && response.data.length > 1000) {
        fs.writeFileSync(outputPath, Buffer.from(response.data));
        console.log('[Voice] ElevenLabs ✅');
        return;
      }
    } catch (err) {
      console.log(`[Voice] ElevenLabs failed: ${err.response?.status || err.message}`);
    }
  }

  // Fallback — Google TTS
  console.log('[Voice] Using Google TTS fallback...');
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(cleanText)}&tl=en&client=tw-ob&ttsspeed=0.85`;
  const response = await axios({ method: 'GET', url, responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36' } });
  fs.writeFileSync(outputPath, Buffer.from(response.data));
  console.log('[Voice] Google TTS ✅');
}

// ─────────────────────────────────────────────
// STEP 4 — GROQ WHISPER: Word-level timestamps
// ─────────────────────────────────────────────
async function getWordTimestamps(audioPath) {
  try {
    console.log('[Whisper] Getting word timestamps...');
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
    console.log(`[Whisper] Got ${words.length} word timestamps ✅`);
    return words; // [{ word, start, end }, ...]
  } catch (err) {
    console.log(`[Whisper] Failed: ${err.message} — using even split`);
    return null;
  }
}

// ─────────────────────────────────────────────
// STEP 5 — FFMPEG: Scene with word-sync captions
// ─────────────────────────────────────────────
function cleanWord(text) {
  return text
    .toUpperCase()
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/['":\\<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escFFmpeg(t) {
  return t.replace(/\\/g, '\\\\').replace(/'/g, '').replace(/:/g, '\\:');
}

function makeDrawtext(text, y, style, startTime, endTime) {
  const t = escFFmpeg(cleanWord(text));
  if (!t) return null;
  let f = `drawtext=text='${t}':fontsize=${style.fontsize}:fontcolor=${style.fontcolor}:fontfile='${style.fontfile}':x=(w-text_w)/2:y=${y}:borderw=${style.borderw}:bordercolor=${style.bordercolor}:enable='between(t,${startTime},${endTime})'`;
  if (style.box) f += `:box=1:boxcolor=${style.boxcolor}:boxborderw=${style.boxborderw}`;
  return f;
}

async function buildSceneVideo(imgPath, audioPath, caption, outputPath, duration, style, wordTimestamps) {
  const fadeOut = Math.max(duration - 0.4, 0);
  const yPos = style.position === 'lower' ? 'h*0.78' : 'h*0.5';

  let textFilters = [];

  if (wordTimestamps && wordTimestamps.length > 0) {
    // Word-by-word sync — each word appears exactly when spoken
    // Group into chunks of 2-3 words for readability
    let i = 0;
    while (i < wordTimestamps.length) {
      const chunk = wordTimestamps.slice(i, i + 2);
      const chunkText = chunk.map(w => w.word).join(' ');
      const startT = chunk[0].start;
      const endT = chunk[chunk.length - 1].end + 0.15;
      const filter = makeDrawtext(chunkText, yPos, style, startT, Math.min(endT, duration));
      if (filter) textFilters.push(filter);
      i += 2;
    }
    console.log(`[Caption] Word-sync: ${wordTimestamps.length} words → ${textFilters.length} chunks`);
  } else {
    // Fallback — static caption shown whole duration
    const clean = cleanWord(caption);
    const words = clean.split(' ');
    let line1 = clean, line2 = '';
    if (words.length > 3) {
      const mid = Math.ceil(words.length / 2);
      line1 = words.slice(0, mid).join(' ');
      line2 = words.slice(mid).join(' ');
    }
    const y1 = style.position === 'lower' ? (line2 ? 'h-260' : 'h-180') : (line2 ? '(h/2)-90' : '(h/2)-40');
    const y2 = style.position === 'lower' ? 'h-180' : '(h/2)+15';
    const f1 = makeDrawtext(line1, y1, style, 0.2, duration);
    if (f1) textFilters.push(f1);
    if (line2) { const f2 = makeDrawtext(line2, y2, style, 0.2, duration); if (f2) textFilters.push(f2); }
    console.log(`[Caption] Static fallback: "${clean}"`);
  }

  const textPart = textFilters.length > 0 ? ',' + textFilters.join(',') : '';
  const vf = `scale=768:1344:force_original_aspect_ratio=decrease,pad=768:1344:(ow-iw)/2:(oh-ih)/2:black${textPart},fade=t=in:st=0:d=0.4,fade=t=out:st=${fadeOut}:d=0.4`;

  await runFFmpeg([
    '-loop', '1', '-i', imgPath,
    '-i', audioPath,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage',
    '-c:a', 'aac', '-b:a', '192k',
    '-pix_fmt', 'yuv420p',
    '-t', String(duration),
    '-vf', vf,
    '-y', outputPath
  ]);
  console.log(`[FFmpeg] Scene done — "${style.name}" ✅`);
}

// ─────────────────────────────────────────────
// STEP 6 — FFMPEG: Stitch + Local Theme Music
// ─────────────────────────────────────────────
async function stitchFinalVideo(sceneVideos, tempDir, outputPath, category) {
  const concatFile = path.join(tempDir, 'concat.txt');
  fs.writeFileSync(concatFile, sceneVideos.map(v => `file '${v}'`).join('\n'));
  const tempConcat = path.join(tempDir, 'raw.mp4');
  await runFFmpeg(['-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', '-y', tempConcat]);

  const musicPath = getMusicPath(category);

  if (musicPath) {
    try {
      console.log(`[Music] Using local: ${path.basename(musicPath)}`);
      const dur = await runFFprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', tempConcat]);
      const durNum = parseFloat(dur);
      await runFFmpeg([
        '-i', tempConcat, '-i', musicPath,
        '-filter_complex', `[1:a]atrim=0:${durNum},afade=t=out:st=${Math.max(durNum - 1, 0)}:d=1,volume=0.15[bg];[0:a]volume=1.0[voice];[voice][bg]amix=inputs=2:duration=first[aout]`,
        '-map', '0:v', '-map', '[aout]',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-y', outputPath
      ]);
      console.log('[Music] Mixed ✅');
      return;
    } catch (e) { console.log('[Music] Mix failed, using voice only:', e.message); }
  } else {
    console.log('[Music] No local music found — voice only');
  }

  fs.copyFileSync(tempConcat, outputPath);
}

// ─────────────────────────────────────────────
// STEP 7 — YOUTUBE
// ─────────────────────────────────────────────
async function uploadToYouTube(videoPath, title, description, hashtags, series) {
  const oauth2Client = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI);
  oauth2Client.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  const res = await youtube.videos.insert({
    part: 'snippet,status',
    requestBody: {
      snippet: { title: `${title} | ${series}`.substring(0, 100), description: `${description}\n\n${hashtags}`, tags: hashtags.split('#').filter(Boolean).map(t => t.trim()), categoryId: '1', defaultLanguage: 'en' },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false }
    },
    media: { mimeType: 'video/mp4', body: fs.createReadStream(videoPath) }
  });
  return res.data.id;
}

// ─────────────────────────────────────────────
// STEP 8 — INSTAGRAM
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
async function runPostingCycle(category = null) {
  const selectedCategory  = category || VIDEO_CATEGORIES[categoryIndex % VIDEO_CATEGORIES.length];
  const selectedArtStyle  = CATEGORY_ART_STYLE[selectedCategory] || CATEGORY_ART_STYLE['adventure'];
  const selectedCaption   = ALL_CAPTION_STYLES[CATEGORY_CAPTION[selectedCategory]] || ALL_CAPTION_STYLES['Bold White'];
  const characterSeed     = Math.floor(Math.random() * 999999);

  categoryIndex++; dailyCount++;

  console.log(`\n🎬 [VidForge v11] Category: ${selectedCategory}`);
  console.log(`🎨 Art Style: ${selectedArtStyle.name}`);
  console.log(`✏️  Caption: ${selectedCaption.name}`);
  console.log(`🎵 Music: ${CATEGORY_MUSIC[selectedCategory] || 'general.mp3'}`);
  console.log(`📊 Daily: ${dailyCount}/${DAILY_LIMIT}\n`);

  const results = { category: selectedCategory, artStyle: selectedArtStyle.name, captionStyle: selectedCaption.name, youtube: null, instagram: null, error: null };
  const tempDir = path.join('/tmp', `vidforge_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    console.log('[VidForge] Writing story...');
    const script = await generateVideoScript(selectedCategory, selectedArtStyle);
    console.log(`[VidForge] "${script.title}" | ${script.series}`);

    const sceneDurations = [];
    const wordTimestamps = [];

    for (let i = 0; i < script.scenes.length; i++) {
      const scene    = script.scenes[i];
      const imgPath  = path.join(tempDir, `image_${i}.png`);
      const audioPath = path.join(tempDir, `voice_${i}.mp3`);

      console.log(`\n[VidForge] Scene ${i + 1}/4: "${cleanWord(scene.caption)}"`);

      // Generate image and voice in parallel
      await Promise.all([
        generateCartoonImage(scene.image_prompt, imgPath, characterSeed),
        generateVoice(scene.narration, audioPath)
      ]);

      // Get word timestamps for sync captions
      const timestamps = await getWordTimestamps(audioPath);
      wordTimestamps.push(timestamps);

      let duration = 5;
      try {
        const d = await runFFprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath]);
        duration = Math.max(parseFloat(d) + 0.8, 3.5);
      } catch (e) {}
      sceneDurations.push(duration);
      console.log(`[VidForge] Scene ${i + 1} ready (${duration.toFixed(1)}s)`);
    }

    console.log(`\n[VidForge] Building scenes with "${selectedCaption.name}" word-sync captions...`);
    const sceneVideos = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const sceneOut = path.join(tempDir, `scene_${i}.mp4`);
      await buildSceneVideo(
        path.join(tempDir, `image_${i}.png`),
        path.join(tempDir, `voice_${i}.mp3`),
        script.scenes[i].caption,
        sceneOut,
        sceneDurations[i],
        selectedCaption,
        wordTimestamps[i]
      );
      sceneVideos.push(sceneOut);
    }

    console.log('\n[VidForge] Stitching with theme music...');
    const videoPath = path.join(tempDir, 'final.mp4');
    await stitchFinalVideo(sceneVideos, tempDir, videoPath, selectedCategory);

    const caption = `${script.title} | ${script.series}\n\n${script.description}\n\n${script.hashtags}`;

    try {
      console.log('\n[VidForge] Uploading to YouTube...');
      const ytId = await uploadToYouTube(videoPath, script.title, script.description, script.hashtags, script.series);
      results.youtube = `https://youtube.com/watch?v=${ytId}`;
      console.log(`[VidForge] YouTube ✅ ${results.youtube}`);
    } catch (err) { console.error('[VidForge] YouTube ❌', err.message); results.youtubeError = err.message; }

    try {
      if (results.youtube) {
        console.log('[VidForge] Posting to Instagram...');
        results.instagram = await postToInstagram(results.youtube, caption);
        console.log('[VidForge] Instagram ✅');
      }
    } catch (err) { console.error('[VidForge] Instagram ❌', err.message); results.instagramError = err.message; }

    console.log(`\n🎉 [VidForge] DONE! ${dailyCount}/${DAILY_LIMIT} today`);
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
app.get('/', (req, res) => res.json({ app: 'VidForge AI', version: '11.0.0', status: 'running' }));

app.get('/test-image', async (req, res) => {
  if (CF_ACCOUNTS.length === 0) return res.json({ success: false, error: 'No Cloudflare accounts configured' });
  try {
    const acc = CF_ACCOUNTS[0];
    const testPrompt = req.query.prompt || 'anime cartoon fox character, cute, vibrant colors, portrait, 9:16';
    const response = await axios.post(
      `https://api.cloudflare.com/client/v4/accounts/${acc.id}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
      { prompt: testPrompt, steps: 4 },
      { headers: { 'Authorization': `Bearer ${acc.token}`, 'Content-Type': 'application/json' }, timeout: 60000 }
    );
    const b64 = response.data?.result?.image || response.data?.image;
    if (b64) { res.set('Content-Type', 'image/jpeg'); res.send(Buffer.from(b64, 'base64')); }
    else res.json({ success: false, error: 'No image in response', raw: response.data });
  } catch (err) {
    res.json({ success: false, error: err.response?.status || err.message, details: err.response?.data });
  }
});

app.get('/status', (req, res) => res.json({
  running: true, version: '11.0.0',
  dailyCount: `${dailyCount}/${DAILY_LIMIT}`,
  nextCategory: VIDEO_CATEGORIES[categoryIndex % VIDEO_CATEGORIES.length],
  cfAccounts: CF_ACCOUNTS.length,
  elevenlabs: !!ELEVENLABS_API_KEY,
  groq: !!GROQ_API_KEY,
  youtube: !!YOUTUBE_REFRESH_TOKEN,
  instagram: !!INSTAGRAM_ACCESS_TOKEN,
  musicFiles: VIDEO_CATEGORIES.map(c => ({ category: c, music: CATEGORY_MUSIC[c], exists: !!getMusicPath(c) })),
  timestamp: new Date().toISOString()
}));

app.post('/generate', async (req, res) => {
  const { category } = req.body || {};
  if (dailyCount >= DAILY_LIMIT) return res.json({ message: 'Daily limit reached!' });
  res.json({ message: '🎬 Video started!', category: category || 'auto' });
  runPostingCycle(category);
});

app.post('/test-script', async (req, res) => {
  const cat = (req.body || {}).category || 'horror';
  const style = CATEGORY_ART_STYLE[cat] || CATEGORY_ART_STYLE['adventure'];
  try { const script = await generateVideoScript(cat, style); res.json({ success: true, script }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/auth/youtube', (req, res) => {
  const oauth2Client = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI);
  res.redirect(oauth2Client.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/youtube.upload'] }));
});

app.get('/auth/youtube/callback', async (req, res) => {
  const oauth2Client = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI);
  const { tokens } = await oauth2Client.getToken(req.query.code);
  res.json({ message: 'Save this refresh_token!', refresh_token: tokens.refresh_token });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
process.env.NODE_OPTIONS = '--max-old-space-size=460';
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 VidForge AI v11.0 — Word-Sync Captions + ElevenLabs + Local Music + CF AI`);
  console.log(`☁️  CF Accounts: ${CF_ACCOUNTS.length} | 🎙️ ElevenLabs: ${ELEVENLABS_API_KEY ? '✅' : '❌ (Google TTS fallback)'}`);
  console.log(`🎵 Music: Local files from /music/ folder`);
  console.log(`⏰ Every 96 min = 15 videos/day | 📊 http://localhost:${PORT}/status\n`);
});

module.exports = app;

// ─────────────────────────────────────────────
// KEEP ALIVE
// ─────────────────────────────────────────────
if (RENDER_URL) {
  setInterval(() => {
    axios.get(`${RENDER_URL}/status`).catch(() => {});
    console.log('[KeepAlive] Ping sent!');
  }, 10 * 60 * 1000);
  console.log('[KeepAlive] Active — pinging every 10 minutes');
}
