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
const MODELSLAB_API_KEY      = process.env.MODELSLAB_API_KEY;

// ─────────────────────────────────────────────
// CONFIG — CATEGORIES & ART STYLES
// ─────────────────────────────────────────────
const VIDEO_CATEGORIES = [
  'horror', 'adventure', 'mystery', 'motivation',
  'fantasy', 'thriller', 'comedy', 'kids',
  'romance', 'science fiction', 'historical', 'nature',
  'life lesson', 'mindset', 'folklore', 'superhero'
];

// Cartoon styles — sent to ModelsLab / fallback generators
const ART_STYLES = [
  'cute cartoon character, expressive face, bold outlines, flat colors, chibi style',
  'anime character, big eyes, colorful hair, detailed expression, manga style, vibrant colors',
  'comic book hero, bold lines, dynamic pose, bright colors, superhero style',
  'cute animal character, cartoon style, expressive emotions, colorful, fun illustration',
  'dark anime style, dramatic character, glowing eyes, detailed, cinematic lighting',
  'pixar 3d cartoon style, cute character, expressive, colorful background, detailed',
  'storybook illustration, watercolor style, cute characters, soft pastel colors',
  'retro cartoon style, bold black outlines, limited colors, expressive characters'
];

// ─────────────────────────────────────────────
// CONFIG — CAPTION STYLES (rotates every video)
// Inspired by CapCut-style caption presets:
// Bold Stroke, Red Highlight, Sleek, Karaoke, Majestic, Beast, Pixel, Clarity
// ─────────────────────────────────────────────
const FONT_BOLD   = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_OBLIQUE = '/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf';
const FONT_MONO   = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf';

const CAPTION_STYLES = [
  {
    name: 'Bold Stroke',
    fontfile: FONT_BOLD, fontsize: 74, fontcolor: 'white',
    borderw: 7, bordercolor: 'black@0.95', box: false, position: 'center'
  },
  {
    name: 'Red Highlight',
    fontfile: FONT_BOLD, fontsize: 68, fontcolor: 'white',
    borderw: 3, bordercolor: 'black@0.8',
    box: true, boxcolor: '0xE6194B@0.85', boxborderw: 18, position: 'center'
  },
  {
    name: 'Sleek',
    fontfile: FONT_BOLD, fontsize: 52, fontcolor: 'white',
    borderw: 1, bordercolor: 'black@0.5',
    box: true, boxcolor: 'black@0.35', boxborderw: 16, position: 'lower'
  },
  {
    name: 'Karaoke',
    fontfile: FONT_BOLD, fontsize: 64, fontcolor: 'white',
    borderw: 2, bordercolor: 'black@0.7',
    box: true, boxcolor: '0x7C3AED@0.85', boxborderw: 18, position: 'center'
  },
  {
    name: 'Majestic',
    fontfile: FONT_OBLIQUE, fontsize: 60, fontcolor: '0xFFE9B0',
    borderw: 4, bordercolor: 'black@0.85', box: false, position: 'center'
  },
  {
    name: 'Beast',
    fontfile: FONT_BOLD, fontsize: 90, fontcolor: 'white',
    borderw: 9, bordercolor: 'black', box: false, position: 'center'
  },
  {
    name: 'Pixel',
    fontfile: FONT_MONO, fontsize: 46, fontcolor: '0x39FF88',
    borderw: 2, bordercolor: 'black@0.8',
    box: true, boxcolor: 'black@0.6', boxborderw: 12, position: 'lower'
  },
  {
    name: 'Clarity',
    fontfile: FONT_BOLD, fontsize: 56, fontcolor: 'white',
    borderw: 2, bordercolor: 'black@0.5', box: false, position: 'lower'
  }
];

