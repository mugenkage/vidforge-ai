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
// STEP 1 — GROQ: Generate Script
// ─────────────────────────────────────────────
async function generateVideoScript(category) {
  const prompt = `Create a short engaging ${category} story for a 30-second Instagram Reel/YouTube Short.

Return ONLY this exact JSON format, no markdown, no extra text:
{
  "title": "catchy title under 60 chars",
  "description": "2-3 sentence caption for the post",
  "hashtags": "#tag1 #tag2 #tag3 #tag4 #tag5 #tag6 #tag7 #tag8 #tag9 #tag10",
  "scenes": [
    {
      "narration": "scene 1 narration, 1-2 sentences",
      "image_prompt": "cinematic scene description, dramatic lighting, photorealistic"
    },
    {
      "narration": "scene 2 narration, 1-2 sentences",
      "image_prompt": "cinematic scene description, dramatic lighting, photorealistic"
    },
    {
      "narration": "scene 3 narration, 1-2 sentences",
      "image_prompt": "cinematic scene description, dramatic lighting, photorealistic"
    },
    {
      "narration": "scene 4 narration, 1-2 sentences",
      "image_prompt": "cinematic scene description, dramatic lighting, photorealistic"
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
async function generateSceneImage(prompt, outputPath, retries = 3) {
  const seed = Math.floor(Math.random() * 999999);
  const encodedPrompt = encodeURIComponent(prompt + ', cinematic, 4k, dramatic');
  const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=768&height=1344&seed=${seed}&nologo=true&model=flux`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'arraybuffer',
        timeout: 90000,
        headers: { 'User-Agent': 'VidForgeAI/4.0' }
      });

      if (response.data && response.data.length > 1000) {
        fs.writeFileSync(outputPath, Buffer.from(response.data));
        console.log(`[Pollinations] Image saved (attempt ${attempt}): ${outputPath}`);
        return;
      }
      throw new Error('Empty image response');
    } catch (err) {
      console.log(`[Pollinations] Attempt ${attempt} failed: ${err.message}`);
      if (attempt < retries) await new Promise(r => setTimeout(r, 5000));
      else throw err;
    }
  }
}

