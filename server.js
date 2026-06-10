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

const GROQ_API_KEY           = process.env.CLAUDE_API_KEY;
const ELEVENLABS_API_KEY     = process.env.ELEVENLABS_API_KEY;
const STABILITY_API_KEY      = process.env.STABILITY_API_KEY;
const RUNWAY_API_KEY         = process.env.RUNWAY_API_KEY; // optional, for future

const POST_SCHEDULE          = process.env.POST_SCHEDULE || '0 */6 * * *';

// ─────────────────────────────────────────────
// CATEGORIES
// ─────────────────────────────────────────────
const VIDEO_CATEGORIES = [
  'horror', 'values', 'life', 'lesson',
  'motivation', 'comedy', 'mystery', 'kids'
];
let categoryIndex = 0;

// ElevenLabs voice ID — "Adam" deep dramatic voice
const ELEVENLABS_VOICE_ID = 'pNInz6obpgDQGcFmaJgB';

// ─────────────────────────────────────────────
// STEP 1 — GROQ: Generate Script + Scenes
// ─────────────────────────────────────────────
async function generateVideoScript(category) {
  const prompt = `Create a short engaging ${category} story for a 30-second Instagram Reel/YouTube Short.

Return ONLY this exact JSON format, nothing else:
{
  "title": "catchy title under 60 chars",
  "description": "2-3 sentence caption for the post",
  "hashtags": "#tag1 #tag2 #tag3 #tag4 #tag5 #tag6 #tag7 #tag8 #tag9 #tag10",
  "scenes": [
    {
      "narration": "what the voice will say for scene 1 (1-2 sentences)",
      "image_prompt": "detailed cinematic image description for scene 1, dramatic lighting, high quality"
    },
    {
      "narration": "what the voice will say for scene 2 (1-2 sentences)",
      "image_prompt": "detailed cinematic image description for scene 2, dramatic lighting, high quality"
    },
    {
      "narration": "what the voice will say for scene 3 (1-2 sentences)",
      "image_prompt": "detailed cinematic image description for scene 3, dramatic lighting, high quality"
    },
    {
      "narration": "what the voice will say for scene 4 (1-2 sentences)",
      "image_prompt": "detailed cinematic image description for scene 4, dramatic lighting, high quality"
    }
  ]
}`;

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama3-8b-8192',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1000,
      temperature: 0.8
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
// STEP 2 — STABILITY AI: Generate Scene Images
// ─────────────────────────────────────────────
async function generateSceneImage(prompt, outputPath) {
  const response = await axios.post(
    'https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image',
    {
      text_prompts: [
        { text: prompt, weight: 1 },
        { text: 'blurry, low quality, text, watermark, ugly', weight: -1 }
      ],
      cfg_scale: 7,
      height: 1344,
      width: 768,
      samples: 1,
      steps: 30
    },
    {
      headers: {
        'Authorization': `Bearer ${STABILITY_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    }
  );

  const imageData = response.data.artifacts[0].base64;
  fs.writeFileSync(outputPath, Buffer.from(imageData, 'base64'));
  console.log(`[Stability] Image saved: ${outputPath}`);
}

// ─────────────────────────────────────────────
// STEP 3 — ELEVENLABS: Generate Voice Narration
// ─────────────────────────────────────────────
async function generateVoice(text, outputPath) {
  const response = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      text: text,
      model_id: 'eleven_monolingual_v1',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.3,
        use_speaker_boost: true
      }
    },
    {
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      responseType: 'arraybuffer'
    }
  );

  fs.writeFileSync(outputPath, Buffer.from(response.data));
  console.log(`[ElevenLabs] Voice saved: ${outputPath}`);
}

// ─────────────────────────────────────────────
// STEP 4 — FFMPEG: Stitch Scenes Into Video
// ─────────────────────────────────────────────
async function stitchVideo(scenes, tempDir, outputPath) {
  // Get duration of each audio file
  const sceneDurations = [];
  for (let i = 0; i < scenes.length; i++) {
    const audioPath = path.join(tempDir, `voice_${i}.mp3`);
    const { stdout } = await execPromise(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
    );
    sceneDurations.push(parseFloat(stdout.trim()));
  }

  // Create video for each scene (image + audio)
  const sceneVideos = [];
  for (let i = 0; i < scenes.length; i++) {
    const imgPath   = path.join(tempDir, `image_${i}.png`);
    const audioPath = path.join(tempDir, `voice_${i}.mp3`);
    const sceneOut  = path.join(tempDir, `scene_${i}.mp4`);
    const duration  = sceneDurations[i];

    await execPromise(
      `ffmpeg -loop 1 -i "${imgPath}" -i "${audioPath}" -c:v libx264 -tune stillimage -c:a aac -b:a 192k -pix_fmt yuv420p -t ${duration} -vf "scale=768:1344" -y "${sceneOut}"`
    );
    sceneVideos.push(sceneOut);
    console.log(`[FFmpeg] Scene ${i + 1} video created`);
  }

  // Write concat list
  const concatFile = path.join(tempDir, 'concat.txt');
  const concatContent = sceneVideos.map(v => `file '${v}'`).join('\n');
  fs.writeFileSync(concatFile, concatContent);

  // Concatenate all scenes
  await execPromise(
    `ffmpeg -f concat -safe 0 -i "${concatFile}" -c copy -y "${outputPath}"`
  );
  console.log(`[FFmpeg] Final video: ${outputPath}`);
}

// ─────────────────────────────────────────────
// STEP 5 — YOUTUBE: Upload Video
// ─────────────────────────────────────────────
async function uploadToYouTube(videoPath, title, description, hashtags) {
  const oauth2Client = new google.auth.OAuth2(
    YOUTUBE_CLIENT_ID,
    YOUTUBE_CLIENT_SECRET,
    YOUTUBE_REDIRECT_URI
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
  // Create container
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

  // Wait for processing
  await new Promise(r => setTimeout(r, 30000));

  // Publish
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

  console.log(`\n🎬 [VidForge] Starting — Category: ${selectedCategory}`);
  const results = { category: selectedCategory, youtube: null, instagram: null, error: null };

  // Temp directory for this cycle
  const tempDir = path.join('/tmp', `vidforge_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // 1. Generate script
    console.log('[VidForge] Generating script...');
    const script = await generateVideoScript(selectedCategory);
    console.log(`[VidForge] Script: "${script.title}"`);

    // 2. Generate images + voices for each scene
    for (let i = 0; i < script.scenes.length; i++) {
      const scene = script.scenes[i];
      console.log(`[VidForge] Scene ${i + 1}/${script.scenes.length}...`);

      await Promise.all([
        generateSceneImage(scene.image_prompt, path.join(tempDir, `image_${i}.png`)),
        generateVoice(scene.narration, path.join(tempDir, `voice_${i}.mp3`))
      ]);
    }

    // 3. Stitch into video
    console.log('[VidForge] Stitching video...');
    const videoPath = path.join(tempDir, 'final.mp4');
    await stitchVideo(script.scenes, tempDir, videoPath);

    const caption = `${script.title}\n\n${script.description}\n\n${script.hashtags}`;

    // 4. Upload to YouTube
    try {
      console.log('[VidForge] Uploading to YouTube...');
      const ytId = await uploadToYouTube(videoPath, script.title, script.description, script.hashtags);
      results.youtube = `https://youtube.com/watch?v=${ytId}`;
      console.log(`[VidForge] YouTube: ${results.youtube}`);
    } catch (err) {
      console.error('[VidForge] YouTube failed:', err.message);
      results.youtubeError = err.message;
    }

    // 5. Post to Instagram (needs public video URL — use YouTube URL)
    try {
      if (results.youtube) {
        console.log('[VidForge] Posting to Instagram...');
        const igId = await postToInstagram(results.youtube, caption);
        results.instagram = igId;
        console.log(`[VidForge] Instagram: ${igId}`);
      }
    } catch (err) {
      console.error('[VidForge] Instagram failed:', err.message);
      results.instagramError = err.message;
    }

    console.log('[VidForge] ✅ Cycle complete!\n');

  } catch (err) {
    results.error = err.message;
    console.error('[VidForge] ❌ Failed:', err.message);
  } finally {
    // Cleanup temp files
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {}
  }

  return results;
}

// ─────────────────────────────────────────────
// CRON SCHEDULER
// ─────────────────────────────────────────────
cron.schedule(POST_SCHEDULE, () => {
  console.log('[Cron] Triggered!');
  runPostingCycle();
});
console.log(`[VidForge] Scheduler: ${POST_SCHEDULE}`);

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ app: 'VidForge AI', status: 'running', version: '3.0.0' });
});

