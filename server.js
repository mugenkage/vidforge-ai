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
  'horror', 'values', 'life', 'lesson',
  'motivation', 'comedy', 'mystery', 'kids',
  'thriller', 'facts', 'history', 'science',
  'mindset', 'finance', 'relationships', 'nature'
];

let categoryIndex = 0;
let dailyCount = 0;
const DAILY_LIMIT = 15;

// Reset daily count at midnight
cron.schedule('0 0 * * *', () => {
  dailyCount = 0;
  console.log('[VidForge] Daily count reset!');
});

// Post every 96 minutes = ~15 videos/day
cron.schedule('*/96 * * * *', () => {
  if (dailyCount < DAILY_LIMIT) {
    console.log(`[Cron] Triggered! Daily count: ${dailyCount}/${DAILY_LIMIT}`);
    runPostingCycle();
  } else {
    console.log(`[Cron] Daily limit reached (${DAILY_LIMIT}). Waiting for reset.`);
  }
});

// ─────────────────────────────────────────────
// STEP 1 — GROQ: Generate Script + Scenes
// ─────────────────────────────────────────────
async function generateVideoScript(category) {
  const prompt = `Create a short engaging ${category} story for a 30-second Instagram Reel/YouTube Short.

Return ONLY this exact JSON format, nothing else, no markdown:
{
  "title": "catchy title under 60 chars",
  "description": "2-3 sentence caption for the post",
  "hashtags": "#tag1 #tag2 #tag3 #tag4 #tag5 #tag6 #tag7 #tag8 #tag9 #tag10",
  "scenes": [
    {
      "narration": "what the voice will say for scene 1, 1-2 sentences max",
      "image_prompt": "detailed cinematic scene description, dramatic lighting, photorealistic, 4k"
    },
    {
      "narration": "what the voice will say for scene 2, 1-2 sentences max",
      "image_prompt": "detailed cinematic scene description, dramatic lighting, photorealistic, 4k"
    },
    {
      "narration": "what the voice will say for scene 3, 1-2 sentences max",
      "image_prompt": "detailed cinematic scene description, dramatic lighting, photorealistic, 4k"
    },
    {
      "narration": "what the voice will say for scene 4, 1-2 sentences max",
      "image_prompt": "detailed cinematic scene description, dramatic lighting, photorealistic, 4k"
    }
  ]
}`;

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1000,
      temperature: 0.9
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
// STEP 2 — POLLINATIONS: Generate Images (FREE)
// ─────────────────────────────────────────────
async function generateSceneImage(prompt, outputPath) {
  const encodedPrompt = encodeURIComponent(
    prompt + ', cinematic, dramatic lighting, photorealistic, 4k, vertical 9:16'
  );
  const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=768&height=1344&nologo=true&enhance=true`;

  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60000
  });

  fs.writeFileSync(outputPath, Buffer.from(response.data));
  console.log(`[Pollinations] Image saved: ${outputPath}`);
}

// ─────────────────────────────────────────────
// STEP 3 — EDGE-TTS: Generate Voice (FREE)
// ─────────────────────────────────────────────
async function generateVoice(text, outputPath) {
  // edge-tts saves as .mp3 directly
  const voice = 'en-US-ChristopherNeural'; // Deep dramatic male voice
  await execPromise(
    `edge-tts --voice "${voice}" --text "${text.replace(/"/g, "'")}" --write-media "${outputPath}"`
  );
  console.log(`[edge-tts] Voice saved: ${outputPath}`);
}

