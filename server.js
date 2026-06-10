// VidForge AI — Complete Backend Server
// Node.js + Express backend for auto video generation and posting

const express = require('express');
const cron = require('node-cron');
const { google } = require('googleapis');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(require('cors')());

// ============================================
// CONFIGURATION — Fill in your API keys in .env
// ============================================
const CONFIG = {
  youtube: {
    apiKey: process.env.YOUTUBE_API_KEY,
    clientId: process.env.YOUTUBE_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
    redirectUri: process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:3000/auth/callback',
    refreshToken: process.env.YOUTUBE_REFRESH_TOKEN,
  },
  instagram: {
    appId: process.env.INSTAGRAM_APP_ID,
    appSecret: process.env.INSTAGRAM_APP_SECRET,
    accessToken: process.env.INSTAGRAM_ACCESS_TOKEN,
    igUserId: process.env.INSTAGRAM_USER_ID,
  },
  runway: {
    apiKey: process.env.RUNWAY_API_KEY,
  },
  claude: {
    apiKey: process.env.CLAUDE_API_KEY,
  },
  schedule: process.env.POST_SCHEDULE || '0 */6 * * *', // Every 6 hours by default
};

// ============================================
// YOUTUBE AUTH SETUP
// ============================================
const oauth2Client = new google.auth.OAuth2(
  CONFIG.youtube.clientId,
  CONFIG.youtube.clientSecret,
  CONFIG.youtube.redirectUri
);

if (CONFIG.youtube.refreshToken) {
  oauth2Client.setCredentials({ refresh_token: CONFIG.youtube.refreshToken });
}

// YouTube OAuth login URL
app.get('/auth/youtube', (req, res) => {
  const scopes = [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube',
  ];
  const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: scopes });
  res.redirect(url);
});

// YouTube OAuth callback
app.get('/auth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    // Save refresh token to .env or database
    console.log('YouTube Refresh Token:', tokens.refresh_token);
    res.send('✅ YouTube connected! Copy the refresh token from server logs and add to .env as YOUTUBE_REFRESH_TOKEN');
  } catch (err) {
    res.status(500).send('Auth error: ' + err.message);
  }
});

// ============================================
// AI SCRIPT GENERATION (using Claude API)
// ============================================
async function generateVideoScript(category) {
  const prompts = {
    horror: 'Write a short scary cartoon story script (60 seconds) with a ghost or monster. Make it suspenseful.',
    values: 'Write a short heartwarming cartoon story (60 seconds) about kindness, friendship or helping others.',
    life: 'Write a short animated story (60 seconds) with a powerful life lesson about growth or resilience.',
    lesson: 'Write a short moral cartoon story (60 seconds) with a clear good lesson for viewers.',
    motivation: 'Write a short motivational cartoon script (60 seconds) that inspires viewers to never give up.',
    comedy: 'Write a funny cartoon script (60 seconds) with a humorous twist ending.',
    mystery: 'Write a mysterious cartoon story (60 seconds) with suspense and an unexpected reveal.',
    kids: 'Write a fun, colorful cartoon story (60 seconds) suitable for children with a happy ending.',
  };

  const prompt = prompts[category] || prompts.life;

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [
          {
            role: 'user',
            content: `${prompt} Format the response as JSON with fields: title, description, script, tags (array of 10 YouTube tags), audioMood (one of: epic, horror, lofi, upbeat, dramatic).`,
          },
        ],
      },
      {
        headers: {
          'x-api-key': CONFIG.claude.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
      }
    );

    const text = response.data.content[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error('Script generation error:', err.message);
    return {
      title: `Amazing ${category} Story`,
      description: `An incredible AI-generated ${category} cartoon story!`,
      script: `A wonderful ${category} adventure begins...`,
      tags: [category, 'cartoon', 'AI', 'animation', 'story', 'shorts', 'viral', 'trending', 'fun', 'kids'],
      audioMood: 'epic',
    };
  }
}