app.get('/status', (req, res) => {
  res.json({
    running: true,
    schedule: POST_SCHEDULE,
    categoriesEnabled: VIDEO_CATEGORIES,
    nextUp: VIDEO_CATEGORIES[categoryIndex % VIDEO_CATEGORIES.length],
    youtubeConnected:   !!YOUTUBE_REFRESH_TOKEN,
    instagramConnected: !!INSTAGRAM_ACCESS_TOKEN,
    groqConnected:      !!GROQ_API_KEY,
    elevenLabsConnected: !!ELEVENLABS_API_KEY,
    stabilityConnected:  !!STABILITY_API_KEY,
    runwayConnected:     !!RUNWAY_API_KEY,
    timestamp: new Date().toISOString()
  });
});

// Manual trigger
app.post('/generate', async (req, res) => {
  const { category } = req.body || {};
  res.json({ message: '🎬 Video generation started!', category: category || 'auto' });
  runPostingCycle(category);
});

// Test script only (free, no API credits used except Groq)
app.post('/test-script', async (req, res) => {
  const { category } = req.body || {};
  try {
    const script = await generateVideoScript(category || 'horror');
    res.json({ success: true, script });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// YouTube OAuth
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
  res.json({ message: 'Save this to Vercel!', refresh_token: tokens.refresh_token });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 VidForge AI v3.0 running on port ${PORT}`);
  console.log(`📊 Status: http://localhost:${PORT}/status\n`);
});

module.exports = app;
