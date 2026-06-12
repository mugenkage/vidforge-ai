const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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
const CF_ACCOUNT_ID          = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_API_TOKEN           = process.env.CLOUDFLARE_API_TOKEN;

// ─────────────────────────────────────────────
// CLOUDFLARE REQUEST TRACKER
// 10,000 free requests per day
// ─────────────────────────────────────────────
const CF_DAILY_LIMIT = 10000;
let cfRequestsUsed = 0;
let cfRequestsDate = new Date().toDateString();

function trackCFRequest() {
  // Reset counter if new day
  const today = new Date().toDateString();
  if (today !== cfRequestsDate) {
    cfRequestsUsed = 0;
    cfRequestsDate = today;
    console.log('[Cloudflare] Daily counter reset!');
  }
  cfRequestsUsed++;
  const remaining = CF_DAILY_LIMIT - cfRequestsUsed;
  console.log(`[Cloudflare] Requests used: ${cfRequestsUsed}/${CF_DAILY_LIMIT} | Remaining: ${remaining}`);
  return remaining;
}

function getCFStatus() {
  const today = new Date().toDateString();
  if (today !== cfRequestsDate) { cfRequestsUsed = 0; cfRequestsDate = today; }
  return {
    used: cfRequestsUsed,
    remaining: CF_DAILY_LIMIT - cfRequestsUsed,
    limit: CF_DAILY_LIMIT,
    resetAt: 'midnight'
  };
}

// Reset CF counter at midnight
cron.schedule('0 0 * * *', () => {
  cfRequestsUsed = 0;
  cfRequestsDate = new Date().toDateString();
  console.log('[Cloudflare] Daily request counter reset!');
});

