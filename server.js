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
  'blue cartoon rabbit character, thick black outlines, flat 2D animation, expressive face, classic cartoon network style, no text',
  'cute blue cartoon animal, bold black outlines, retro cartoon style, bright colors, expressive emotions, no text',
  'anime style, Studio Ghibli inspired, detailed illustration, soft lighting, no text',
  'dark anime style, dramatic lighting, detailed manga art, cinematic shadows, no text',
  'comic book style, bold lines, vibrant colors, action poses, no text',
  'chibi anime style, cute characters, pastel colors, big eyes, no text',
  'watercolor cartoon style, soft colors, storybook illustration, no text',
  'pixar 3D cartoon style, colorful, expressive characters, cinematic lighting, no text'
];

// Hugging Face models — anime/cartoon focused
const HF_MODELS = [
  'Linaqruf/anything-v3.0',
  'stabilityai/stable-diffusion-xl-base-1.0',
  'runwayml/stable-diffusion-v1-5'
];

const CAPTION_STYLES = {
  horror:     { size: 58, color: 'red',    outline: 'black',  bg: '0.7' },
  thriller:   { size: 58, color: 'red',    outline: 'black',  bg: '0.7' },
  mystery:    { size: 56, color: 'white',  outline: 'purple', bg: '0.6' },
  fantasy:    { size: 56, color: 'yellow', outline: 'black',  bg: '0.5' },
  folklore:   { size: 56, color: 'yellow', outline: 'black',  bg: '0.5' },
  adventure:  { size: 60, color: 'white',  outline: 'black',  bg: '0.6' },
  superhero:  { size: 62, color: 'yellow', outline: 'black',  bg: '0.0' },
  motivation: { size: 60, color: 'white',  outline: 'black',  bg: '0.0' },
  mindset:    { size: 58, color: 'white',  outline: 'black',  bg: '0.0' },
  comedy:     { size: 62, color: 'yellow', outline: 'black',  bg: '0.5' },
  kids:       { size: 64, color: 'yellow', outline: 'black',  bg: '0.6' },
  romance:    { size: 54, color: 'white',  outline: 'black',  bg: '0.5' },
  default:    { size: 56, color: 'white',  outline: 'black',  bg: '0.5' }
};

// ElevenLabs voices — rotate for variety
const ELEVENLABS_VOICES = [
  '21m00Tcm4TlvDq8ikWAM', // Rachel — calm female
  'AZnzlk1XvdvUeBnXmlld', // Domi — strong female
  'EXAVITQu4vr4xnSDxMaL', // Bella — soft female
  'ErXwobaYiN019PkySvjV', // Antoni — male
  'MF3mGyEYCl7XYWbV9V6O', // Elli — young female
  'TxGEqnHWrfWFTfGW9XjX', // Josh — deep male
  'VR6AewLTigWG4xSOukaG', // Arnold — strong male
  'pNInz6obpgDQGcFmaJgB'  // Adam — neutral male
];

let categoryIndex  = 0;
let artStyleIndex  = 0;
let voiceIndex     = 0;
let hfModelIndex   = 0;
let dailyCount     = 0;
const DAILY_LIMIT  = 15;

cron.schedule('0 0 * * *', () => { dailyCount = 0; console.log('[VidForge] Daily count reset!'); });
cron.schedule('*/96 * * * *', () => {
  if (dailyCount < DAILY_LIMIT) runPostingCycle();
  else console.log('[Cron] Daily limit reached.');
});

