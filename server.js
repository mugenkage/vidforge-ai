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

// Cartoon/anime styles that rotate for variety
const ART_STYLES = [
  'anime style, Studio Ghibli inspired, detailed illustration',
  'cartoon style, Pixar inspired, colorful 3D render',
  'dark anime style, dramatic lighting, detailed manga art',
  'watercolor cartoon style, soft colors, storybook illustration',
  'comic book style, bold lines, vibrant colors',
  'chibi anime style, cute characters, pastel colors',
  'realistic anime style, cinematic, detailed background',
  'flat design cartoon, minimalist, colorful'
];

let categoryIndex = 0;
let artStyleIndex = 0;
let dailyCount = 0;
const DAILY_LIMIT = 15;

// Reset daily count at midnight
cron.schedule('0 0 * * *', () => {
  dailyCount = 0;
  console.log('[VidForge] Daily count reset!');
});

// Post every 96 minutes = 15 videos/day
cron.schedule('*/96 * * * *', () => {
  if (dailyCount < DAILY_LIMIT) {
    console.log(`[Cron] Triggered! Daily: ${dailyCount}/${DAILY_LIMIT}`);
    runPostingCycle();
  } else {
    console.log(`[Cron] Daily limit reached. Waiting for reset.`);
  }
});

// ─────────────────────────────────────────────
// STEP 1 — GROQ: Generate Story + Scenes
// ─────────────────────────────────────────────
async function generateVideoScript(category, artStyle) {
  const prompt = `Create an engaging ${category} cartoon story for a 30-second Instagram Reel/YouTube Short.

The story should have 4 scenes. Each scene image MUST visually match the narration exactly.

Return ONLY this JSON, no markdown, no extra text:
{
  "title": "Episode title under 60 chars",
  "series": "Series name (e.g. Dark Tales, Adventure Time, Mystery Files)",
  "episode": "Episode 1",
  "description": "2-3 sentence caption",
  "hashtags": "#cartoon #anime #shorts #story #viral #fyp #animation #tales #${category} #episode",
  "scenes": [
    {
      "narration": "Opening narration 1-2 sentences that sets the scene",
      "caption": "Short punchy text to show on screen (max 8 words)",
      "image_prompt": "${artStyle}, ${category} scene, [describe EXACTLY what narration says visually], vertical 9:16, high quality, detailed"
    },
    {
      "narration": "Scene 2 narration continuing the story",
      "caption": "Short punchy text for scene 2 (max 8 words)",
      "image_prompt": "${artStyle}, ${category} scene, [describe EXACTLY what narration says visually], vertical 9:16, high quality, detailed"
    },
    {
      "narration": "Scene 3 narration building tension or action",
      "caption": "Short punchy text for scene 3 (max 8 words)",
      "image_prompt": "${artStyle}, ${category} scene, [describe EXACTLY what narration says visually], vertical 9:16, high quality, detailed"
    },
    {
      "narration": "Scene 4 narration with a powerful ending or cliffhanger",
      "caption": "Ending text that makes viewer want more (max 8 words)",
      "image_prompt": "${artStyle}, ${category} scene, [describe EXACTLY what narration says visually], vertical 9:16, high quality, detailed"
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
// STEP 2 — POLLINATIONS: Cartoon Image
// ─────────────────────────────────────────────
async function generateCartoonImage(prompt, outputPath) {
  const seed = Math.floor(Math.random() * 999999);
  const fullPrompt = encodeURIComponent(prompt + ', no text, no watermark, high quality');
  
  // Try Pollinations first (best quality cartoon)
  const urls = [
    `https://image.pollinations.ai/prompt/${fullPrompt}?width=768&height=1344&seed=${seed}&nologo=true&model=flux`,
    `https://image.pollinations.ai/prompt/${fullPrompt}?width=768&height=1344&seed=${seed}&nologo=true`,
    `https://picsum.photos/seed/${seed}/768/1344`
  ];

  for (const url of urls) {
    try {
      const response = await axios({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        timeout: 60000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36' }
      });
      if (response.data && response.data.length > 5000) {
        fs.writeFileSync(outputPath, Buffer.from(response.data));
        console.log(`[Image] Saved from ${url.includes('pollinations') ? 'Pollinations' : 'Picsum'}`);
        return;
      }
    } catch (err) {
      console.log(`[Image] Failed: ${err.message} — trying next...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error('All image sources failed');
}

// ─────────────────────────────────────────────
// STEP 3 — GOOGLE TTS: Voice Generation
// ─────────────────────────────────────────────
async function generateVoice(text, outputPath) {
  const cleanText = text.replace(/['"]/g, '').substring(0, 200);
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(cleanText)}&tl=en&client=tw-ob&ttsspeed=0.9`;
  
  const response = await axios({
    method: 'GET',
    url,
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36' }
  });

  fs.writeFileSync(outputPath, Buffer.from(response.data));
  console.log(`[Voice] Saved: ${outputPath}`);
}

// ─────────────────────────────────────────────
// STEP 4 — FFMPEG: Build Scene Video with Caption
// ─────────────────────────────────────────────
async function buildSceneVideo(imgPath, audioPath, caption, outputPath, duration) {
  // Clean caption for FFmpeg
  const cleanCaption = caption.replace(/['":\\]/g, '').substring(0, 50);
  
  // Build scene video with:
  // - Image as background
  // - Caption text at bottom (white with black outline)
  // - Audio narration
  // - Fade in/out effect
  const ffmpegCmd = `ffmpeg -loop 1 -i "${imgPath}" -i "${audioPath}" \
    -c:v libx264 -tune stillimage -c:a aac -b:a 192k \
    -pix_fmt yuv420p -t ${duration} \
    -vf "scale=768:1344:force_original_aspect_ratio=decrease,\
pad=768:1344:(ow-iw)/2:(oh-ih)/2:black,\
drawtext=text='${cleanCaption}':fontsize=52:fontcolor=white:\
fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:\
x=(w-text_w)/2:y=h-180:\
borderw=4:bordercolor=black:\
box=1:boxcolor=black@0.5:boxborderw=15,\
fade=t=in:st=0:d=0.3,fade=t=out:st=${Math.max(duration - 0.3, 0)}:d=0.3" \
    -y "${outputPath}"`;

  await execPromise(ffmpegCmd);
  console.log(`[FFmpeg] Scene with caption done: ${outputPath}`);
}

// ─────────────────────────────────────────────
// STEP 5 — FFMPEG: Add Background Music + Stitch
// ─────────────────────────────────────────────
async function stitchFinalVideo(sceneVideos, tempDir, outputPath) {
  // Concat all scenes
  const concatFile = path.join(tempDir, 'concat.txt');
  fs.writeFileSync(concatFile, sceneVideos.map(v => `file '${v}'`).join('\n'));
  
  const tempConcat = path.join(tempDir, 'concat_raw.mp4');
  await execPromise(`ffmpeg -f concat -safe 0 -i "${concatFile}" -c copy -y "${tempConcat}"`);

  // Download free background music
  const musicPath = path.join(tempDir, 'music.mp3');
  let hasMusicFile = false;
  
  try {
    // Free lofi/ambient music from GitHub
    const musicUrls = [
      'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
      'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3'
    ];
    const musicUrl = musicUrls[Math.floor(Math.random() * musicUrls.length)];
    const musicResponse = await axios.get(musicUrl, { responseType: 'arraybuffer', timeout: 15000 });
    fs.writeFileSync(musicPath, Buffer.from(musicResponse.data));
    hasMusicFile = true;
    console.log('[Music] Background music downloaded!');
  } catch (e) {
    console.log('[Music] No music available, continuing without');
  }

  if (hasMusicFile) {
    // Mix voice (100% volume) + background music (15% volume)
    await execPromise(
      `ffmpeg -i "${tempConcat}" -i "${musicPath}" \
      -filter_complex "[0:a]volume=1.0[voice];[1:a]volume=0.15,atrim=0:$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${tempConcat}")[bgm];[voice][bgm]amix=inputs=2:duration=first[aout]" \
      -map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 192k -y "${outputPath}"`
    );
  } else {
    fs.copyFileSync(tempConcat, outputPath);
  }

  console.log(`[FFmpeg] Final video ready: ${outputPath}`);
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
        description: `${description}\n\n${hashtags}\n\n#${series.replace(/ /g, '')}`,
        tags: hashtags.split('#').filter(Boolean).map(t => t.trim()),
        categoryId: '1', // Film & Animation
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

  console.log(`\n🎬 [VidForge] Category: ${selectedCategory} | Style: ${selectedStyle.split(',')[0]}`);
  console.log(`📊 Daily: ${dailyCount}/${DAILY_LIMIT}`);
  
  const results = { category: selectedCategory, youtube: null, instagram: null, error: null };
  const tempDir = path.join('/tmp', `vidforge_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // 1. Generate story
    console.log('[VidForge] Writing story...');
    const script = await generateVideoScript(selectedCategory, selectedStyle);
    console.log(`[VidForge] Story: "${script.title}" | Series: ${script.series}`);

    // 2. Generate all scenes (images + voice in parallel)
    const sceneDurations = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const scene = script.scenes[i];
      console.log(`[VidForge] Generating scene ${i + 1}/4...`);

      const imgPath   = path.join(tempDir, `image_${i}.png`);
      const audioPath = path.join(tempDir, `voice_${i}.mp3`);

      await Promise.all([
        generateCartoonImage(scene.image_prompt, imgPath),
        generateVoice(scene.narration, audioPath)
      ]);

      // Get audio duration
      let duration = 5;
      try {
        const { stdout } = await execPromise(
          `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
        );
        duration = Math.max(parseFloat(stdout.trim()) + 0.5, 3);
      } catch (e) {}
      sceneDurations.push(duration);

      console.log(`[VidForge] Scene ${i + 1} ready! Duration: ${duration.toFixed(1)}s`);
    }

    // 3. Build scene videos with captions
    console.log('[VidForge] Building scene videos with captions...');
    const sceneVideos = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const imgPath   = path.join(tempDir, `image_${i}.png`);
      const audioPath = path.join(tempDir, `voice_${i}.mp3`);
      const sceneOut  = path.join(tempDir, `scene_${i}.mp4`);
      
      await buildSceneVideo(
        imgPath, audioPath,
        script.scenes[i].caption,
        sceneOut,
        sceneDurations[i]
      );
      sceneVideos.push(sceneOut);
    }

    // 4. Stitch with background music
    console.log('[VidForge] Stitching final video with music...');
    const videoPath = path.join(tempDir, 'final.mp4');
    await stitchFinalVideo(sceneVideos, tempDir, videoPath);

    const caption = `${script.title} | ${script.series}\n\n${script.description}\n\n${script.hashtags}`;

    // 5. Upload YouTube
    try {
      console.log('[VidForge] Uploading to YouTube...');
      const ytId = await uploadToYouTube(videoPath, script.title, script.description, script.hashtags, script.series);
      results.youtube = `https://youtube.com/watch?v=${ytId}`;
      console.log(`[VidForge] YouTube ✅ ${results.youtube}`);
    } catch (err) {
      console.error('[VidForge] YouTube ❌', err.message);
      results.youtubeError = err.message;
    }

    // 6. Post Instagram
    try {
      if (results.youtube) {
        console.log('[VidForge] Posting to Instagram...');
        const igId = await postToInstagram(results.youtube, caption);
        results.instagram = igId;
        console.log(`[VidForge] Instagram ✅`);
      }
    } catch (err) {
      console.error('[VidForge] Instagram ❌', err.message);
      results.instagramError = err.message;
    }

    console.log(`\n✅ [VidForge] Done! ${dailyCount}/${DAILY_LIMIT} today\n`);

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
  status: 'running',
  version: '5.0.0',
  description: 'Infinite AI Cartoon Series Generator'
}));

