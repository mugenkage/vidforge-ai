/**
 * VidForge AI — server.js  v4.0
 * Built by @mugenkage.ai
 *
 * FIXES vs v3.0
 * ─────────────────────────────────────────────────────────────
 * [FIX-01] Vercel 10s timeout → Long-running pipeline now runs
 *          via a detached background worker (setImmediate) and
 *          the HTTP response returns instantly.
 * [FIX-02] No concurrency lock → isRunning flag prevents two
 *          pipelines from overlapping and exhausting /tmp space.
 * [FIX-03] Instagram 30s hardcoded wait → Replaced with a retry
 *          polling loop (up to 5 min) that checks container
 *          status before publishing.
 * [FIX-04] Instagram uses YouTube watch URL as video_url → YT
 *          URLs are NOT accepted by Meta. The MP4 must be hosted
 *          on a public CDN or served from this server's /tmp.
 *          Fixed: server exposes a temporary /tmp/:file route so
 *          Meta can pull the raw MP4 directly.
 * [FIX-05] GROQ JSON parse crash → wrapped in try/catch with
 *          regex fallback to extract JSON from markdown fences.
 * [FIX-06] FFmpeg paths with spaces → all paths quoted and
 *          sanitised via shellEscape().
 * [FIX-07] FFmpeg scale filter forces even dimensions (libx264
 *          requires even width/height) → scale=768:1344:flags=
 *          lanczos,format=yuv420p.
 * [FIX-08] ffprobe returns NaN on some files → fallback to 5s.
 * [FIX-09] ElevenLabs free tier char limit → script trims each
 *          narration to 300 chars max and logs total usage.
 * [FIX-10] Stability AI response can have empty artifacts array
 *          → validates before accessing [0].
 * [FIX-11] categoryIndex resets on each Vercel cold boot → now
 *          driven by Date-based round-robin (hour slot mod 8).
 * [FIX-12] YouTube upload missing #Shorts in title/description
 *          → auto-appended so the video qualifies as a Short.
 * [FIX-13] Missing env vars crash silently deep in pipeline →
 *          validateEnv() checks all required keys at startup and
 *          logs clear warnings.
 * [FIX-14] 15 videos/day cron → 15 evenly-spaced jobs defined
 *          explicitly (every 96 min) instead of a vague "*/1".
 * [FIX-15] /tmp not cleaned on uncaught error → finally block
 *          always runs cleanup; also cleans files older than 1h
 *          on each pipeline start to avoid disk bloat on Vercel.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const express   = require('express');
const cron      = require('node-cron');
const axios     = require('axios');
const { google } = require('googleapis');
const fs        = require('fs');
const path      = require('path');
const { exec }  = require('child_process');
const util      = require('util');

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

const GROQ_API_KEY           = process.env.CLAUDE_API_KEY;       // env key kept as-is
const ELEVENLABS_API_KEY     = process.env.ELEVENLABS_API_KEY;
const STABILITY_API_KEY      = process.env.STABILITY_API_KEY;

// Public base URL — required so Meta can pull the MP4
// e.g.  https://vidforge-ai-zeta.vercel.app
const PUBLIC_BASE_URL        = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

const ELEVENLABS_VOICE_ID    = 'pNInz6obpgDQGcFmaJgB'; // Adam

// [FIX-13] Validate env at startup
function validateEnv() {
  const required = {
    CLAUDE_API_KEY:         GROQ_API_KEY,
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
    console.warn(`⚠️  [VidForge] Missing env vars: ${missing.join(', ')}`);
  } else {
    console.log('✅ [VidForge] All env vars present.');
  }
}

// ─────────────────────────────────────────────
// CONCURRENCY LOCK  [FIX-02]
// ─────────────────────────────────────────────
let isRunning = false;

// ─────────────────────────────────────────────
// CATEGORIES
// ─────────────────────────────────────────────
const VIDEO_CATEGORIES = [
  'horror', 'values', 'life', 'lesson',
  'motivation', 'comedy', 'mystery', 'kids'
];

