const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

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
const CF_ACCOUNT_ID          = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_API_TOKEN           = process.env.CLOUDFLARE_API_TOKEN;

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
// CARTOON ART STYLES
// ─────────────────────────────────────────────
const ART_STYLES = [
  { name: 'Chibi Cartoon', prompt: 'chibi cartoon style, cute oversized head, tiny body, big sparkly eyes, bold black outlines, flat bright colors, kawaii, adorable expression' },
  { name: 'Anime Manga', prompt: 'anime manga style, big expressive eyes, dynamic hair, detailed shading, clean lines, vibrant colors, emotional expression, japanese animation' },
  { name: 'Comic Book Hero', prompt: 'american comic book style, bold ink outlines, dynamic pose, halftone shading, primary colors, superhero aesthetic, dramatic lighting' },
  { name: 'Pixar 3D', prompt: 'pixar 3d animation style, smooth surfaces, expressive cartoon face, colorful background, subsurface scattering skin, disney quality render' },
  { name: 'Retro Cartoon', prompt: 'retro 1950s cartoon style, rubberhose animation, simple round shapes, limited color palette, bold black outlines, vintage cartoon feel' },
  { name: 'Dark Anime', prompt: 'dark anime style, dramatic lighting, glowing eyes, detailed shading, cinematic, mature manga aesthetic, moody atmosphere, sharp lines' },
  { name: 'Storybook', prompt: 'childrens storybook illustration style, watercolor textures, soft pastel colors, whimsical characters, gentle lines, fairy tale aesthetic' },
  { name: 'Street Art Cartoon', prompt: 'graffiti street art cartoon style, bold flat colors, sharp geometric shapes, urban aesthetic, spray paint texture, expressive character' }
];

// ─────────────────────────────────────────────
// CAPTION STYLES
// ─────────────────────────────────────────────
const FONT_BOLD    = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_OBLIQUE = '/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf';
const FONT_MONO    = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf';

const CAPTION_STYLES = [
  { name: 'Bold Stroke', fontfile: FONT_BOLD, fontsize: 74, fontcolor: 'white', borderw: 7, bordercolor: 'black@0.95', box: false, position: 'center' },
  { name: 'Red Highlight', fontfile: FONT_BOLD, fontsize: 68, fontcolor: 'white', borderw: 3, bordercolor: 'black@0.8', box: true, boxcolor: '0xE6194B@0.85', boxborderw: 18, position: 'center' },
  { name: 'Sleek', fontfile: FONT_BOLD, fontsize: 52, fontcolor: 'white', borderw: 1, bordercolor: 'black@0.5', box: true, boxcolor: 'black@0.35', boxborderw: 16, position: 'lower' },
  { name: 'Karaoke', fontfile: FONT_BOLD, fontsize: 64, fontcolor: 'white', borderw: 2, bordercolor: 'black@0.7', box: true, boxcolor: '0x7C3AED@0.85', boxborderw: 18, position: 'center' },
  { name: 'Majestic', fontfile: FONT_OBLIQUE, fontsize: 60, fontcolor: '0xFFE9B0', borderw: 4, bordercolor: 'black@0.85', box: false, position: 'center' },
  { name: 'Beast', fontfile: FONT_BOLD, fontsize: 90, fontcolor: 'white', borderw: 9, bordercolor: 'black', box: false, position: 'center' },
  { name: 'Pixel', fontfile: FONT_MONO, fontsize: 46, fontcolor: '0x39FF88', borderw: 2, bordercolor: 'black@0.8', box: true, boxcolor: 'black@0.6', boxborderw: 12, position: 'lower' },
  { name: 'Clarity', fontfile: FONT_BOLD, fontsize: 56, fontcolor: 'white', borderw: 2, bordercolor: 'black@0.5', box: false, position: 'lower' }
];

// ─────────────────────────────────────────────
// THEME MUSIC
// ─────────────────────────────────────────────
const THEME_MUSIC = {
  'horror': [9, 14, 16], 'mystery': [9, 14, 6], 'thriller': [16, 9, 14],
  'adventure': [1, 5, 8], 'fantasy': [2, 5, 11], 'motivation': [3, 7, 10],
  'comedy': [4, 12, 13], 'kids': [4, 12, 13], 'romance': [2, 11, 15],
  'science fiction': [9, 16, 6], 'historical': [5, 8, 11], 'nature': [1, 10, 15],
  'life lesson': [3, 7, 10], 'mindset': [3, 7, 10], 'folklore': [5, 11, 2], 'superhero': [16, 9, 4]
};

