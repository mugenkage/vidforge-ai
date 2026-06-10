/**
 * VidForge AI - server.js  v4.1
 * Built by @mugenkage.ai
 *
 * FIXES vs v4.0
 * -------------------------------------------------------------
 * [FIX-16] SyntaxError at line 40 - curly/smart quotes removed
 *          throughout entire file. All strings use straight quotes.
 * [FIX-17] Groq JSON parse crash - sanitize curly quotes, trailing
 *          commas, and control characters before JSON.parse().
 * [FIX-18] Truncated file - restored missing bottom half:
 *          pipeline finally/cleanup block, all Express routes,
 *          cron scheduler, and app.listen().
 * [FIX-19] GROQ_API_KEY was reading process.env.CLAUDE_API_KEY -
 *          now correctly reads process.env.GROQ_API_KEY.
 *          Update your Render/Vercel env var name accordingly.
 * -------------------------------------------------------------
 */

'use strict';

const express    = require('express');
const cron       = require('node-cron');
const axios      = require('axios');
const { google } = require('googleapis');
const fs         = require('fs');
const path       = require('path');
const { exec }   = require('child_process');
const util       = require('util');

const execPromise = util.promisify(exec);
const app = express();
app.use(express.json());

// ---------------------------------------------
// ENV VARIABLES
// ---------------------------------------------
const YOUTUBE_CLIENT_ID      = process.env.YOUTUBE_CLIENT_ID;
const YOUTUBE_CLIENT_SECRET  = process.env.YOUTUBE_CLIENT_SECRET;
const YOUTUBE_REDIRECT_URI   = process.env.YOUTUBE_REDIRECT_URI;
const YOUTUBE_REFRESH_TOKEN  = process.env.YOUTUBE_REFRESH_TOKEN;

const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const INSTAGRAM_USER_ID      = process.env.INSTAGRAM_USER_ID;

// [FIX-19] Correct env var name
const GROQ_API_KEY           = process.env.GROQ_API_KEY;
const ELEVENLABS_API_KEY     = process.env.ELEVENLABS_API_KEY;
const STABILITY_API_KEY      = process.env.STABILITY_API_KEY;

// Public base URL - required so Meta can pull the MP4
// e.g. https://vidforge-ai-zeta.vercel.app
const PUBLIC_BASE_URL        = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

const ELEVENLABS_VOICE_ID    = 'pNInz6obpgDQGcFmaJgB'; // Adam

// [FIX-13] Validate env at startup
function validateEnv() {
  const required = {
    GROQ_API_KEY:           GROQ_API_KEY,
    ELEVENLABS_API_KEY:     ELEVENLABS_API_KEY,
    STABILITY_API_KEY:      STABILITY_API_KEY,
    YOUTUBE_CLIENT_ID:      YOUTUBE_CLIENT_ID,
    YOUTUBE_CLIENT_SECRET:  YOUTUBE_CLIENT_SECRET,
    YOUTUBE_REDIRECT_URI:   YOUTUBE_REDIRECT_URI,
    YOUTUBE_REFRESH_TOKEN:  YOUTUBE_REFRESH_TOKEN,
    INSTAGRAM_ACCESS_TOKEN: INSTAGRAM_ACCESS_TOKEN,
    INSTAGRAM_USER_ID:      INSTAGRAM_USER_ID,
    PUBLIC_BASE_URL:        PUBLIC_BASE_URL
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.warn('WARNING [VidForge] Missing env vars: ' + missing.join(', '));
  } else {
    console.log('OK [VidForge] All env vars present.');
  }
}

// ---------------------------------------------
// CONCURRENCY LOCK
// ---------------------------------------------
let isRunning = false;

// ---------------------------------------------
// CATEGORIES
// ---------------------------------------------
const VIDEO_CATEGORIES = [
  'horror', 'values', 'life', 'lesson',
  'motivation', 'comedy', 'mystery', 'kids'
];

