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

const YOUTUBE_CLIENT_ID      = process.env.YOUTUBE_CLIENT_ID;
const YOUTUBE_CLIENT_SECRET  = process.env.YOUTUBE_CLIENT_SECRET;
const YOUTUBE_REDIRECT_URI   = process.env.YOUTUBE_REDIRECT_URI;
const YOUTUBE_REFRESH_TOKEN  = process.env.YOUTUBE_REFRESH_TOKEN;
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const INSTAGRAM_USER_ID      = process.env.INSTAGRAM_USER_ID;
const GROQ_API_KEY           = process.env.GROQ_API_KEY;
const HF_API_KEY             = process.env.HUGGINGFACE_API_KEY;

const VIDEO_CATEGORIES = [
  'horror', 'adventure', 'mystery', 'motivation',
  'fantasy', 'thriller', 'comedy', 'kids',
  'romance', 'science fiction', 'historical', 'nature',
  'life lesson', 'mindset', 'folklore', 'superhero'
];

// Cartoon art styles — focused on high quality cartoon look
const ART_STYLES = [
  'cartoon network style, thick black outlines, flat 2D colors, expressive character, blue rabbit, bold design',
  'retro cartoon style, thick outlines, bright flat colors, funny expressive face, classic animation',
  'anime cartoon style, studio ghibli inspired, soft colors, detailed background, cute characters',
  'dark gothic cartoon, thick lines, moody colors, dramatic shadows, horror cartoon style',
  'comic book cartoon, halftone dots, bold outlines, action pose, vibrant colors',
  'chibi cartoon style, big head small body, huge eyes, pastel colors, cute expressions',
  'adventure cartoon style, dynamic pose, bright colors, thick outlines, heroic character',
  'pixar inspired cartoon, 3D look, smooth shading, expressive eyes, colorful scene'
];

const CAPTION_STYLES = {
  horror:    { size: 58, color: 'red',    outline: 'black',  bg: '0.7' },
  thriller:  { size: 58, color: 'red',    outline: 'black',  bg: '0.7' },
  mystery:   { size: 56, color: 'white',  outline: 'purple', bg: '0.6' },
  fantasy:   { size: 56, color: 'yellow', outline: 'black',  bg: '0.5' },
  folklore:  { size: 56, color: 'yellow', outline: 'black',  bg: '0.5' },
  adventure: { size: 60, color: 'white',  outline: 'black',  bg: '0.6' },
  superhero: { size: 62, color: 'yellow', outline: 'black',  bg: '0.0' },
  motivation:{ size: 60, color: 'white',  outline: 'black',  bg: '0.0' },
  mindset:   { size: 58, color: 'white',  outline: 'black',  bg: '0.0' },
  comedy:    { size: 62, color: 'yellow', outline: 'black',  bg: '0.5' },
  kids:      { size: 64, color: 'yellow', outline: 'black',  bg: '0.6' },
  romance:   { size: 54, color: 'white',  outline: 'black',  bg: '0.5' },
  default:   { size: 56, color: 'white',  outline: 'black',  bg: '0.5' }
};

let categoryIndex = 0;
let artStyleIndex = 0;
let dailyCount = 0;
const DAILY_LIMIT = 15;

cron.schedule('0 0 * * *', function() { dailyCount = 0; console.log('[VidForge] Daily count reset!'); });
cron.schedule('*/96 * * * *', function() {
  if (dailyCount < DAILY_LIMIT) runPostingCycle();
  else console.log('[Cron] Daily limit reached.');
});