// ============================================
// AI VIDEO GENERATION (Runway ML)
// ============================================
async function generateVideo(script, category) {
  console.log(`🎬 Generating video for category: ${category}`);
  console.log(`📝 Script: ${script.title}`);

  try {
    // Step 1: Generate image/video with Runway ML
    const response = await axios.post(
      'https://api.dev.runwayml.com/v1/image_to_video',
      {
        model: 'gen3a_turbo',
        promptText: `Cartoon animation style. ${script.script}. Vibrant colors, professional animation.`,
        duration: 10,
        ratio: '9:16', // Vertical for Reels/Shorts
      },
      {
        headers: {
          Authorization: `Bearer ${CONFIG.runway.apiKey}`,
          'Content-Type': 'application/json',
          'X-Runway-Version': '2024-11-06',
        },
      }
    );

    const taskId = response.data.id;
    console.log(`⏳ Video generation task started: ${taskId}`);

    // Step 2: Poll for completion
    let videoUrl = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 10000)); // Wait 10 seconds
      const statusRes = await axios.get(
        `https://api.dev.runwayml.com/v1/tasks/${taskId}`,
        { headers: { Authorization: `Bearer ${CONFIG.runway.apiKey}`, 'X-Runway-Version': '2024-11-06' } }
      );

      if (statusRes.data.status === 'SUCCEEDED') {
        videoUrl = statusRes.data.output[0];
        console.log(`✅ Video generated: ${videoUrl}`);
        break;
      } else if (statusRes.data.status === 'FAILED') {
        throw new Error('Video generation failed');
      }
      console.log(`⏳ Still generating... (${i + 1}/30)`);
    }

    if (!videoUrl) throw new Error('Video generation timed out');

    // Step 3: Download video
    const videoPath = path.join('/tmp', `video_${Date.now()}.mp4`);
    const videoResponse = await axios.get(videoUrl, { responseType: 'arraybuffer' });
    fs.writeFileSync(videoPath, Buffer.from(videoResponse.data));
    console.log(`💾 Video saved to: ${videoPath}`);

    return videoPath;
  } catch (err) {
    console.error('Video generation error:', err.message);
    throw err;
  }
}

// ============================================
// YOUTUBE UPLOAD
// ============================================
async function uploadToYouTube(videoPath, script, category) {
  console.log(`📤 Uploading to YouTube: ${script.title}`);

  try {
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

    const response = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: script.title,
          description: `${script.description}\n\n#${category} #cartoon #AIvideo #animation #shorts`,
          tags: script.tags,
          categoryId: '22', // People & Blogs
          defaultLanguage: 'en',
        },
        status: {
          privacyStatus: 'public',
          selfDeclaredMadeForKids: false,
        },
      },
      media: {
        body: fs.createReadStream(videoPath),
      },
    });

    const videoId = response.data.id;
    console.log(`✅ YouTube upload successful! Video ID: ${videoId}`);
    console.log(`🔗 URL: https://youtube.com/watch?v=${videoId}`);
    return videoId;
  } catch (err) {
    console.error('YouTube upload error:', err.message);
    throw err;
  }
}

// ============================================
// INSTAGRAM UPLOAD (Reels)
// ============================================
async function uploadToInstagram(videoPath, script) {
  console.log(`📸 Uploading to Instagram: ${script.title}`);

  try {
    const caption = `${script.title}\n\n${script.description}\n\n#cartoon #animation #AIvideo #reels #viral #trending #shorts`;
    const igUserId = CONFIG.instagram.igUserId;
    const accessToken = CONFIG.instagram.accessToken;

    // Step 1: Create media container
    // Note: Video must be publicly accessible URL for Instagram API
    // In production, upload to cloud storage first (AWS S3, Cloudinary, etc.)
    const videoPublicUrl = `https://your-storage-url.com/${path.basename(videoPath)}`;

    const containerRes = await axios.post(
      `https://graph.facebook.com/v18.0/${igUserId}/media`,
      {
        media_type: 'REELS',
        video_url: videoPublicUrl,
        caption: caption,
        share_to_feed: true,
      },
      { params: { access_token: accessToken } }
    );

    const containerId = containerRes.data.id;
    console.log(`⏳ Instagram container created: ${containerId}`);

    // Step 2: Wait for processing
    await new Promise(r => setTimeout(r, 30000));

    // Step 3: Publish
    const publishRes = await axios.post(
      `https://graph.facebook.com/v18.0/${igUserId}/media_publish`,
      { creation_id: containerId },
      { params: { access_token: accessToken } }
    );

    console.log(`✅ Instagram upload successful! Media ID: ${publishRes.data.id}`);
    return publishRes.data.id;
  } catch (err) {
    console.error('Instagram upload error:', err.message);
    throw err;
  }
}