// ─────────────────────────────────────────────
// CONFIG — THEME-BASED BACKGROUND MUSIC
// Maps each category to a mood-matched pool of tracks
// ─────────────────────────────────────────────
const THEME_MUSIC = {
  'horror':          [9, 14, 16],
  'mystery':         [9, 14, 6],
  'thriller':        [16, 9, 14],
  'adventure':       [1, 5, 8],
  'fantasy':         [2, 5, 11],
  'motivation':      [3, 7, 10],
  'comedy':          [4, 12, 13],
  'kids':            [4, 12, 13],
  'romance':         [2, 11, 15],
  'science fiction': [9, 16, 6],
  'historical':      [5, 8, 11],
  'nature':          [1, 10, 15],
  'life lesson':     [3, 7, 10],
  'mindset':         [3, 7, 10],
  'folklore':        [5, 11, 2],
  'superhero':       [16, 9, 4]
};

function getThemeMusicUrl(category) {
  const pool = THEME_MUSIC[category] || [1, 2, 3];
  const track = pool[Math.floor(Math.random() * pool.length)];
  return `https://www.soundhelix.com/examples/mp3/SoundHelix-Song-${track}.mp3`;
}

let categoryIndex = 0;
let artStyleIndex = 0;
let captionStyleIndex = 0;
let dailyCount = 0;
const DAILY_LIMIT = 15;

cron.schedule('0 0 * * *', () => {
  dailyCount = 0;
  console.log('[VidForge] Daily count reset!');
});

cron.schedule('*/96 * * * *', () => {
  if (dailyCount < DAILY_LIMIT) {
    console.log(`[Cron] Triggered! Daily: ${dailyCount}/${DAILY_LIMIT}`);
    runPostingCycle();
  } else {
    console.log(`[Cron] Daily limit reached.`);
  }
});