// Date-driven category - survives cold boots
function getNextCategory() {
  const slotIndex = Math.floor(Date.now() / (96 * 60 * 1000));
  return VIDEO_CATEGORIES[slotIndex % VIDEO_CATEGORIES.length];
}

// ---------------------------------------------
// HELPERS
// ---------------------------------------------
function shellEscape(p) {
  return '"' + p.replace(/"/g, '\\"') + '"';
}

function cleanOldTempDirs() {
  try {
    const tmpBase = '/tmp';
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    fs.readdirSync(tmpBase)
      .filter(f => f.startsWith('vidforge_'))
      .map(f => path.join(tmpBase, f))
      .forEach(dirPath => {
        try {
          const stat = fs.statSync(dirPath);
          if (stat.mtimeMs < oneHourAgo) {
            fs.rmSync(dirPath, { recursive: true, force: true });
            console.log('[Cleanup] Removed old temp dir: ' + dirPath);
          }
        } catch (_) {}
      });
  } catch (_) {}
}

// ---------------------------------------------
// STEP 1 - GROQ: Generate Script
// [FIX-17] Robust JSON sanitization before parse
// ---------------------------------------------
async function generateVideoScript(category) {
  const prompt = 'Create a short engaging ' + category + ' story for a 30-second Instagram Reel/YouTube Short.\n\n' +
    'Return ONLY valid JSON - no markdown, no explanation:\n' +
    '{\n' +
    '  "title": "catchy title under 55 chars",\n' +
    '  "description": "2-3 sentence caption for the post",\n' +
    '  "hashtags": "#tag1 #tag2 #tag3 #tag4 #tag5 #tag6 #tag7 #tag8 #tag9 #tag10",\n' +
    '  "scenes": [\n' +
    '    { "narration": "voice line for scene 1 - max 280 chars", "image_prompt": "cinematic scene 1, dramatic lighting, 9:16 vertical, high quality, no text" },\n' +
    '    { "narration": "voice line for scene 2 - max 280 chars", "image_prompt": "cinematic scene 2, dramatic lighting, 9:16 vertical, high quality, no text" },\n' +
    '    { "narration": "voice line for scene 3 - max 280 chars", "image_prompt": "cinematic scene 3, dramatic lighting, 9:16 vertical, high quality, no text" },\n' +
    '    { "narration": "voice line for scene 4 - max 280 chars", "image_prompt": "cinematic scene 4, dramatic lighting, 9:16 vertical, high quality, no text" }\n' +
    '  ]\n' +
    '}';

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1200,
      temperature: 0.8
    },
    {
      headers: {
        'Authorization': 'Bearer ' + GROQ_API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }
  );

  let text = response.data.choices[0].message.content.trim();

  // Strip markdown fences
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  // Extract first {...} block
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Groq returned no valid JSON block');

  // [FIX-17] Sanitize before parsing
  const cleaned = jsonMatch[0]
    .replace(/[\u201C\u201D]/g, '"')   // curly double quotes
    .replace(/[\u2018\u2019]/g, "'")   // curly single quotes
    .replace(/[\u2013\u2014]/g, '-')   // em/en dashes
    .replace(/,(\s*[}\]])/g, '$1')     // trailing commas
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''); // control chars

  let script;
  try {
    script = JSON.parse(cleaned);
  } catch (e) {
    throw new Error('Groq JSON parse failed: ' + e.message);
  }

  // Enforce narration length for ElevenLabs free tier
  let totalChars = 0;
  script.scenes = script.scenes.map(scene => {
    const narration = (scene.narration || '').substring(0, 300);
    totalChars += narration.length;
    return { ...scene, narration };
  });
  console.log('[Groq] Script ready: "' + script.title + '" | ~' + totalChars + ' TTS chars');

  return script;
}

