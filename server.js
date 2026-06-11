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
const ELEVENLABS_API_KEY     = process.env.ELEVENLABS_API_KEY;
const HF_API_KEY             = process.env.HF_API_KEY;

const VIDEO_CATEGORIES = [
  'horror', 'adventure', 'mystery', 'motivation',
  'fantasy', 'thriller', 'comedy', 'kids',
  'romance', 'science fiction', 'historical', 'nature',
  'life lesson', 'mindset', 'folklore', 'superhero'
];

const ART_STYLES = [
  'anime style, Studio Ghibli inspired, soft lighting, detailed illustration, cinematic',
  'dark anime style, dramatic lighting, detailed manga art, cinematic shadows',
  'cartoon network style, thick black outlines, flat 2D animation, vibrant colors',
  'comic book style, bold lines, vibrant colors, action poses, dynamic',
  'chibi anime style, cute characters, pastel colors, big expressive eyes',
  'pixar 3D cartoon style, colorful expressive characters, cinematic lighting',
  'watercolor cartoon style, soft colors, storybook illustration',
  'retro anime 90s style, cel shading, bold outlines, classic animation'
];

const HF_MODELS = [
  'Linaqruf/anything-v3.0',
  'stabilityai/stable-diffusion-xl-base-1.0',
  'runwayml/stable-diffusion-v1-5'
];

const CAPTION_STYLES = {
  horror:     { size: 52, color: 'red',    outline: 'black',  bg: '0.7' },
  thriller:   { size: 52, color: 'red',    outline: 'black',  bg: '0.7' },
  mystery:    { size: 50, color: 'white',  outline: 'purple', bg: '0.6' },
  fantasy:    { size: 50, color: 'yellow', outline: 'black',  bg: '0.5' },
  folklore:   { size: 50, color: 'yellow', outline: 'black',  bg: '0.5' },
  adventure:  { size: 52, color: 'white',  outline: 'black',  bg: '0.6' },
  superhero:  { size: 54, color: 'yellow', outline: 'black',  bg: '0.0' },
  motivation: { size: 52, color: 'white',  outline: 'black',  bg: '0.0' },
  mindset:    { size: 50, color: 'white',  outline: 'black',  bg: '0.0' },
  comedy:     { size: 54, color: 'yellow', outline: 'black',  bg: '0.5' },
  kids:       { size: 56, color: 'yellow', outline: 'black',  bg: '0.6' },
  romance:    { size: 48, color: 'white',  outline: 'black',  bg: '0.5' },
  default:    { size: 50, color: 'white',  outline: 'black',  bg: '0.5' }
};

const ELEVENLABS_VOICES = [
  '21m00Tcm4TlvDq8ikWAM',
  'AZnzlk1XvdvUeBnXmlld',
  'EXAVITQu4vr4xnSDxMaL',
  'ErXwobaYiN019PkySvjV',
  'TxGEqnHWrfWFTfGW9XjX',
  'VR6AewLTigWG4xSOukaG',
  'pNInz6obpgDQGcFmaJgB'
];

let categoryIndex = 0;
let artStyleIndex = 0;
let voiceIndex    = 0;
let hfModelIndex  = 0;
let dailyCount    = 0;
const DAILY_LIMIT = 15;

cron.schedule('0 0 * * *', () => { dailyCount = 0; console.log('[VidForge] Daily count reset!'); });
cron.schedule('*/96 * * * *', () => {
  if (dailyCount < DAILY_LIMIT) runPostingCycle();
  else console.log('[Cron] Daily limit reached.');
});

