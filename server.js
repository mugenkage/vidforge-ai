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

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const VIDEO_CATEGORIES = [
  'horror', 'adventure', 'mystery', 'motivation',
  'fantasy', 'thriller', 'comedy', 'kids',
  'romance', 'science fiction', 'historical', 'nature',
  'life lesson', 'mindset', 'folklore', 'superhero'
];

// Cartoon styles optimized for Picsum fallback too
const ART_STYLES = [
  'cute cartoon character, expressive face, bold outlines, flat colors, white background, chibi style',
  'anime character, big eyes, colorful hair, detailed expression, manga style, vibrant colors',
  'comic book hero, bold lines, dynamic pose, bright colors, superhero style',
  'cute animal character, cartoon style, expressive emotions, colorful, fun illustration',
  'dark anime style, dramatic character, glowing eyes, detailed, cinematic lighting',
  'pixar 3d cartoon style, cute character, expressive, colorful background, detailed',
  'storybook illustration, watercolor style, cute characters, soft pastel colors',
  'retro cartoon style, bold black outlines, limited colors, expressive characters'
];

let categoryIndex = 0;
let artStyleIndex = 0;
let dailyCount = 0;
const DAILY_LIMIT = 15;

cron.schedule('0 0 * * *', () => {
  dailyCount = 0;
  console.log('[VidForge] Daily count reset!');
});

cron.schedule('*/96 * * * *', () => {
  if (dailyCount < DAILY_LIMIT) {
    console.log(`[Cron] Triggered! Daily: ${dailyCount}/${DAILY_LIMIT}`);
    runPostingCycle();
  } else {
    console.log(`[Cron] Daily limit reached.`);
  }
});

