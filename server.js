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
  'horror', 'adventure', 'mystery', 'motivation',
  'fantasy', 'thriller', 'comedy', 'kids',
  'romance', 'science fiction', 'historical', 'nature',
  'life lesson', 'mindset', 'folklore', 'superhero'
];

// Art styles — blue cartoon character style + others
const ART_STYLES = [
  'blue cartoon rabbit character, thick black outlines, flat 2D animation style, expressive face, white background, similar to classic cartoon network style',
  'cute blue cartoon animal character, bold black outlines, retro cartoon style, bright colors, expressive emotions, 2D flat design',
  'anime style, Studio Ghibli inspired, detailed illustration, soft lighting, painterly',
  'dark anime style, dramatic lighting, detailed manga art, cinematic shadows',
  'comic book style, bold lines, vibrant colors, action poses, halftone dots',
  'chibi anime style, cute characters, pastel colors, big eyes, soft shading',
  'watercolor cartoon style, soft colors, storybook illustration, gentle textures',
  'pixar 3D cartoon style, colorful, expressive characters, cinematic lighting'
];

// Caption styles per category vibe
const CAPTION_STYLES = {
  horror:   { font: 'DejaVuSans-Bold', size: 58, color: 'red',    outline: 'black',  bg: '0.7', position: 'center' },
  thriller: { font: 'DejaVuSans-Bold', size: 58, color: 'red',    outline: 'black',  bg: '0.7', position: 'center' },
  mystery:  { font: 'DejaVuSans-Bold', size: 56, color: 'white',  outline: 'purple', bg: '0.6', position: 'center' },
  fantasy:  { font: 'DejaVuSans-Bold', size: 56, color: 'yellow', outline: 'black',  bg: '0.5', position: 'center' },
  folklore: { font: 'DejaVuSans-Bold', size: 56, color: 'yellow', outline: 'black',  bg: '0.5', position: 'center' },
  adventure:{ font: 'DejaVuSans-Bold', size: 60, color: 'white',  outline: 'black',  bg: '0.6', position: 'center' },
  superhero:{ font: 'DejaVuSans-Bold', size: 62, color: 'yellow', outline: 'black',  bg: '0.0', position: 'center' },
  motivation:{ font: 'DejaVuSans-Bold',size: 60, color: 'white',  outline: 'black',  bg: '0.0', position: 'center' },
  mindset:  { font: 'DejaVuSans-Bold', size: 58, color: 'white',  outline: 'black',  bg: '0.0', position: 'center' },
  comedy:   { font: 'DejaVuSans-Bold', size: 62, color: 'yellow', outline: 'black',  bg: '0.5', position: 'center' },
  kids:     { font: 'DejaVuSans-Bold', size: 64, color: 'yellow', outline: 'black',  bg: '0.6', position: 'center' },
  romance:  { font: 'DejaVuSans-Bold', size: 54, color: 'white',  outline: 'black',  bg: '0.5', position: 'center' },
  default:  { font: 'DejaVuSans-Bold', size: 56, color: 'white',  outline: 'black',  bg: '0.5', position: 'center' },
};