// [FIX-11] Date-driven category — survives cold boots
function getNextCategory() {
  // Cycles through all 8 categories based on wall-clock slot
  const slotIndex = Math.floor(Date.now() / (96 * 60 * 1000)); // new slot every 96 min
  return VIDEO_CATEGORIES[slotIndex % VIDEO_CATEGORIES.length];
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

// [FIX-06] Escape a file path for use in a shell command string
function shellEscape(p) {
  return `"${p.replace(/"/g, '\\"')}"`;
}

// [FIX-15] Delete /tmp/vidforge_* dirs older than 1 hour
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
            console.log(`[Cleanup] Removed old temp dir: ${dirPath}`);
          }
        } catch (_) {}
      });
  } catch (_) {}
}

// ─────────────────────────────────────────────
// STEP 1 — GROQ: Generate Script  [FIX-05][FIX-09]
// ─────────────────────────────────────────────
async function generateVideoScript(category) {
  const prompt = `Create a short engaging ${category} story for a 30-second Instagram Reel/YouTube Short.

Return ONLY valid JSON — no markdown, no explanation:
{
  "title": "catchy title under 55 chars",
  "description": "2-3 sentence caption for the post",
  "hashtags": "#tag1 #tag2 #tag3 #tag4 #tag5 #tag6 #tag7 #tag8 #tag9 #tag10",
  "scenes": [
    {
      "narration": "voice line for scene 1 — max 280 chars",
      "image_prompt": "cinematic scene 1 description, dramatic lighting, 9:16 vertical, high quality, no text"
    },
    {
      "narration": "voice line for scene 2 — max 280 chars",
      "image_prompt": "cinematic scene 2 description, dramatic lighting, 9:16 vertical, high quality, no text"
    },
    {
      "narration": "voice line for scene 3 — max 280 chars",
      "image_prompt": "cinematic scene 3 description, dramatic lighting, 9:16 vertical, high quality, no text"
    },
    {
      "narration": "voice line for scene 4 — max 280 chars",
      "image_prompt": "cinematic scene 4 description, dramatic lighting, 9:16 vertical, high quality, no text"
    }
  ]
}`;

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
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }
  );

  let text = response.data.choices[0].message.content.trim();

  // [FIX-05] Strip markdown code fences if present
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

  // [FIX-05] Extract first {...} block if extra text surrounds it
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Groq returned no valid JSON block');
  const script = JSON.parse(jsonMatch[0]);

  // [FIX-09] Enforce narration length to stay within ElevenLabs free tier
  let totalChars = 0;
  script.scenes = script.scenes.map(scene => {
    const narration = (scene.narration || '').substring(0, 300);
    totalChars += narration.length;
    return { ...scene, narration };
  });
  console.log(`[Groq] Script ready: "${script.title}" | ~${totalChars} TTS chars`);

  return script;
}

