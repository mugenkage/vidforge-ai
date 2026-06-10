# VidForge AI — Deployment Guide

## Files in this project:
- `server.js` — Main backend (auto-generates and posts videos)
- `package.json` — Dependencies list
- `.env.example` — Template for your API keys
- `ai-video-studio.jsx` — Frontend dashboard (already built)

---

## Step 1 — Create GitHub Repository
1. Go to github.com and log in
2. Click "+" top right → "New repository"
3. Name it: `vidforge-ai`
4. Set to Public
5. Click "Create repository"
6. Upload all these files to the repo

---

## Step 2 — Deploy on Vercel
1. Go to vercel.com
2. Sign in with GitHub
3. Click "Add New Project"
4. Select your `vidforge-ai` repo
5. Click "Deploy"
6. Your app is now live at: `vidforge-ai.vercel.app`

---

## Step 3 — Add Environment Variables on Vercel
1. Go to your project on Vercel
2. Click "Settings" → "Environment Variables"
3. Add each variable from .env.example one by one:
   - YOUTUBE_API_KEY
   - YOUTUBE_CLIENT_ID
   - YOUTUBE_CLIENT_SECRET
   - YOUTUBE_REDIRECT_URI = https://vidforge-ai.vercel.app/auth/callback
   - INSTAGRAM_APP_ID = 1015450684564757
   - INSTAGRAM_APP_SECRET
   - INSTAGRAM_ACCESS_TOKEN
   - RUNWAY_API_KEY
   - CLAUDE_API_KEY
   - POST_SCHEDULE = 0 */6 * * *
4. Click "Redeploy" after adding all variables

---

## Step 4 — Connect YouTube (get Refresh Token)
1. Go to: https://vidforge-ai.vercel.app/auth/youtube
2. Log in with your Google account
3. Approve permissions
4. Copy the refresh token from the page
5. Add it to Vercel as YOUTUBE_REFRESH_TOKEN
6. Redeploy

---

## Step 5 — Get Instagram Access Token
1. Go to developers.facebook.com
2. Open VidForge AI-IG app
3. Instagram → API setup with Instagram login
4. Click "Generate token" next to mugenkage.ai
5. Copy the token
6. Add to Vercel as INSTAGRAM_ACCESS_TOKEN

---

## Step 6 — Get Runway ML API Key (Free)
1. Go to runwayml.com
2. Sign up free
3. Go to Account → API Keys
4. Create new key
5. Add to Vercel as RUNWAY_API_KEY

---

## Step 7 — Get Claude API Key (for scripts)
1. Go to console.anthropic.com
2. Sign up free
3. Go to API Keys → Create Key
4. Add to Vercel as CLAUDE_API_KEY

---

## Step 8 — Test Everything
Visit: https://vidforge-ai.vercel.app/status
You should see all connections as true!

Then test posting: 
POST to https://vidforge-ai.vercel.app/generate
Body: { "category": "horror" }

---

## How Money is Made
- YouTube AdSense: $2-5 per 1000 views
- Instagram Reels Bonus: $0.01-0.05 per 1000 views
- Goal: Post 4 videos/day = 120 videos/month
- At 10K views each = 1.2M views/month = $2400-6000/month

---

## Support
If you get stuck, open a new Claude AI chat at claude.ai
Upload this README file and the VidForge-Setup-Guide.md
Tell Claude: "Continue helping me deploy VidForge AI"
