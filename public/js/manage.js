const loginSection = document.getElementById('login-section');
const listSection  = document.getElementById('list-section');
const secretInput  = document.getElementById('secret-input');
const loginBtn     = document.getElementById('login-btn');
const loginError   = document.getElementById('login-error');
const logoutBtn    = document.getElementById('logout-btn');
const groupList    = document.getElementById('group-list');
const emptyMsg     = document.getElementById('empty-msg');

let secret = '';

loginBtn.addEventListener('click', () => {
    secret = secretInput.value.trim();
    if (!secret) return;
    tryLoad();
});

secretInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') loginBtn.click();
});

logoutBtn.addEventListener('click', () => {
    secret = '';
    listSection.classList.add('hidden');
    loginSection.classList.remove('hidden');
    secretInput.value = '';
});

async function tryLoad() {
    loginError.classList.add('hidden');
    const res = await fetch('/api/list', { headers: { 'X-Delete-Secret': secret } });
    if (res.status === 403) { loginError.classList.remove('hidden'); return; }
    loginSection.classList.add('hidden');
    listSection.classList.remove('hidden');
    const data = await res.json();
    renderGroups(data.groups || []);
}

function renderGroups(groups) {
    groupList.innerHTML = '';
    if (groups.length === 0) { emptyMsg.classList.remove('hidden'); return; }
    emptyMsg.classList.add('hidden');
    for (const g of groups) {
        const card = document.createElement('div');
        card.className = 'card';
        const date  = g.createdAt ? new Date(g.createdAt).toLocaleString('ko-KR') : '날짜 없음';
        const views = g.views || 0;
        const title = g.title || '(제목 없음)';
        const arUrl = `${location.origin}/ar/${g.id}`;
        const fileItems = g.files.map(f => {
            const icon = f.type.startsWith('video/') ? '🎬' : '🖼️';
            const size = (f.size / 1024 / 1024).toFixed(1);
            return `<span class="file-tag">${icon} ${escHtml(f.filename)} (${size}MB)</span>`;
        }).join('');
        const previews = g.files.map(f => {
            if (f.type.startsWith('image/')) {
                return `<img src="/api/file/${f.id}" class="thumb" loading="lazy" alt="${escHtml(f.filename)}">`;
            }
            return `<video src="/api/file/${f.id}" class="thumb" preload="metadata" muted playsinline></video>`;
        }).join('');
        card.innerHTML = `
            <div class="card-top">
                <div class="card-info">
                    <div class="card-title">${escHtml(title)}</div>
                    <div class="card-date">${date} &nbsp;·&nbsp; 조회수 ${views.toLocaleString()}회</div>
                    <div class="thumb-row">${previews}</div>
                    <div class="card-files">${fileItems}</div>
                </div>
                <div class="card-btns">
                    <button class="edit-btn">편집</button>
                    <button class="stats-btn">통계</button>
                    <button class="del-btn">삭제</button>
                </div>
            </div>
            <div class="stats-panel hidden"></div>
            <div class="card-link">
                <input type="text" readonly value="${arUrl}">
                <button class="copy-btn">복사</button>
                <a href="${arUrl}" target="_blank" class="open-btn">열기</a>
            </div>
        `;
        card.querySelector('.edit-btn').addEventListener('click', () => {
            const existing = card.querySelector('.edit-panel');
            if (existing) { existing.remove(); return; }
            openEditPanel(g, card);
        });
        card.querySelector('.del-btn').addEventListener('click', () => deleteGroup(g.id, card));
        card.querySelector('.stats-btn').addEventListener('click', () => toggleStats(g.id, card));
        card.querySelector('.copy-btn').addEventListener('click', () => {
            navigator.clipboard.writeText(arUrl);
            const btn = card.querySelector('.copy-btn');
            btn.textContent = '복사됨!';
            setTimeout(() => btn.textContent = '복사', 1500);
        });
        groupList.appendChild(card);
    }
}