// ─────────────────────────────────────────────
// STEP 4 — FFMPEG: Stitch Scenes Into Video
// ─────────────────────────────────────────────
async function stitchVideo(scenes, tempDir, outputPath) {
  // Get audio durations
  const sceneDurations = [];
  for (let i = 0; i < scenes.length; i++) {
    const audioPath = path.join(tempDir, `voice_${i}.mp3`);
    try {
      const { stdout } = await execPromise(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
      );
      sceneDurations.push(Math.max(parseFloat(stdout.trim()), 3));
    } catch (e) {
      sceneDurations.push(5); // fallback 5 seconds
    }
  }

  // Create video per scene
  const sceneVideos = [];
  for (let i = 0; i < scenes.length; i++) {
    const imgPath   = path.join(tempDir, `image_${i}.png`);
    const audioPath = path.join(tempDir, `voice_${i}.mp3`);
    const sceneOut  = path.join(tempDir, `scene_${i}.mp4`);
    const duration  = sceneDurations[i];

    await execPromise(
      `ffmpeg -loop 1 -i "${imgPath}" -i "${audioPath}" -c:v libx264 -tune stillimage -c:a aac -b:a 192k -pix_fmt yuv420p -t ${duration} -vf "scale=768:1344:force_original_aspect_ratio=decrease,pad=768:1344:(ow-iw)/2:(oh-ih)/2" -y "${sceneOut}"`
    );
    sceneVideos.push(sceneOut);
    console.log(`[FFmpeg] Scene ${i + 1}/${scenes.length} done`);
  }

  // Concat all scenes
  const concatFile = path.join(tempDir, 'concat.txt');
  fs.writeFileSync(concatFile, sceneVideos.map(v => `file '${v}'`).join('\n'));

  await execPromise(
    `ffmpeg -f concat -safe 0 -i "${concatFile}" -c copy -y "${outputPath}"`
  );
  console.log(`[FFmpeg] Final video: ${outputPath}`);
}

// ─────────────────────────────────────────────
// STEP 5 — YOUTUBE: Upload
// ─────────────────────────────────────────────
async function uploadToYouTube(videoPath, title, description, hashtags) {
  const oauth2Client = new google.auth.OAuth2(
    YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI
  );
  oauth2Client.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });

  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  const uploadResponse = await youtube.videos.insert({
    part: 'snippet,status',
    requestBody: {
      snippet: {
        title: title.substring(0, 100),
        description: `${description}\n\n${hashtags}`,
        tags: hashtags.split('#').filter(Boolean).map(t => t.trim()),
        categoryId: '22',
        defaultLanguage: 'en'
      },
      status: {
        privacyStatus: 'public',
        selfDeclaredMadeForKids: false
      }
    },
    media: {
      mimeType: 'video/mp4',
      body: fs.createReadStream(videoPath)
    }
  });

  return uploadResponse.data.id;
}

// ─────────────────────────────────────────────
// STEP 6 — INSTAGRAM: Post Reel
// ─────────────────────────────────────────────
async function postToInstagram(videoUrl, caption) {
  const containerResponse = await axios.post(
    `https://graph.facebook.com/v18.0/${INSTAGRAM_USER_ID}/media`,
    {
      media_type: 'REELS',
      video_url: videoUrl,
      caption: caption,
      share_to_feed: true,
      access_token: INSTAGRAM_ACCESS_TOKEN
    }
  );

  const containerId = containerResponse.data.id;
  console.log(`[Instagram] Container: ${containerId}`);

  // Wait for Instagram to process video
  await new Promise(r => setTimeout(r, 45000));

  const publishResponse = await axios.post(
    `https://graph.facebook.com/v18.0/${INSTAGRAM_USER_ID}/media_publish`,
    {
      creation_id: containerId,
      access_token: INSTAGRAM_ACCESS_TOKEN
    }
  );

  return publishResponse.data.id;
}