// ---------------------------------------------
// STEP 2 - STABILITY AI: Generate Images
// ---------------------------------------------
async function generateSceneImage(prompt, outputPath) {
  const response = await axios.post(
    'https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image',
    {
      text_prompts: [
        { text: prompt + ', vertical 9:16 portrait format', weight: 1 },
        { text: 'blurry, low quality, text, watermark, ugly, horizontal, landscape', weight: -1 }
      ],
      cfg_scale: 7,
      height: 1344,
      width: 768,
      samples: 1,
      steps: 30
    },
    {
      headers: {
        'Authorization': 'Bearer ' + STABILITY_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 60000
    }
  );

  const artifacts = response.data && response.data.artifacts;
  if (!artifacts || artifacts.length === 0) {
    throw new Error('Stability AI returned no image artifacts');
  }
  if (artifacts[0].finishReason === 'ERROR') {
    throw new Error('Stability AI image error: ' + artifacts[0].finishReason);
  }

  fs.writeFileSync(outputPath, Buffer.from(artifacts[0].base64, 'base64'));
  console.log('[Stability] Image saved: ' + path.basename(outputPath));
}

// ---------------------------------------------
// STEP 3 - ELEVENLABS: Generate Voice
// ---------------------------------------------
async function generateVoice(text, outputPath) {
  const response = await axios.post(
    'https://api.elevenlabs.io/v1/text-to-speech/' + ELEVENLABS_VOICE_ID,
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
      responseType: 'arraybuffer',
      timeout: 30000
    }
  );

  fs.writeFileSync(outputPath, Buffer.from(response.data));
  console.log('[ElevenLabs] Voice saved: ' + path.basename(outputPath));
}

// ---------------------------------------------
// STEP 4 - FFMPEG: Stitch Video
// ---------------------------------------------
async function getAudioDuration(audioPath) {
  try {
    const { stdout } = await execPromise(
      'ffprobe -v error -show_entries format=duration ' +
      '-of default=noprint_wrappers=1:nokey=1 ' + shellEscape(audioPath)
    );
    const dur = parseFloat(stdout.trim());
    return isNaN(dur) ? 5 : dur;
  } catch (_) {
    return 5;
  }
}