// ─── STEP 1 — Generate Script ───────────────────────────────────────────────
async function generateVideoScript(category, artStyle) {
  const prompt = `Create an engaging ${category} cartoon story for a 30-second YouTube Short.

Have 4 scenes. Captions must match mood:
- horror/thriller = dramatic short lines like "No one believed her..."
- comedy = funny like "The robot had ONE job."
- motivation = powerful like "She fell 99 times."
- kids = fun like "The bunny had a plan!"
Max 7 words per caption. Cinematic and punchy.

Return ONLY this JSON, no markdown:
{
  "title": "Episode title under 60 chars",
  "series": "Series name",
  "episode": "Episode 1",
  "description": "2-3 sentence caption",
  "hashtags": "#cartoon #anime #shorts #story #viral #fyp #animation #${category}",
  "mood": "${category}",
  "scenes": [
    {
      "narration": "Opening narration 1-2 sentences",
      "caption": "Short punchy text MAX 7 words",
      "image_prompt": "${artStyle}, ${category} scene, describe what narration shows visually, vertical 9:16, high quality, no text in image"
    },
    {
      "narration": "Scene 2 narration",
      "caption": "Short punchy text MAX 7 words",
      "image_prompt": "${artStyle}, ${category} scene, describe scene 2 visually, vertical 9:16, high quality, no text in image"
    },
    {
      "narration": "Scene 3 narration",
      "caption": "Short punchy text MAX 7 words",
      "image_prompt": "${artStyle}, ${category} scene, describe scene 3 visually, vertical 9:16, high quality, no text in image"
    },
    {
      "narration": "Scene 4 powerful ending or cliffhanger",
      "caption": "Ending text MAX 7 words, makes viewer want more",
      "image_prompt": "${artStyle}, ${category} scene, describe scene 4 visually, vertical 9:16, high quality, no text in image"
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

// ─── STEP 2 — Generate Image via Hugging Face ────────────────────────────────
async function generateCartoonImage(prompt, outputPath) {
  const model = HF_MODELS[hfModelIndex % HF_MODELS.length];
  hfModelIndex++;

  console.log(`[Image] Using HF model: ${model}`);

  // Try Hugging Face first
  try {
    const response = await axios({
      method: 'POST',
      url: `https://api-inference.huggingface.co/models/${model}`,
      headers: {
        'Authorization': `Bearer ${HF_API_KEY}`,
        'Content-Type': 'application/json'
      },
      data: {
        inputs: prompt + ', vertical portrait 9:16, high quality, no text, no watermark',
        parameters: {
          width: 512,
          height: 896,
          num_inference_steps: 25,
          guidance_scale: 7.5
        }
      },
      responseType: 'arraybuffer',
      timeout: 120000
    });

    if (response.data && response.data.length > 5000) {
      fs.writeFileSync(outputPath, Buffer.from(response.data));
      console.log('[Image] HF image saved!');
      return;
    }
  } catch (err) {
    console.log(`[Image] HF failed: ${err.message} — trying Pollinations...`);
  }

  // Fallback: Pollinations
  try {
    const seed = Math.floor(Math.random() * 999999);
    const encoded = encodeURIComponent(prompt + ', no text, no watermark');
    const url = `https://image.pollinations.ai/prompt/${encoded}?width=576&height=1024&seed=${seed}&nologo=true&model=flux`;
    const response = await axios({ method: 'GET', url, responseType: 'arraybuffer', timeout: 60000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (response.data && response.data.length > 5000) {
      fs.writeFileSync(outputPath, Buffer.from(response.data));
      console.log('[Image] Pollinations fallback saved!');
      return;
    }
  } catch (err) {
    console.log(`[Image] Pollinations failed: ${err.message}`);
  }

  // Last resort: solid color placeholder
  console.log('[Image] Using placeholder image');
  await execPromise(`ffmpeg -f lavfi -i color=c=black:size=576x1024:duration=1 -vframes 1 "${outputPath}" -y`);
}

// ─── STEP 3 — Generate Voice via ElevenLabs (with Google TTS fallback) ───────
async function generateVoice(text, outputPath) {
  const cleanText = text.replace(/['"]/g, '').substring(0, 500);
  const voiceId = ELEVENLABS_VOICES[voiceIndex % ELEVENLABS_VOICES.length];
  voiceIndex++;

  // Try ElevenLabs first
  if (ELEVENLABS_API_KEY) {
    try {
      const response = await axios({
        method: 'POST',
        url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg'
        },
        data: {
          text: cleanText,
          model_id: 'eleven_monolingual_v1',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 }
        },
        responseType: 'arraybuffer',
        timeout: 30000
      });
      fs.writeFileSync(outputPath, Buffer.from(response.data));
      console.log(`[Voice] ElevenLabs saved: ${path.basename(outputPath)}`);
      return;
    } catch (err) {
      console.log(`[Voice] ElevenLabs failed: ${err.message} — using Google TTS fallback`);
    }
  }

  // Fallback: Google TTS
  const shortText = cleanText.substring(0, 200);
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(shortText)}&tl=en&client=tw-ob&ttsspeed=0.9`;
  const response = await axios({ method: 'GET', url, responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } });
  fs.writeFileSync(outputPath, Buffer.from(response.data));
  console.log(`[Voice] Google TTS fallback saved: ${path.basename(outputPath)}`);
}

// ─── STEP 4 — Build Scene Video with Karaoke Captions ────────────────────────
async function buildSceneVideo(imgPath, audioPath, caption, outputPath, duration, category) {
  const style = CAPTION_STYLES[category] || CAPTION_STYLES['default'];
  const cleanCaption = caption.replace(/['":\\]/g, '').replace(/\./g, '').substring(0, 60).toUpperCase();

  const captionStart = 0.3;
  const captionEnd = Math.max(duration - 0.3, captionStart + 1.0);
  const yPos = '(h/2-text_h/2)-60';
  const words = cleanCaption.split(' ');
  const wordDuration = (captionEnd - captionStart) / Math.max(words.length, 1);

  let drawFilters = '';

  if (words.length <= 3) {
    drawFilters = `drawtext=text='${cleanCaption}':fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:fontsize=${style.size}:fontcolor=${style.color}:x=(w-text_w)/2:y=${yPos}:borderw=5:bordercolor=${style.outline}:box=1:boxcolor=black@${style.bg}:boxborderw=18:enable='between(t,${captionStart},${captionEnd})'`;
  } else {
    const wordFilters = [];
    let accumulated = '';
    words.forEach((word, i) => {
      accumulated = words.slice(0, i + 1).join(' ');
      const wStart = (captionStart + i * wordDuration).toFixed(2);
      const wEnd = captionEnd.toFixed(2);
      wordFilters.push(`drawtext=text='${accumulated}':fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:fontsize=${style.size}:fontcolor=${style.color}:x=(w-text_w)/2:y=${yPos}:borderw=5:bordercolor=${style.outline}:box=1:boxcolor=black@${style.bg}:boxborderw=18:enable='between(t,${wStart},${wEnd})'`);
    });
    drawFilters = wordFilters.join(',');
  }

  const fadeOut = Math.max(duration - 0.2, 0);
  const vf = `scale=576:1024:force_original_aspect_ratio=decrease,pad=576:1024:(ow-iw)/2:(oh-ih)/2:black,${drawFilters},fade=t=in:st=0:d=0.2,fade=t=out:st=${fadeOut}:d=0.2`;
  const cmd = `ffmpeg -loop 1 -i "${imgPath}" -i "${audioPath}" -c:v libx264 -tune stillimage -c:a aac -b:a 192k -pix_fmt yuv420p -t ${duration} -vf "${vf}" -y "${outputPath}"`;

  await execPromise(cmd);
  console.log(`[FFmpeg] Scene done: ${path.basename(outputPath)} | Caption: "${cleanCaption}"`);
}

// ─── STEP 5 — Stitch Final Video + Background Music ──────────────────────────
async function stitchFinalVideo(sceneVideos, tempDir, outputPath) {
  const concatFile = path.join(tempDir, 'concat.txt');
  fs.writeFileSync(concatFile, sceneVideos.map(v => `file '${v}'`).join('\n'));
  const tempConcat = path.join(tempDir, 'concat_raw.mp4');
  await execPromise(`ffmpeg -f concat -safe 0 -i "${concatFile}" -c copy -y "${tempConcat}"`);

  const musicPath = path.join(tempDir, 'music.mp3');
  let hasMusicFile = false;
  try {
    const musicUrls = [
      'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
      'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
      'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3'
    ];
    const musicUrl = musicUrls[Math.floor(Math.random() * musicUrls.length)];
    const musicResponse = await axios.get(musicUrl, { responseType: 'arraybuffer', timeout: 15000 });
    fs.writeFileSync(musicPath, Buffer.from(musicResponse.data));
    hasMusicFile = true;
    console.log('[Music] Downloaded!');
  } catch (e) { console.log('[Music] Skipping background music'); }

  if (hasMusicFile) {
    const { stdout } = await execPromise(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${tempConcat}"`);
    const totalDur = parseFloat(stdout.trim());
    await execPromise(`ffmpeg -i "${tempConcat}" -i "${musicPath}" -filter_complex "[0:a]volume=1.0[voice];[1:a]volume=0.10,atrim=0:${totalDur}[bgm];[voice][bgm]amix=inputs=2:duration=first[aout]" -map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 192k -y "${outputPath}"`);
  } else {
    fs.copyFileSync(tempConcat, outputPath);
  }
  console.log('[FFmpeg] Final video ready!');
}