// ============================================
// MAIN AUTO-POST FUNCTION
// ============================================
const categories = ['horror', 'values', 'life', 'lesson', 'motivation', 'comedy', 'mystery', 'kids'];
let categoryIndex = 0;

async function autoGenerateAndPost() {
  const category = categories[categoryIndex % categories.length];
  categoryIndex++;

  console.log('\n🚀 ==========================================');
  console.log(`🎬 Starting auto-post for category: ${category}`);
  console.log('==========================================\n');

  try {
    // Step 1: Generate script
    console.log('📝 Step 1: Generating AI script...');
    const script = await generateVideoScript(category);
    console.log(`✅ Script ready: ${script.title}`);

    // Step 2: Generate video
    console.log('🎬 Step 2: Generating AI video...');
    const videoPath = await generateVideo(script, category);
    console.log(`✅ Video ready: ${videoPath}`);

    // Step 3: Upload to YouTube
    console.log('▶ Step 3: Uploading to YouTube...');
    const youtubeId = await uploadToYouTube(videoPath, script, category);
    console.log(`✅ YouTube: https://youtube.com/watch?v=${youtubeId}`);

    // Step 4: Upload to Instagram
    console.log('◈ Step 4: Uploading to Instagram...');
    const igId = await uploadToInstagram(videoPath, script);
    console.log(`✅ Instagram posted: ${igId}`);

    // Step 5: Cleanup temp video file
    fs.unlinkSync(videoPath);
    console.log('🧹 Temp file cleaned up');

    console.log('\n🎉 SUCCESS! Video posted to YouTube and Instagram!');
    console.log(`📊 Title: ${script.title}`);
    console.log(`🏷️ Category: ${category}`);

    return { success: true, youtubeId, igId, title: script.title };
  } catch (err) {
    console.error('❌ Auto-post failed:', err.message);
    return { success: false, error: err.message };
  }
}

// ============================================
// CRON JOB — Auto post on schedule
// ============================================
console.log(`⏰ Setting up cron schedule: ${CONFIG.schedule}`);
cron.schedule(CONFIG.schedule, () => {
  console.log('⏰ Cron triggered! Starting auto-post...');
  autoGenerateAndPost();
});

// ============================================
// API ROUTES
// ============================================

// Health check
app.get('/', (req, res) => {
  res.json({
    status: '✅ VidForge AI is running!',
    schedule: CONFIG.schedule,
    nextCategory: categories[categoryIndex % categories.length],
  });
});

// Manually trigger a video generation
app.post('/generate', async (req, res) => {
  const { category } = req.body;
  if (category) {
    const idx = categories.indexOf(category);
    if (idx !== -1) categoryIndex = idx;
  }
  res.json({ message: '🎬 Video generation started!', category: categories[categoryIndex % categories.length] });
  autoGenerateAndPost();
});

// Get status
app.get('/status', (req, res) => {
  res.json({
    running: true,
    schedule: CONFIG.schedule,
    categoriesEnabled: categories,
    nextUp: categories[categoryIndex % categories.length],
    youtubeConnected: !!CONFIG.youtube.refreshToken,
    instagramConnected: !!CONFIG.instagram.accessToken,
  });
});

// Update schedule
app.post('/schedule', (req, res) => {
  const { schedule } = req.body;
  CONFIG.schedule = schedule;
  res.json({ message: '✅ Schedule updated', schedule });
});

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 VidForge AI Backend running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}`);
  console.log(`🔗 YouTube Auth: http://localhost:${PORT}/auth/youtube`);
  console.log(`⏰ Auto-post schedule: ${CONFIG.schedule}`);
  console.log('\n✅ Ready to generate and post videos automatically!\n');
});

module.exports = app;