function getThemeMusicUrl(category) {
  const pool = THEME_MUSIC[category] || [1, 2, 3];
  const track = pool[Math.floor(Math.random() * pool.length)];
  return `https://www.soundhelix.com/examples/mp3/SoundHelix-Song-${track}.mp3`;
}

// ─────────────────────────────────────────────
// COUNTERS
// ─────────────────────────────────────────────
let categoryIndex     = 0;
let artStyleIndex     = 0;
let captionStyleIndex = 0;
let dailyCount        = 0;
const DAILY_LIMIT     = 15;

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
- Design ONE consistent main character that appears in EVERY scene (same species/look/outfit/colors, only emotion and pose changes per scene)
- Each scene narration MUST match its image emotion exactly
- Captions must be SHORT and PUNCHY (max 6 words, ALL CAPS)
- Story arc: Hook -> Build-up -> Climax -> Twist/Ending
- Make it emotional and shareable

Return ONLY this exact JSON, no markdown:
{
  "title": "Episode title under 55 characters",
  "series": "Series name (e.g. Shadow Files, Toon Tales)",
  "description": "2 sentence engaging caption with 2-3 emojis",
  "hashtags": "#cartoon #shorts #viral #story #fyp #animation #${category.replace(/ /g, '')} #trending #episode #anime",
  "character_design": "Precise visual description of the ONE main character: species, body shape, color palette, outfit, hair/ears/tail, distinguishing features. Will be reused in every scene.",
  "scenes": [
    { "narration": "Hook opening 1-2 sentences", "caption": "HOOK CAPTION", "emotion": "character emotion, pose, action, background for scene 1 only" },
    { "narration": "Build-up 1-2 sentences", "caption": "BUILD CAPTION", "emotion": "character emotion, pose, action, background for scene 2 only" },
    { "narration": "Climax 1-2 sentences", "caption": "CLIMAX CAPTION", "emotion": "character emotion, pose, action, background for scene 3 only" },
    { "narration": "Twist ending 1-2 sentences", "caption": "ENDING CAPTION", "emotion": "character emotion, pose, action, background for scene 4 only" }
  ]
}`;

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    { model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: prompt }], max_tokens: 1400, temperature: 0.95 },
    { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
  );

  const text = response.data.choices[0].message.content;
  const script = JSON.parse(text.replace(/```json|```/g, '').trim());

  script.scenes = script.scenes.map(scene => ({
    ...scene,
    image_prompt: `${artStyle.prompt}, ${script.character_design}, ${scene.emotion}, vertical 9:16 composition, vibrant colors, no text, no watermark, high quality`
  }));

  return script;
}

// ─────────────────────────────────────────────
// STEP 2 — CLOUDFLARE WORKERS AI: Cartoon Image
// Model: @cf/black-forest-labs/flux-1-schnell
// Falls back to Picsum if blocked/fails
// ─────────────────────────────────────────────
async function generateCartoonImage(prompt, outputPath, seed) {
  // PRIMARY: Cloudflare Workers AI (FLUX)
  if (CF_ACCOUNT_ID && CF_API_TOKEN) {
    try {
      const response = await axios.post(
        `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
        {
          prompt: prompt,
          num_steps: 8
        },
        {
          headers: {
            'Authorization': `Bearer ${CF_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          responseType: 'arraybuffer',
          timeout: 90000
        }
      );

      if (response.data && response.data.length > 5000) {
        fs.writeFileSync(outputPath, Buffer.from(response.data));
        console.log('[Image] Cloudflare Workers AI ✅');
        return;
      }
    } catch (err) {
      const msg = err.response ? `${err.response.status} ${JSON.stringify(err.response.data).substring(0, 150)}` : err.message;
      console.log(`[Image] Cloudflare failed: ${msg}`);
      console.log('[Image] Trying Pollinations fallback...');
    }
  }

  // FALLBACK: Pollinations
  const enc = encodeURIComponent(prompt);
  const urls = [
    `https://image.pollinations.ai/prompt/${enc}?width=768&height=1344&seed=${seed}&nologo=true&model=flux&enhance=true`,
    `https://image.pollinations.ai/prompt/${enc}?width=768&height=1344&seed=${seed + 1}&nologo=true&model=turbo`
  ];

  for (const [i, url] of urls.entries()) {
    try {
      const res = await axios({ method: 'GET', url, responseType: 'arraybuffer', timeout: 70000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (res.data && res.data.length > 5000) {
        fs.writeFileSync(outputPath, Buffer.from(res.data));
        console.log(`[Image] Pollinations fallback ${i + 1} ✅`);
        return;
      }
    } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
  }

  // LAST RESORT: Picsum placeholder
  try {
    const res = await axios({ method: 'GET', url: `https://picsum.photos/seed/${seed}/768/1344`, responseType: 'arraybuffer', timeout: 30000 });
    fs.writeFileSync(outputPath, Buffer.from(res.data));
    console.log('[Image] Picsum placeholder (last resort)');
  } catch (e) {
    throw new Error('All image sources failed');
  }
}

// ─────────────────────────────────────────────
// STEP 3 — VOICE: Google TTS (free)
// ─────────────────────────────────────────────
async function generateVoice(text, outputPath) {
  const cleanText = text.replace(/['"]/g, '').substring(0, 200);
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(cleanText)}&tl=en&client=tw-ob&ttsspeed=0.85`;
  const response = await axios({ method: 'GET', url, responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36' } });
  fs.writeFileSync(outputPath, Buffer.from(response.data));
  console.log('[Voice] Saved ✅');
}

// ─────────────────────────────────────────────
// STEP 4 — FFMPEG: Caption overlay
// ─────────────────────────────────────────────
function buildTextSegment(text, y, style) {
  const safe = text.replace(/'/g, '\u2019').replace(/:/g, '\\:').replace(/\\/g, '\\\\');
  let f = `drawtext=text='${safe}':fontsize=${style.fontsize}:fontcolor=${style.fontcolor}:fontfile=${style.fontfile}:x=(w-text_w)/2:y=${y}:borderw=${style.borderw}:bordercolor=${style.bordercolor}`;
  if (style.box) f += `:box=1:boxcolor=${style.boxcolor}:boxborderw=${style.boxborderw}`;
  return f;
}

async function buildSceneVideo(imgPath, audioPath, caption, outputPath, duration, captionStyle) {
  const clean = caption.toUpperCase().replace(/['":\\<>|]/g, '').substring(0, 40).trim();
  const words = clean.split(' ');
  let line1 = clean, line2 = '';
  if (words.length > 3) { const mid = Math.ceil(words.length / 2); line1 = words.slice(0, mid).join(' '); line2 = words.slice(mid).join(' '); }

  let y1, y2;
  if (captionStyle.position === 'lower') { y1 = line2 ? 'h-260' : 'h-180'; y2 = 'h-180'; }
  else { y1 = line2 ? '(h/2)-90' : '(h/2)-40'; y2 = '(h/2)+15'; }

  let textFilter = buildTextSegment(line1, y1, captionStyle);
  if (line2) textFilter += ',' + buildTextSegment(line2, y2, captionStyle);

  const fadeOut = Math.max(duration - 0.4, 0);
  const cmd = `ffmpeg -loop 1 -i "${imgPath}" -i "${audioPath}" -c:v libx264 -tune stillimage -c:a aac -b:a 192k -pix_fmt yuv420p -t ${duration} -vf "scale=768:1344:force_original_aspect_ratio=decrease,pad=768:1344:(ow-iw)/2:(oh-ih)/2:black,${textFilter},fade=t=in:st=0:d=0.4,fade=t=out:st=${fadeOut}:d=0.4" -y "${outputPath}"`;
  await execPromise(cmd);
  console.log(`[FFmpeg] Scene done — "${captionStyle.name}" caption ✅`);
}

// ─────────────────────────────────────────────
// STEP 5 — FFMPEG: Stitch + Theme Music
// ─────────────────────────────────────────────
async function stitchFinalVideo(sceneVideos, tempDir, outputPath, category) {
  const concatFile = path.join(tempDir, 'concat.txt');
  fs.writeFileSync(concatFile, sceneVideos.map(v => `file '${v}'`).join('\n'));
  const tempConcat = path.join(tempDir, 'raw.mp4');
  await execPromise(`ffmpeg -f concat -safe 0 -i "${concatFile}" -c copy -y "${tempConcat}"`);

  const musicPath = path.join(tempDir, 'music.mp3');
  let hasMusic = false;
  try {
    const res = await axios.get(getThemeMusicUrl(category), { responseType: 'arraybuffer', timeout: 20000 });
    fs.writeFileSync(musicPath, Buffer.from(res.data));
    hasMusic = true;
    console.log(`[Music] Theme music loaded for "${category}" ✅`);
  } catch (e) { console.log('[Music] Skipping background music'); }

  if (hasMusic) {
    try {
      const { stdout } = await execPromise(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${tempConcat}"`);
      const dur = parseFloat(stdout.trim());
      await execPromise(`ffmpeg -i "${tempConcat}" -i "${musicPath}" -filter_complex "[1:a]atrim=0:${dur},volume=0.12[bg];[0:a]volume=1.0[voice];[voice][bg]amix=inputs=2:duration=first[aout]" -map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 192k -y "${outputPath}"`);
      console.log('[Music] Mixed ✅'); return;
    } catch (e) { console.log('[Music] Mix failed, using voice only'); }
  }
  fs.copyFileSync(tempConcat, outputPath);
}

