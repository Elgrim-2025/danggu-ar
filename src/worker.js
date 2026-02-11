export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCORS();
    }

    // API routes
    if (path === '/api/upload' && request.method === 'POST') {
      return handleUpload(request, env);
    }

    const fileMatch = path.match(/^\/api\/file\/([a-z0-9]+)$/);
    if (fileMatch && request.method === 'GET') {
      return handleGetFile(env, fileMatch[1]);
    }

    const metaMatch = path.match(/^\/api\/meta\/([a-z0-9]+)$/);
    if (metaMatch && request.method === 'GET') {
      return handleGetMeta(env, metaMatch[1]);
    }

    // AR viewer SPA route — serve ar.html for /ar/{id}
    const arMatch = path.match(/^\/ar\/([a-z0-9]+)$/);
    if (arMatch) {
      const arUrl = new URL('/ar.html', request.url);
      return env.ASSETS.fetch(new Request(arUrl, request));
    }

    // Static assets fallthrough
    return env.ASSETS.fetch(request);
  }
};

// ─── Upload Handler ──────────────────────────────────────────────

async function handleUpload(request, env) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const colorHex = formData.get('color') || '#00ff00';
    const similarity = parseFloat(formData.get('similarity')) || 0.4;
    const smoothness = parseFloat(formData.get('smoothness')) || 0.1;

    if (!file || !file.name) {
      return jsonResponse({ error: '파일이 없습니다.' }, 400);
    }

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/png', 'video/mp4', 'video/webm'];
    if (!allowedTypes.includes(file.type)) {
      return jsonResponse({ error: '지원하지 않는 파일 형식입니다. (jpg, png, mp4, webm)' }, 400);
    }

    // Validate file size (50MB)
    if (file.size > 50 * 1024 * 1024) {
      return jsonResponse({ error: '파일 크기는 50MB 이하여야 합니다.' }, 400);
    }

    // Generate unique 8-char ID
    const id = generateId();
    const ext = getExtension(file.type);
    const key = `${id}.${ext}`;

    // Store in R2
    await env.AR_BUCKET.put(key, file.stream(), {
      httpMetadata: { contentType: file.type }
    });

    // Store metadata in KV (30 day TTL)
    const metadata = {
      id,
      filename: file.name,
      type: file.type,
      ext,
      size: file.size,
      color: colorHex,
      similarity,
      smoothness,
      createdAt: Date.now()
    };

    await env.AR_META.put(id, JSON.stringify(metadata), {
      expirationTtl: 30 * 24 * 60 * 60
    });

    return jsonResponse({ id, url: `/ar/${id}`, meta: metadata }, 201);
  } catch (err) {
    return jsonResponse({ error: '업로드 실패: ' + err.message }, 500);
  }
}

// ─── File Serving Handler ────────────────────────────────────────

async function handleGetFile(env, id) {
  const metaStr = await env.AR_META.get(id);
  if (!metaStr) {
    return jsonResponse({ error: '파일을 찾을 수 없습니다.' }, 404);
  }

  const meta = JSON.parse(metaStr);
  const object = await env.AR_BUCKET.get(`${meta.id}.${meta.ext}`);
  if (!object) {
    return jsonResponse({ error: '파일을 찾을 수 없습니다.' }, 404);
  }

  const headers = new Headers();
  headers.set('Content-Type', meta.type);
  headers.set('Cache-Control', 'public, max-age=86400');
  headers.set('Access-Control-Allow-Origin', '*');

  return new Response(object.body, { headers });
}

// ─── Metadata Handler ────────────────────────────────────────────

async function handleGetMeta(env, id) {
  const metaStr = await env.AR_META.get(id);
  if (!metaStr) {
    return jsonResponse({ error: '메타데이터를 찾을 수 없습니다.' }, 404);
  }
  return jsonResponse(JSON.parse(metaStr));
}

// ─── Helpers ─────────────────────────────────────────────────────

function generateId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let id = '';
  for (const b of bytes) {
    id += chars[b % chars.length];
  }
  return id;
}

function getExtension(mimeType) {
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'video/mp4': 'mp4',
    'video/webm': 'webm'
  };
  return map[mimeType] || 'bin';
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

function handleCORS() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    }
  });
}