async function stitchVideo(scenes, tempDir, outputPath) {
  const sceneVideos = [];

  for (let i = 0; i < scenes.length; i++) {
    const imgPath   = path.join(tempDir, 'image_' + i + '.png');
    const audioPath = path.join(tempDir, 'voice_' + i + '.mp3');
    const sceneOut  = path.join(tempDir, 'scene_' + i + '.mp4');

    const duration = await getAudioDuration(audioPath);

    await execPromise(
      'ffmpeg -loop 1 -i ' + shellEscape(imgPath) + ' ' +
      '-i ' + shellEscape(audioPath) + ' ' +
      '-c:v libx264 -tune stillimage ' +
      '-c:a aac -b:a 192k ' +
      '-pix_fmt yuv420p ' +
      '-t ' + duration + ' ' +
      '-vf "scale=768:1344:flags=lanczos,format=yuv420p" ' +
      '-movflags +faststart ' +
      '-y ' + shellEscape(sceneOut)
    );
    sceneVideos.push(sceneOut);
    console.log('[FFmpeg] Scene ' + (i + 1) + '/' + scenes.length + ' done (' + duration.toFixed(1) + 's)');
  }

  const concatFile = path.join(tempDir, 'concat.txt');
  const concatContent = sceneVideos
    .map(v => "file '" + v.replace(/'/g, "'\\''") + "'")
    .join('\n');
  fs.writeFileSync(concatFile, concatContent);

  await execPromise(
    'ffmpeg -f concat -safe 0 -i ' + shellEscape(concatFile) + ' ' +
    '-c copy -movflags +faststart -y ' + shellEscape(outputPath)
  );
  console.log('[FFmpeg] Final video: ' + outputPath);
}

// ---------------------------------------------
// STEP 5 - YOUTUBE: Upload
// ---------------------------------------------
async function uploadToYouTube(videoPath, title, description, hashtags) {
  const oauth2Client = new google.auth.OAuth2(
    YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI
  );
  oauth2Client.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });

  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  const shortTitle = title.includes('#Shorts')
    ? title.substring(0, 100)
    : (title + ' #Shorts').substring(0, 100);

  const shortDescription = description + '\n\n' + hashtags + '\n\n#Shorts';

  const uploadResponse = await youtube.videos.insert({
    part: 'snippet,status',
    requestBody: {
      snippet: {
        title: shortTitle,
        description: shortDescription,
        tags: [
          ...hashtags.split('#').filter(Boolean).map(t => t.trim()),
          'Shorts', 'YouTubeShorts'
        ],
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

// ---------------------------------------------
// STEP 6 - INSTAGRAM: Post Reel
// ---------------------------------------------
async function waitForInstagramContainer(containerId, timeoutMs) {
  timeoutMs = timeoutMs || 300000;
  const interval = 10000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval));

    const statusRes = await axios.get(
      'https://graph.facebook.com/v18.0/' + containerId,
      {
        params: {
          fields: 'status_code,status',
          access_token: INSTAGRAM_ACCESS_TOKEN
        }
      }
    );

    const status_code = statusRes.data.status_code;
    console.log('[Instagram] Container status: ' + status_code);

    if (status_code === 'FINISHED') return;
    if (status_code === 'ERROR' || status_code === 'EXPIRED') {
      throw new Error('Instagram container failed with status: ' + status_code);
    }
  }
  throw new Error('Instagram container timed out after 5 minutes');
}

async function postToInstagram(videoUrl, caption) {
  console.log('[Instagram] Uploading from: ' + videoUrl);

  const containerResponse = await axios.post(
    'https://graph.facebook.com/v18.0/' + INSTAGRAM_USER_ID + '/media',
    {
      media_type: 'REELS',
      video_url: videoUrl,
      caption: caption,
      share_to_feed: true,
      access_token: INSTAGRAM_ACCESS_TOKEN
    },
    { timeout: 30000 }
  );

  const containerId = containerResponse.data.id;
  console.log('[Instagram] Container created: ' + containerId);

  await waitForInstagramContainer(containerId);

  const publishResponse = await axios.post(
    'https://graph.facebook.com/v18.0/' + INSTAGRAM_USER_ID + '/media_publish',
    {
      creation_id: containerId,
      access_token: INSTAGRAM_ACCESS_TOKEN
    },
    { timeout: 30000 }
  );

  return publishResponse.data.id;
}

// ---------------------------------------------
// TEMP FILE SERVER
// Serves the final MP4 from /tmp so Meta can pull it.
// Route: GET /tmp/:filename
// ---------------------------------------------
app.get('/tmp/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join('/tmp', filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'inline; filename="' + filename + '"');
  fs.createReadStream(filePath).pipe(res);
});

// ---------------------------------------------
// MAIN PIPELINE
// ---------------------------------------------
async function runPostingCycle(category) {
  category = category || null;

  if (isRunning) {
    console.log('[VidForge] Pipeline already running - skipping this slot.');
    return { skipped: true, reason: 'Pipeline already running' };
  }
  isRunning = true;

  cleanOldTempDirs();

  const selectedCategory = category || getNextCategory();
  console.log('\n[VidForge] Starting - Category: ' + selectedCategory);

  const results = {
    category: selectedCategory,
    youtube: null,
    instagram: null,
    error: null,
    timestamp: new Date().toISOString()
  };

  const runId          = Date.now();
  const tempDir        = path.join('/tmp', 'vidforge_' + runId);
  const finalVideoName = 'final_' + runId + '.mp4';
  const videoPath      = path.join(tempDir, finalVideoName);

  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // STEP 1 - Script
    console.log('[1/6] Generating script...');
    const script = await generateVideoScript(selectedCategory);

    // STEP 2+3 - Images & Voices (parallel per scene)
    for (let i = 0; i < script.scenes.length; i++) {
      const scene = script.scenes[i];
      console.log('[2-3/6] Scene ' + (i + 1) + '/' + script.scenes.length + ' - image + voice...');
      await Promise.all([
        generateSceneImage(scene.image_prompt, path.join(tempDir, 'image_' + i + '.png')),
        generateVoice(scene.narration,          path.join(tempDir, 'voice_' + i + '.mp3'))
      ]);
    }

    // STEP 4 - Stitch
    console.log('[4/6] Stitching video...');
    await stitchVideo(script.scenes, tempDir, videoPath);

    // Copy to /tmp root so /tmp/:filename route can serve it
    const publicVideoPath = path.join('/tmp', finalVideoName);
    fs.copyFileSync(videoPath, publicVideoPath);

    if (!PUBLIC_BASE_URL) {
      throw new Error('PUBLIC_BASE_URL env var is not set - Instagram cannot fetch the video.');
    }
    const videoPublicUrl = PUBLIC_BASE_URL + '/tmp/' + finalVideoName;
    const caption = script.title + '\n\n' + script.description + '\n\n' + script.hashtags;

    // STEP 5 - YouTube
    try {
      console.log('[5/6] Uploading to YouTube...');
      const ytId = await uploadToYouTube(videoPath, script.title, script.description, script.hashtags);
      results.youtube = 'https://youtube.com/shorts/' + ytId;
      console.log('[VidForge] YouTube: ' + results.youtube);
    } catch (err) {
      console.error('[VidForge] YouTube failed: ' + err.message);
      results.youtubeError = err.message;
    }

    // STEP 6 - Instagram
    try {
      console.log('[6/6] Posting to Instagram...');
      const igId = await postToInstagram(videoPublicUrl, caption);
      results.instagram = igId;
      console.log('[VidForge] Instagram post ID: ' + igId);
    } catch (err) {
      console.error('[VidForge] Instagram failed: ' + err.message);
      results.instagramError = err.message;
    }

  } catch (err) {
    console.error('[VidForge] Pipeline error: ' + err.message);
    results.error = err.message;
  } finally {
    isRunning = false;
    // Clean up this run's temp dir
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      console.log('[Cleanup] Removed temp dir: ' + tempDir);
    } catch (_) {}
  }

  return results;
}