// ─────────────────────────────────────────────
// STEP 3 — MICROSOFT TTS: Voice via HTTP (FREE)
// No pip install needed — direct API call!
// ─────────────────────────────────────────────
async function generateVoice(text, outputPath) {
  // Get access token from Microsoft
  const tokenResponse = await axios.post(
    'https://eastus.api.cognitive.microsoft.com/sts/v1.0/issueToken',
    null,
    {
      headers: {
        'Ocp-Apim-Subscription-Key': 'free',
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }
  ).catch(() => null);

  // If Microsoft fails, use TTS.monster free API
  const ttsUrl = 'https://api.tts.quest/v3/voicevox/audio';
  
  try {
    // Try VoiceVox TTS (completely free, no key)
    const response = await axios.get(ttsUrl, {
      params: { text: text, speaker: 1 },
      responseType: 'arraybuffer',
      timeout: 30000
    });
    fs.writeFileSync(outputPath, Buffer.from(response.data));
    console.log(`[TTS] Voice saved: ${outputPath}`);
  } catch (err) {
    // Fallback: use gtts via direct Google translate TTS
    console.log('[TTS] Trying Google TTS fallback...');
    const googleTTS = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=en&client=tw-ob`;
    const gResponse = await axios.get(googleTTS, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    fs.writeFileSync(outputPath, Buffer.from(gResponse.data));
    console.log(`[TTS] Google TTS voice saved: ${outputPath}`);
  }
}

// ─────────────────────────────────────────────
// STEP 4 — FFMPEG: Stitch Video
// ─────────────────────────────────────────────
async function stitchVideo(scenes, tempDir, outputPath) {
  const sceneDurations = [];
  for (let i = 0; i < scenes.length; i++) {
    const audioPath = path.join(tempDir, `voice_${i}.mp3`);
    try {
      const { stdout } = await execPromise(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
      );
      sceneDurations.push(Math.max(parseFloat(stdout.trim()), 3));
    } catch (e) {
      sceneDurations.push(5);
    }
  }

  const sceneVideos = [];
  for (let i = 0; i < scenes.length; i++) {
    const imgPath   = path.join(tempDir, `image_${i}.png`);
    const audioPath = path.join(tempDir, `voice_${i}.mp3`);
    const sceneOut  = path.join(tempDir, `scene_${i}.mp4`);
    const duration  = sceneDurations[i];

    await execPromise(
      `ffmpeg -loop 1 -i "${imgPath}" -i "${audioPath}" -c:v libx264 -tune stillimage -c:a aac -b:a 192k -pix_fmt yuv420p -t ${duration} -vf "scale=768:1344:force_original_aspect_ratio=decrease,pad=768:1344:(ow-iw)/2:(oh-ih)/2:black" -y "${sceneOut}"`
    );
    sceneVideos.push(sceneOut);
    console.log(`[FFmpeg] Scene ${i + 1}/${scenes.length} done`);
  }

  const concatFile = path.join(tempDir, 'concat.txt');
  fs.writeFileSync(concatFile, sceneVideos.map(v => `file '${v}'`).join('\n'));
  await execPromise(`ffmpeg -f concat -safe 0 -i "${concatFile}" -c copy -y "${outputPath}"`);
  console.log(`[FFmpeg] Final video ready!`);
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
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false }
    },
    media: { mimeType: 'video/mp4', body: fs.createReadStream(videoPath) }
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
  categoryIndex++;
  dailyCount++;

  console.log(`\n🎬 [VidForge] Category: ${selectedCategory} (${dailyCount}/${DAILY_LIMIT})`);
  const results = { category: selectedCategory, youtube: null, instagram: null, error: null };

  const tempDir = path.join('/tmp', `vidforge_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    console.log('[VidForge] Generating script...');
    const script = await generateVideoScript(selectedCategory);
    console.log(`[VidForge] Script: "${script.title}"`);

    for (let i = 0; i < script.scenes.length; i++) {
      console.log(`[VidForge] Scene ${i + 1}/${script.scenes.length}...`);
      await Promise.all([
        generateSceneImage(script.scenes[i].image_prompt, path.join(tempDir, `image_${i}.png`)),
        generateVoice(script.scenes[i].narration, path.join(tempDir, `voice_${i}.mp3`))
      ]);
    }

    console.log('[VidForge] Stitching video...');
    const videoPath = path.join(tempDir, 'final.mp4');
    await stitchVideo(script.scenes, tempDir, videoPath);

    const caption = `${script.title}\n\n${script.description}\n\n${script.hashtags}`;

    try {
      console.log('[VidForge] Uploading to YouTube...');
      const ytId = await uploadToYouTube(videoPath, script.title, script.description, script.hashtags);
      results.youtube = `https://youtube.com/watch?v=${ytId}`;
      console.log(`[VidForge] YouTube ✅ ${results.youtube}`);
    } catch (err) {
      console.error('[VidForge] YouTube ❌', err.message);
      results.youtubeError = err.message;
    }

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

    console.log(`[VidForge] ✅ Done! ${dailyCount}/${DAILY_LIMIT} today\n`);

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
app.get('/', (req, res) => res.json({ app: 'VidForge AI', status: 'running', version: '4.1.0' }));

app.get('/status', (req, res) => res.json({
  running: true,
  version: '4.1.0',
  schedule: 'Every 96 minutes (15 videos/day)',
  dailyCount: `${dailyCount}/${DAILY_LIMIT}`,
  nextCategory: VIDEO_CATEGORIES[categoryIndex % VIDEO_CATEGORIES.length],
  youtubeConnected:   !!YOUTUBE_REFRESH_TOKEN,
  instagramConnected: !!INSTAGRAM_ACCESS_TOKEN,
  groqConnected:      !!GROQ_API_KEY,
  imageService:  'Pollinations AI (Free)',
  voiceService:  'Google TTS (Free)',
  videoService:  'FFmpeg (Free)',
  timestamp: new Date().toISOString()
}));

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
  console.log(`\n🚀 VidForge AI v4.1 running on port ${PORT}`);
  console.log(`📊 Status: http://localhost:${PORT}/status`);
  console.log(`🎬 Schedule: Every 96 minutes = 15 videos/day\n`);
});

module.exports = app;