function openEditPanel(g, card) {
    const panel = document.createElement('div');
    panel.className = 'edit-panel';
    const filesHtml = g.files.map((f, i) => {
        const isVideo = f.type.startsWith('video/');
        const icon = isVideo ? '🎬' : '🖼️';
        const sim  = (f.similarity  || 0.4).toFixed(2);
        const smo  = (f.smoothness  || 0.1).toFixed(2);
        return `
        <div class="ep-file" data-index="${i}">
            <div class="ep-file-name">${icon} ${escHtml(f.filename)}</div>
            <div class="ep-controls">
                <div class="ep-row">
                    <span class="ep-label">크로마키 색상</span>
                    <input type="color" class="ep-color" value="${f.color || '#00ff00'}">
                </div>
                <div class="ep-row">
                    <span class="ep-label">유사도 <em class="ep-val">${sim}</em></span>
                    <input type="range" class="ep-range ep-similarity" min="0.1" max="0.8" step="0.01" value="${f.similarity || 0.4}">
                </div>
                <div class="ep-row">
                    <span class="ep-label">부드러움 <em class="ep-val">${smo}</em></span>
                    <input type="range" class="ep-range ep-smoothness" min="0" max="0.3" step="0.01" value="${f.smoothness || 0.1}">
                </div>
                ${isVideo ? `
                <div class="ep-row">
                    <span class="ep-label">소리 재생</span>
                    <label class="ep-switch">
                        <input type="checkbox" class="ep-audio"${f.audio ? ' checked' : ''}>
                        <span class="ep-slider"></span>
                    </label>
                </div>` : ''}
                <button class="ep-replace-btn" data-index="${i}">📁 파일 교체</button>
                <input type="file" class="ep-replace-input" accept=".jpg,.jpeg,.png,.mp4,.webm,image/jpeg,image/png,video/mp4,video/webm" style="display:none">
                ${isVideo ? `
                <div class="ep-android-section" data-index="${i}">
                    <div class="ep-android-label">안드로이드용 WebM alpha</div>
                    ${f.androidId
                        ? `<div class="ep-android-registered">
                               <span class="ep-android-badge">등록됨</span>
                               <button class="ep-android-replace-btn" data-index="${i}">교체</button>
                               <button class="ep-android-remove-btn" data-index="${i}">제거</button>
                           </div>`
                        : `<button class="ep-android-add-btn" data-index="${i}">+ WebM 추가</button>`
                    }
                    <input type="file" class="ep-android-input" accept=".webm,video/webm" style="display:none">
                </div>` : ''}
            </div>
        </div>`;
    }).join('');
    panel.innerHTML = `
        <div class="ep-section-title">제목</div>
        <input type="text" class="ep-input ep-title" value="${escHtml(g.title || '')}" maxlength="50" placeholder="(제목 없음)">
        <div class="ep-section-title" style="margin-top:14px">파일 설정</div>
        ${filesHtml}
        <div class="ep-actions">
            <button class="ep-save-btn">저장</button>
            <button class="ep-cancel-btn">닫기</button>
        </div>
    `;
    panel.querySelectorAll('.ep-range').forEach(input => {
        input.addEventListener('input', () => {
            const val = input.closest('.ep-row').querySelector('.ep-val');
            if (val) val.textContent = parseFloat(input.value).toFixed(2);
        });
    });
    panel.querySelectorAll('.ep-replace-btn').forEach(btn => {
        const fileInput = btn.nextElementSibling;
        btn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', async () => {
            const file = fileInput.files[0];
            if (!file) return;
            const idx = parseInt(btn.dataset.index);
            btn.textContent = '교체 중...';
            btn.disabled = true;
            await replaceFile(g, idx, file, btn, card);
            fileInput.value = '';
        });
    });
    panel.querySelector('.ep-save-btn').addEventListener('click', () => saveMetaEdits(g, panel, card));
    panel.querySelector('.ep-cancel-btn').addEventListener('click', () => panel.remove());

    // ─── Android variant 버튼 이벤트 ──────────────────────────
    panel.querySelectorAll('.ep-android-section').forEach(section => {
        const idx = parseInt(section.dataset.index);
        const fileInput = section.querySelector('.ep-android-input');

        function attachAndroidBtns() {
            const addBtn     = section.querySelector('.ep-android-add-btn');
            const replaceBtn = section.querySelector('.ep-android-replace-btn');
            const removeBtn  = section.querySelector('.ep-android-remove-btn');

            if (addBtn)     addBtn.addEventListener('click', () => fileInput.click());
            if (replaceBtn) replaceBtn.addEventListener('click', () => fileInput.click());
            if (removeBtn)  removeBtn.addEventListener('click', () => removeAndroidVariant(g, idx, section));
        }

        fileInput.addEventListener('change', async () => {
            const file = fileInput.files[0];
            if (!file) return;
            await uploadAndroidVariant(g, idx, file, section);
            fileInput.value = '';
        });

        attachAndroidBtns();
    });

    card.appendChild(panel);
}

