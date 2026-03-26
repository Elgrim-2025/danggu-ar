export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return handleCORS(path);

    if (path === '/api/upload' && request.method === 'POST') return handleUpload(request, env);
    if (path === '/api/list' && request.method === 'GET') return handleList(request, env);

    // 25MB 초과로 ASSETS에 못 넣는 파일 → R2에서 직접 서빙
    if (path === '/wasm/ffmpeg-core.wasm' && request.method === 'GET') return handleWasm(env);

    const deleteMatch = path.match(/^\/api\/delete\/([a-z0-9]+)$/);
    if (deleteMatch && request.method === 'DELETE') return handleDelete(request, env, deleteMatch[1]);

    const projectMatch = path.match(/^\/api\/project\/([a-z0-9]+)$/);
    if (projectMatch && request.method === 'PATCH') return handleProjectUpdate(request, env, projectMatch[1]);

    const projectFileMatch = path.match(/^\/api\/project\/([a-z0-9]+)\/file\/(\d+)$/);
    if (projectFileMatch && request.method === 'PATCH') return handleFileReplace(request, env, projectFileMatch[1], parseInt(projectFileMatch[2]));

    const androidMatch = path.match(/^\/api\/project\/([a-z0-9]+)\/file\/(\d+)\/android$/);
    if (androidMatch && request.method === 'PATCH')  return handleAndroidVariantUpload(request, env, androidMatch[1], parseInt(androidMatch[2]));
    if (androidMatch && request.method === 'DELETE') return handleAndroidVariantDelete(request, env, androidMatch[1], parseInt(androidMatch[2]));

    const fileMatch = path.match(/^\/api\/file\/([a-z0-9]+)$/);
    if (fileMatch && (request.method === 'GET' || request.method === 'HEAD')) return handleGetFile(env, fileMatch[1], request);

    const metaMatch = path.match(/^\/api\/meta\/([a-z0-9]+)$/);
    if (metaMatch && request.method === 'GET') return handleGetMeta(env, metaMatch[1]);

    const statsMatch = path.match(/^\/api\/stats\/([a-z0-9]+)$/);
    if (statsMatch && request.method === 'GET') return handleGetStats(request, env, statsMatch[1]);

    const arMatch = path.match(/^\/ar\/([a-z0-9]+)$/);
    if (arMatch) return serveHtml(env, request, '/ar.html');

    if (path === '/manage') return serveHtml(env, request, '/manage.html');

    if (path === '/' || path === '') {
      return new Response(null, { status: 302, headers: { 'Location': '/ar/8qtbe0sq' } });
    }

    return env.ASSETS.fetch(request);
  }
};

// ─── Static WASM Handler (R2) ────────────────────────────────────

async function handleWasm(env) {
  try {
    const object = await env.AR_BUCKET.get('wasm/ffmpeg-core.wasm');
    if (!object) return new Response('Not found', { status: 404 });
    const headers = new Headers();
    headers.set('Content-Type', 'application/wasm');
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(object.body, { headers });
  } catch (err) {
    return new Response('WASM 로드 실패', { status: 500 });
  }
}

// ─── Upload Handler ──────────────────────────────────────────────