// ─────────────────────────────────────────────
// FFMPEG — spawn only (no exec, no buffer issues)
// ─────────────────────────────────────────────
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args);
    let errOut = '';
    ff.stderr.on('data', d => { errOut = (errOut + d.toString()).slice(-500); });
    ff.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg failed (${code}): ${errOut.slice(-200)}`));
    });
    ff.on('error', err => reject(new Error(`FFmpeg spawn error: ${err.message}`)));
  });
}

function runFFprobe(filePath) {
  return new Promise((resolve) => {
    const ff = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ]);
    let out = '';
    ff.stdout.on('data', d => { out += d.toString(); });
    ff.on('close', () => resolve(parseFloat(out.trim()) || 5.0));
    ff.on('error', () => resolve(5.0));
  });
}

// ─────────────────────────────────────────────
// CATEGORIES
// ─────────────────────────────────────────────
const VIDEO_CATEGORIES = [
  'horror', 'adventure', 'mystery', 'motivation',
  'fantasy', 'thriller', 'comedy', 'kids',
  'romance', 'science fiction', 'historical', 'nature',
  'life lesson', 'mindset', 'folklore', 'superhero'
];

// ─────────────────────────────────────────────
// ART STYLES
// ─────────────────────────────────────────────
const ART_STYLES = [
  { name: 'Chibi Cartoon',     prompt: 'masterpiece chibi cartoon style, cute oversized head, tiny body, big sparkly eyes, bold black outlines, flat bright colors, kawaii, high quality illustration' },
  { name: 'Anime Manga',       prompt: 'masterpiece anime manga style, big expressive eyes, dynamic hair, detailed cel shading, clean lines, vibrant colors, japanese animation, high quality' },
  { name: 'Comic Book Hero',   prompt: 'masterpiece american comic book style, bold ink outlines, dynamic pose, halftone shading, primary colors, dramatic lighting, high quality illustration' },
  { name: 'Pixar 3D',          prompt: 'masterpiece pixar 3d animation style, smooth subsurface skin, expressive cartoon face, colorful background, disney quality render, soft lighting' },
  { name: 'Retro Cartoon',     prompt: 'masterpiece retro 1950s cartoon style, rubberhose animation, simple round shapes, limited color palette, bold black outlines, vintage cartoon' },
  { name: 'Dark Anime',        prompt: 'masterpiece dark anime style, dramatic cinematic lighting, glowing eyes, detailed shading, mature manga aesthetic, moody atmosphere, sharp lines' },
  { name: 'Storybook',         prompt: 'masterpiece childrens storybook illustration, watercolor textures, soft pastel colors, whimsical characters, gentle lines, fairy tale aesthetic' },
  { name: 'Street Art Cartoon',prompt: 'masterpiece graffiti street art cartoon style, bold flat colors, sharp geometric shapes, urban aesthetic, spray paint texture, expressive character' }
];

// ─────────────────────────────────────────────
// CAPTION STYLES
// ─────────────────────────────────────────────
const FONT_BOLD    = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_OBLIQUE = '/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf';
const FONT_MONO    = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf';

const CAPTION_STYLES = [
  { name: 'Bold Stroke',   fontfile: FONT_BOLD,    fontsize: 70, fontcolor: 'white',    borderw: 6, bordercolor: 'black@0.95', box: false, position: 'center' },
  { name: 'Red Highlight', fontfile: FONT_BOLD,    fontsize: 64, fontcolor: 'white',    borderw: 3, bordercolor: 'black@0.8',  box: true,  boxcolor: '0xE6194B@0.85', boxborderw: 16, position: 'center' },
  { name: 'Sleek',         fontfile: FONT_BOLD,    fontsize: 50, fontcolor: 'white',    borderw: 2, bordercolor: 'black@0.6',  box: true,  boxcolor: 'black@0.4',     boxborderw: 14, position: 'lower' },
  { name: 'Karaoke',       fontfile: FONT_BOLD,    fontsize: 60, fontcolor: 'white',    borderw: 2, bordercolor: 'black@0.7',  box: true,  boxcolor: '0x7C3AED@0.85', boxborderw: 16, position: 'center' },
  { name: 'Majestic',      fontfile: FONT_OBLIQUE, fontsize: 58, fontcolor: '0xFFE9B0', borderw: 4, bordercolor: 'black@0.9',  box: false, position: 'center' },
  { name: 'Beast',         fontfile: FONT_BOLD,    fontsize: 82, fontcolor: 'white',    borderw: 8, bordercolor: 'black',      box: false, position: 'center' },
  { name: 'Pixel',         fontfile: FONT_MONO,    fontsize: 44, fontcolor: '0x39FF88', borderw: 2, bordercolor: 'black@0.8',  box: true,  boxcolor: 'black@0.6',     boxborderw: 10, position: 'lower' },
  { name: 'Clarity',       fontfile: FONT_BOLD,    fontsize: 54, fontcolor: 'white',    borderw: 2, bordercolor: 'black@0.6',  box: false, position: 'lower' }
];

// ─────────────────────────────────────────────
// THEME MUSIC
// ─────────────────────────────────────────────
const THEME_MUSIC = {
  'horror': [9,14,16], 'mystery': [9,14,6], 'thriller': [16,9,14],
  'adventure': [1,5,8], 'fantasy': [2,5,11], 'motivation': [3,7,10],
  'comedy': [4,12,13], 'kids': [4,12,13], 'romance': [2,11,15],
  'science fiction': [9,16,6], 'historical': [5,8,11], 'nature': [1,10,15],
  'life lesson': [3,7,10], 'mindset': [3,7,10], 'folklore': [5,11,2], 'superhero': [16,9,4]
};

function getThemeMusicUrl(category) {
  const pool = THEME_MUSIC[category.toLowerCase()] || [1,2,3];
  return `https://www.soundhelix.com/examples/mp3/SoundHelix-Song-${pool[Math.floor(Math.random()*pool.length)]}.mp3`;
}

// ─────────────────────────────────────────────
// COUNTERS
// ─────────────────────────────────────────────
let categoryIndex = 0, artStyleIndex = 0, captionStyleIndex = 0, dailyCount = 0;
const DAILY_LIMIT = 15;