// ---------------------------------------------
// EXPRESS ROUTES
// ---------------------------------------------

// Health check
app.get('/', (req, res) => {
  res.json({ app: 'VidForge AI', status: 'running', version: '4.1' });
});

// System status
app.get('/status', (req, res) => {
  res.json({
    status: 'online',
    isRunning,
    groq:       !!GROQ_API_KEY,
    stability:  !!STABILITY_API_KEY,
    elevenlabs: !!ELEVENLABS_API_KEY,
    youtube:    !!(YOUTUBE_CLIENT_ID && YOUTUBE_REFRESH_TOKEN),
    instagram:  !!(INSTAGRAM_ACCESS_TOKEN && INSTAGRAM_USER_ID),
    publicUrl:  PUBLIC_BASE_URL || 'NOT SET',
    nextCategory: getNextCategory(),
    timestamp: new Date().toISOString()
  });
});

// Manual trigger - returns immediately, pipeline runs in background
app.post('/generate', (req, res) => {
  const category = (req.body && req.body.category) || null;
  res.json({ message: 'Pipeline started', category: category || getNextCategory() });
  setImmediate(() => runPostingCycle(category));
});

// Test script generation only (no credits used for images/voice/video)
app.post('/test-script', async (req, res) => {
  try {
    const category = (req.body && req.body.category) || getNextCategory();
    const script = await generateVideoScript(category);
    res.json({ success: true, category, script });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// YouTube OAuth flow
app.get('/auth/youtube', (req, res) => {
  const oauth2Client = new google.auth.OAuth2(
    YOUTU