// ─── STEP 6 — Upload to YouTube ──────────────────────────────────────────────
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

// ─── STEP 7 — Post to Instagram ──────────────────────────────────────────────
async function postToInstagram(videoUrl, caption) {
  const containerResponse = await axios.post(
    `https://graph.facebook.com/v18.0/${INSTAGRAM_USER_ID}/media`,
    { media_type: 'REELS', video_url: videoUrl, caption: caption, share_to_feed: true, access_token: INSTAGRAM_ACCESS_TOKEN }
  );
  const containerId = containerResponse.data.id;
  await new Promise(r => setTimeout(r, 45000));
  const publishResponse = await axios.post(
    `https://graph.facebook.com/v18.0/${INSTAGRAM_USER_ID}/media_publish`,
    { creation_id: containerId, access_token: INSTAGRAM_ACCESS_TOKEN }
  );
  return publishResponse.data.id;
}

// ─── MAIN PIPELINE ───────────────────────────────────────────────────────────
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
    console.log(`[VidForge] Story: "${script.title}" | Series: ${script.series}`);

    const sceneDurations = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const scene = script.scenes[i];
      console.log(`[VidForge] Scene ${i+1}/4 | Caption: "${scene.caption}"`);
      const imgPath   = path.join(tempDir, `image_${i}.png`);
      const audioPath = path.join(tempDir, `voice_${i}.mp3`);
      await generateCartoonImage(scene.image_prompt, imgPath);
      await generateVoice(scene.narration, audioPath);
      let duration = 5;
      try {
        const result = await execPromise(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`);
        duration = Math.max(parseFloat(result.stdout.trim()) + 0.5, 3);
      } catch (e) {}
      sceneDurations.push(duration);
      console.log(`[VidForge] Scene ${i+1} ready! Duration: ${duration.toFixed(1)}s`);
    }

    console.log('[VidForge] Building scene videos with karaoke captions...');
    const sceneVideos = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const imgPath   = path.join(tempDir, `image_${i}.png`);
      const audioPath = path.join(tempDir, `voice_${i}.mp3`);
      const sceneOut  = path.join(tempDir, `scene_${i}.mp4`);
      await buildSceneVideo(imgPath, audioPath, script.scenes[i].caption, sceneOut, sceneDurations[i], script.mood || selectedCategory);
      sceneVideos.push(sceneOut);
    }

    console.log('[VidForge] Stitching final video...');
    const videoPath = path.join(tempDir, 'final.mp4');
    await stitchFinalVideo(sceneVideos, tempDir, videoPath);

    const caption = `${script.title} | ${script.series}\n\n${script.description}\n\n${script.hashtags}`;

    try {
      console.log('[VidForge] Uploading to YouTube...');
      const ytId = await uploadToYouTube(videoPath, script.title, script.description, script.hashtags, script.series);
      results.youtube = `https://youtube.com/watch?v=${ytId}`;
      console.log(`[VidForge] YouTube done! ${results.youtube}`);
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
app.get('/', (req, res) => {
  res.json({ app: 'VidForge AI', status: 'running', version: '7.0.0', description: 'HF Images + ElevenLabs Voice + Karaoke Captions' });
});

app.get('/status', (req, res) => {
  res.json({
    running: true,
    version: '7.0.0',
    schedule: 'Every 96 minutes (15 videos/day)',
    dailyCount: `${dailyCount}/${DAILY_LIMIT}`,
    nextCategory: VIDEO_CATEGORIES[categoryIndex % VIDEO_CATEGORIES.length],
    nextStyle: ART_STYLES[artStyleIndex % ART_STYLES.length].split(',')[0],
    nextHFModel: HF_MODELS[hfModelIndex % HF_MODELS.length],
    youtubeConnected: !!YOUTUBE_REFRESH_TOKEN,
    instagramConnected: !!INSTAGRAM_ACCESS_TOKEN,
    groqConnected: !!GROQ_API_KEY,
    elevenLabsConnected: !!ELEVENLABS_API_KEY,
    hfConnected: !!HF_API_KEY,
    features: ['HF cartoon images', 'ElevenLabs human voice', 'Google TTS fallback', 'Karaoke word-by-word captions', 'Mood-matched colors', 'Background music'],
    timestamp: new Date().toISOString()
  });
});

app.post('/generate', (req, res) => {
  const category = (req.body || {}).category;
  if (dailyCount >= DAILY_LIMIT) return res.json({ message: 'Daily limit reached!', dailyCount, DAILY_LIMIT });
  res.json({ message: '🎬 Cartoon episode started!', category: category || 'auto' });
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
  res.json({ message: 'Save this refresh token!', refresh_token: tokens.refresh_token });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n🚀 VidForge AI v7.0 — HF Images + ElevenLabs Voice + Karaoke Captions');
  console.log(`📊 Status: http://localhost:${PORT}/status`);
  console.log(`🎨 Styles: ${ART_STYLES.length} art styles rotating`);
  console.log(`📚 Categories: ${VIDEO_CATEGORIES.length} story categories`);
  console.log(`🤖 HF Models: ${HF_MODELS.length} models rotating`);
  console.log(`🎙️ Voices: ${ELEVENLABS_VOICES.length} ElevenLabs voices rotating`);
  console.log(` Schedule: Every 96 minutes = 15 videos/day\n`);
});

module.exports = app;
