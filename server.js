const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────
// ENV VARIABLES (set in Vercel dashboard)
// ─────────────────────────────────────────────
const YOUTUBE_API_KEY        = process.env.YOUTUBE_API_KEY;
const YOUTUBE_CLIENT_ID      = process.env.YOUTUBE_CLIENT_ID;
const YOUTUBE_CLIENT_SECRET  = process.env.YOUTUBE_CLIENT_SECRET;
const YOUTUBE_REDIRECT_URI   = process.env.YOUTUBE_REDIRECT_URI;
const YOUTUBE_REFRESH_TOKEN  = process.env.YOUTUBE_REFRESH_TOKEN;

const INSTAGRAM_APP_ID       = process.env.INSTAGRAM_APP_ID;
const INSTAGRAM_APP_SECRET   = process.env.INSTAGRAM_APP_SECRET;
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const INSTAGRAM_USER_ID      = process.env.INSTAGRAM_USER_ID;

const RUNWAY_API_KEY         = process.env.RUNWAY_API_KEY;
const GROQ_API_KEY           = process.env.CLAUDE_API_KEY; // stored as CLAUDE_API_KEY in Vercel

const POST_SCHEDULE          = process.env.POST_SCHEDULE || '0 */6 * * *';

// ─────────────────────────────────────────────
// VIDEO CATEGORIES (rotates every cycle)
// ─────────────────────────────────────────────
const VIDEO_CATEGORIES = [
  'horror', 'values', 'life', 'lesson',
  'motivation', 'comedy', 'mystery', 'kids'
];
let categoryIndex = 0;

// ─────────────────────────────────────────────
// GROQ API — AI Script Generation (FREE)
// ─────────────────────────────────────────────
async function generateVideoScript(category) {
  const prompt = `Create a short, engaging ${category} video script for a 30-second YouTube/Instagram Reel.
Format:
TITLE: (catchy title under 60 chars)
DESCRIPTION: (2-3 sentences for caption)
VISUAL_PROMPT: (detailed scene description for AI video generation, cinematic, vivid)
HASHTAGS: (10 relevant hashtags)

Keep it punchy, viral-worthy, and suitable for a faceless AI content channel.`;

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama3-8b-8192',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
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

  // Parse the structured response
  const titleMatch       = text.match(/TITLE:\s*(.+)/);
  const descMatch        = text.match(/DESCRIPTION:\s*([\s\S]+?)(?=VISUAL_PROMPT:|$)/);
  const visualMatch      = text.match(/VISUAL_PROMPT:\s*([\s\S]+?)(?=HASHTAGS:|$)/);
  const hashtagsMatch    = text.match(/HASHTAGS:\s*([\s\S]+?)$/);

  return {
    title:        titleMatch    ? titleMatch[1].trim()    : `${category} video`,
    description:  descMatch     ? descMatch[1].trim()     : `Amazing ${category} content`,
    visualPrompt: visualMatch   ? visualMatch[1].trim()   : `Cinematic ${category} scene, high quality, dramatic lighting`,
    hashtags:     hashtagsMatch ? hashtagsMatch[1].trim() : `#${category} #viral #shorts`
  };
}

// ─────────────────────────────────────────────
// RUNWAY ML — AI Video Generation
// ─────────────────────────────────────────────
async function generateVideo(visualPrompt) {
  // Submit generation job
  const createResponse = await axios.post(
    'https://api.dev.runwayml.com/v1/image_to_video',
    {
      model: 'gen3a_turbo',
      promptText: visualPrompt,
      duration: 10,
      ratio: '768:1344', // vertical 9:16 for Reels
      watermark: false
    },
    {
      headers: {
        'Authorization': `Bearer ${RUNWAY_API_KEY}`,
        'Content-Type': 'application/json',
        'X-Runway-Version': '2024-11-06'
      }
    }
  );

  const taskId = createResponse.data.id;
  console.log(`[Runway] Task created: ${taskId}`);

  // Poll for completion (max 3 minutes)
  for (let attempt = 0; attempt < 36; attempt++) {
    await new Promise(r => setTimeout(r, 5000)); // wait 5s between polls

    const statusResponse = await axios.get(
      `https://api.dev.runwayml.com/v1/tasks/${taskId}`,
      {
        headers: {
          'Authorization': `Bearer ${RUNWAY_API_KEY}`,
          'X-Runway-Version': '2024-11-06'
        }
      }
    );

    const task = statusResponse.data;
    console.log(`[Runway] Status: ${task.status} (attempt ${attempt + 1})`);

    if (task.status === 'SUCCEEDED') {
      return task.output[0]; // video URL
    }
    if (task.status === 'FAILED') {
      throw new Error(`Runway generation failed: ${task.failure || 'Unknown error'}`);
    }
  }

  throw new Error('Runway generation timed out after 3 minutes');
}