app.get('/status', (req, res) => res.json({
  running: true,
  version: '5.0.0',
  schedule: 'Every 96 minutes (15 videos/day)',
  dailyCount: `${dailyCount}/${DAILY_LIMIT}`,
  nextCategory: VIDEO_CATEGORIES[categoryIndex % VIDEO_CATEGORIES.length],
  nextStyle: ART_STYLES[artStyleIndex % ART_STYLES.length].split(',')[0],
  totalCategories: VIDEO_CATEGORIES.length,
  totalStyles: ART_STYLES.length,
  youtubeConnected:   !!YOUTUBE_REFRESH_TOKEN,
  instagramConnected: !!INSTAGRAM_ACCESS_TOKEN,
  groqConnected:      !!GROQ_API_KEY,
  features: ['Cartoon/Anime Images', 'Story-matched visuals', 'Text captions on screen', 'Background music', 'Voice narration', 'Infinite series'],
  timestamp: new Date().toISOString()
}));

app.post('/generate', async (req, res) => {
  const { category } = req.body || {};
  if (dailyCount >= DAILY_LIMIT) {
    return res.json({ message: 'Daily limit reached! Resets at midnight.', dailyCount, DAILY_LIMIT });
  }
  res.json({ message: '🎬 Cartoon episode generation started!', category: category || 'auto', dailyCount: dailyCount + 1 });
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
  res.json({ message: 'Save this!', refresh_token: tokens.refresh_token });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 VidForge AI v5.0 — Infinite Cartoon Series`);
  console.log(`📊 Status: http://localhost:${PORT}/status`);
  console.log(`🎨 Styles: ${ART_STYLES.length} art styles rotating`);
  console.log(`📚 Categories: ${VIDEO_CATEGORIES.length} story categories`);
  console.log(`⏰ Schedule: Every 96 minutes = 15 videos/day\n`);
});

module.exports = app;