async function handleUpload(request, env) {
  const uploaded = []; // 롤백용: R2/KV에 성공한 파일 추적
  async function rollback() {
    if (uploaded.length === 0) return;
    await Promise.all(uploaded.flatMap(f => [
      env.AR_BUCKET.delete(`${f.id}.${f.ext}`).catch(() => {}),
      env.AR_META.delete(`file:${f.id}`).catch(() => {}),
    ]));
  }

  try {

    const formData = await request.formData();
    const groupId = generateId();
    const files = [];

    for (let i = 0; i < 3; i++) {
      const file = formData.get(`file${i}`);
      if (!file || !file.name) break;

      const allowedTypes = ['image/jpeg', 'image/png', 'video/mp4', 'video/webm'];
      if (!allowedTypes.includes(file.type)) {
        await rollback();
        return jsonResponse({ error: `파일 ${i + 1}: 지원하지 않는 파일 형식입니다. (jpg, png, mp4, webm)` }, 400);
      }
      if (file.size > 100 * 1024 * 1024) {
        await rollback();
        return jsonResponse({ error: `파일 ${i + 1}: 파일 크기는 100MB 이하여야 합니다.` }, 400);
      }

      const fileId = generateId();
      const ext = getExtension(file.type);
      await env.AR_BUCKET.put(`${fileId}.${ext}`, file.stream(), {
        httpMetadata: { contentType: file.type }
      });
      await env.AR_META.put(`file:${fileId}`, JSON.stringify({ ext, type: file.type }));
      uploaded.push({ id: fileId, ext });

      // 입력값 범위 검증
      const rawColor = (formData.get(`color${i}`) || '').toString();
      const color = /^#[0-9a-fA-F]{6}$/.test(rawColor) ? rawColor : '#00ff00';
      const similarity = Math.min(0.8, Math.max(0.1, parseFloat(formData.get(`similarity${i}`)) || 0.4));
      const smoothness = Math.min(0.3, Math.max(0, parseFloat(formData.get(`smoothness${i}`)) || 0.1));
      const rawName = (file.name || '').toString().trim().slice(0, 100).replace(/[<>"'&]/g, '');

      const isVideo = file.type.startsWith('video/');
      const fileRecord = {
        id: fileId,
        filename: rawName || `file${i + 1}`,
        type: file.type,
        ext,
        size: file.size,
        color,
        similarity,
        smoothness,
        audio: isVideo && formData.get(`audio${i}`) === 'true'
      };

      // Android WebM alpha variant (비디오 슬롯만)
      if (isVideo) {
        const androidFile = formData.get(`androidFile${i}`);
        if (androidFile && androidFile.name && androidFile.type === 'video/webm' && androidFile.size <= 100 * 1024 * 1024) {
          const androidId = generateId();
          await env.AR_BUCKET.put(`${androidId}.webm`, androidFile.stream(), { httpMetadata: { contentType: 'video/webm' } });
          await env.AR_META.put(`file:${androidId}`, JSON.stringify({ ext: 'webm', type: 'video/webm' }));
          uploaded.push({ id: androidId, ext: 'webm' });
          fileRecord.androidId  = androidId;
          fileRecord.androidExt = 'webm';
        }
      }

      files.push(fileRecord);
    }

    if (files.length === 0) return jsonResponse({ error: '파일이 없습니다.' }, 400);

    const rawTitle = (formData.get('title') || '').toString().trim().slice(0, 50);
    const metadata = { id: groupId, title: rawTitle || null, files, createdAt: Date.now() };
    await env.AR_META.put(groupId, JSON.stringify(metadata));

    return jsonResponse({ id: groupId, url: `/ar/${groupId}`, meta: metadata }, 201);
  } catch (err) {
    await rollback();
    return jsonResponse({ error: '업로드 실패: ' + err.message }, 500);
  }
}

// ─── File Serving Handler ────────────────────────────────────────
// iOS Safari는 영상 재생 시 Range 요청 필수 (206 Partial Content)
// Range 없이 200으로 응답하면 Safari에서 영상 재생 불가

async function handleGetFile(env, id, request) {
  try {
    const fileMetaStr = await env.AR_META.get(`file:${id}`);
    if (!fileMetaStr) return jsonResponse({ error: '파일을 찾을 수 없습니다.' }, 404);

    const fileMeta = JSON.parse(fileMetaStr);
    const key = `${id}.${fileMeta.ext}`;
    const isVideo = fileMeta.type.startsWith('video/');

    const rangeHeader = request.headers.get('Range');

    // Range 요청 처리 (iOS Safari / Android Chrome 영상 탐색)
    if (rangeHeader && isVideo) {
      // 전체 크기 확인 (head 요청으로 body 다운로드 없이)
      const head = await env.AR_BUCKET.head(key);
      if (!head) return jsonResponse({ error: '파일을 찾을 수 없습니다.' }, 404);
      const totalSize = head.size;

      const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
      if (!match) {
        return new Response('Invalid Range', {
          status: 416,
          headers: { 'Content-Range': `bytes */${totalSize}` }
        });
      }

      const rawStart = match[1];
      const rawEnd   = match[2];
      let start, end;

      if (rawStart === '') {
        // suffix-range: bytes=-N  → 마지막 N 바이트
        start = totalSize - parseInt(rawEnd, 10);
        end   = totalSize - 1;
      } else {
        start = parseInt(rawStart, 10);
        end   = rawEnd !== '' ? Math.min(parseInt(rawEnd, 10), totalSize - 1) : totalSize - 1;
      }

      if (isNaN(start) || isNaN(end) || start > end || start < 0 || end >= totalSize) {
        return new Response('Range Not Satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${totalSize}` }
        });
      }

      const chunkSize = end - start + 1;
      const object = await env.AR_BUCKET.get(key, {
        range: { offset: start, length: chunkSize }
      });
      if (!object) return jsonResponse({ error: '파일을 찾을 수 없습니다.' }, 404);

      const headers = new Headers();
      headers.set('Content-Type', fileMeta.type);
      headers.set('Content-Range', `bytes ${start}-${end}/${totalSize}`);
      headers.set('Content-Length', String(chunkSize));
      headers.set('Accept-Ranges', 'bytes');
      headers.set('Cache-Control', 'public, max-age=86400');
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(object.body, { status: 206, headers });
    }

    // HEAD 요청 (브라우저가 파일 크기 사전 확인)
    if (request.method === 'HEAD') {
      const head = await env.AR_BUCKET.head(key);
      if (!head) return jsonResponse({ error: '파일을 찾을 수 없습니다.' }, 404);
      const headers = new Headers();
      headers.set('Content-Type', fileMeta.type);
      headers.set('Content-Length', String(head.size));
      headers.set('Accept-Ranges', 'bytes');
      headers.set('Cache-Control', 'public, max-age=86400');
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(null, { status: 200, headers });
    }

    // 일반 GET 요청
    const object = await env.AR_BUCKET.get(key);
    if (!object) return jsonResponse({ error: '파일을 찾을 수 없습니다.' }, 404);

    const headers = new Headers();
    headers.set('Content-Type', fileMeta.type);
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Length', String(object.size));
    headers.set('Cache-Control', 'public, max-age=86400');
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(object.body, { status: 200, headers });
  } catch (err) {
    return jsonResponse({ error: '파일 조회 실패' }, 500);
  }
}

// ─── Metadata Handler ────────────────────────────────────────────

async function handleGetMeta(env, id) {
  try {
    const metaStr = await env.AR_META.get(id);
    if (!metaStr) return jsonResponse({ error: '콘텐츠를 찾을 수 없습니다.' }, 404);

    // 총 조회수 + 일별 조회수 증가
    const today = new Date().toISOString().slice(0, 10);
    try {
      const [total, daily] = await Promise.all([
        env.AR_META.get('views:' + id),
        env.AR_META.get('daily:' + id + ':' + today),
      ]);
      await Promise.all([
        env.AR_META.put('views:' + id, String(parseInt(total || '0') + 1)),
        env.AR_META.put('daily:' + id + ':' + today, String(parseInt(daily || '0') + 1)),
      ]);
    } catch (_) {}

    return jsonResponse(JSON.parse(metaStr));
  } catch (err) {
    return jsonResponse({ error: '메타데이터 조회 실패' }, 500);
  }
}

// ─── Stats Handler ───────────────────────────────────────────────

async function handleGetStats(request, env, id) {

  try {
    const prefix = 'daily:' + id + ':';
    const listed = await env.AR_META.list({ prefix, limit: 365 });
    const entries = await Promise.all(
      listed.keys.map(async k => ({
        date: k.name.slice(prefix.length),
        count: parseInt(await env.AR_META.get(k.name) || '0'),
      }))
    );
    const stats = {};
    for (const e of entries) stats[e.date] = e.count;
    return jsonResponse({ stats }, 200, false);
  } catch (err) {
    return jsonResponse({ error: '통계 조회 실패' }, 500, false);
  }
}

// ─── List Handler ────────────────────────────────────────────────

async function handleList(request, env) {


  try {
    const groups = [];
    let cursor = undefined;
    do {
      const result = await env.AR_META.list({ cursor, limit: 1000 });
      const validKeys = result.keys.filter(k =>
        !k.name.startsWith('file:') && !k.name.startsWith('rl:') &&
        !k.name.startsWith('views:') && !k.name.startsWith('daily:')
      );
      // 순차 읽기(N+1) 대신 병렬 읽기
      const metas = await Promise.all(validKeys.map(k => env.AR_META.get(k.name).catch(() => null)));
      for (const metaStr of metas) {
        if (metaStr) try { groups.push(JSON.parse(metaStr)); } catch (_) {}
      }
      cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);

    groups.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    // 조회수 병렬 조회
    const viewCounts = await Promise.all(
      groups.map(g => env.AR_META.get('views:' + g.id).catch(() => null))
    );
    groups.forEach((g, i) => { g.views = parseInt(viewCounts[i] || '0'); });

    return jsonResponse({ groups }, 200, false);
  } catch (err) {
    return jsonResponse({ error: '목록 조회 실패' }, 500, false);
  }
}

// ─── Project Update Handler ──────────────────────────────────────

async function handleProjectUpdate(request, env, groupId) {

  try {
    const metaStr = await env.AR_META.get(groupId);
    if (!metaStr) return jsonResponse({ error: '찾을 수 없습니다.' }, 404, false);
    const meta = JSON.parse(metaStr);
    const body = await request.json();
    if ('title' in body) meta.title = String(body.title || '').trim().slice(0, 50) || null;
    if (Array.isArray(body.files)) {
      body.files.forEach((update, i) => {
        if (!update || i >= meta.files.length) return;
        const f = meta.files[i];
        if ('color' in update) {
          const c = String(update.color);
          if (/^#[0-9a-fA-F]{6}$/.test(c)) f.color = c;
        }
        if ('similarity' in update) f.similarity = Math.min(0.8, Math.max(0.1, parseFloat(update.similarity) || f.similarity));
        if ('smoothness' in update) f.smoothness = Math.min(0.3, Math.max(0, parseFloat(update.smoothness)));
        if ('audio' in update && f.type.startsWith('video/')) f.audio = Boolean(update.audio);
      });
    }
    meta.updatedAt = Date.now();
    await env.AR_META.put(groupId, JSON.stringify(meta));
    return jsonResponse({ ok: true, meta }, 200, false);
  } catch (err) {
    return jsonResponse({ error: '업데이트 실패: ' + err.message }, 500, false);
  }
}

// ─── File Replace Handler ────────────────────────────────────────

async function handleFileReplace(request, env, groupId, fileIndex) {

  try {
    const metaStr = await env.AR_META.get(groupId);
    if (!metaStr) return jsonResponse({ error: '찾을 수 없습니다.' }, 404, false);
    const meta = JSON.parse(metaStr);
    if (fileIndex < 0 || fileIndex >= meta.files.length) return jsonResponse({ error: '잘못된 파일 인덱스' }, 400, false);
    const formData = await request.formData();
    const file = formData.get('file');
    if (!file || !file.name) return jsonResponse({ error: '파일이 없습니다.' }, 400, false);
    const allowedTypes = ['image/jpeg', 'image/png', 'video/mp4', 'video/webm'];
    if (!allowedTypes.includes(file.type)) return jsonResponse({ error: '지원하지 않는 파일 형식입니다.' }, 400, false);
    if (file.size > 100 * 1024 * 1024) return jsonResponse({ error: '파일 크기는 100MB 이하여야 합니다.' }, 400, false);
    const oldFile = meta.files[fileIndex];
    const newFileId = generateId();
    const newExt = getExtension(file.type);
    await env.AR_BUCKET.put(`${newFileId}.${newExt}`, file.stream(), { httpMetadata: { contentType: file.type } });
    await env.AR_META.put(`file:${newFileId}`, JSON.stringify({ ext: newExt, type: file.type }));
    await env.AR_BUCKET.delete(`${oldFile.id}.${oldFile.ext}`).catch(() => {});
    await env.AR_META.delete(`file:${oldFile.id}`).catch(() => {});
    const rawName = (file.name || '').toString().trim().slice(0, 100).replace(/[<>"'&]/g, '');
    const isVideo = file.type.startsWith('video/');
    meta.files[fileIndex] = {
      id: newFileId,
      filename: rawName || `file${fileIndex + 1}`,
      type: file.type,
      ext: newExt,
      size: file.size,
      color: oldFile.color || '#00ff00',
      similarity: oldFile.similarity || 0.4,
      smoothness: oldFile.smoothness || 0.1,
      audio: isVideo && (oldFile.audio || false),
    };
    meta.updatedAt = Date.now();
    await env.AR_META.put(groupId, JSON.stringify(meta));
    return jsonResponse({ ok: true, file: meta.files[fileIndex] }, 200, false);
  } catch (err) {
    return jsonResponse({ error: '파일 교체 실패: ' + err.message }, 500, false);
  }
}

// ─── Android Variant Upload Handler ─────────────────────────────

async function handleAndroidVariantUpload(request, env, groupId, fileIndex) {

  try {
    const metaStr = await env.AR_META.get(groupId);
    if (!metaStr) return jsonResponse({ error: '찾을 수 없습니다.' }, 404, false);
    const meta = JSON.parse(metaStr);
    if (fileIndex < 0 || fileIndex >= meta.files.length) return jsonResponse({ error: '잘못된 파일 인덱스' }, 400, false);

    const formData = await request.formData();
    const file = formData.get('file');
    if (!file || !file.name) return jsonResponse({ error: '파일이 없습니다.' }, 400, false);
    if (file.type !== 'video/webm') return jsonResponse({ error: 'WebM 파일만 업로드 가능합니다.' }, 400, false);
    if (file.size > 100 * 1024 * 1024) return jsonResponse({ error: '파일 크기는 100MB 이하여야 합니다.' }, 400, false);

    // 기존 android variant 삭제
    const oldFile = meta.files[fileIndex];
    if (oldFile.androidId) {
      await env.AR_BUCKET.delete(`${oldFile.androidId}.${oldFile.androidExt}`).catch(() => {});
      await env.AR_META.delete(`file:${oldFile.androidId}`).catch(() => {});
    }

    const androidId = generateId();
    await env.AR_BUCKET.put(`${androidId}.webm`, file.stream(), { httpMetadata: { contentType: 'video/webm' } });
    await env.AR_META.put(`file:${androidId}`, JSON.stringify({ ext: 'webm', type: 'video/webm' }));

    meta.files[fileIndex].androidId  = androidId;
    meta.files[fileIndex].androidExt = 'webm';
    meta.updatedAt = Date.now();
    await env.AR_META.put(groupId, JSON.stringify(meta));
    return jsonResponse({ ok: true, androidId }, 200, false);
  } catch (err) {
    return jsonResponse({ error: '업로드 실패: ' + err.message }, 500, false);
  }
}

// ─── Android Variant Delete Handler ─────────────────────────────

async function handleAndroidVariantDelete(request, env, groupId, fileIndex) {

  try {
    const metaStr = await env.AR_META.get(groupId);
    if (!metaStr) return jsonResponse({ error: '찾을 수 없습니다.' }, 404, false);
    const meta = JSON.parse(metaStr);
    if (fileIndex < 0 || fileIndex >= meta.files.length) return jsonResponse({ error: '잘못된 파일 인덱스' }, 400, false);

    const f = meta.files[fileIndex];
    if (!f.androidId) return jsonResponse({ error: 'android variant가 없습니다.' }, 404, false);

    await env.AR_BUCKET.delete(`${f.androidId}.${f.androidExt}`).catch(() => {});
    await env.AR_META.delete(`file:${f.androidId}`).catch(() => {});
    delete meta.files[fileIndex].androidId;
    delete meta.files[fileIndex].androidExt;
    meta.updatedAt = Date.now();
    await env.AR_META.put(groupId, JSON.stringify(meta));
    return jsonResponse({ ok: true }, 200, false);
  } catch (err) {
    return jsonResponse({ error: '삭제 실패: ' + err.message }, 500, false);
  }
}

// ─── Delete Handler ──────────────────────────────────────────────

async function handleDelete(request, env, groupId) {


  try {
    const metaStr = await env.AR_META.get(groupId);
    if (!metaStr) return jsonResponse({ error: '찾을 수 없습니다.' }, 404, false);

    const meta = JSON.parse(metaStr);
    await deleteGroup(env, meta);
    return jsonResponse({ ok: true, deleted: groupId }, 200, false);
  } catch (err) {
    return jsonResponse({ error: '삭제 실패: ' + err.message }, 500, false);
  }
}

// ─── Group Delete Helper ─────────────────────────────────────────

/**
 * 그룹에 속한 R2 파일 + KV 항목을 모두 삭제 (handleDelete/만료 공용)
 * @param {any} env
 * @param {{ id: string, files: Array<{id:string, ext:string}> }} meta
 */
async function deleteGroup(env, meta) {
  await Promise.all(meta.files.flatMap(file => {
    const ops = [
      env.AR_BUCKET.delete(`${file.id}.${file.ext}`),
      env.AR_META.delete(`file:${file.id}`),
    ];
    if (file.androidId) {
      ops.push(env.AR_BUCKET.delete(`${file.androidId}.${file.androidExt}`).catch(() => {}));
      ops.push(env.AR_META.delete(`file:${file.androidId}`).catch(() => {}));
    }
    return ops;
  }));
  await env.AR_META.delete(meta.id);
}

// ─── HTML 서빙 (보안 헤더 포함) ──────────────────────────────────

async function serveHtml(env, request, htmlPath) {
  const url = new URL(htmlPath, request.url);
  const res = await env.ASSETS.fetch(new Request(url, request));
  if (!res.ok) return res;
  const headers = new Headers(res.headers);
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'wasm-unsafe-eval'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' blob: data:; " +
    "media-src 'self' blob:; " +
    "connect-src 'self'; " +
    "worker-src blob: 'self'; " +
    "object-src 'none'; " +
    "frame-ancestors 'none';"
  );
  return new Response(res.body, { status: res.status, headers });
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

// cors=false: 관리 전용 엔드포인트 (list, delete) — 크로스오리진 접근 차단
function jsonResponse(data, status = 200, cors = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (cors) headers['Access-Control-Allow-Origin'] = '*';
  return new Response(JSON.stringify(data), { status, headers });
}

// 관리 경로(list, delete)는 Access-Control-Allow-Origin 헤더 미포함 → 브라우저가 크로스오리진 차단
function handleCORS(path) {
  const isAdmin = path === '/api/list'
    || /^\/api\/delete\/[a-z0-9]+$/.test(path)
    || /^\/api\/project\/[a-z0-9]+(\/file\/\d+(\/android)?)?$/.test(path);
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, PATCH, OPTIONS, HEAD',
    'Access-Control-Allow-Headers': 'Content-Type, Range',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    'Access-Control-Max-Age': '86400'
  };
  if (!isAdmin) headers['Access-Control-Allow-Origin'] = '*';
  return new Response(null, { headers });
}