let categoryIndex = 0;
let artStyleIndex = 0;
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
// STEP 1 — GROQ: Generate Story + Scenes
// ─────────────────────────────────────────────
async function generateVideoScript(category, artStyle) {
  const prompt = `Create an engaging ${category} cartoon story for a 30-second Instagram Reel/YouTube Short.

The story should have 4 scenes. Each scene image MUST visually match the narration exactly.
Captions must PERFECTLY match the mood:
- horror/thriller = short dramatic lines like "No one believed her..." or "Then it moved."
- comedy = funny punchlines like "The robot had ONE job." 
- motivation = powerful lines like "She fell 99 times." or "100th try. She flew."
- kids = fun lines like "The bunny had a plan!" 
- mystery = suspense lines like "The door was locked... from inside."
Keep captions MAX 7 words. Make them feel cinematic and punchy.

Return ONLY this JSON, no markdown, no extra text:
{
  "title": "Episode title under 60 chars",
  "series": "Series name (e.g. Dark Tales, Adventure Time, Mystery Files)",
  "episode": "Episode 1",
  "description": "2-3 sentence caption",
  "hashtags": "#cartoon #anime #shorts #story #viral #fyp #animation #tales #${category} #episode",
  "mood": "${category}",
  "scenes": [
    {
      "narration": "Opening narration 1-2 sentences that sets the scene",
      "caption": "Short punchy text MAX 7 words matching the mood",
      "image_prompt": "${artStyle}, ${category} scene, [describe EXACTLY what narration says visually], vertical 9:16, high quality, detailed, no text in image"
    },
    {
      "narration": "Scene 2 narration continuing the story",
      "caption": "Short punchy text MAX 7 words matching the mood",
      "image_prompt": "${artStyle}, ${category} scene, [describe EXACTLY what narration says visually], vertical 9:16, high quality, detailed, no text in image"
    },
    {
      "narration": "Scene 3 narration building tension or action",
      "caption": "Short punchy text MAX 7 words matching the mood",
      "image_prompt": "${artStyle}, ${category} scene, [describe EXACTLY what narration says visually], vertical 9:16, high quality, detailed, no text in image"
    },
    {
      "narration": "Scene 4 narration with a powerful ending or cliffhanger",
      "caption": "Ending text MAX 7 words that makes viewer want more",
      "image_prompt": "${artStyle}, ${category} scene, [describe EXACTLY what narration says visually], vertical 9:16, high quality, detailed, no text in image"
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
// STEP 2 — POLLINATIONS: Cartoon Image (FREE)
// ─────────────────────────────────────────────
async function generateCartoonImage(prompt, outputPath) {
  const seed = Math.floor(Math.random() * 999999);
  const fullPrompt = encodeURIComponent(prompt + ', no text, no watermark, no captions, high quality');
  
  const urls = [
    `https://image.pollinations.ai/prompt/${fullPrompt}?width=768&height=1344&seed=${seed}&nologo=true&model=flux`,
    `https://image.pollinations.ai/prompt/${fullPrompt}?width=768&height=1344&seed=${seed}&nologo=true`,
    `https://picsum.photos/seed/${seed}/768/1344`
  ];

  for (const url of urls) {
    try {
      const response = await axios({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        timeout: 60000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36' }
      });
      if (response.data && response.data.length > 5000) {
        fs.writeFileSync(outputPath, Buffer.from(response.data));
        console.log(`[Image] Saved from ${url.includes('pollinations') ? 'Pollinations' : 'Picsum'}`);
        return;
      }
    } catch (err) {
      console.log(`[Image] Failed: ${err.message} — trying next...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error('All image sources failed');
}

// ─────────────────────────────────────────────
// STEP 3 — GOOGLE TTS: Voice Generation
// ─────────────────────────────────────────────
async function generateVoice(text, outputPath) {
  const cleanText = text.replace(/['"]/g, '').substring(0, 200);
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(cleanText)}&tl=en&client=tw-ob&ttsspeed=0.9`;
  
  const response = await axios({
    method: 'GET',
    url,
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36' }
  });

  fs.writeFileSync(outputPath, Buffer.from(response.data));
  console.log(`[Voice] Saved: ${outputPath}`);
}

// ─────────────────────────────────────────────
// STEP 4 — FFMPEG: Build Scene Video
// Caption is CENTER of screen, synced to voice duration
// Style changes based on video mood/category
// ─────────────────────────────────────────────
async function buildSceneVideo(imgPath, audioPath, caption, outputPath, duration, category) {
  // Clean caption for FFmpeg (remove special chars)
  const cleanCaption = caption
    .replace(/['":\\]/g, '')
    .replace(/\./g, '')
    .substring(0, 60)
    .toUpperCase(); // All caps looks more cinematic

  // Get caption style based on category mood
  const style = CAPTION_STYLES[category] || CAPTION_STYLES['default'];

  // Calculate caption timing:
  // - Caption appears 0.3s after scene starts (after voice begins)
  // - Caption disappears 0.3s before scene ends
  const captionStart = 0.3;
  const captionEnd = Math.max(duration - 0.3, captionStart + 1.0);
  const captionDuration = captionEnd - captionStart;

  // Caption position: CENTER of screen (y=h/2 - text_h/2)
  // With slight offset upward to look better visually
  const yPosition = `(h/2-text_h/2)-60`;

  // Word-by-word caption reveal timing
  // Split caption into words and show them progressively
  const words = cleanCaption.split(' ');
  const wordDuration = captionDuration / Math.max(words.length, 1);

  // Build word-by-word drawtext filters for karaoke effect
  let drawtextFilters = '';
  
  if (words.length <= 3) {
    // Show all at once for short captions
    drawtextFilters = `drawtext=text='${cleanCaption}':` +
      `fontfile=/usr/share/fonts/truetype/dejavu/${style.font}.ttf:` +
      `fontsize=${style.size}:` +
      `fontcolor=${style.color}:` +
      `x=(w-text_w)/2:y=${yPosition}:` +
      `borderw=5:bordercolor=${style.outline}:` +
      `box=1:boxcolor=black@${style.bg}:boxborderw=18:` +
      `enable='between(t,${captionStart},${captionEnd})',` +
      // Fade in effect
      `drawtext=text='${cleanCaption}':` +
      `fontfile=/usr/share/fonts/truetype/dejavu/${style.font}.ttf:` +
      `fontsize=${style.size}:` +
      `fontcolor=${style.color}@0.0:` +
      `x=(w-text_w)/2:y=${yPosition}:` +
      `enable='lt(t,${captionStart})'`;
  } else {
    // Show word by word for longer captions (karaoke style)
    let accumulated = '';
    const wordFilters = [];
    
    words.forEach((word, i) => {
      accumulated = words.slice(0, i + 1).join(' ');
      const wStart = captionStart + (i * wordDuration);
      const wEnd = captionEnd;
      
      wordFilters.push(
        `drawtext=text='${accumulated}':` +
        `fontfile=/usr/share/fonts/truetype/dejavu/${style.font}.ttf:` +
        `fontsize=${style.size}:` +
        `fontcolor=${style.color}:` +
        `x=(w-text_w)/2:y=${yPosition}:` +
        `borderw=5:bordercolor=${style.outline}:` +
        `box=1:boxcolor=black@${style.bg}:boxborderw=18:` +
        `enable='between(t,${wStart.toFixed(2)},${wEnd.toFixed(2)})'`
      );
    });
    
    drawtextFilters = wordFilters.join(',');
  }

  // Full FFmpeg command
  // - Image as background (loop for duration of audio)
  // - Caption in CENTER with mood-matching style
  // - Voice audio synced perfectly
  // - Fade in/out on video
  const ffmpegCmd = `ffmpeg -loop 1 -i "${imgPath}" -i "${audioPath}" \
    -c:v libx264 -tune stillimage -c:a aac -b:a 192k \
    -pix_fmt yuv420p -t ${duration} \
    -vf "scale=768:1344:force_original_aspect_ratio=decrease,\
pad=768:1344:(ow-iw)/2:(oh-ih)/2:black,\
${drawtextFilters},\
fade=t=in:st=0:d=0.2,fade=t=out:st=${Math.max(duration - 0.2, 0)}:d=0.2" \
    -y "${outputPath}"`;

  await execPromise(ffmpegCmd);
  console.log(`[FFmpeg] Scene done: ${path.basename(outputPath)} | Caption: "${cleanCaption}" | Style: ${category}`);
}

// ─────────────────────────────────────────────
// STEP 5 — FFMPEG: Stitch + Background Music
// ─────────────────────────────────────────────
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
      'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3'
    ];
    const musicUrl = musicUrls[Math.floor(Math.random() * musicUrls.length)];
    const musicResponse = await axios.get(musicUrl, { responseType: 'arraybuffer', timeout: 15000 });
    fs.writeFileSync(musicPath, Buffer.from(musicResponse.data));
    hasMusicFile = true;
    console.log('[Music] Background music downloaded!');
  } catch (e) {
    console.log('[Music] No music available, continuing without');
  }

  if (hasMusicFile) {
    await execPromise(
      `ffmpeg -i "${tempConcat}" -i "${musicPath}" \
      -filter_complex "[0:a]volume=1.0[voice];[1:a]volume=0.12,atrim=0:$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${tempConcat}")[bgm];[voice][bgm]amix=inputs=2:duration=first[aout]" \
      -map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 192k -y "${outputPath}"`
    );
  } else {
    fs.copyFileSync(tempConcat, outputPath);
  }

  console.log(`[FFmpeg] Final video ready: ${outputPath}`);
}

// ─────────────────────────────────────────────
// STEP 6 — YOUTUBE: Upload
// ─────────────────────────────────────────────
async function uploadToYouTube(videoPath, title, description, hashtags, series) {
  const oauth2Client = new google.auth.OAuth2(
    YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI
  );
  oauth2Client.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  const uploadResponse = await youtube.videos.insert({
    part: 'snippet,status',
    requestBody: {
      snippet: {
        title: `${title} | ${series}`.substring(0, 100),
        description: `${description}\n\n${hashtags}\n\n#${series.replace(/ /g, '')}`,
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

// ─────────────────────────────────────────────
// STEP 7 — INSTAGRAM: Post Reel
// ─────────────────────────────────────────────
async function postToInstagram(videoUrl, caption) {
  const containerResponse = await axios.post(
    `https://graph.facebook.com/v18.0/${INSTAGRAM_USER_ID}/media`,
    {
      media_type: 'REELS',
      video_url: videoUrl,
      caption,
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
  const selectedStyle = ART_STYLES[artStyleIndex % ART_STYLES.length];
  categoryIndex++;
  artStyleIndex++;
  dailyCount++;

  console.log(`\n🎬 [VidForge] Category: ${selectedCategory} | Style: ${selectedStyle.split(',')[0]}`);
  console.log(`📊 Daily: ${dailyCount}/${DAILY_LIMIT}`);
  
  const results = { category: selectedCategory, youtube: null, instagram: null, error: null };
  const tempDir = path.join('/tmp', `vidforge_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // 1. Generate story with mood-matched captions
    console.log('[VidForge] Writing story with mood captions...');
    const script = await generateVideoScript(selectedCategory, selectedStyle);
    console.log(`[VidForge] Story: "${script.title}" | Series: ${script.series}`);
    console.log(`[VidForge] Mood: ${script.mood || selectedCategory}`);

    // 2. Generate all scenes (images + voice in parallel)
    const sceneDurations = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const scene = script.scenes[i];
      console.log(`[VidForge] Generating scene ${i + 1}/4 | Caption: "${scene.caption}"`);

      const imgPath   = path.join(tempDir, `image_${i}.png`);
      const audioPath = path.join(tempDir, `voice_${i}.mp3`);

      await Promise.all([
        generateCartoonImage(scene.image_prompt, imgPath),
        generateVoice(scene.narration, audioPath)
      ]);

      // Get exact audio duration for perfect sync
      let duration = 5;
      try {
        const { stdout } = await execPromise(
          `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
        );
        duration = Math.max(parseFloat(stdout.trim()) + 0.5, 3);
      } catch (e) {}
      sceneDurations.push(duration);

      console.log(`[VidForge] Scene ${i + 1} ready! Duration: ${duration.toFixed(1)}s`);
    }

    // 3. Build scene videos with CENTER captions synced to voice
    console.log('[VidForge] Building scenes with center captions synced to voice...');
    const sceneVideos = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const imgPath   = path.join(tempDir, `image_${i}.png`);
      const audioPath = path.join(tempDir, `voice_${i}.mp3`);
      const sceneOut  = path.join(tempDir, `scene_${i}.mp4`);
      
      await buildSceneVideo(
        imgPath,
        audioPath,
        script.scenes[i].caption,
        sceneOut,
        sceneDurations[i],
        script.mood || selectedCategory  // Pass mood for caption styling
      );
      sceneVideos.push(sceneOut);
    }

    // 4. Stitch with background music
    console.log('[VidForge] Stitching final video with music...');
    const videoPath = path.join(tempDir, 'final.mp4');
    await stitchFinalVideo(sceneVideos, tempDir, videoPath);

    const caption = `${script.title} | ${script.series}\n\n${script.description}\n\n${script.hashtags}`;

    // 5. Upload YouTube
    try {
      console.log('[VidForge] Uploading to YouTube...');
      const ytId = await uploadToYouTube(videoPath, scrip