// ─────────────────────────────────────────────
// STEP 1 — GROQ: Story + Scene Matching
// ─────────────────────────────────────────────
async function generateVideoScript(category, artStyle) {
  const prompt = `Create a viral ${category} cartoon story for Instagram Reels/YouTube Shorts.

Rules:
- Each scene narration MUST match its image visually
- Captions must be SHORT and PUNCHY (max 6 words, ALL CAPS)
- Story must have a hook, build up, climax, and twist/ending
- Make it emotional and shareable

Return ONLY this JSON, no markdown:
{
  "title": "Catchy episode title under 55 chars",
  "series": "Cool series name (e.g. Dark Tales, Shadow Files)",
  "description": "Engaging 2 sentence caption with emojis",
  "hashtags": "#cartoon #anime #shorts #viral #story #fyp #animation #episode #${category.replace(/ /g,'')} #trending",
  "scenes": [
    {
      "narration": "Hook opening that grabs attention immediately, 1-2 sentences",
      "caption": "HOOK CAPTION HERE",
      "image_prompt": "${artStyle}, [character/scene that EXACTLY matches narration], vertical composition, 9:16, vibrant colors, expressive, detailed"
    },
    {
      "narration": "Build up scene that creates tension or curiosity, 1-2 sentences",
      "caption": "BUILD UP CAPTION",
      "image_prompt": "${artStyle}, [character/scene that EXACTLY matches narration], vertical composition, 9:16, vibrant colors, expressive, detailed"
    },
    {
      "narration": "Climax scene with the most dramatic moment, 1-2 sentences",
      "caption": "CLIMAX CAPTION HERE",
      "image_prompt": "${artStyle}, [character/scene that EXACTLY matches narration], vertical composition, 9:16, vibrant colors, expressive, detailed"
    },
    {
      "narration": "Powerful ending with twist or moral that makes viewers want more, 1-2 sentences",
      "caption": "ENDING CAPTION HERE",
      "image_prompt": "${artStyle}, [character/scene that EXACTLY matches narration], vertical composition, 9:16, vibrant colors, expressive, detailed"
    }
  ]
}`;

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1200,
      temperature: 0.95
    },
    {
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  const text = response.data.choices[0].message.content;
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ─────────────────────────────────────────────
// STEP 2 — IMAGE: Cartoon Scene
// ─────────────────────────────────────────────
async function generateCartoonImage(prompt, outputPath) {
  const seed = Math.floor(Math.random() * 999999);
  const fullPrompt = encodeURIComponent(prompt + ', no text, no watermark');

  const urls = [
    `https://image.pollinations.ai/prompt/${fullPrompt}?width=768&height=1344&seed=${seed}&nologo=true&model=flux`,
    `https://image.pollinations.ai/prompt/${fullPrompt}?width=768&height=1344&seed=${seed}&nologo=true`,
    `https://picsum.photos/seed/${seed}/768/1344`
  ];

  for (const url of urls) {
    try {
      const response = await axios({
        method: 'GET', url,
        responseType: 'arraybuffer',
        timeout: 60000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/91.0' }
      });
      if (response.data && response.data.length > 5000) {
        fs.writeFileSync(outputPath, Buffer.from(response.data));
        const src = url.includes('pollinations') ? 'Pollinations🎨' : 'Picsum📸';
        console.log(`[Image] ${src} saved!`);
        return;
      }
    } catch (err) {
      console.log(`[Image] Trying next source...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error('All image sources failed');
}

// ─────────────────────────────────────────────
// STEP 3 — VOICE: Google TTS
// ─────────────────────────────────────────────
async function generateVoice(text, outputPath) {
  const cleanText = text.replace(/['"]/g, '').substring(0, 200);
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(cleanText)}&tl=en&client=tw-ob&ttsspeed=0.85`;

  const response = await axios({
    method: 'GET', url,
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36' }
  });

  fs.writeFileSync(outputPath, Buffer.from(response.data));
  console.log(`[Voice] Saved!`);
}

// ─────────────────────────────────────────────
// STEP 4 — FFMPEG: Scene with CENTER Caption
// ─────────────────────────────────────────────
async function buildSceneVideo(imgPath, audioPath, caption, outputPath, duration) {
  // Clean caption - uppercase, remove special chars
  const cleanCaption = caption
    .toUpperCase()
    .replace(/['":\\<>|]/g, '')
    .substring(0, 40)
    .trim();

  // Split long captions into 2 lines
  const words = cleanCaption.split(' ');
  let line1 = '', line2 = '';
  if (words.length > 3) {
    const mid = Math.ceil(words.length / 2);
    line1 = words.slice(0, mid).join(' ');
    line2 = words.slice(mid).join(' ');
  } else {
    line1 = cleanCaption;
  }

  const textFilter = line2
    ? `drawtext=text='${line1}':fontsize=72:fontcolor=white:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:x=(w-text_w)/2:y=(h/2)-80:borderw=5:bordercolor=black@0.9:box=1:boxcolor=black@0.4:boxborderw=20,drawtext=text='${line2}':fontsize=72:fontcolor=white:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:x=(w-text_w)/2:y=(h/2)+10:borderw=5:bordercolor=black@0.9:box=1:boxcolor=black@0.4:boxborderw=20`
    : `drawtext=text='${line1}':fontsize=72:fontcolor=white:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:x=(w-text_w)/2:y=(h/2)-40:borderw=5:bordercolor=black@0.9:box=1:boxcolor=black@0.4:boxborderw=20`;

  const fadeOut = Math.max(duration - 0.4, 0);

  const cmd = `ffmpeg -loop 1 -i "${imgPath}" -i "${audioPath}" \
    -c:v libx264 -tune stillimage -c:a aac -b:a 192k \
    -pix_fmt yuv420p -t ${duration} \
    -vf "scale=768:1344:force_original_aspect_ratio=decrease,\
pad=768:1344:(ow-iw)/2:(oh-ih)/2:black,\
${textFilter},\
fade=t=in:st=0:d=0.4,fade=t=out:st=${fadeOut}:d=0.4" \
    -y "${outputPath}"`;

  await execPromise(cmd);
  console.log(`[FFmpeg] Scene with CENTER caption done!`);
}

// ─────────────────────────────────────────────
// STEP 5 — FFMPEG: Stitch + Background Music
// ─────────────────────────────────────────────
async function stitchFinalVideo(sceneVideos, tempDir, outputPath) {
  const concatFile = path.join(tempDir, 'concat.txt');
  fs.writeFileSync(concatFile, sceneVideos.map(v => `file '${v}'`).join('\n'));

  const tempConcat = path.join(tempDir, 'raw.mp4');
  await execPromise(`ffmpeg -f concat -safe 0 -i "${concatFile}" -c copy -y "${tempConcat}"`);

  // Try to get background music
  const musicPath = path.join(tempDir, 'music.mp3');
  let hasMusic = false;

  try {
    const musicUrls = [
      'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3',
      'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3'
    ];
    const url = musicUrls[Math.floor(Math.random() * musicUrls.length)];
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
    fs.writeFileSync(musicPath, Buffer.from(res.data));
    hasMusic = true;
    console.log('[Music] Background music ready!');
  } catch (e) {
    console.log('[Music] Skipping background music');
  }

  if (hasMusic) {
    try {
      const totalDuration = await execPromise(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${tempConcat}"`
      );
      const dur = parseFloat(totalDuration.stdout.trim());

      await execPromise(
        `ffmpeg -i "${tempConcat}" -i "${musicPath}" \
        -filter_complex "[1:a]atrim=0:${dur},volume=0.12[bg];[0:a]volume=1.0[voice];[voice][bg]amix=inputs=2:duration=first[aout]" \
        -map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 192k -y "${outputPath}"`
      );
      console.log('[Music] Mixed with voice successfully!');
      return;
    } catch (e) {
      console.log('[Music] Mix failed, using voice only');
    }
  }

  fs.copyFileSync(tempConcat, outputPath);
}

// ─────────────────────────────────────────────
// STEP 6 — YOUTUBE: Upload
// ─────────────────────────────────────────────
async function uploadToYouTube(videoPath, title, description, hashtags, series) {
  const oauth2Client = new google.auth.OAuth2(
    YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI
  );
  oauth2Client.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  const uploadResponse = await youtube.videos.insert({
    part: 'snippet,status',
    requestBody: {
      snippet: {
        title: `${title} | ${series}`.substring(0, 100),
        description: `${description}\n\n${hashtags}`,
        tags: hashtags.split('#').filter(Boolean).map(t => t.trim()),
        categoryId: '1',
        defaultLanguage: 'en'
      },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false }
    },
    media: { mimeType: 'video/mp4', body: fs.createReadStream(videoPath) }
  });

  return uploadResponse.data.id;
}

// ─────────────────────────────────────────────
// STEP 7 — INSTAGRAM: Post Reel
// ─────────────────────────────────────────────
async function postToInstagram(videoUrl, caption) {
  const containerResponse = await axios.post(
    `https://graph.facebook.com/v18.0/${INSTAGRAM_USER_ID}/media`,
    {
      media_type: 'REELS',
      video_url: videoUrl,
      caption,
      share_to_feed: true,
      access_token: INSTAGRAM_ACCESS_TOKEN
    }
  );

  const containerId = containerResponse.data.id;
  await new Promise(r => setTimeout(r, 45000));

  const publishResponse = await axios.post(
    `https://graph.facebook.com/v18.0/${INSTAGRAM_USER_ID}/media_publish`,
    { creation_id: containerId, access_token: INSTAGRAM_ACCESS_TOKEN }
  );

  return publishResponse.data.id;
}

// ─────────────────────────────────────────────
// MAIN PIPELINE
// ─────────────────────────────────────────────
async function runPostingCycle(category = null) {
  const selectedCategory = category || VIDEO_CATEGORIES[categoryIndex % VIDEO_CATEGORIES.length];
  const selectedStyle = ART_STYLES[artStyleIndex % ART_STYLES.length];
  categoryIndex++;
  artStyleIndex++;
  dailyCount++;

  console.log(`\n🎬 [VidForge v6] Category: ${selectedCategory}`);
  console.log(`🎨 Style: ${selectedStyle.split(',')[0]}`);
  console.log(`📊 Daily: ${dailyCount}/${DAILY_LIMIT}\n`);

  const results = { category: selectedCategory, youtube: null, instagram: null, error: null };
  const tempDir = path.join('/tmp', `vidforge_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // 1. Generate story
    console.log('[VidForge] Writing story...');
    const script = await generateVideoScript(selectedCategory, selectedStyle);
    console.log(`[VidForge] ✍️ "${script.title}" | ${script.series}`);

    // 2. Generate scenes
    const sceneDurations = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const scene = script.scenes[i];
      console.log(`\n[VidForge] 🎬 Scene ${i + 1}/4: "${scene.caption}"`);

      const imgPath   = path.join(tempDir, `image_${i}.png`);
      const audioPath = path.join(tempDir, `voice_${i}.mp3`);

      await Promise.all([
        generateCartoonImage(scene.image_prompt, imgPath),
        generateVoice(scene.narration, audioPath)
      ]);

      let duration = 5;
      try {
        const { stdout } = await execPromise(
          `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
        );
        duration = Math.max(parseFloat(stdout.trim()) + 0.8, 3.5);
      } catch (e) {}
      sceneDurations.push(duration);
      console.log(`[VidForge] Scene ${i + 1} ready! (${duration.toFixed(1)}s)`);
    }

    // 3. Build scene videos with CENTER captions
    console.log('\n[VidForge] 🖊️ Adding captions and building scenes...');
    const sceneVideos = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const sceneOut = path.join(tempDir, `scene_${i}.mp4`);
      await buildSceneVideo(
        path.join(tempDir, `image_${i}.png`),
        path.join(tempDir, `voice_${i}.mp3`),
        script.scenes[i].caption,
        sceneOut,
        sceneDurations[i]
      );
      sceneVideos.push(sceneOut);
    }

    // 4. Stitch with music
    console.log('\n[VidForge] 🎵 Stitching with background music...');
    const videoPath = path.join(tempDir, 'final.mp4');
    await stitchFinalVideo(sceneVideos, tempDir, videoPath);

    const caption = `${script.title} | ${script.series}\n\n${script.description}\n\n${script.hashtags}`;

    // 5. YouTube
    try {
      console.log('\n[VidForge] 📺 Uploading to YouTube...');
      const ytId = await uploadToYouTube(videoPath, script.title, script.description, script.hashtags, script.series);
      results.youtube = `https://youtube.com/watch?v=${ytId}`;
      console.log(`[VidForge] YouTube ✅ ${results.youtube}`);
    } catch (err) {
      console.error('[VidForge] YouTube ❌', err.message);
      results.youtubeError = err.message;
    }

    // 6. Instagram
    try {
      if (results.youtube) {
        console.log('[VidForge] 📱 Posting to Instagram...');
        const igId = await postToInstagram(results.youtube, caption);
        results.instagram = igId;
        console.log(`[VidForge] Instagram ✅`);
      }
    } catch (err) {
      console.error('[VidForge] Instagram ❌', err.message);
      results.instagramError = err.message;
    }

    console.log(`\n🎉 [VidForge] DONE! ${dailyCount}/${DAILY_LIMIT} today`);
    console.log(`🔗 Watch: ${results.youtube}\n`);

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
  app: 'VidForge AI',
  version: '6.0.0',
  status: 'running',
  description: 'Infinite AI Cartoon Series — Center Captions + Background Music'
}));

