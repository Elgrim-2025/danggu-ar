export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return handleCORS();

    if (path === '/api/upload' && request.method === 'POST') return handleUpload(request, env);
    if (path === '/api/list' && request.method === 'GET') return handleList(request, env);

    const deleteMatch = path.match(/^\/api\/delete\/([a-z0-9]+)$/);
    if (deleteMatch && request.method === 'DELETE') return handleDelete(request, env, deleteMatch[1]);

    const fileMatch = path.match(/^\/api\/file\/([a-z0-9]+)$/);
    if (fileMatch && request.method === 'GET') return handleGetFile(env, fileMatch[1]);

    const metaMatch = path.match(/^\/api\/meta\/([a-z0-9]+)$/);
    if (metaMatch && request.method === 'GET') return handleGetMeta(env, metaMatch[1]);

    const arMatch = path.match(/^\/ar\/([a-z0-9]+)$/);
    if (arMatch) {
      const arUrl = new URL('/ar.html', request.url);
      return env.ASSETS.fetch(new Request(arUrl, request));
    }

    if (path === '/manage') {
      const manageUrl = new URL('/manage.html', request.url);
      return env.ASSETS.fetch(new Request(manageUrl, request));
    }

    if (path === '/' || path === '') {
      const indexUrl = new URL('/index.html', request.url);
      return env.ASSETS.fetch(new Request(indexUrl, request));
    }

    return env.ASSETS.fetch(request);
  }
};

// ─── Upload Handler ──────────────────────────────────────────────

async function handleUpload(request, env) {
  try {
    const formData = await request.formData();
    const groupId = generateId();
    const files = [];

    for (let i = 0; i < 3; i++) {
      const file = formData.get(`file${i}`);
      if (!file || !file.name) break;

      const allowedTypes = ['image/jpeg', 'image/png', 'video/mp4', 'video/webm'];
      if (!allowedTypes.includes(file.type)) {
        return jsonResponse({ error: `파일 ${i + 1}: 지원하지 않는 파일 형식입니다. (jpg, png, mp4, webm)` }, 400);
      }
      if (file.size > 100 * 1024 * 1024) {
        return jsonResponse({ error: `파일 ${i + 1}: 파일 크기는 100MB 이하여야 합니다.` }, 400);
      }

      const fileId = generateId();
      const ext = getExtension(file.type);
      await env.AR_BUCKET.put(`${fileId}.${ext}`, file.stream(), {
        httpMetadata: { contentType: file.type }
      });

      await env.AR_META.put(`file:${fileId}`, JSON.stringify({ ext, type: file.type }));

      const isVideo = file.type.startsWith('video/');
      files.push({
        id: fileId,
        filename: file.name,
        type: file.type,
        ext,
        size: file.size,
        color: formData.get(`color${i}`) || '#00ff00',
        similarity: parseFloat(formData.get(`similarity${i}`)) || 0.4,
        smoothness: parseFloat(formData.get(`smoothness${i}`)) || 0.1,
        audio: isVideo && formData.get(`audio${i}`) === 'true'
      });
    }

    if (files.length === 0) return jsonResponse({ error: '파일이 없습니다.' }, 400);

    const rawTitle = (formData.get('title') || '').toString().trim().slice(0, 50);
    const metadata = { id: groupId, title: rawTitle || null, files, createdAt: Date.now() };
    await env.AR_META.put(groupId, JSON.stringify(metadata));

    return jsonResponse({ id: groupId, url: `/ar/${groupId}`, meta: metadata }, 201);
  } catch (err) {
    return jsonResponse({ error: '업로드 실패: ' + err.message }, 500);
  }
}

// ─── File Serving Handler ────────────────────────────────────────

async function handleGetFile(env, id) {
  try {
    const fileMetaStr = await env.AR_META.get(`file:${id}`);
    // KV TTL 만료 시 fileMetaStr === null → 404
    if (!fileMetaStr) return jsonResponse({ error: '파일을 찾을 수 없습니다.' }, 404);

    const fileMeta = JSON.parse(fileMetaStr);
    const object = await env.AR_BUCKET.get(`${id}.${fileMeta.ext}`);
    if (!object) return jsonResponse({ error: '파일을 찾을 수 없습니다.' }, 404);

    const headers = new Headers();
    headers.set('Content-Type', fileMeta.type);
    headers.set('Cache-Control', 'public, max-age=86400');
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(object.body, { headers });
  } catch (err) {
    return jsonResponse({ error: '파일 조회 실패' }, 500);
  }
}