// ─── STEP 1 — Generate Script ────────────────────────────────────────────────
async function generateVideoScript(category, artStyle) {
  const prompt = `Create an engaging ${category} cartoon story for a 30-second YouTube Short.

Have 4 scenes. Narration should be SHORT — max 2 sentences per scene, max 20 words total per scene.
Captions must match mood:
- horror/thriller = dramatic like "No one believed her..."
- comedy = funny like "The robot had ONE job."
- motivation = powerful like "She fell 99 times."
- kids = fun like "The bunny had a plan!"
Max 6 words per caption.

Return ONLY this JSON, no markdown:
{
  "title": "Episode title under 60 chars",
  "series": "Series name",
  "description": "2-3 sentence caption",
  "hashtags": "#cartoon #anime #shorts #story #viral #fyp #animation #${category}",
  "mood": "${category}",
  "scenes": [
    {
      "narration": "Short narration max 20 words",
      "caption": "MAX 6 words",
      "image_prompt": "${artStyle}, ${category} scene, vertical 9:16, high quality cinematic, no text"
    },
    {
      "narration": "Short narration max 20 words",
      "caption": "MAX 6 words",
      "image_prompt": "${artStyle}, ${category} scene 2, vertical 9:16, high quality cinematic, no text"
    },
    {
      "narration": "Short narration max 20 words",
      "caption": "MAX 6 words",
      "image_prompt": "${artStyle}, ${category} scene 3, vertical 9:16, high quality cinematic, no text"
    },
    {
      "narration": "Powerful ending max 20 words cliffhanger",
      "caption": "MAX 6 words ending hook",
      "image_prompt": "${artStyle}, ${category} dramatic ending scene, vertical 9:16, high quality cinematic, no text"
    }
  ]
}`;

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1400,
      temperature: 0.95
    },
    { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
  );

  const text = response.data.choices[0].message.content;
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ─── STEP 2 — Generate Image (Pollinations flux, free, no API key) ────────────
async function generateCartoonImage(prompt, outputPath) {
  await new Promise(r => setTimeout(r, 4000)); // avoid rate limit

  const fullPrompt = prompt + ', high quality, detailed, cinematic, no text, no watermark, no logo';
  const encoded = encodeURIComponent(fullPrompt);
  const seed = Math.floor(Math.random() * 999999);

  const urls = [
    `https://image.pollinations.ai/prompt/${encoded}?width=576&height=1024&seed=${seed}&nologo=true&model=flux&enhance=true`,
    `https://image.pollinations.ai/prompt/${encoded}?width=576&height=1024&seed=${seed}&nologo=true&model=flux`,
    `https://image.pollinations.ai/prompt/${encoded}?width=576&height=1024&seed=${seed}&nologo=true`
  ];

  for (const url of urls) {
    try {
      console.log('[Image] Trying Pollinations flux...');
      const response = await axios({
        method: 'GET', url, responseType: 'arraybuffer', timeout: 90000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      if (response.data && response.data.length > 10000) {
        fs.writeFileSync(outputPath, Buffer.from(response.data));
        console.log(`[Image] Pollinations saved! ${Math.round(response.data.length/1024)}KB`);
        return;
      }
    } catch (err) {
      console.log(`[Image] Pollinations failed: ${err.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // HF backup
  try {
    const model = HF_MODELS[hfModelIndex % HF_MODELS.length];
    hfModelIndex++;
    console.log(`[Image] Trying HF: ${model}`);
    const response = await axios({
      method: 'POST',
      url: `https://api-inference.huggingface.co/models/${model}`,
      headers: { 'Authorization': `Bearer ${HF_API_KEY}`, 'Content-Type': 'application/json' },
      data: { inputs: fullPrompt },
      responseType: 'arraybuffer', timeout: 90000
    });
    if (response.data && response.data.length > 5000) {
      fs.writeFileSync(outputPath, Buffer.from(response.data));
      console.log('[Image] HF saved!');
      return;
    }
  } catch (err) {
    console.log(`[Image] HF failed: ${err.message}`);
  }

  // Picsum last resort
  try {
    const seed2 = Math.floor(Math.random() * 9999);
    const response = await axios({ method: 'GET', url: `https://picsum.photos/seed/${seed2}/576/1024`, responseType: 'arraybuffer', timeout: 15000 });
    if (response.data && response.data.length > 5000) {
      fs.writeFileSync(outputPath, Buffer.from(response.data));
      console.log('[Image] Picsum saved!');
      return;
    }
  } catch (err) { console.log(`[Image] Picsum failed: ${err.message}`); }

  await execPromise(`ffmpeg -f lavfi -i color=c=black:size=576x1024:duration=1 -vframes 1 "${outputPath}" -y`);
  console.log('[Image] Using black placeholder');
}

// ─── STEP 3 — Generate Voice ─────────────────────────────────────────────────
async function generateVoice(text, outputPath) {
  const cleanText = text.replace(/['"]/g, '').substring(0, 500);
  const voiceId = ELEVENLABS_VOICES[voiceIndex % ELEVENLABS_VOICES.length];
  voiceIndex++;

  if (ELEVENLABS_API_KEY) {
    try {
      const response = await axios({
        method: 'POST',
        url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
        data: { text: cleanText, model_id: 'eleven_monolingual_v1', voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
        responseType: 'arraybuffer', timeout: 30000
      });
      fs.writeFileSync(outputPath, Buffer.from(response.data));
      console.log(`[Voice] ElevenLabs saved!`);
      return;
    } catch (err) {
      console.log(`[Voice] ElevenLabs failed: ${err.message}`);
    }
  }

  // Google TTS fallback
  const shortText = cleanText.substring(0, 200);
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(shortText)}&tl=en&client=tw-ob&ttsspeed=0.9`;
  const response = await axios({ method: 'GET', url, responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } });
  fs.writeFileSync(outputPath, Buffer.from(response.data));
  console.log(`[Voice] Google TTS saved!`);
}

// ─── STEP 4 — Get word timestamps from Groq Whisper ──────────────────────────
async function getWordTimestamps(audioPath) {
  try {
    const audioData = fs.readFileSync(audioPath);
    const base64Audio = audioData.toString('base64');

    const response = await axios.post(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      {
        file: `data:audio/mp3;base64,${base64Audio}`,
        model: 'whisper-large-v3',
        response_format: 'verbose_json',
        timestamp_granularities: ['word']
      },
      {
        headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );

    if (response.data && response.data.words) {
      console.log(`[Whisper] Got ${response.data.words.length} word timestamps!`);
      return response.data.words;
    }
  } catch (err) {
    console.log(`[Whisper] Failed: ${err.message} — using even split`);
  }
  return null;
}

// ─── STEP 5 — Build Scene Video with synced captions ─────────────────────────
async function buildSceneVideo(imgPath, audioPath, narration, outputPath, duration, category) {
  const style = CAPTION_STYLES[category] || CAPTION_STYLES['default'];
  const font = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  const yPos = '(h*0.78)'; // lower third — like real Shorts

  // Try to get word timestamps from Whisper
  const wordTimings = await getWordTimestamps(audioPath);

  let drawFilters = '';

  if (wordTimings && wordTimings.length > 0) {
    // ✅ PERFECT SYNC — use Whisper word timestamps
    // Group into chunks of 2-3 words for readability
    const chunks = [];
    let i = 0;
    while (i < wordTimings.length) {
      const chunk = wordTimings.slice(i, i + 3);
      chunks.push({
        text: chunk.map(w => w.word.toUpperCase()).join(' ').replace(/['":\\]/g, '').replace(/[^A-Z0-9 !?]/g, ''),
        start: chunk[0].start,
        end: chunk[chunk.length - 1].end
      });
      i += 3;
    }

    drawFilters = chunks.map(chunk =>
      `drawtext=text='${chunk.text}':fontfile=${font}:fontsize=${style.size}:fontcolor=${style.color}:x=(w-text_w)/2:y=${yPos}:borderw=6:bordercolor=${style.outline}:box=1:boxcolor=black@${style.bg}:boxborderw=20:enable='between(t,${chunk.start},${chunk.end})'`
    ).join(',');

    console.log(`[Caption] Whisper sync: ${chunks.length} chunks`);
  } else {
    // ✅ EVEN SPLIT — no Whisper, split narration evenly by word count
    const words = narration.toUpperCase().replace(/['":\\]/g, '').replace(/[^A-Z0-9 !?]/g, '').split(' ').filter(Boolean);
    const chunkSize = 3;
    const chunks = [];
    for (let i = 0; i < words.length; i += chunkSize) {
      chunks.push(words.slice(i, i + chunkSize).join(' '));
    }

    const timePerChunk = (duration - 0.5) / chunks.length;
    drawFilters = chunks.map((text, i) => {
      const start = (0.2 + i * timePerChunk).toFixed(2);
      const end = (0.2 + (i + 1) * timePerChunk).toFixed(2);
      return `drawtext=text='${text}':fontfile=${font}:fontsize=${style.size}:fontcolor=${style.color}:x=(w-text_w)/2:y=${yPos}:borderw=6:bordercolor=${style.outline}:box=1:boxcolor=black@${style.bg}:boxborderw=20:enable='between(t,${start},${end})'`;
    }).join(',');

    console.log(`[Caption] Even split: ${chunks.length} chunks`);
  }

  const fadeOut = Math.max(duration - 0.2, 0);
  const vf = `scale=576:1024:force_original_aspect_ratio=decrease,pad=576:1024:(ow-iw)/2:(oh-ih)/2:black,${drawFilters},fade=t=in:st=0:d=0.3,fade=t=out:st=${fadeOut}:d=0.2`;
  const cmd = `ffmpeg -loop 1 -i "${imgPath}" -i "${audioPath}" -c:v libx264 -tune stillimage -c:a aac -b:a 192k -pix_fmt yuv420p -t ${duration} -vf "${vf}" -y "${outputPath}"`;

  await execPromise(cmd);
  console.log(`[FFmpeg] Scene done! ${duration.toFixed(1)}s`);
}

// ─── STEP 6 — Stitch Final Video + Music ─────────────────────────────────────
async function stitchFinalVideo(sceneVideos, tempDir, outputPath) {
  const concatFile = path.join(tempDir, 'concat.txt');
  fs.writeFileSync(concatFile, sceneVideos.map(v => `file '${v}'`).join('\n'));
  const tempConcat = path.join(tempDir, 'concat_raw.mp4');
  await execPromise(`ffmpeg -f concat -safe 0 -i "${concatFile}" -c copy -y "${tempConcat}"`);

  const musicPath = path.join(tempDir, 'music.mp3');
  let hasMusic = false;
  try {
    const musicUrls = [
      'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
      'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
      'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3'
    ];
    const musicUrl = musicUrls[Math.floor(Math.random() * musicUrls.length)];
    const musicRes = await axios.get(musicUrl, { responseType: 'arraybuffer', timeout: 15000 });
    fs.writeFileSync(musicPath, Buffer.from(musicRes.data));
    hasMusic = true;
    console.log('[Music] Downloaded!');
  } catch (e) { console.log('[Music] Skipping music'); }

  if (hasMusic) {
    const { stdout } = await execPromise(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${tempConcat}"`);
    const totalDur = parseFloat(stdout.trim());
    await execPromise(`ffmpeg -i "${tempConcat}" -i "${musicPath}" -filter_complex "[0:a]volume=1.0[voice];[1:a]volume=0.10,atrim=0:${totalDur}[bgm];[voice][bgm]amix=inputs=2:duration=first[aout]" -map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 192k -y "${outputPath}"`);
  } else {
    fs.copyFileSync(tempConcat, outputPath);
  }
  console.log('[FFmpeg] Final video ready!');
}

// ─── STEP 7 — Upload YouTube ──────────────────────────────────────────────────
async function uploadToYouTube(videoPath, title, description, hashtags, series) {
  const oauth2Client = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI);
  oauth2Client.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  const uploadResponse = await youtube.videos.insert({
    part: 'snippet,status',
    requestBody: {
      snippet: {
        title: (title + ' | ' + series).substring(0, 100),
        description: description + '\n\n' + hashtags,
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

// ─── STEP 8 — Post Instagram ──────────────────────────────────────────────────
async function postToInstagram(videoUrl, caption) {
  const containerRes = await axios.post(
    `https://graph.facebook.com/v18.0/${INSTAGRAM_USER_ID}/media`,
    { media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: true, access_token: INSTAGRAM_ACCESS_TOKEN }
  );
  const containerId = containerRes.data.id;
  await new Promise(r => setTimeout(r, 45000));
  const publishRes = await axios.post(
    `https://graph.facebook.com/v18.0/${INSTAGRAM_USER_ID}/media_publish`,
    { creation_id: containerId, access_token: INSTAGRAM_ACCESS_TOKEN }
  );
  return publishRes.data.id;
}

// ─── MAIN PIPELINE ────────────────────────────────────────────────────────────
async function runPostingCycle(category) {
  const selectedCategory = category || VIDEO_CATEGORIES[categoryIndex % VIDEO_CATEGORIES.length];
  const selectedStyle = ART_STYLES[artStyleIndex % ART_STYLES.length];
  categoryIndex++;
  artStyleIndex++;
  dailyCount++;

  console.log(`\n[VidForge] Category: ${selectedCategory} | Style: ${selectedStyle.split(',')[0]}`);
  console.log(`[VidForge] Daily: ${dailyCount}/${DAILY_LIMIT}`);

  const results = { category: selectedCategory, youtube: null, instagram: null, error: null };
  const tempDir = path.join('/tmp', 'vidforge_' + Date.now());
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    console.log('[VidForge] Writing story...');
    const script = await generateVideoScript(selectedCategory, selectedStyle);
    console.log(`[VidForge] Story: "${script.title}"`);

    const sceneDurations = [];

    // Generate images and voices in sequence (avoid rate limits)
    for (let i = 0; i < script.scenes.length; i++) {
      const scene = script.scenes[i];
      console.log(`[VidForge] Scene ${i+1}/4`);
      const imgPath   = path.join(tempDir, `image_${i}.png`);
      const audioPath = path.join(tempDir, `voice_${i}.mp3`);

      await generateCartoonImage(scene.image_prompt, imgPath);
      await generateVoice(scene.narration, audioPath);

      let duration = 5;
      try {
        const result = await execPromise(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`);
        duration = Math.max(parseFloat(result.stdout.trim()) + 0.8, 4);
      } catch (e) {}
      sceneDurations.push(duration);
      console.log(`[VidForge] Scene ${i+1} ready! ${duration.toFixed(1)}s`);
    }

    console.log('[VidForge] Building videos with synced captions...');
    const sceneVideos = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const imgPath   = path.join(tempDir, `image_${i}.png`);
      const audioPath = path.join(tempDir, `voice_${i}.mp3`);
      const sceneOut  = path.join(tempDir, `scene_${i}.mp4`);
      await buildSceneVideo(imgPath, audioPath, script.scenes[i].narration, sceneOut, sceneDurations[i], script.mood || selectedCategory);
      sceneVideos.push(sceneOut);
    }

    console.log('[VidForge] Stitching final video...');
    const videoPath = path.join(tempDir, 'final.mp4');
    await stitchFinalVideo(sceneVideos, tempDir, videoPath);

    const caption = `${script.title}\n\n${script.description}\n\n${script.hashtags}`;

    try {
      console.log('[VidForge] Uploading to YouTube...');
      const ytId = await uploadToYouTube(videoPath, script.title, script.description, script.hashtags, script.series);
      results.youtube = `https://youtube.com/watch?v=${ytId}`;
      console.log(`[VidForge] YouTube! ${results.youtube}`);
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

    console.log(`\n[VidForge] Done! ${dailyCount}/${DAILY_LIMIT} today\n`);
  } catch (err) {
    results.error = err.message;
    dailyCount--;
    console.error('[VidForge] Failed:', err.message);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
  }
  return results;
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ app: 'VidForge AI', version: '8.0.0', status: 'running' }));

app.get('/status', (req, res) => res.json({
  running: true, version: '8.0.0',
  schedule: 'Every 96 minutes (15/day)',
  dailyCount: `${dailyCount}/${DAILY_LIMIT}`,
  nextCategory: VIDEO_CATEGORIES[categoryIndex % VIDEO_CATEGORIES.length],
  nextStyle: ART_STYLES[artStyleIndex % ART_STYLES.length].split(',')[0],
  youtubeConnected: !!YOUTUBE_REFRESH_TOKEN,
  instagramConnected: !!INSTAGRAM_ACCESS_TOKEN,
  groqConnected: !!GROQ_API_KEY,
  elevenLabsConnected: !!ELEVENLABS_API_KEY,
  hfConnected: !!HF_API_KEY,
  features: ['Pollinations flux images', 'Whisper word-sync captions', 'ElevenLabs voice', 'Background music', '15 videos/day'],
  timestamp: new Date().toISOString()
}));

app.post('/generate', (req, res) => {
  const category = (req.body || {}).category;
  if (dailyCount >= DAILY_LIMIT) return res.json({ message: 'Daily limit reached!', dailyCount, DAILY_LIMIT });
  res.json({ message: 'Video started!', category: category || 'auto' });
  runPostingCycle(category);
});

app.post('/test-script', async (req, res) => {
  const cat = ((req.body || {}).category) || 'horror';
  const style = ART_STYLES[Math.floor(Math.random() * ART_STYLES.length)];
  try {
    const script = await generateVideoScript(cat, style);
    res.json({ success: true, category: cat, script });
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
  const tokens = (await oauth2Client.getToken(req.query.code)).tokens;
  res.json({ message: 'Save this!', refresh_token: tokens.refresh_token });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 VidForge AI v8.0 — Pollinations + Whisper Sync Captions`);
  console.log(`📊 Status: http://localhost:${PORT}/status`);
  console.log(`🎨 ${ART_STYLES.length} art styles | 📚 ${VIDEO_CATEGORIES.length} categories`);
  console.log(` Schedule: Every 96 mins = 15 videos/day\n`);
});

module.exports = app;
