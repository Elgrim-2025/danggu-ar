# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AR chroma key web app (AR 크로마키 웹앱). Users upload images/videos, configure chroma key settings, and get a shareable AR link. Visitors open the link, grant camera access, and see the uploaded content overlaid on their camera feed with real-time background removal via WebGL2 shaders.

Korean-language project — UI text, comments, and commit messages are in Korean.

## Commands

```bash
npm run dev          # Local dev server (wrangler dev)
npm run deploy       # Deploy to Cloudflare Workers
npm run r2:create    # Create R2 bucket (first-time setup)
npm run kv:create    # Create KV namespace (first-time setup)
```

No test framework is configured. No build step — static files served directly.

## Architecture

**Serverless monolith on Cloudflare Workers.** Single worker file handles all API routes; static frontend served via ASSETS binding.

### Backend: `src/worker.js`
- Single fetch handler with manual URL-based routing
- All API endpoints defined here (upload, meta, file serving, admin CRUD, stats)
- Storage: **R2** for files, **KV** for metadata/stats/rate-limits
- Auth: HMAC-SHA256 constant-time password comparison against `UPLOAD_SECRET` and `DELETE_SECRET` env vars
- Rate limiting via KV with TTL (auth: 10/5min, upload: 5/10min, general: 10/60s)
- File serving supports Range requests for iOS Safari video streaming

### Frontend: `public/` (vanilla JS, no framework)
- **3 pages**: upload (`index.html`), AR viewer (`ar.html`), admin (`manage.html`)
- Each page has its own JS (`js/`) and CSS (`css/`) file
- No bundler — scripts loaded directly

### AR Viewer (`js/ar-viewer.js`)
- WebGL2 + GLSL fragment shader for real-time chroma key compositing
- Camera stream via getUserMedia, overlaid content rendered as WebGL texture
- Touch gestures: drag to move, pinch to zoom
- Recording: MediaRecorder API → WebM → FFmpeg WASM (from R2) → MP4
- Platform differences: iOS uses Web Share API for save; Android supports native WebM alpha transparency

### Storage Layout
- **R2 bucket** (`ar-uploads`): `{fileId}.{ext}` for uploads, `wasm/ffmpeg-core.wasm` for FFmpeg
- **KV namespace** (`AR_META`): project metadata as JSON keyed by project ID, plus `views:`, `daily:`, `file:`, and `rl:` prefixed keys

### Auth Model
Two secrets (set via `wrangler secret put`):
- `UPLOAD_SECRET` — required to create AR projects
- `DELETE_SECRET` — required for all admin/manage operations

Passwords are stored only in memory on the client side (no sessionStorage).

## Key Constraints

- Max 3 files per AR project (image or video)
- Allowed file types: JPEG, PNG, MP4, WebM only
- Max file size: 100MB
- FFmpeg WASM (~25MB) must be stored in R2, not in ASSETS (size limit)
- Project IDs are random 8-character alphanumeric strings
- KV namespace ID in `wrangler.jsonc` must match the actual deployed namespace