// ─────────────────────────────────────────────
// MAIN PIPELINE
// ─────────────────────────────────────────────
async function runPostingCycle(category = null) {
  const selectedCategory = category || VIDEO_CATEGORIES[categoryIndex % VIDEO_CATEGORIES.length];
  categoryIndex++;
  dailyCount++;

  console.log(`\n🎬 [VidForge] Starting — Category: ${selectedCategory} (${dailyCount}/${DAILY_LIMIT} today)`);
  const results = { category: selectedCategory, youtube: null, instagram: null, error: null };

  const tempDir = path.join('/tmp', `vidforge_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // 1. Script
    console.log('[VidForge] Generating script...');
    const script = await generateVideoScript(selectedCategory);
    console.log(`[VidForge] Script: "${script.title}"`);

    // 2. Images + Voice (parallel per scene)
    for (let i = 0; i < script.scenes.length; i++) {
      const scene = script.scenes[i];
      console.log(`[VidForge] Generating scene ${i + 1}/${script.scenes.length}...`);
      await Promise.all([
        generateSceneImage(scene.image_prompt, path.join(tempDir, `image_${i}.png`)),
        generateVoice(scene.narration, path.join(tempDir, `voice_${i}.mp3`))
      ]);
    }

    // 3. Stitch video
    console.log('[VidForge] Stitching video...');
    const videoPath = path.join(tempDir, 'final.mp4');
    await stitchVideo(script.scenes, tempDir, videoPath);

    const caption = `${script.title}\n\n${script.description}\n\n${script.hashtags}`;

    // 4. YouTube
    try {
      console.log('[VidForge] Uploading to YouTube...');
      const ytId = await uploadToYouTube(videoPath, script.title, script.description, script.hashtags);
      results.youtube = `https://youtube.com/watch?v=${ytId}`;
      console.log(`[VidForge] YouTube ✅ ${results.youtube}`);
    } catch (err) {
      console.error('[VidForge] YouTube ❌', err.message);
      results.youtubeError = err.message;
    }

    // 5. Instagram
    try {
      if (results.youtube) {
        console.log('[VidForge] Posting to Instagram...');
        const igId = await postToInstagram(results.youtube, caption);
        results.instagram = igId;
        console.log(`[VidForge] Instagram ✅ ${igId}`);
      }
    } catch (err) {
      console.error('[VidForge] Instagram ❌', err.message);
      results.instagramError = err.message;
    }

    console.log(`[VidForge] ✅ Done! Daily: ${dailyCount}/${DAILY_LIMIT}\n`);

  } catch (err) {
    results.error = err.message;
    dailyCount--; // don't count failed attempts
    console.error('[VidForge] ❌ Pipeline failed:', err.message);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
  }

  return results;
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ app: 'VidForge AI', status: 'running', version: '4.0.0' });
});

app.get('/status', (req, res) => {
  res.json({
    running: true,
    version: '4.0.0',
    schedule: 'Every 96 minutes (15 videos/day)',
    dailyCount: `${dailyCount}/${DAILY_LIMIT}`,
    nextCategory: VIDEO_CATEGORIES[categoryIndex % VIDEO_CATEGORIES.length],
    categoriesTotal: VIDEO_CATEGORIES.length,
    youtubeConnected:   !!YOUTUBE_REFRESH_TOKEN,
    instagramConnected: !!INSTAGRAM_ACCESS_TOKEN,
    groqConnected:      !!GROQ_API_KEY,
    imageService:       'Pollinations AI (Free)',
    voiceService:       'edge-tts Microsoft (Free)',
    videoService:       'FFmpeg (Free)',
    timestamp: new Date().toISOString()
  });
});

app.post('/generate', async (req, res) => {
  const { category } = req.body || {};
  if (dailyCount >= DAILY_LIMIT) {
    return res.json({ message: 'Daily limit reached! Resets at midnight.', dailyCount, DAILY_LIMIT });
  }
  res.json({ message: '🎬 Video generation started!', category: category || 'auto', dailyCount: dailyCount + 1 });
  runPostingCycle(category);
});

app.post('/test-script', async (req, res) => {
  const { category } = req.body || {};
  try {
    const script = await generateVideoScript(category || 'horror');
    res.json({ success: true, script });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/auth/youtube', (req, res) => {
  const oauth2Client = new google.auth.OAuth2(
    YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI
  );
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/youtube.upload']
  });
  res.redirect(url);
});

app.get('/auth/youtube/callback', async (req, res) => {
  const { code } = req.query;
  const oauth2Client = new google.auth.OAuth2(
    YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI
  );
  const { tokens } = await oauth2Client.getToken(code);
  res.json({ message: 'Save this to your env!', refresh_token: tokens.refresh_token });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`\n🚀 VidForge AI v4.0 running on port ${PORT}`);
  console.log(`📊 Status: http://localhost:${PORT}/status`);
  console.log(`🎬 Schedule: Every 96 minutes = 15 videos/day\n`);
});

module.exports = app;