// ─────────────────────────────────────────────
// YOUTUBE — Upload Video
// ─────────────────────────────────────────────
async function uploadToYouTube(videoUrl, title, description, hashtags) {
  const oauth2Client = new google.auth.OAuth2(
    YOUTUBE_CLIENT_ID,
    YOUTUBE_CLIENT_SECRET,
    YOUTUBE_REDIRECT_URI
  );
  oauth2Client.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });

  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  // Download video to temp buffer
  const videoResponse = await axios.get(videoUrl, { responseType: 'stream' });

  const uploadResponse = await youtube.videos.insert({
    part: 'snippet,status',
    requestBody: {
      snippet: {
        title: title.substring(0, 100),
        description: `${description}\n\n${hashtags}`,
        tags: hashtags.split('#').filter(Boolean).map(t => t.trim()),
        categoryId: '22', // People & Blogs
        defaultLanguage: 'en'
      },
      status: {
        privacyStatus: 'public',
        selfDeclaredMadeForKids: false
      }
    },
    media: {
      mimeType: 'video/mp4',
      body: videoResponse.data
    }
  });

  return uploadResponse.data.id;
}

// ─────────────────────────────────────────────
// INSTAGRAM — Post Reel
// ─────────────────────────────────────────────
async function postToInstagram(videoUrl, caption) {
  // Step 1: Create media container
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
  console.log(`[Instagram] Container created: ${containerId}`);

  // Step 2: Wait for video processing
  await new Promise(r => setTimeout(r, 30000));

  // Step 3: Publish
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
// MAIN — Full Auto-Post Pipeline
// ─────────────────────────────────────────────
async function runPostingCycle(category = null) {
  const selectedCategory = category || VIDEO_CATEGORIES[categoryIndex % VIDEO_CATEGORIES.length];
  categoryIndex++;

  console.log(`\n🎬 [VidForge] Starting cycle — Category: ${selectedCategory}`);
  const results = { category: selectedCategory, youtube: null, instagram: null, error: null };

  try {
    // 1. Generate script with Groq
    console.log('[VidForge] Generating script with Groq...');
    const script = await generateVideoScript(selectedCategory);
    console.log(`[VidForge] Script ready: "${script.title}"`);

    // 2. Generate video with Runway
    console.log('[VidForge] Generating video with Runway ML...');
    const videoUrl = await generateVideo(script.visualPrompt);
    console.log(`[VidForge] Video ready: ${videoUrl}`);

    // 3. Upload to YouTube
    try {
      console.log('[VidForge] Uploading to YouTube...');
      const ytId = await uploadToYouTube(videoUrl, script.title, script.description, script.hashtags);
      results.youtube = `https://youtube.com/watch?v=${ytId}`;
      console.log(`[VidForge] YouTube uploaded: ${results.youtube}`);
    } catch (ytErr) {
      console.error('[VidForge] YouTube upload failed:', ytErr.message);
      results.youtubeError = ytErr.message;
    }

    // 4. Post to Instagram
    try {
      console.log('[VidForge] Posting to Instagram...');
      const igId = await postToInstagram(
        videoUrl,
        `${script.title}\n\n${script.description}\n\n${script.hashtags}`
      );
      results.instagram = igId;
      console.log(`[VidForge] Instagram posted: ${igId}`);
    } catch (igErr) {
      console.error('[VidForge] Instagram post failed:', igErr.message);
      results.instagramError = igErr.message;
    }

    console.log('[VidForge] ✅ Cycle complete!\n');
  } catch (err) {
    results.error = err.message;
    console.error('[VidForge] ❌ Cycle failed:', err.message);
  }

  return results;
}

// ─────────────────────────────────────────────
// CRON SCHEDULER — Every 6 Hours
// ─────────────────────────────────────────────
cron.schedule(POST_SCHEDULE, () => {
  console.log('[Cron] Scheduled posting cycle triggered');
  runPostingCycle();
});
console.log(`[VidForge] Scheduler running: ${POST_SCHEDULE}`);

// ─────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────

// Status check
app.get('/status', (req, res) => {
  res.json({
    status: 'online',
    running: true,
    schedule: POST_SCHEDULE,
    youtubeConnected: !!YOUTUBE_REFRESH_TOKEN,
    instagramConnected: !!INSTAGRAM_ACCESS_TOKEN,
    runwayConnected: !!RUNWAY_API_KEY,
    groqConnected: !!GROQ_API_KEY,
    nextCategory: VIDEO_CATEGORIES[categoryIndex % VIDEO_CATEGORIES.length],
    timestamp: new Date().toISOString()
  });
});

// Manual trigger — POST /generate with optional {"category": "horror"}
app.post('/generate', async (req, res) => {
  const { category } = req.body || {};
  console.log(`[VidForge] Manual trigger — category: ${category || 'auto'}`);

  // Respond immediately, run in background
  res.json({ message: 'Video generation started', category: category || 'auto (next in rotation)' });

  runPostingCycle(category).then(results => {
    console.log('[VidForge] Manual cycle results:', JSON.stringify(results));
  });
});

// Test script generation only (no video, no credits used)
app.post('/test-script', async (req, res) => {
  const { category } = req.body || {};
  const cat = category || 'horror';
  try {
    const script = await generateVideoScript(cat);
    res.json({ success: true, category: cat, script });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// YouTube OAuth flow
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
  res.json({ message: 'Save this refresh_token to Vercel env!', refresh_token: tokens.refresh_token });
});

// Health check
app.get('/', (req, res) => {
  res.json({ app: 'VidForge AI', status: 'running', version: '2.0.0' });
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 VidForge AI server running on port ${PORT}`);
  console.log(`📊 Status: http://localhost:${PORT}/status\n`);
});

module.exports = app;