// ─────────────────────────────────────────────
// STEP 1 — GROQ: Story + Character + Scene Matching
// ─────────────────────────────────────────────
async function generateVideoScript(category, artStyle) {
  const prompt = `Create a viral ${category} cartoon story for Instagram Reels/YouTube Shorts.

Rules:
- First, design ONE main character that will appear in EVERY scene (same character, same outfit/colors, only emotion/pose changes)
- Each scene narration MUST match its image visually
- Captions must be SHORT and PUNCHY (max 6 words, ALL CAPS)
- Story must have a hook, build up, climax, and twist/ending
- Make it emotional and shareable

Return ONLY this JSON, no markdown:
{
  "title": "Catchy episode title under 55 chars",
  "series": "Cool series name (e.g. Dark Tales, Shadow Files)",
  "description": "Engaging 2 sentence caption with emojis",
  "hashtags": "#cartoon #anime #shorts #viral #story #fyp #animation #episode #${category.replace(/ /g,'')} #trending",
  "character_design": "Detailed visual description of the MAIN CHARACTER ONLY — species/look, color palette, outfit, distinguishing features. This exact description will be reused in every scene to keep the character consistent.",
  "scenes": [
    {
      "narration": "Hook opening that grabs attention immediately, 1-2 sentences",
      "caption": "HOOK CAPTION HERE",
      "emotion": "the character's emotion/pose/action in this scene only, e.g. 'shocked, pointing at something off-screen, dark forest background'"
    },
    {
      "narration": "Build up scene that creates tension or curiosity, 1-2 sentences",
      "caption": "BUILD UP CAPTION",
      "emotion": "the character's emotion/pose/action in this scene only"
    },
    {
      "narration": "Climax scene with the most dramatic moment, 1-2 sentences",
      "caption": "CLIMAX CAPTION HERE",
      "emotion": "the character's emotion/pose/action in this scene only"
    },
    {
      "narration": "Powerful ending with twist or moral that makes viewers want more, 1-2 sentences",
      "caption": "ENDING CAPTION HERE",
      "emotion": "the character's emotion/pose/action in this scene only"
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
  const script = JSON.parse(clean);

  // Build the final image_prompt for each scene:
  // SAME character_design + artStyle in every scene + scene-specific emotion/action
  script.scenes = script.scenes.map(scene => ({
    ...scene,
    image_prompt: `${artStyle}, ${script.character_design}, ${scene.emotion}, vertical composition, 9:16, vibrant colors, detailed, no text, no watermark`
  }));

  return script;
}

// ─────────────────────────────────────────────
// STEP 2 — IMAGE: Cartoon Scene (ModelsLab + fallbacks)
// Same seed is reused for every scene of an episode so the
// character stays visually consistent across the whole video.
// ─────────────────────────────────────────────
async function generateCartoonImage(prompt, outputPath, seed) {
  // ── Primary: ModelsLab text2img ──────────────────────
  if (MODELSLAB_API_KEY) {
    try {
      const response = await axios.post(
        'https://modelslab.com/api/v6/realtime/text2img',
        {
          key: MODELSLAB_API_KEY,
          prompt: `${prompt}, high quality, sharp focus`,
          negative_prompt: 'blurry, low quality, watermark, text, signature, deformed, extra limbs, ugly',
          width: 768,
          height: 1344,
          samples: 1,
          seed: seed,
          safety_checker: false,
          base64: false
        },
        { timeout: 90000 }
      );

      let imgUrl = await resolveModelsLabImage(response.data);

      if (imgUrl) {
        const imgRes = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 60000 });
        fs.writeFileSync(outputPath, Buffer.from(imgRes.data));
        console.log('[Image] ModelsLab 🎨✅');
        return;
      }
      console.log('[Image] ModelsLab returned no image, falling back...');
    } catch (err) {
      console.log('[Image] ModelsLab failed:', err.message, '- falling back');
    }
  }

  // ── Fallback: Pollinations / Picsum ──────────────────
  const fullPrompt = encodeURIComponent(prompt);
  const urls = [
    `https://image.pollinations.ai/prompt/${fullPrompt}?width=768&height=1344&seed=${seed}&nologo=true&model=flux`,
    `https://image.pollinations.ai/prompt/${fullPrompt}?width=768&height=1344&seed=${seed}&nologo=true`,
    `https://picsum.photos/seed/${seed}/768/1344`
  ];

  for (const url of urls) {
    try {
      const response = await axios({
        method: 'GET', url,
        responseType: 'arraybuffer',
        timeout: 60000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/91.0' }
      });
      if (response.data && response.data.length > 5000) {
        fs.writeFileSync(outputPath, Buffer.from(response.data));
        const src = url.includes('pollinations') ? 'Pollinations🎨' : 'Picsum📸';
        console.log(`[Image] ${src} saved (fallback)!`);
        return;
      }
    } catch (err) {
      console.log(`[Image] Trying next source...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error('All image sources failed');
}

// Resolves a ModelsLab response into a downloadable image URL.
// Handles: instant "output" array, "proxy_links", and async "processing" jobs.
async function resolveModelsLabImage(data) {
  if (data.output && data.output.length > 0) {
    const out = data.output[0];
    return out.startsWith('http') ? out : null; // base64 handled separately if needed
  }
  if (data.proxy_links && data.proxy_links.length > 0) {
    return data.proxy_links[0];
  }
  if (data.status === 'processing' && data.fetch_result) {
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const poll = await axios.post(data.fetch_result, { key: MODELSLAB_API_KEY }, { timeout: 30000 });
        if (poll.data.output && poll.data.output.length > 0) {
          return poll.data.output[0];
        }
        if (poll.data.status === 'success' && poll.data.proxy_links && poll.data.proxy_links.length > 0) {
          return poll.data.proxy_links[0];
        }
      } catch (e) { /* keep polling */ }
    }
  }
  return null;
}

// ─────────────────────────────────────────────
// STEP 3 — VOICE: Google TTS
// ─────────────────────────────────────────────
async function generateVoice(text, outputPath) {
  const cleanText = text.replace(/['"]/g, '').substring(0, 200);
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(cleanText)}&tl=en&client=tw-ob&ttsspeed=0.85`;

  const response = await axios({
    method: 'GET', url,
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36' }
  });

  fs.writeFileSync(outputPath, Buffer.from(response.data));
  console.log(`[Voice] Saved!`);
}

// ─────────────────────────────────────────────
// STEP 4 — FFMPEG: Build a single drawtext segment
// ─────────────────────────────────────────────
function buildTextSegment(text, y, style) {
  let f = `drawtext=text='${text}':fontsize=${style.fontsize}:fontcolor=${style.fontcolor}` +
    `:fontfile=${style.fontfile}:x=(w-text_w)/2:y=${y}` +
    `:borderw=${style.borderw}:bordercolor=${style.bordercolor}`;
  if (style.box) {
    f += `:box=1:boxcolor=${style.boxcolor}:boxborderw=${style.boxborderw}`;
  }
  return f;
}

// ─────────────────────────────────────────────
// STEP 4 — FFMPEG: Scene with rotating Caption Style
// ─────────────────────────────────────────────
async function buildSceneVideo(imgPath, audioPath, caption, outputPath, duration, captionStyle) {
  // Clean caption - uppercase, remove special chars
  const cleanCaption = caption
    .toUpperCase()
    .replace(/['":\\<>|]/g, '')
    .substring(0, 40)
    .trim();

  // Split long captions into 2 lines
  const words = cleanCaption.split(' ');
  let line1 = '', line2 = '';
  if (words.length > 3) {
    const mid = Math.ceil(words.length / 2);
    line1 = words.slice(0, mid).join(' ');
    line2 = words.slice(mid).join(' ');
  } else {
    line1 = cleanCaption;
  }

  // Position based on style ('center' vs 'lower')
  let y1, y2;
  if (captionStyle.position === 'lower') {
    y1 = line2 ? 'h-260' : 'h-180';
    y2 = 'h-180';
  } else {
    y1 = line2 ? '(h/2)-90' : '(h/2)-40';
    y2 = '(h/2)+15';
  }

  let textFilter = buildTextSegment(line1, y1, captionStyle);
  if (line2) {
    textFilter += ',' + buildTextSegment(line2, y2, captionStyle);
  }

  const fadeOut = Math.max(duration - 0.4, 0);

  const cmd = `ffmpeg -loop 1 -i "${imgPath}" -i "${audioPath}" \
    -c:v libx264 -tune stillimage -c:a aac -b:a 192k \
    -pix_fmt yuv420p -t ${duration} \
    -vf "scale=768:1344:force_original_aspect_ratio=decrease,\
pad=768:1344:(ow-iw)/2:(oh-ih)/2:black,\
${textFilter},\
fade=t=in:st=0:d=0.4,fade=t=out:st=${fadeOut}:d=0.4" \
    -y "${outputPath}"`;

  await execPromise(cmd);
  console.log(`[FFmpeg] Scene with "${captionStyle.name}" caption done!`);
}

// ─────────────────────────────────────────────
// STEP 5 — FFMPEG: Stitch + Theme-Matched Background Music
// ─────────────────────────────────────────────
async function stitchFinalVideo(sceneVideos, tempDir, outputPath, category) {
  const concatFile = path.join(tempDir, 'concat.txt');
  fs.writeFileSync(concatFile, sceneVideos.map(v => `file '${v}'`).join('\n'));

  const tempConcat = path.join(tempDir, 'raw.mp4');
  await execPromise(`ffmpeg -f concat -safe 0 -i "${concatFile}" -c copy -y "${tempConcat}"`);

  // Try to get theme-matched background music
  const musicPath = path.join(tempDir, 'music.mp3');
  let hasMusic = false;

  try {
    const url = getThemeMusicUrl(category);
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
    fs.writeFileSync(musicPath, Buffer.from(res.data));
    hasMusic = true;
    console.log(`[Music] Theme music ready for "${category}" → ${url.split('/').pop()}`);
  } catch (e) {
    console.log('[Music] Skipping background music');
  }

  if (hasMusic) {
    try {
      const totalDuration = await execPromise(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${tempConcat}"`
      );
      const dur = parseFloat(totalDuration.stdout.trim());

      await execPromise(
        `ffmpeg -i "${tempConcat}" -i "${musicPath}" \
        -filter_complex "[1:a]atrim=0:${dur},volume=0.12[bg];[0:a]volume=1.0[voice];[voice][bg]amix=inputs=2:duration=first[aout]" \
        -map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 192k -y "${outputPath}"`
      );
      console.log('[Music] Mixed with voice successfully!');
      return;
    } catch (e) {
      console.log('[Music] Mix failed, using voice only');
    }
  }

  fs.copyFileSync(tempConcat, outputPath);
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
        description: `${description}\n\n${hashtags}`,
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
  const selectedCaptionStyle = CAPTION_STYLES[captionStyleIndex % CAPTION_STYLES.length];
  const characterSeed = Math.floor(Math.random() * 999999); // same seed for ALL scenes = consistent character

  categoryIndex++;
  artStyleIndex++;
  captionStyleIndex++;
  dailyCount++;

  console.log(`\n🎬 [VidForge v7] Category: ${selectedCategory}`);
  console.log(`🎨 Art Style: ${selectedStyle.split(',')[0]}`);
  console.log(`✏️ Caption Style: ${selectedCaptionStyle.name}`);
  console.log(`🌱 Character Seed: ${characterSeed}`);
  console.log(`📊 Daily: ${dailyCount}/${DAILY_LIMIT}\n`);

  const results = { category: selectedCategory, captionStyle: selectedCaptionStyle.name, youtube: null, instagram: null, error: null };
  const tempDir = path.join('/tmp', `vidforge_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // 1. Generate story + character design
    console.log('[VidForge] Writing story & designing character...');
    const script = await generateVideoScript(selectedCategory, selectedStyle);
    console.log(`[VidForge] ✍️ "${script.title}" | ${script.series}`);
    console.log(`[VidForge] 🎭 Character: ${script.character_design.substring(0, 80)}...`);

    // 2. Generate scenes (same character seed across all scenes)
    const sceneDurations = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const scene = script.scenes[i];
      console.log(`\n[VidForge] 🎬 Scene ${i + 1}/4: "${scene.caption}"`);

      const imgPath   = path.join(tempDir, `image_${i}.png`);
      const audioPath = path.join(tempDir, `voice_${i}.mp3`);

      await Promise.all([
        generateCartoonImage(scene.image_prompt, imgPath, characterSeed),
        generateVoice(scene.narration, audioPath)
      ]);

      let duration = 5;
      try {
        const { stdout } = await execPromise(
          `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
        );
        duration = Math.max(parseFloat(stdout.trim()) + 0.8, 3.5);
      } catch (e) {}
      sceneDurations.push(duration);
      console.log(`[VidForge] Scene ${i + 1} ready! (${duration.toFixed(1)}s)`);
    }

    // 3. Build scene videos with rotating caption style
    console.log(`\n[VidForge] 🖊️ Adding "${selectedCaptionStyle.name}" captions and building scenes...`);
    const sceneVideos = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const sceneOut = path.join(tempDir, `scene_${i}.mp4`);
      await buildSceneVideo(
        path.join(tempDir, `image_${i}.png`),
        path.join(tempDir, `voice_${i}.mp3`),
        script.scenes[i].caption,
        sceneOut,
        sceneDurations[i],
        selectedCaptionStyle
      );
      sceneVideos.push(sceneOut);
    }

    // 4. Stitch with theme-matched music
    console.log('\n[VidForge] 🎵 Stitching with theme-matched background music...');
    const videoPath = path.join(tempDir, 'final.mp4');
    await stitchFinalVideo(sceneVideos, tempDir, videoPath, selectedCategory);

    const caption = `${script.title} | ${script.series}\n\n${script.description}\n\n${script.hashtags}`;

    // 5. YouTube
    try {
      console.log('\n[VidForge] 📺 Uploading to YouTube...');
      const ytId = await uploadToYouTube(videoPath, script.title, script.description, script.hashtags, script.series);
      results.youtube = `https://youtube.com/watch?v=${ytId}`;
      console.log(`[VidForge] YouTube ✅ ${results.youtube}`);
    } catch (err) {
      console.error('[VidForge] YouTube ❌', err.message);
      results.youtubeError = err.message;
    }

    // 6. Instagram
    try {
      if (results.youtube) {
        console.log('[VidForge] 📱 Posting to Instagram...');
        const igId = await postToInstagram(results.youtube, caption);
        results.instagram = igId;
        console.log(`[VidForge] Instagram ✅`);
      }
    } catch (err) {
      console.error('[VidForge] Instagram ❌', err.message);
      results.instagramError = err.message;
    }

    console.log(`\n🎉 [VidForge] DONE! ${dailyCount}/${DAILY_LIMIT} today`);
    console.log(`🔗 Watch: ${results.youtube}\n`);

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
app.get('/', (req, res) => res.json({
  app: 'VidForge AI',
  version: '7.0.0',
  status: 'running',
  description: 'Infinite AI Cartoon Series — Consistent Characters + Rotating Caption Styles + Theme Music'
}));

app.get('/status', (req, res) => res.json({
  running: true,
  version: '7.0.0',
  schedule: 'Every 96 minutes (15 videos/day)',
  dailyCount: `${dailyCount}/${DAILY_LIMIT}`,
  nextCategory: VIDEO_CATEGORIES[categoryIndex % VIDEO_CATEGORIES.length],
  nextArtStyle: ART_STYLES[artStyleIndex % ART_STYLES.length].split(',')[0],
  nextCaptionStyle: CAPTION_STYLES[captionStyleIndex % CAPTION_STYLES.length].name,
  youtubeConnected:   !!YOUTUBE_REFRESH_TOKEN,
  instagramConnected: !!INSTAGRAM_ACCESS_TOKEN,
  groqConnected:      !!GROQ_API_KEY,
  modelslabConnected: !!MODELSLAB_API_KEY,
  features: [
    'Consistent main character across all scenes (ModelsLab + seed)',
    '8 rotating caption styles (Bold Stroke, Red Highlight, Sleek, Karaoke, Majestic, Beast, Pixel, Clarity)',
    'Theme-matched background music per category',
    'Story-matched visuals',
    'Voice narration',
    'Fade transitions',
    'Infinite series'
  ],
  captionStyles: CAPTION_STYLES.map(s => s.name),
  timestamp: new Date().toISOString()
}));

app.post('/generate', async (req, res) => {
  const { category } = req.body || {};
  if (dailyCount >= DAILY_LIMIT) {
    return res.json({ message: 'Daily limit reached!', dailyCount, DAILY_LIMIT });
  }
  res.json({ message: '🎬 Cartoon episode started!', category: category || 'auto', dailyCount: dailyCount + 1 });
  runPostingCycle(category);
});

app.post('/test-script', async (req, res) => {
  const { category } = req.body || {};
  const cat = category || 'horror';
  const style = ART_STYLES[Math.floor(Math.random() * ART_STYLES.length)];
  try {
    const script = await generateVideoScript(cat, style);
    res.json({ success: true, category: cat, style: style.split(',')[0], script });
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
  res.json({ message: 'Save this refresh_token!', refresh_token: tokens.refresh_token });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 VidForge AI v7.0 — Consistent Characters + Caption Styles + Theme Music`);
  console.log(`🎨 ${ART_STYLES.length} art styles | ✏️ ${CAPTION_STYLES.length} caption styles | 📚 ${VIDEO_CATEGORIES.length} categories`);
  console.log(`🖼️ ModelsLab: ${MODELSLAB_API_KEY ? 'ENABLED ✅' : 'not set (using fallback images)'}`);
  console.log(`⏰ Every 96 min = 15 videos/day`);
  console.log(`📊 http://localhost:${PORT}/status\n`);
});

module.exports = app;