// ─────────────────────────────────────────────
// STEP 6 — YOUTUBE
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
// STEP 7 — INSTAGRAM
// ─────────────────────────────────────────────
async function postToInstagram(videoUrl, caption) {
  const con = await axios.post(`https://graph.facebook.com/v18.0/${INSTAGRAM_USER_ID}/media`, { media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: true, access_token: INSTAGRAM_ACCESS_TOKEN });
  const containerId = con.data.id;
  console.log(`[Instagram] Container: ${containerId}`);
  await new Promise(r => setTimeout(r, 45000));
  const pub = await axios.post(`https://graph.facebook.com/v18.0/${INSTAGRAM_USER_ID}/media_publish`, { creation_id: containerId, access_token: INSTAGRAM_ACCESS_TOKEN });
  return pub.data.id;
}

// ─────────────────────────────────────────────
// MAIN PIPELINE
// ─────────────────────────────────────────────
async function runPostingCycle(category = null) {
  const selectedCategory = category || VIDEO_CATEGORIES[categoryIndex % VIDEO_CATEGORIES.length];
  const selectedArtStyle = ART_STYLES[artStyleIndex % ART_STYLES.length];
  const selectedCaption  = CAPTION_STYLES[captionStyleIndex % CAPTION_STYLES.length];
  const characterSeed    = Math.floor(Math.random() * 999999);

  categoryIndex++; artStyleIndex++; captionStyleIndex++; dailyCount++;

  console.log(`\n🎬 [VidForge v9] Category: ${selectedCategory}`);
  console.log(`🎨 Art Style: ${selectedArtStyle.name}`);
  console.log(`✏️  Caption: ${selectedCaption.name}`);
  console.log(`📊 Daily: ${dailyCount}/${DAILY_LIMIT}\n`);

  const results = { category: selectedCategory, artStyle: selectedArtStyle.name, captionStyle: selectedCaption.name, youtube: null, instagram: null, error: null };
  const tempDir = path.join('/tmp', `vidforge_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    console.log('[VidForge] Writing story & designing character...');
    const script = await generateVideoScript(selectedCategory, selectedArtStyle);
    console.log(`[VidForge] "${script.title}" | ${script.series}`);

    const sceneDurations = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const scene = script.scenes[i];
      const imgPath   = path.join(tempDir, `image_${i}.png`);
      const audioPath = path.join(tempDir, `voice_${i}.mp3`);

      console.log(`\n[VidForge] Scene ${i + 1}/4: "${scene.caption}"`);
      await generateCartoonImage(scene.image_prompt, imgPath, characterSeed + i);
      await generateVoice(scene.narration, audioPath);

      let duration = 5;
      try { const { stdout } = await execPromise(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`); duration = Math.max(parseFloat(stdout.trim()) + 0.8, 3.5); } catch (e) {}
      sceneDurations.push(duration);
      console.log(`[VidForge] Scene ${i + 1} ready (${duration.toFixed(1)}s)`);
    }

    console.log(`\n[VidForge] Building scenes with "${selectedCaption.name}" captions...`);
    const sceneVideos = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const sceneOut = path.join(tempDir, `scene_${i}.mp4`);
      await buildSceneVideo(path.join(tempDir, `image_${i}.png`), path.join(tempDir, `voice_${i}.mp3`), script.scenes[i].caption, sceneOut, sceneDurations[i], selectedCaption);
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
app.get('/', (req, res) => res.json({ app: 'VidForge AI', version: '9.0.0', status: 'running' }));