async function saveMetaEdits(g, panel, card) {
    const saveBtn = panel.querySelector('.ep-save-btn');
    saveBtn.textContent = '저장 중...';
    saveBtn.disabled = true;
    const title = panel.querySelector('.ep-title').value.trim();
    const fileUpdates = [];
    panel.querySelectorAll('.ep-file').forEach(el => {
        const update = {
            color:      el.querySelector('.ep-color').value,
            similarity: parseFloat(el.querySelector('.ep-similarity').value),
            smoothness: parseFloat(el.querySelector('.ep-smoothness').value),
        };
        const audioEl = el.querySelector('.ep-audio');
        if (audioEl) update.audio = audioEl.checked;
        fileUpdates.push(update);
    });
    try {
        const res = await fetch(`/api/project/${g.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Delete-Secret': secret },
            body: JSON.stringify({ title, files: fileUpdates }),
        });
        if (res.ok) {
            const data = await res.json();
            g.title = data.meta.title;
            g.files  = data.meta.files;
            card.querySelector('.card-title').textContent = g.title || '(제목 없음)';
            saveBtn.textContent = '저장됨!';
            setTimeout(() => { saveBtn.textContent = '저장'; saveBtn.disabled = false; }, 1500);
        } else {
            const err = await res.json().catch(() => ({}));
            alert(err.error || '저장 실패');
            saveBtn.textContent = '저장';
            saveBtn.disabled = false;
        }
    } catch {
        alert('저장 실패');
        saveBtn.textContent = '저장';
        saveBtn.disabled = false;
    }
}

async function replaceFile(g, fileIndex, file, btn, card) {
    const fd = new FormData();
    fd.append('file', file);
    try {
        const res = await fetch(`/api/project/${g.id}/file/${fileIndex}`, {
            method: 'PATCH',
            headers: { 'X-Delete-Secret': secret },
            body: fd,
        });
        if (res.ok) {
            const data = await res.json();
            g.files[fileIndex] = data.file;
            const thumbs = card.querySelectorAll('.thumb');
            if (thumbs[fileIndex]) {
                const newSrc  = `/api/file/${data.file.id}`;
                const isVideo = data.file.type.startsWith('video/');
                if (isVideo && thumbs[fileIndex].tagName === 'IMG') {
                    const v = document.createElement('video');
                    v.src = newSrc; v.className = 'thumb'; v.muted = true; v.playsInline = true; v.preload = 'metadata';
                    thumbs[fileIndex].replaceWith(v);
                } else if (!isVideo && thumbs[fileIndex].tagName === 'VIDEO') {
                    const img = document.createElement('img');
                    img.src = newSrc; img.className = 'thumb'; img.loading = 'lazy';
                    thumbs[fileIndex].replaceWith(img);
                } else {
                    thumbs[fileIndex].src = newSrc + '?t=' + Date.now();
                }
            }
            const tags = card.querySelectorAll('.file-tag');
            if (tags[fileIndex]) {
                const icon = data.file.type.startsWith('video/') ? '🎬' : '🖼️';
                const size = (data.file.size / 1024 / 1024).toFixed(1);
                tags[fileIndex].textContent = `${icon} ${data.file.filename} (${size}MB)`;
            }
            const epFile = btn.closest('.ep-file');
            if (epFile) {
                const nameEl = epFile.querySelector('.ep-file-name');
                if (nameEl) nameEl.textContent = (data.file.type.startsWith('video/') ? '🎬 ' : '🖼️ ') + data.file.filename;
            }
            btn.textContent = '✓ 교체됨!';
            setTimeout(() => { btn.textContent = '📁 파일 교체'; btn.disabled = false; }, 1500);
        } else {
            const err = await res.json().catch(() => ({}));
            alert(err.error || '파일 교체 실패');
            btn.textContent = '📁 파일 교체';
            btn.disabled = false;
        }
    } catch {
        alert('파일 교체 실패');
        btn.textContent = '📁 파일 교체';
        btn.disabled = false;
    }
}

async function uploadAndroidVariant(g, fileIndex, file, section) {
    const ctrl = section.querySelector('.ep-android-registered, .ep-android-add-btn');
    const prevHtml = section.innerHTML.replace(/<input[^>]*>/, '');
    const fileInputEl = section.querySelector('.ep-android-input');
    if (ctrl) { ctrl.style.opacity = '0.5'; ctrl.style.pointerEvents = 'none'; }

    const statusEl = section.querySelector('.ep-android-add-btn') || section.querySelector('.ep-android-replace-btn');
    if (statusEl) statusEl.textContent = '업로드 중...';

    const fd = new FormData();
    fd.append('file', file);
    try {
        const res = await fetch(`/api/project/${g.id}/file/${fileIndex}/android`, {
            method: 'PATCH',
            headers: { 'X-Delete-Secret': secret },
            body: fd,
        });
        if (res.ok) {
            const data = await res.json();
            g.files[fileIndex].androidId  = data.androidId;
            g.files[fileIndex].androidExt = 'webm';
            section.innerHTML = `
                <div class="ep-android-label">안드로이드용 WebM alpha</div>
                <div class="ep-android-registered">
                    <span class="ep-android-badge">등록됨</span>
                    <button class="ep-android-replace-btn" data-index="${fileIndex}">교체</button>
                    <button class="ep-android-remove-btn" data-index="${fileIndex}">제거</button>
                </div>
                <input type="file" class="ep-android-input" accept=".webm,video/webm" style="display:none">
            `;
            section.querySelector('.ep-android-replace-btn').addEventListener('click', () => section.querySelector('.ep-android-input').click());
            section.querySelector('.ep-android-remove-btn').addEventListener('click', () => removeAndroidVariant(g, fileIndex, section));
            section.querySelector('.ep-android-input').addEventListener('change', async (e) => {
                const f = e.target.files[0];
                if (!f) return;
                await uploadAndroidVariant(g, fileIndex, f, section);
                e.target.value = '';
            });
        } else {
            const err = await res.json().catch(() => ({}));
            alert(err.error || '업로드 실패');
            if (ctrl) { ctrl.style.opacity = ''; ctrl.style.pointerEvents = ''; }
            if (statusEl) statusEl.textContent = g.files[fileIndex].androidId ? '교체' : '+ WebM 추가';
        }
    } catch {
        alert('업로드 실패');
        if (ctrl) { ctrl.style.opacity = ''; ctrl.style.pointerEvents = ''; }
        if (statusEl) statusEl.textContent = g.files[fileIndex].androidId ? '교체' : '+ WebM 추가';
    }
}

async function removeAndroidVariant(g, fileIndex, section) {
    const removeBtn = section.querySelector('.ep-android-remove-btn');
    if (removeBtn) { removeBtn.textContent = '제거 중...'; removeBtn.disabled = true; }
    try {
        const res = await fetch(`/api/project/${g.id}/file/${fileIndex}/android`, {
            method: 'DELETE',
            headers: { 'X-Delete-Secret': secret },
        });
        if (res.ok) {
            delete g.files[fileIndex].androidId;
            delete g.files[fileIndex].androidExt;
            section.innerHTML = `
                <div class="ep-android-label">안드로이드용 WebM alpha</div>
                <button class="ep-android-add-btn" data-index="${fileIndex}">+ WebM 추가</button>
                <input type="file" class="ep-android-input" accept=".webm,video/webm" style="display:none">
            `;
            section.querySelector('.ep-android-add-btn').addEventListener('click', () => section.querySelector('.ep-android-input').click());
            section.querySelector('.ep-android-input').addEventListener('change', async (e) => {
                const f = e.target.files[0];
                if (!f) return;
                await uploadAndroidVariant(g, fileIndex, f, section);
                e.target.value = '';
            });
        } else {
            const err = await res.json().catch(() => ({}));
            alert(err.error || '제거 실패');
            if (removeBtn) { removeBtn.textContent = '제거'; removeBtn.disabled = false; }
        }
    } catch {
        alert('제거 실패');
        if (removeBtn) { removeBtn.textContent = '제거'; removeBtn.disabled = false; }
    }
}

async function deleteGroup(id, card) {
    if (!confirm('이 항목을 삭제하시겠습니까?')) return;
    const btn = card.querySelector('.del-btn');
    btn.textContent = '삭제 중...';
    btn.disabled = true;
    const res = await fetch(`/api/delete/${id}`, { method: 'DELETE', headers: { 'X-Delete-Secret': secret } });
    if (res.ok) {
        card.classList.add('removing');
        setTimeout(() => { card.remove(); if (!groupList.querySelector('.card')) emptyMsg.classList.remove('hidden'); }, 300);
    } else {
        btn.textContent = '삭제'; btn.disabled = false; alert('삭제 실패');
    }
}

function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── 통계 그래프 ────────────────────────────────────────────────

async function toggleStats(id, card) {
    const panel = card.querySelector('.stats-panel');
    const btn   = card.querySelector('.stats-btn');
    if (!panel.classList.contains('hidden')) {
        panel.classList.add('hidden');
        btn.textContent = '통계';
        return;
    }
    btn.textContent = '로딩 중...';
    btn.disabled = true;
    try {
        const res = await fetch('/api/stats/' + id, { headers: { 'X-Delete-Secret': secret } });
        if (!res.ok) throw new Error();
        const { stats } = await res.json();
        panel.innerHTML = renderStatsChart(stats);
        panel.classList.remove('hidden');
        btn.textContent = '통계 닫기';
    } catch {
        alert('통계 조회 실패');
        btn.textContent = '통계';
    }
    btn.disabled = false;
}

function renderStatsChart(stats) {
    const days = [];
    for (let i = 29; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        days.push({ date: key, count: stats[key] || 0 });
    }
    const maxCount = Math.max(...days.map(d => d.count), 1);

    const W = 600, H = 150;
    const cX = 36, cY = 12, cW = 552, cH = 90;
    const barW = cW / 30;
    const gap  = 3;

    const bars = days.map((d, i) => {
        const barH = Math.max(2, Math.round((d.count / maxCount) * cH));
        const x = cX + i * barW + gap / 2;
        const y = cY + cH - barH;
        const w = barW - gap;
        const fill = d.count > 0 ? '#6366f1' : '#e5e7eb';
        return `<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${barH}" fill="${fill}" rx="2"><title>${d.date}: ${d.count}회</title></rect>`;
    }).join('');

    const xLabels = [];
    [0, 5, 10, 15, 20, 25, 29].forEach(i => {
        const x = (cX + i * barW + barW / 2).toFixed(1);
        xLabels.push(`<text x="${x}" y="${cY + cH + 16}" text-anchor="middle" font-size="9" fill="#9ca3af">${days[i].date.slice(5)}</text>`);
    });

    const yLines = [0.25, 0.5, 0.75, 1].map(r => {
        const y = (cY + cH - r * cH).toFixed(1);
        const label = Math.round(maxCount * r);
        return `<line x1="${cX}" y1="${y}" x2="${cX + cW}" y2="${y}" stroke="#f3f4f6" stroke-width="1"/>
<text x="${(cX - 4)}" y="${y}" text-anchor="end" dominant-baseline="middle" font-size="9" fill="#9ca3af">${label}</text>`;
    }).join('');

    const axisLine = `<line x1="${cX}" y1="${cY + cH}" x2="${cX + cW}" y2="${cY + cH}" stroke="#e5e7eb" stroke-width="1"/>`;
    const total = days.reduce((s, d) => s + d.count, 0);
    const summary = `<text x="${cX + cW}" y="${cY - 2}" text-anchor="end" font-size="10" fill="#6b7280">최근 30일 합계: ${total.toLocaleString()}회</text>`;

    return `<div style="padding:12px 0 4px">
<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;">${yLines}${axisLine}${bars}${xLabels.join('')}${summary}</svg>
</div>`;
}