// ─── Metadata Handler ────────────────────────────────────────────

async function handleGetMeta(env, id) {
  try {
    const metaStr = await env.AR_META.get(id);
    if (!metaStr) return jsonResponse({ error: '콘텐츠를 찾을 수 없습니다.' }, 404);

    return jsonResponse(JSON.parse(metaStr));
  } catch (err) {
    return jsonResponse({ error: '메타데이터 조회 실패' }, 500);
  }
}

// ─── List Handler ────────────────────────────────────────────────

async function handleList(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!await checkRateLimit(env, ip)) return jsonResponse({ error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' }, 429);

  const secret = request.headers.get('X-Delete-Secret');
  if (!await verifySecret(secret, env.DELETE_SECRET)) return jsonResponse({ error: '인증 실패' }, 403);

  try {
    const groups = [];
    let cursor = undefined;
    do {
      const result = await env.AR_META.list({ cursor, limit: 1000 });
      for (const key of result.keys) {
        if (key.name.startsWith('file:') || key.name.startsWith('rl:')) continue;
        try {
          const metaStr = await env.AR_META.get(key.name);
          if (metaStr) groups.push(JSON.parse(metaStr));
        } catch (_) { /* 개별 항목 파싱 실패 시 건너뜀 */ }
      }
      cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);

    groups.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return jsonResponse({ groups });
  } catch (err) {
    return jsonResponse({ error: '목록 조회 실패' }, 500);
  }
}

// ─── Delete Handler ──────────────────────────────────────────────

async function handleDelete(request, env, groupId) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!await checkRateLimit(env, ip)) return jsonResponse({ error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' }, 429);

  const secret = request.headers.get('X-Delete-Secret');
  if (!await verifySecret(secret, env.DELETE_SECRET)) return jsonResponse({ error: '인증 실패' }, 403);

  try {
    const metaStr = await env.AR_META.get(groupId);
    if (!metaStr) return jsonResponse({ error: '찾을 수 없습니다.' }, 404);

    const meta = JSON.parse(metaStr);
    await deleteGroup(env, meta);
    return jsonResponse({ ok: true, deleted: groupId });
  } catch (err) {
    return jsonResponse({ error: '삭제 실패: ' + err.message }, 500);
  }
}

// ─── Group Delete Helper ─────────────────────────────────────────

/**
 * 그룹에 속한 R2 파일 + KV 항목을 모두 삭제 (handleDelete/만료 공용)
 * @param {any} env
 * @param {{ id: string, files: Array<{id:string, ext:string}> }} meta
 */
async function deleteGroup(env, meta) {
  await Promise.all(meta.files.flatMap(file => [
    env.AR_BUCKET.delete(`${file.id}.${file.ext}`),
    env.AR_META.delete(`file:${file.id}`),
  ]));
  await env.AR_META.delete(meta.id);
}

// ─── Auth Helpers ────────────────────────────────────────────────

/**
 * 타이밍 공격 방지 비밀 검증 (HMAC 기반 constant-time 비교)
 * 단순 문자열 비교(===)는 길이/내용에 따라 실행 시간이 달라져 시크릿 유추 가능
 * @param {string|null} provided
 * @param {string} expected
 * @returns {Promise<boolean>}
 */
async function verifySecret(provided, expected) {
  if (!provided || !expected) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode('ar-verify'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const [sigA, sigB] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(provided)),
    crypto.subtle.sign('HMAC', key, enc.encode(expected)),
  ]);
  const a = new Uint8Array(sigA), b = new Uint8Array(sigB);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * IP 기반 Rate Limiting — 60초 윈도우 내 최대 10회
 * KV key: `rl:{ip}` (expirationTtl: 60초)
 * @param {any} env
 * @param {string} ip
 * @returns {Promise<boolean>} true = 허용
 */
async function checkRateLimit(env, ip) {
  const key = 'rl:' + ip;
  const raw = await env.AR_META.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= 10) return false;
  await env.AR_META.put(key, String(count + 1), { expirationTtl: 60 });
  return true;
}

// ─── Helpers ─────────────────────────────────────────────────────

function generateId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let id = '';
  for (const b of bytes) id += chars[b % chars.length];
  return id;
}

function getExtension(mimeType) {
  return { 'image/jpeg': 'jpg', 'image/png': 'png', 'video/mp4': 'mp4', 'video/webm': 'webm' }[mimeType] || 'bin';
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

function handleCORS() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    }
  });
}