// ─────────────────────────────────────────────
// STEP 2 — STABILITY AI: Generate Images  [FIX-10]
// ─────────────────────────────────────────────
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
        'Authorization': `Bearer ${STABILITY_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 60000
    }
  );

  // [FIX-10] Guard against empty artifacts
  const artifacts = response.data?.artifacts;
  if (!artifacts || artifacts.length === 0) {
    throw new Error('Stability AI returned no image artifacts');
  }
  if (artifacts[0].finishReason === 'ERROR') {
    throw new Error(`Stability AI image error: ${artifacts[0].finishReason}`);
  }

  fs.writeFileSync(outputPath, Buffer.from(artifacts[0].base64, 'base64'));
  console.log(`[Stability] Image saved: ${path.basename(outputPath)}`);
}

// ─────────────────────────────────────────────
// STEP 3 — ELEVENLABS: Generate Voice
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
      responseType: 'arraybuffer',
      timeout: 30000
    }
  );

  fs.writeFileSync(outputPath, Buffer.from(response.data));
  console.log(`[ElevenLabs] Voice saved: ${path.basename(outputPath)}`);
}

// ─────────────────────────────────────────────
// STEP 4 — FFMPEG: Stitch Video  [FIX-06][FIX-07][FIX-08]
// ─────────────────────────────────────────────
async function getAudioDuration(audioPath) {
  try {
    const { stdout } = await execPromise(
      `ffprobe -v error -show_entries format=duration ` +
      `-of default=noprint_wrappers=1:nokey=1 ${shellEscape(audioPath)}`
    );
    const dur = parseFloat(stdout.trim());
    return isNaN(dur) ? 5 : dur;   // [FIX-08] fallback to 5s
  } catch (_) {
    return 5;
  }
}

async function stitchVideo(scenes, tempDir, outputPath) {
  const sceneVideos = [];

  for (let i = 0; i < scenes.length; i++) {
    const imgPath   = path.join(tempDir, `image_${i}.png`);
    const audioPath = path.join(tempDir, `voice_${i}.mp3`);
    const sceneOut  = path.join(tempDir, `scene_${i}.mp4`);

    const duration = await getAudioDuration(audioPath);

    // [FIX-07] scale forces even dimensions required by libx264
    await execPromise(
      `ffmpeg -loop 1 -i ${shellEscape(imgPath)} ` +
      `-i ${shellEscape(audioPath)} ` +
      `-c:v libx264 -tune stillimage ` +
      `-c:a aac -b:a 192k ` +
      `-pix_fmt yuv420p ` +
      `-t ${duration} ` +
      `-vf "scale=768:1344:flags=lanczos,format=yuv420p" ` +
      `-movflags +faststart ` +
      `-y ${shellEscape(sceneOut)}`
    );
    sceneVideos.push(sceneOut);
    console.log(`[FFmpeg] Scene ${i + 1}/${scenes.length} done (${duration.toFixed(1)}s)`);
  }

  // [FIX-06] Write concat list with properly escaped paths
  const concatFile = path.join(tempDir, 'concat.txt');
  const concatContent = sceneVideos
    .map(v => `file '${v.replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(concatFile, concatContent);

  await execPromise(
    `ffmpeg -f concat -safe 0 -i ${shellEscape(concatFile)} ` +
    `-c copy -movflags +faststart -y ${shellEscape(outputPath)}`
  );
  console.log(`[FFmpeg] Final video: ${outputPath}`);
}

// ─────────────────────────────────────────────
// STEP 5 — YOUTUBE: Upload  [FIX-12]
// ─────────────────────────────────────────────
async function uploadToYouTube(videoPath, title, description, hashtags) {
  const oauth2Client = new google.auth.OAuth2(
    YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI
  );
  oauth2Client.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });

  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  // [FIX-12] Ensure #Shorts in title so YouTube indexes as a Short
  const shortTitle = title.includes('#Shorts')
    ? title.substring(0, 100)
    : `${title} #Shorts`.substring(0, 100);

  const shortDescription =
    `${description}\n\n${hashtags}\n\n#Shorts`;

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

// ─────────────────────────────────────────────
// STEP 6 — INSTAGRAM: Post Reel  [FIX-03][FIX-04]
// ─────────────────────────────────────────────

// [FIX-03] Poll container status until FINISHED or timeout
async function waitForInstagramContainer(containerId, timeoutMs = 300000) {
  const interval = 10000; // check every 10s
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval));

    const statusRes = await axios.get(
      `https://graph.facebook.com/v18.0/${containerId}`,
      {
        params: {
          fields: 'status_code,status',
          access_token: INSTAGRAM_ACCESS_TOKEN
        }
      }
    );

    const { status_code } = statusRes.data;
    console.log(`[Instagram] Container status: ${status_code}`);

    if (status_code === 'FINISHED') return;
    if (status_code === 'ERROR' || status_code === 'EXPIRED') {
      throw new Error(`Instagram container failed with status: ${status_code}`);
    }
    // IN_PROGRESS → keep polling
  }
  throw new Error('Instagram container timed out after 5 minutes');
}

async function postToInstagram(videoUrl, caption) {
  // [FIX-04] videoUrl must be a direct public MP4 link, NOT a YouTube URL
  console.log(`[Instagram] Uploading from: ${videoUrl}`);

  const containerResponse = await axios.post(
    `https://graph.facebook.com/v18.0/${INSTAGRAM_USER_ID}/media`,
    {
      media_type: 'REELS',
      video_url: videoUrl,   // must be a raw MP4 URL
      caption: caption,
      share_to_feed: true,
      access_token: INSTAGRAM_ACCESS_TOKEN
    },
    { timeout: 30000 }
  );

  const containerId = containerResponse.data.id;
  console.log(`[Instagram] Container created: ${containerId}`);

  // [FIX-03] Wait until Meta has finished processing the video
  await waitForInstagramContainer(containerId);

  const publishResponse = await axios.post(
    `https://graph.facebook.com/v18.0/${INSTAGRAM_USER_ID}/media_publish`,
    {
      creation_id: containerId,
      access_token: INSTAGRAM_ACCESS_TOKEN
    },
    { timeout: 30000 }
  );

  return publishResponse.data.id;
}