// ── TEST ROUTE: checks if Cloudflare Workers AI works on Render ──
app.get('/test-image', async (req, res) => {
  console.log('[Test] Testing Cloudflare Workers AI...');
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
    return res.json({ success: false, error: 'CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN not set in Render environment!' });
  }
  try {
    const response = await axios.post(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
      { prompt: 'cute chibi cartoon cat, big eyes, colorful, kawaii style', num_steps: 4 },
      { headers: { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' }, responseType: 'arraybuffer', timeout: 60000 }
    );
    if (response.data && response.data.length > 1000) {
      console.log('[Test] Cloudflare Workers AI ✅ WORKS!');
      res.set('Content-Type', 'image/png');
      res.send(Buffer.from(response.data));
    } else {
      res.json({ success: false, error: 'Got response but image too small', size: response.data.length });
    }
  } catch (err) {
    const msg = err.response ? `${err.response.status}: ${JSON.stringify(err.response.data).substring(0, 300)}` : err.message;
    console.log(`[Test] Cloudflare FAILED: ${msg}`);
    res.json({ success: false, error: msg, conclusion: 'Cloudflare is BLOCKED on Render' });
  }
});

app.get('/status', (req, res) => res.json({
  running: true, version: '9.0.0',
  schedule: 'Every 96 minutes (15 videos/day)',
  dailyCount: `${dailyCount}/${DAILY_LIMIT}`,
  nextCategory: VIDEO_CATEGORIES[categoryIndex % VIDEO_CATEGORIES.length],
  nextArtStyle: ART_STYLES[artStyleIndex % ART_STYLES.length].name,
  nextCaptionStyle: CAPTION_STYLES[captionStyleIndex % CAPTION_STYLES.length].name,
  cloudflareConnected: !!(CF_ACCOUNT_ID && CF_API_TOKEN),
  groqConnected: !!GROQ_API_KEY,
  youtubeConnected: !!YOUTUBE_REFRESH_TOKEN,
  instagramConnected: !!INSTAGRAM_ACCESS_TOKEN,
  imageSource: (CF_ACCOUNT_ID && CF_API_TOKEN) ? 'Cloudflare Workers AI FLUX (primary) + Pollinations (fallback)' : 'Pollinations only',
  testImageUrl: '/test-image',
  captionStyles: CAPTION_STYLES.map(s => s.name),
  artStyles: ART_STYLES.map(s => s.name),
  timestamp: new Date().toISOString()
}));

app.post('/generate', async (req, res) => {
  const { category } = req.body || {};
  if (dailyCount >= DAILY_LIMIT) return res.json({ message: 'Daily limit reached!', dailyCount, DAILY_LIMIT });
  res.json({ message: '🎬 Cartoon episode started!', category: category || 'auto' });
  runPostingCycle(category);
});

app.post('/test-script', async (req, res) => {
  const cat = (req.body || {}).category || 'horror';
  const style = ART_STYLES[Math.floor(Math.random() * ART_STYLES.length)];
  try { const script = await generateVideoScript(cat, style); res.json({ success: true, category: cat, artStyle: style.name, script }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/auth/youtube', (req, res) => {
  const oauth2Client = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI);
  res.redirect(oauth2Client.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/youtube.upload'] }));
});

app.get('/auth/youtube/callback', async (req, res) => {
  const oauth2Client = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI);
  const { tokens } = await oauth2Client.getToken(req.query.code);
  res.json({ message: 'Save this refresh_token to Render!', refresh_token: tokens.refresh_token });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 VidForge AI v9.0 — Cloudflare Workers AI + ${ART_STYLES.length} Art Styles + ${CAPTION_STYLES.length} Caption Styles`);
  console.log(`☁️  Cloudflare: ${(CF_ACCOUNT_ID && CF_API_TOKEN) ? 'ENABLED ✅' : 'NOT SET ❌'}`);
  console.log(`🧪 Test image: http://localhost:${PORT}/test-image`);
  console.log(`⏰ Every 96 min = 15 videos/day | 📊 http://localhost:${PORT}/status\n`);
});

module.exports = app;