app.get('/status', (req, res) => res.json({
  running: true,
  version: '6.0.0',
  schedule: 'Every 96 minutes (15 videos/day)',
  dailyCount: `${dailyCount}/${DAILY_LIMIT}`,
  nextCategory: VIDEO_CATEGORIES[categoryIndex % VIDEO_CATEGORIES.length],
  nextStyle: ART_STYLES[artStyleIndex % ART_STYLES.length].split(',')[0],
  youtubeConnected:   !!YOUTUBE_REFRESH_TOKEN,
  instagramConnected: !!INSTAGRAM_ACCESS_TOKEN,
  groqConnected:      !!GROQ_API_KEY,
  features: [
    'Cartoon/Anime art styles',
    'CENTER bold captions',
    'Story-matched visuals',
    'Background music',
    'Voice narration',
    'Fade transitions',
    'Infinite series'
  ],
  timestamp: new Date().toISOString()
}));

app.post('/generate', async (req, res) => {
  const { category } = req.body || {};
  if (dailyCount >= DAILY_LIMIT) {
    return res.json({ message: 'Daily limit reached!', dailyCount, DAILY_LIMIT });
  }
  res.json({ message: '🎬 Cartoon episode started!', category: category || 'auto', dailyCount: dailyCount + 1 });
  runPostingCycle(category);
});

app.post('/test-script', async (req, res) => {
  const { category } = req.body || {};
  const cat = category || 'horror';
  const style = ART_STYLES[Math.floor(Math.random() * ART_STYLES.length)];
  try {
    const script = await generateVideoScript(cat, style);
    res.json({ success: true, category: cat, style: style.split(',')[0], script });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
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
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 VidForge AI v6.0 — Infinite Cartoon Series`);
  console.log(`🎨 ${ART_STYLES.length} art styles | 📚 ${VIDEO_CATEGORIES.length} categories`);
  console.log(`⏰ Every 96 min = 15 videos/day`);
  console.log(`📊 http://localhost:${PORT}/status\n`);
});

module.exports = app;