// STEP 1 — Generate Script with Groq
async function generateVideoScript(category, artStyle) {
  const prompt = 'Create an engaging ' + category + ' cartoon story for a 30-second YouTube Short.\n\nHave 4 scenes. Captions must match mood:\n- horror/thriller = dramatic like "No one believed her..."\n- comedy = funny like "The robot had ONE job."\n- motivation = powerful like "She fell 99 times."\n- kids = fun like "The bunny had a plan!"\nMax 7 words per caption. Cinematic and punchy.\n\nReturn ONLY valid JSON, no markdown:\n{\n  "title": "Episode title under 60 chars",\n  "series": "Series name",\n  "episode": "Episode 1",\n  "description": "2-3 sentence caption",\n  "hashtags": "#cartoon #anime #shorts #story #viral #fyp #animation #' + category + '",\n  "mood": "' + category + '",\n  "scenes": [\n    {\n      "narration": "Opening narration 1-2 sentences",\n      "caption": "Short punchy text MAX 7 words",\n      "image_prompt": "' + artStyle + ', ' + category + ' scene, describe what narration shows visually, vertical 9:16, no text in image"\n    },\n    {\n      "narration": "Scene 2 narration",\n      "caption": "Short punchy text MAX 7 words",\n      "image_prompt": "' + artStyle + ', ' + category + ' scene, describe scene 2 visually, vertical 9:16, no text in image"\n    },\n    {\n      "narration": "Scene 3 narration",\n      "caption": "Short punchy text MAX 7 words",\n      "image_prompt": "' + artStyle + ', ' + category + ' scene, describe scene 3 visually, vertical 9:16, no text in image"\n    },\n    {\n      "narration": "Scene 4 powerful ending",\n      "caption": "Ending text MAX 7 words",\n      "image_prompt": "' + artStyle + ', ' + category + ' scene, describe scene 4 visually, vertical 9:16, no text in image"\n    }\n  ]\n}';

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    { model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: prompt }], max_tokens: 1400, temperature: 0.95 },
    { headers: { 'Authorization': 'Bearer ' + GROQ_API_KEY, 'Content-Type': 'application/json' } }
  );

  const text = response.data.choices[0].message.content;
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// STEP 2 — Generate Cartoon Image using Hugging Face
async function generateCartoonImage(prompt, outputPath) {
  const seed = Math.floor(Math.random() * 999999);

  // HF models for cartoon style — try in order
  const hfModels = [
    'Linaqruf/anything-v3.0',
    'dreamlike-art/dreamlike-anime-1.0',
    'prompthero/openjourney-v4'
  ];

  // Try Hugging Face first (best cartoon quality)
  if (HF_API_KEY) {
    for (const model of hfModels) {
      try {
        console.log('[Image] Trying HuggingFace model: ' + model);
        const response = await axios({
          method: 'POST',
          url: 'https://api-inference.huggingface.co/models/' + model,
          headers: {
            'Authorization': 'Bearer ' + HF_API_KEY,
            'Content-Type': 'application/json'
          },
          data: {
            inputs: prompt + ', high quality, detailed, no text, no watermark',
            parameters: { seed: seed, width: 512, height: 896 }
          },
          responseType: 'arraybuffer',
          timeout: 60000
        });

        if (response.data && response.data.length > 5000) {
          fs.writeFileSync(outputPath, Buffer.from(response.data));
          console.log('[Image] HuggingFace success with ' + model + '!');
          return;
        }
      } catch (err) {
        console.log('[Image] HF ' + model + ' failed: ' + err.message + ' — trying next...');
        await new Promise(function(r) { setTimeout(r, 3000); });
      }
    }
  }

  // Fallback 1 — Pollinations with multiple retries
  console.log('[Image] Trying Pollinations fallback...');
  const pollinationModels = ['flux', 'turbo', 'flux-realism'];
  for (const model of pollinationModels) {
    try {
      const fullPrompt = encodeURIComponent(prompt + ', cartoon style, thick outlines, bright colors, no text, no watermark');
      const url = 'https://image.pollinations.ai/prompt/' + fullPrompt + '?width=576&height=1024&seed=' + seed + '&nologo=true&model=' + model;
      const response = await axios({ method: 'GET', url, responseType: 'arraybuffer', timeout: 60000, headers: { 'User-Agent': 'Mozilla/5.0 VidForgeBot/1.0' } });
      if (response.data && response.data.length > 5000) {
        fs.writeFileSync(outputPath, Buffer.from(response.data));
        console.log('[Image] Pollinations ' + model + ' success!');
        return;
      }
    } catch (err) {
      console.log('[Image] Pollinations ' + model + ' failed: ' + err.message);
      await new Promise(function(r) { setTimeout(r, 2000); });
    }
  }

  // Fallback 2 — Use a solid color background with text as last resort
  console.log('[Image] All sources failed, using placeholder...');
  const colors = ['#1a1a2e', '#16213e', '#0f3460', '#533483', '#2d6a4f'];
  const color = colors[Math.floor(Math.random() * colors.length)];
  const svgContent = '<svg width="576" height="1024" xmlns="http://www.w3.org/2000/svg"><rect width="576" height="1024" fill="' + color + '"/><text x="288" y="512" font-size="48" fill="white" text-anchor="middle" font-family="Arial">🎬</text></svg>';
  // Convert SVG to PNG using ImageMagick if available
  try {
    const svgPath = outputPath.replace('.png', '.svg');
    fs.writeFileSync(svgPath, svgContent);
    await execPromise('convert -size 576x1024 xc:' + color + ' ' + outputPath);
    console.log('[Image] Placeholder created!');
  } catch (e) {
    // Last resort — download any image
    const fallbackUrl = 'https://picsum.photos/seed/' + seed + '/576/1024';
    const response = await axios({ method: 'GET', url: fallbackUrl, responseType: 'arraybuffer', timeout: 30000 });
    fs.writeFileSync(outputPath, Buffer.from(response.data));
    console.log('[Image] Picsum fallback used');
  }
}