cron.schedule('0 0 * * *', () => { dailyCount = 0; console.log('[VidForge] Daily video count reset!'); });
cron.schedule('*/96 * * * *', () => {
  if (dailyCount < DAILY_LIMIT) {
    console.log(`[Cron] Auto-trigger ${dailyCount + 1}/${DAILY_LIMIT}`);
    runPostingCycle();
  }
});

// ─────────────────────────────────────────────
// CAPTION CLEANER
// ─────────────────────────────────────────────
function cleanCaption(raw) {
  return (raw || '')
    .toUpperCase()
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/['"\\:;<>|!@#$%^&*()+=\[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .substring(0, 30)
    .trim();
}

// ─────────────────────────────────────────────
// STEP 1 — GROQ: Script
// ─────────────────────────────────────────────
async function generateVideoScript(category, artStyle) {
  const prompt = `Create a viral ${category} cartoon story for YouTube Shorts and Instagram Reels.
Art style: ${artStyle.name}
STRICT RULES:
1. ONE main character in ALL 4 scenes (same species, colors, outfit - only emotion changes per scene)
2. Scene captions: MAX 5 WORDS, ALL CAPS, ENGLISH LETTERS AND SPACES ONLY - NO emojis NO symbols NO punctuation at all
3. Story: Hook -> Buildup -> Climax -> Surprising Twist
Respond with ONLY valid JSON (no markdown, no backticks):
{"title":"Catchy title under 55 chars","series":"Short series name","description":"2 engaging sentences with 2 emojis","hashtags":"#cartoon #shorts #viral #fyp #animation #${category.replace(/ /g,'')} #trending #anime #story #episode","character_design":"Detailed: species, body type, color palette, outfit, hair or ears, key features","scenes":[{"narration":"Hook 1-2 sentences","caption":"CAPTION HERE","emotion":"emotion, pose, action, background"},{"narration":"Buildup 1-2 sentences","caption":"CAPTION HERE","emotion":"emotion, pose, action, background"},{"narration":"Climax 1-2 sentences","caption":"CAPTION HERE","emotion":"emotion, pose, action, background"},{"narration":"Twist 1-2 sentences","caption":"CAPTION HERE","emotion":"emotion, pose, action, background"}]}`;

  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    { model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: prompt }], max_tokens: 1200, temperature: 0.9 },
    { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
  );

  const script = JSON.parse(res.data.choices[0].message.content.replace(/```json|```/g, '').trim());
  script.scenes = script.scenes.map(scene => ({
    ...scene,
    image_prompt: `${artStyle.prompt}, ${script.character_design}, ${scene.emotion}, portrait vertical 9:16, vibrant colors, masterpiece, best quality, no text, no watermark`
  }));
  return script;
}

// ─────────────────────────────────────────────
// STEP 2 — IMAGE: Cloudflare with rate limit protection
// 5 second delay between requests = no 429 errors
// ─────────────────────────────────────────────
async function generateCartoonImage(prompt, outputPath, seed, sceneIndex) {
  // Add delay between scenes to avoid 429 rate limit
  // Scene 0 = no delay, Scene 1+ = 5s delay
  if (sceneIndex > 0) {
    console.log(`[Image] Waiting 5s to avoid rate limit...`);
    await new Promise(r => setTimeout(r, 5000));
  }

  if (CF_ACCOUNT_ID && CF_API_TOKEN) {
    const remaining = trackCFRequest();
    if (remaining < 0) {
      console.log('[Image] Cloudflare daily limit reached, using fallback');
    } else {
      try {
        const res = await axios.post(
          `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
          { prompt: prompt, num_steps: 6 },
          {
            headers: { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
            responseType: 'arraybuffer',
            timeout: 90000
          }
        );
        if (res.data && res.data.length > 5000) {
          fs.writeFileSync(outputPath, Buffer.from(res.data));
          console.log(`[Image] Cloudflare ✅ (${remaining} requests remaining today)`);
          return;
        }
        console.log('[Image] Cloudflare empty response, using fallback...');
      } catch (err) {
        const code = err.response ? err.response.status : 'timeout';
        if (code === 429) {
          console.log('[Image] Cloudflare 429 rate limited — waiting 10s then retrying...');
          await new Promise(r => setTimeout(r, 10000));
          // One retry after waiting
          try {
            const retry = await axios.post(
              `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
              { prompt: prompt, num_steps: 6 },
              {
                headers: { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
                responseType: 'arraybuffer',
                timeout: 90000
              }
            );
            if (retry.data && retry.data.length > 5000) {
              fs.writeFileSync(outputPath, Buffer.from(retry.data));
              console.log('[Image] Cloudflare retry ✅');
              return;
            }
          } catch (retryErr) {
            console.log('[Image] Cloudflare retry also failed, using fallback...');
          }
        } else {
          console.log(`[Image] Cloudflare error ${code}, using fallback...`);
        }
      }
    }
  }

  // FALLBACK: Picsum
  try {
    const res = await axios({ method: 'GET', url: `https://picsum.photos/seed/${seed}/720/1280`, responseType: 'arraybuffer', timeout: 20000 });
    fs.writeFileSync(outputPath, Buffer.from(res.data));
    console.log('[Image] Picsum fallback ✅');
  } catch (err) {
    throw new Error(`All image sources failed: ${err.message}`);
  }
}