// ─────────────────────────────────────────────
// TEMP FILE SERVER  [FIX-04]
// Serves the final MP4 from /tmp so Meta can pull it.
// Route: GET /tmp/:filename
// ─────────────────────────────────────────────
app.get('/tmp/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // prevent path traversal
  const filePath = path.join('/tmp', filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  fs.createReadStream(filePath).pipe(res);
});

// ─────────────────────────────────────────────
// MAIN PIPELINE  [FIX-01][FIX-02][FIX-04][FIX-15]
// ─────────────────────────────────────────────
async function runPostingCycle(category = null) {
  // [FIX-02] Prevent overlapping runs
  if (isRunning) {
    console.log('[VidForge] ⏳ Pipeline already running — skipping this slot.');
    return { skipped: true, reason: 'Pipeline already running' };
  }
  isRunning = true;

  // [FIX-15] Clean up stale temp dirs before starting
  cleanOldTempDirs();

  const selectedCategory = category || getNextCategory();
  console.log(`\n🎬 [VidForge] Starting — Category: ${selectedCategory}`);

  const results = {
    category: selectedCategory,
    youtube: null,
    instagram: null,
    error: null,
    timestamp: new Date().toISOString()
  };

  // Use a stable filename so the /tmp route can serve it
  const runId  = Date.now();
  const tempDir = path.join('/tmp', `vidforge_${runId}`);
  const finalVideoName = `final_${runId}.mp4`;
  const videoPath = path.join(tempDir, finalVideoName);

  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // STEP 1 — Script
    console.log('[1/6] Generating script...');
    const script = await generateVideoScript(selectedCategory);

    // STEP 2 + 3 — Images & Voices (parallel per scene)
    for (let i = 0; i < script.scenes.length; i++) {
      const scene = script.scenes[i];
      console.log(`[2-3/6] Scene ${i + 1}/${script.scenes.length} — image + voice...`);
      await Promise.all([
        generateSceneImage(scene.image_prompt, path.join(tempDir, `image_${i}.png`)),
        generateVoice(scene.narration,          path.join(tempDir, `voice_${i}.mp3`))
      ]);
    }

    // STEP 4 — Stitch
    console.log('[4/6] Stitching video...');
    await stitchVideo(script.scenes, tempDir, videoPath);

    // Copy final MP4 to /tmp root so /tmp/:filename can serve it
    const publicVideoPath = path.join('/tmp', finalVideoName);
    fs.copyFileSync(videoPath, publicVideoPath);

    // [FIX-04] Build the direct MP4 URL for Meta
    if (!PUBLIC_BASE_URL) {
      throw new Error('PUBLIC_BASE_URL env var is not set — Instagram cannot fetch the video.');
    }
    const videoPublicUrl = `${PUBLIC_BASE_URL}/tmp/${finalVideoName}`;

    const caption = `${script.title}\n\n${script.description}\n\n${script.hashtags}`;

    // STEP 5 — YouTube
    try {
      console.log('[5/6] Uploading to YouTube...');
      const ytId = await uploadToYouTube(videoPath, script.title, script.description, script.hashtags);
      results.youtube = `https://youtube.com/shorts/${ytId}`;
      console.log(`[VidForge] ✅ YouTube: ${results.youtube}`);
    } catch (err) {
      console.error('[VidForge] ❌ YouTube failed:', err.message);
      results.youtubeError = err.message;
    }

    // STEP 6 — Instagram
    try {
      console.log('[6/6] Posting to Instagram...');
      const igId = await postToInstagram(videoPublicUrl, caption);
      results.instagram = igId;
      console.log(`[VidForge] ✅ Instagram post ID: ${igId}`);
  