// STEP 3 — Generate Voice
async function generateVoice(text, outputPath) {
  const cleanText = text.replace(/['"]/g, '').substring(0, 200);
  const url = 'https://translate.google.com/translate_tts?ie=UTF-8&q=' + encodeURIComponent(cleanText) + '&tl=en&client=tw-ob&ttsspeed=0.9';
  const response = await axios({ method: 'GET', url, responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } });
  fs.writeFileSync(outputPath, Buffer.from(response.data));
  console.log('[Voice] Saved!');
}

// STEP 4 — Build Scene with CENTER caption synced to voice
async function buildSceneVideo(imgPath, audioPath, caption, outputPath, duration, category) {
  const style = CAPTION_STYLES[category] || CAPTION_STYLES['default'];
  const cleanCaption = caption.replace(/['":\\]/g, '').replace(/\./g, '').substring(0, 60).toUpperCase();
  const captionStart = 0.3;
  const captionEnd = Math.max(duration - 0.3, captionStart + 1.0);

  // CENTER position — middle of screen
  const yPos = '(h/2-text_h/2)-80';

  const words = cleanCaption.split(' ');
  const wordDuration = (captionEnd - captionStart) / Math.max(words.length, 1);

  let drawFilters = '';
  if (words.length <= 3) {
    drawFilters = 'drawtext=text=\'' + cleanCaption + '\':fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:fontsize=' + style.size + ':fontcolor=' + style.color + ':x=(w-text_w)/2:y=' + yPos + ':borderw=5:bordercolor=' + style.outline + ':box=1:boxcolor=black@' + style.bg + ':boxborderw=18:enable=\'between(t,' + captionStart + ',' + captionEnd + ')\'';
  } else {
    const wordFilters = [];
    let accumulated = '';
    words.forEach(function(word, i) {
      accumulated = words.slice(0, i + 1).join(' ');
      const wStart = (captionStart + i * wordDuration).toFixed(2);
      const wEnd = captionEnd.toFixed(2);
      wordFilters.push('drawtext=text=\'' + accumulated + '\':fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:fontsize=' + style.size + ':fontcolor=' + style.color + ':x=(w-text_w)/2:y=' + yPos + ':borderw=5:bordercolor=' + style.outline + ':box=1:boxcolor=black@' + style.bg + ':boxborderw=18:enable=\'between(t,' + wStart + ',' + wEnd + ')\'');
    });
    drawFilters = wordFilters.join(',');
  }

  const fadeOut = Math.max(duration - 0.2, 0);
  const vf = 'scale=768:1344:force_original_aspect_ratio=decrease,pad=768:1344:(ow-iw)/2:(oh-ih)/2:black,' + drawFilters + ',fade=t=in:st=0:d=0.2,fade=t=out:st=' + fadeOut + ':d=0.2';
  const cmd = 'ffmpeg -loop 1 -i "' + imgPath + '" -i "' + audioPath + '" -c:v libx264 -tune stillimage -c:a aac -b:a 192k -pix_fmt yuv420p -t ' + duration + ' -vf "' + vf + '" -y "' + outputPath + '"';

  await execPromise(cmd);
  console.log('[FFmpeg] Scene done! Caption: "' + cleanCaption + '"');
}

// STEP 5 — Stitch + Music
async function stitchFinalVideo(sceneVideos, tempDir, outputPath) {
  const concatFile = path.join(tempDir, 'concat.txt');
  fs.writeFileSync(concatFile, sceneVideos.map(function(v) { return 'file \'' + v + '\''; }).join('\n'));
  const tempConcat = path.join(tempDir, 'concat_raw.mp4');
  await execPromise('ffmpeg -f concat -safe 0 -i "' + concatFile + '" -c copy -y "' + tempConcat + '"');

  const musicPath = path.join(tempDir, 'music.mp3');
  let hasMusicFile = false;
  try {
    const musicUrls = ['https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3'];
    const musicUrl = musicUrls[Math.floor(Math.random() * musicUrls.length)];
    const musicResponse = await axios.get(musicUrl, { responseType: 'arraybuffer', timeout: 15000 });
    fs.writeFileSync(musicPath, Buffer.from(musicResponse.data));
    hasMusicFile = true;
  } catch (e) { console.log('[Music] Skipping'); }

  if (hasMusicFile) {
    const getDur = await execPromise('ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "' + tempConcat + '"');
    const totalDur = parseFloat(getDur.stdout.trim());
    await execPromise('ffmpeg -i "' + tempConcat + '" -i "' + musicPath + '" -filter_complex "[0:a]volume=1.0[voice];[1:a]volume=0.12,atrim=0:' + totalDur + '[bgm];[voice][bgm]amix=inputs=2:duration=first[aout]" -map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 192k -y "' + outputPath + '"');
  } else {
    fs.copyFileSync(tempConcat, outputPath);
  }
  console.log('[FFmpeg] Final video ready!');
}

// STEP 6 — Upload YouTube
async function uploadToYouTube(videoPath, title, description, hashtags, series) {
  const oauth2Client = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI);
  oauth2Client.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  const uploadResponse = await youtube.videos.insert({
    part: 'snippet,status',
    requestBody: {
      snippet: {
        title: (title + ' | ' + series).substring(0, 100),
        description: description + '\n\n' + hashtags + '\n\n#' + series.replace(/ /g, ''),
        tags: hashtags.split('#').filter(Boolean).map(function(t) { return t.trim(); }),
        categoryId: '1', defaultLanguage: 'en'
      },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false }
    },
    media: { mimeType: 'video/mp4', body: fs.createReadStream(videoPath) }
  });
  return uploadResponse.data.id;
}

// STEP 7 — Post Instagram
async function postToInstagram(videoUrl, caption) {
  const containerResponse = await axios.post(
    'https://graph.facebook.com/v18.0/' + INSTAGRAM_USER_ID + '/media',
    { media_type: 'REELS', video_url: videoUrl, caption: caption, share_to_feed: true, access_token: INSTAGRAM_ACCESS_TOKEN }
  );
  const containerId = containerResponse.data.id;
  await new Promise(function(r) { setTimeout(r, 45000); });
  const publishResponse = await axios.post(
    'https://graph.facebook.com/v18.0/' + INSTAGRAM_USER_ID + '/media_publish',
    { creation_id: containerId, access_token: INSTAGRAM_ACCESS_TOKEN }
  );
  return publishResponse.data.id;
}

// MAIN PIPELINE
async function runPostingCycle(category) {
  const selectedCategory = category || VIDEO_CATEGORIES[categoryIndex % VIDEO_CATEGORIES.length];
  const selectedStyle = ART_STYLES[artStyleIndex % ART_STYLES.length];
  categoryIndex++;
  artStyleIndex++;
  dailyCount++;

  console.log('\n[VidForge] Category: ' + selectedCategory + ' | Style: ' + selectedStyle.split(',')[0]);
  console.log('[VidForge] Daily: ' + dailyCount + '/' + DAILY_LIMIT);

  const results = { category: selectedCategory, youtube: null, instagram: null, error: null };
  const tempDir = path.join('/tmp', 'vidforge_' + Date.now());
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    console.log('[VidForge] Writing story...');
    const script = await generateVideoScript(selectedCategory, selectedStyle);
    console.log('[VidForge] Story: "' + script.title + '" | Series: ' + script.series);

    const sceneDurations = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const scene = script.scenes[i];
      console.log('[VidForge] Scene ' + (i+1) + '/4 | Caption: "' + scene.caption + '"');
      const imgPath = path.join(tempDir, 'image_' + i + '.png');
      const audioPath = path.join(tempDir, 'voice_' + i + '.mp3');
      await Promise.all([generateCartoonImage(scene.image_prompt, imgPath), generateVoice(scene.narration, audioPath)]);
      let duration = 5;
      try {
        const result = await execPromise('ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "' + audioPath + '"');
        duration = Math.max(parseFloat(result.stdout.trim()) + 0.5, 3);
      } catch (e) {}
      sceneDurations.push(duration);
      console.log('[VidForge] Scene ' + (i+1) + ' ready! Duration: ' + duration.toFixed(1) + 's');
    }

    console.log('[VidForge] Building scene videos with center captions...');
    const sceneVideos = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const imgPath = path.join(tempDir, 'image_' + i + '.png');
      const audioPath = path.join(tempDir, 'voice_' + i + '.mp3');
      const sceneOut = path.join(tempDir, 'scene_' + i + '.mp4');
      await buildSceneVideo(imgPath, audioPath, script.scenes[i].caption, sceneOut, sceneDurations[i], script.mood || selectedCategory);
      sceneVideos.push(sceneOut);
    }

    console.log('[VidForge] Stitching final video...');
    const videoPath = path.join(tempDir, 'final.mp4');
    await stitchFinalVideo(sceneVideos, tempDir, videoPath);

    const caption = script.title + ' | ' + script.series + '\n\n' + script.description + '\n\n' + script.hashtags;

    try {
      console.log('[VidForge] Uploading to YouTube...');
      const ytId = await uploadToYouTube(videoPath, script.title, script.description, script.hashtags, script.series);
      results.youtube = 'https://youtube.com/watch?v=' + ytId;
      console.log('[VidForge] YouTube done! ' + results.youtube);
    } catch (err) {
      console.error('[VidForge] YouTube failed:', err.message);
      results.youtubeError = err.message;
    }

    try {
      if (results.youtube) {
        console.log('[VidForge] Posting to Instagram...');
        const igId = await postToInstagram(results.youtube, caption);
        results.instagram = igId;
        console.log('[VidForge] Instagram done!');
      }
    } catch (err) {
      console.error('[VidForge] Instagram failed:', err.message);
      results.instagramError = err.message;
    }

    console.log('\n[VidForge] Done! ' + dailyCount + '/' + DAILY_LIMIT + ' today\n');
  } catch (err) {
    results.error = err.message;
    dailyCount--;
    console.error('[VidForge] Failed:', err.message);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
  }
  return results;
}