// ─────────────────────────────────────────────
// STEP 3 — VOICE: Google TTS
// ─────────────────────────────────────────────
async function generateVoice(text, outputPath) {
  const clean = text.replace(/['"]/g,'').replace(/[^\x00-\x7F]/g,'').substring(0,200).trim();
  const res = await axios({
    method: 'GET',
    url: `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(clean)}&tl=en&client=tw-ob&ttsspeed=0.9`,
    responseType: 'arraybuffer',
    timeout: 25000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36' }
  });
  fs.writeFileSync(outputPath, Buffer.from(res.data));
  console.log('[Voice] ✅');
}

// ─────────────────────────────────────────────
// STEP 4 — FFMPEG: Scene video with caption
// ─────────────────────────────────────────────
async function buildSceneVideo(imgPath, audioPath, caption, outputPath, duration, style) {
  const clean = cleanCaption(caption);
  const words = clean.split(' ').filter(Boolean);
  let line1 = clean, line2 = '';
  if (words.length > 3) {
    const mid = Math.ceil(words.length / 2);
    line1 = words.slice(0, mid).join(' ');
    line2 = words.slice(mid).join(' ');
  }

  const esc = t => t.replace(/\\/g,'\\\\').replace(/'/g,'').replace(/:/g,'\\:').replace(/\[/g,'\\[').replace(/\]/g,'\\]');
  const l1 = esc(line1);
  const l2 = line2 ? esc(line2) : '';

  let y1, y2;
  if (style.position === 'lower') { y1 = l2 ? 'h*0.78' : 'h*0.82'; y2 = 'h*0.88'; }
  else { y1 = l2 ? 'h*0.44' : 'h*0.48'; y2 = 'h*0.54'; }

  const makeText = (t, y) => {
    let f = `drawtext=text='${t}':fontsize=${style.fontsize}:fontcolor=${style.fontcolor}:fontfile='${style.fontfile}':x=(w-text_w)/2:y=${y}:borderw=${style.borderw}:bordercolor=${style.bordercolor}`;
    if (style.box) f += `:box=1:boxcolor=${style.boxcolor}:boxborderw=${style.boxborderw}`;
    return f;
  };

  const fadeOut = Math.max(duration - 0.4, 0.1);
  let textFilters = makeText(l1, y1);
  if (l2) textFilters += ',' + makeText(l2, y2);

  const vf = [
    'scale=720:1280:force_original_aspect_ratio=decrease',
    'pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black',
    textFilters,
    'fade=t=in:st=0:d=0.3',
    `fade=t=out:st=${fadeOut.toFixed(2)}:d=0.3`
  ].join(',');

  await runFFmpeg([
    '-loop', '1', '-i', imgPath,
    '-i', audioPath,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage',
    '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k',
    '-pix_fmt', 'yuv420p',
    '-t', duration.toFixed(2),
    '-vf', vf,
    '-movflags', '+faststart',
    '-y', outputPath
  ]);
  console.log(`[FFmpeg] Scene done — ${style.name} ✅`);
}

// ─────────────────────────────────────────────
// STEP 5 — FFMPEG: Stitch + Theme Music
// ─────────────────────────────────────────────
async function stitchFinalVideo(sceneVideos, tempDir, outputPath, category) {
  const concatFile = path.join(tempDir, 'concat.txt');
  fs.writeFileSync(concatFile, sceneVideos.map(v => `file '${v}'`).join('\n'));
  const tempConcat = path.join(tempDir, 'raw.mp4');

  await runFFmpeg(['-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', '-y', tempConcat]);
  console.log('[FFmpeg] Scenes concatenated ✅');

  const musicPath = path.join(tempDir, 'music.mp3');
  let hasMusic = false;
  try {
    const musicRes = await axios.get(getThemeMusicUrl(category), { responseType: 'arraybuffer', timeout: 15000 });
    fs.writeFileSync(musicPath, Buffer.from(musicRes.data));
    hasMusic = true;
    console.log('[Music] Downloaded ✅');
  } catch (e) { console.log('[Music] Skipped'); }

  if (hasMusic) {
    try {
      const totalDur = await runFFprobe(tempConcat);
      await runFFmpeg([
        '-i', tempConcat, '-i', musicPath,
        '-filter_complex', `[1:a]atrim=0:${totalDur.toFixed(2)},asetpts=PTS-STARTPTS,volume=0.10[bg];[0:a]volume=1.0[voice];[voice][bg]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
        '-map', '0:v', '-map', '[aout]',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        '-y', outputPath
      ]);
      console.log('[Music] Mixed ✅'); return;
    } catch (e) { console.log('[Music] Mix failed, using voice only'); }
  }
  fs.copyFileSync(tempConcat, outputPath);
  console.log('[Video] Ready (no music) ✅');
}

// ─────────────────────────────────────────────
// STEP 6 — YOUTUBE
// ─────────────────────────────────────────────
async function uploadToYouTube(videoPath, title, description, hashtags, series) {
  const auth = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI);
  auth.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });
  const yt = google.youtube({ version: 'v3', auth });
  const res = await yt.videos.insert({
    part: 'snippet,status',
    requestBody: {
      snippet: {
        title: `${title} | ${series}`.substring(0, 100),
        description: `${description}\n\n${hashtags}`,
        tags: hashtags.split('#').filter(Boolean).map(t => t.trim()).slice(0, 15),
        categoryId: '1', defaultLanguage: 'en'
      },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false }
    },
    media: { mimeType: 'video/mp4', body: fs.createReadStream(videoPath) }
  });
  return res.data.id;
}

// ─────────────────────────────────────────────
// STEP 7 — INSTAGRAM
// ─────────────────────────────────────────────
async function postToInstagram(videoUrl, caption) {
  const conRes = await axios.post(
    `https://graph.facebook.com/v18.0/${INSTAGRAM_USER_ID}/media`,
    { media_type: 'REELS', video_url: videoUrl, caption: caption.substring(0,2200), share_to_feed: true, access_token: INSTAGRAM_ACCESS_TOKEN }
  );
  console.log(`[Instagram] Container: ${conRes.data.id}`);
  await new Promise(r => setTimeout(r, 45000));
  const pubRes = await axios.post(
    `https://graph.facebook.com/v18.0/${INSTAGRAM_USER_ID}/media_publish`,
    { creation_id: conRes.data.id, access_token: INSTAGRAM_ACCESS_TOKEN }
  );
  return pubRes.data.id;
}

// ─────────────────────────────────────────────
// MAIN PIPELINE
// ─────────────────────────────────────────────
async function runPostingCycle(category = null) {
  const cat  = (category || VIDEO_CATEGORIES[categoryIndex % VIDEO_CATEGORIES.length]).toLowerCase();
  const art  = ART_STYLES[artStyleIndex % ART_STYLES.length];
  const cap  = CAPTION_STYLES[captionStyleIndex % CAPTION_STYLES.length];
  const seed = Math.floor(Math.random() * 999999);

  categoryIndex++; artStyleIndex++; captionStyleIndex++; dailyCount++;

  console.log(`\n🎬 [VidForge v14]`);
  console.log(`   Category  : ${cat}`);
  console.log(`   Art Style : ${art.name}`);
  console.log(`   Caption   : ${cap.name}`);
  console.log(`   Videos    : ${dailyCount}/${DAILY_LIMIT}`);
  console.log(`   CF Limit  : ${getCFStatus().remaining} requests remaining\n`);

  const results = { category: cat, artStyle: art.name, caption: cap.name, youtube: null, instagram: null, error: null };
  const tempDir = path.join('/tmp', `vf_${Date.now()}`);

  try {
    fs.mkdirSync(tempDir, { recursive: true });

    // 1. Script
    console.log('[1/5] Generating script...');
    const script = await generateVideoScript(cat, art);
    console.log(`[1/5] "${script.title}" | ${script.series} ✅`);

    // 2+3. Image + Voice for each scene (sequential + delay)
    const durations = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const imgPath   = path.join(tempDir, `image_${i}.png`);
      const audioPath = path.join(tempDir, `voice_${i}.mp3`);
      console.log(`[2/5] Scene ${i+1}/4 — "${cleanCaption(script.scenes[i].caption)}"`);
      await generateCartoonImage(script.scenes[i].image_prompt, imgPath, seed + i, i);
      await generateVoice(script.scenes[i].narration, audioPath);
      const dur = await runFFprobe(audioPath);
      durations.push(Math.max(dur + 0.8, 3.5));
      console.log(`      Duration: ${durations[i].toFixed(1)}s | CF remaining: ${getCFStatus().remaining}`);
    }

    // 4. Build scene videos
    console.log(`\n[3/5] Building scenes with "${cap.name}" captions...`);
    const sceneVideos = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const sceneOut = path.join(tempDir, `scene_${i}.mp4`);
      await buildSceneVideo(
        path.join(tempDir, `image_${i}.png`),
        path.join(tempDir, `voice_${i}.mp3`),
        script.scenes[i].caption, sceneOut, durations[i], cap
      );
      sceneVideos.push(sceneOut);
    }

    // 5. Stitch
    console.log('\n[4/5] Stitching with theme music...');
    const videoPath = path.join(tempDir, 'final.mp4');
    await stitchFinalVideo(sceneVideos, tempDir, videoPath, cat);
    const totalDur = await runFFprobe(videoPath);
    console.log(`[4/5] Final video: ${totalDur.toFixed(1)}s ✅`);

    const postCaption = `${script.title} | ${script.series}\n\n${script.description}\n\n${script.hashtags}`;

    // 6. YouTube
    console.log('\n[5/5] Uploading to YouTube...');
    try {
      const ytId = await uploadToYouTube(videoPath, script.title, script.description, script.hashtags, script.series);
      results.youtube = `https://youtube.com/watch?v=${ytId}`;
      console.log(`[5/5] YouTube ✅ ${results.youtube}`);
    } catch (err) { console.error('[5/5] YouTube ❌', err.message); results.youtubeError = err.message; }

    // 7. Instagram
    if (results.youtube) {
      console.log('[5/5] Posting to Instagram...');
      try {
        results.instagram = await postToInstagram(results.youtube, postCaption);
        console.log('[5/5] Instagram ✅');
      } catch (err) { console.error('[5/5] Instagram ❌', err.message); results.instagramError = err.message; }
    }

    console.log(`\n🎉 [VidForge v14] DONE! ${dailyCount}/${DAILY_LIMIT} today`);
    console.log(`🔗 ${results.youtube || 'No YouTube link'}`);
    console.log(`☁️  CF requests remaining: ${getCFStatus().remaining}\n`);

  } catch (err) {
    results.error = err.message; dailyCount--;
    console.error('\n❌ [VidForge v14] Failed:', err.message, '\n');
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
  }
  return results;
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  app: 'VidForge AI', version: '14.0.0', status: 'running',
  cloudflareRequests: getCFStatus()
}));

app.get('/status', (req, res) => res.json({
  version: '14.0.0', running: true,
  videos: { today: dailyCount, limit: DAILY_LIMIT, remaining: DAILY_LIMIT - dailyCount },
  cloudflare: getCFStatus(),
  nextCategory: VIDEO_CATEGORIES[categoryIndex % VIDEO_CATEGORIES.length],
  nextArtStyle: ART_STYLES[artStyleIndex % ART_STYLES.length].name,
  nextCaption: CAPTION_STYLES[captionStyleIndex % CAPTION_STYLES.length].name,
  services: {
    cloudflare: !!(CF_ACCOUNT_ID && CF_API_TOKEN),
    groq: !!GROQ_API_KEY,
    youtube: !!YOUTUBE_REFRESH_TOKEN,
    instagram: !!INSTAGRAM_ACCESS_TOKEN
  },
  artStyles: ART_STYLES.map(s => s.name),
  captionStyles: CAPTION_STYLES.map(s => s.name),
  timestamp: new Date().toISOString()
}));

app.get('/test-image', async (req, res) => {
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) return res.status(400).json({ error: 'Cloudflare keys not set' });
  try {
    trackCFRequest();
    const response = await axios.post(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
      { prompt: 'cute chibi cartoon cat, big sparkly eyes, colorful kawaii style, masterpiece', num_steps: 4 },
      { headers: { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' }, responseType: 'arraybuffer', timeout: 60000 }
    );
    if (response.data && response.data.length > 1000) {
      res.set('Content-Type', 'image/png');
      return res.send(Buffer.from(response.data));
    }
    res.json({ error: 'Empty response', cfStatus: getCFStatus() });
  } catch (err) {
    res.status(500).json({ error: err.response ? `HTTP ${err.response.status}` : err.message, cfStatus: getCFStatus() });
  }
});

app.post('/generate', async (req, res) => {
  if (dailyCount >= DAILY_LIMIT) return res.json({ success: false, message: `Daily limit reached (${DAILY_LIMIT}/day)`, cfStatus: getCFStatus() });
  const category = (req.body || {}).category || null;
  res.json({ success: true, message: '🎬 Video generation started!', category: category || 'auto', cfStatus: getCFStatus() });
  runPostingCycle(category);
});

app.post('/test-script', async (req, res) => {
  const cat = (req.body || {}).category || 'horror';
  const style = ART_STYLES[Math.floor(Math.random() * ART_STYLES.length)];
  try { res.json({ success: true, script: await generateVideoScript(cat, style) }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/auth/youtube', (req, res) => {
  const auth = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI);
  res.redirect(auth.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/youtube.upload'] }));
});

app.get('/auth/youtube/callback', async (req, res) => {
  try {
    const auth = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI);
    const { tokens } = await auth.getToken(req.query.code);
    res.json({ message: 'Copy this to Render environment!', refresh_token: tokens.refresh_token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 VidForge AI v14.0 — Stable + Quality + Rate Limit Protection`);
  console.log(`☁️  Cloudflare : ${(CF_ACCOUNT_ID && CF_API_TOKEN) ? 'ENABLED ✅' : 'NOT SET ❌'}`);
  console.log(`🎙️  Groq       : ${GROQ_API_KEY ? 'ENABLED ✅' : 'NOT SET ❌'}`);
  console.log(`📺  YouTube    : ${YOUTUBE_REFRESH_TOKEN ? 'ENABLED ✅' : 'NOT SET ❌'}`);
  console.log(`📱  Instagram  : ${INSTAGRAM_ACCESS_TOKEN ? 'ENABLED ✅' : 'NOT SET ❌'}`);
  console.log(`☁️  CF Limit   : ${getCFStatus().remaining} requests remaining today`);
  console.log(`⏰  Schedule   : Every 96 min (${DAILY_LIMIT} videos/day)`);
  console.log(`📊  Status     : http://localhost:${PORT}/status\n`);
});

module.exports = app;