// ROUTES
app.get('/', function(req, res) {
  res.json({ app: 'VidForge AI', status: 'running', version: '7.0.0', description: 'HuggingFace Cartoon Images + Center Captions + Mood Sync' });
});

app.get('/status', function(req, res) {
  res.json({
    running: true, version: '7.0.0',
    schedule: 'Every 96 minutes (15 videos/day)',
    dailyCount: dailyCount + '/' + DAILY_LIMIT,
    nextCategory: VIDEO_CATEGORIES[categoryIndex % VIDEO_CATEGORIES.length],
    nextStyle: ART_STYLES[artStyleIndex % ART_STYLES.length].split(',')[0],
    youtubeConnected: !!YOUTUBE_REFRESH_TOKEN,
    instagramConnected: !!INSTAGRAM_ACCESS_TOKEN,
    groqConnected: !!GROQ_API_KEY,
    hfConnected: !!HF_API_KEY,
    features: ['HuggingFace cartoon images', 'Center captions', 'Mood-matched colors', 'Word-by-word reveal', 'Voice synced timing', '15 videos/day'],
    timestamp: new Date().toISOString()
  });
});

app.post('/generate', function(req, res) {
  const category = (req.body || {}).category;
  if (dailyCount >= DAILY_LIMIT) return res.json({ message: 'Daily limit reached!', dailyCount: dailyCount });
  res.json({ message: 'Cartoon episode started!', category: category || 'auto' });
  runPostingCycle(category);
});

app.post('/test-script', async function(req, res) {
  const cat = ((req.body || {}).category) || 'horror';
  const style = ART_STYLES[Math.floor(Math.random() * ART_STYLES.length)];
  try {
    const script = await generateVideoScript(cat, style);
    res.json({ success: true, category: cat, script: script });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/auth/youtube', function(req, res) {
  const oauth2Client = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI);
  res.redirect(oauth2Client.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/youtube.upload'] }));
});

app.get('/auth/youtube/callback', async function(req, res) {
  const oauth2Client = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI);
  const tokens = (await oauth2Client.getToken(req.query.code)).tokens;
  res.json({ message: 'Save this!', refresh_token: tokens.refresh_token });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('\n VidForge AI v7.0 — HuggingFace Cartoon + Center Captions');
  console.log(' HF Connected: ' + (HF_API_KEY ? 'YES' : 'NO - add HF_API_KEY'));
  console.log(' Status: http://localhost:' + PORT + '/status\n');
});

module.exports = app;
