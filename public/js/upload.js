(function () {
    'use strict';

    const MAX_SLOTS = 3;
    const slots = []; // { file, color, similarity, smoothness, audio, mediaEl }
    let previewingIdx = -1;
    let previewingRAF = null;

    // DOM
    const slotsContainer = document.getElementById('slots-container');
    const addSlotBtn     = document.getElementById('add-slot-btn');
    const previewSection = document.getElementById('preview-section');
    const previewCanvas  = document.getElementById('preview-canvas');
    const previewCtx     = previewCanvas.getContext('2d');
    const offCanvas      = document.createElement('canvas');
    const offCtx         = offCanvas.getContext('2d');
    const generateSection = document.getElementById('generate-section');
    const generateBtn    = document.getElementById('generate-btn');
    const uploadProgress = document.getElementById('upload-progress');
    const progressFill   = document.getElementById('progress-fill');
    const progressText   = document.getElementById('progress-text');
    const resultSection  = document.getElementById('result-section');
    const resultLink     = document.getElementById('result-link');
    const copyLinkBtn    = document.getElementById('copy-link-btn');
    const openArLink     = document.getElementById('open-ar-link');
    const newUploadBtn   = document.getElementById('new-upload-btn');

    // 첫 슬롯 생성
    createSlot();

    // ─── 슬롯 생성 ───────────────────────────────────────────────

    function createSlot() {
        const idx = slots.length;
        slots.push({ file: null, color: '#00ff00', similarity: 0.4, smoothness: 0.1, audio: false, mediaEl: null });

        const div = document.createElement('div');
        div.className = 'file-slot';
        div.dataset.idx = idx;
        div.innerHTML = `
            <div class="slot-dropzone" id="dz-${idx}">
                <p>파일을 여기에 끌어다 놓거나<br>아래 버튼으로 선택하세요</p>
                <small>JPG &middot; PNG &middot; MP4 &middot; WEBM &middot; 50MB 이하</small>
                <input type="file" id="fi-${idx}" accept="image/jpeg,image/png,video/mp4,video/webm" hidden>
                <button class="select-btn" data-idx="${idx}">파일 선택</button>
            </div>
            <div class="slot-config hidden" id="sc-${idx}">
                <div class="config-header">
                    <span class="slot-num">파일 ${idx + 1}</span>
                    <span class="slot-fname" id="fn-${idx}"></span>
                    <button class="remove-btn" data-idx="${idx}">×</button>
                </div>
                <div class="audio-row hidden" id="ar-${idx}">
                    <span class="audio-label">소리</span>
                    <label class="switch">
                        <input type="checkbox" id="aud-${idx}">
                        <span class="switch-track"></span>
                    </label>
                </div>
                <div class="color-presets" id="cp-${idx}">
                    <button class="color-preset active" data-color="#00ff00" style="background:#00ff00" title="초록">초록</button>
                    <button class="color-preset" data-color="#0000ff" style="background:#0000ff;color:#fff" title="파랑">파랑</button>
                    <button class="color-preset" data-color="#ff0000" style="background:#ff0000;color:#fff" title="빨강">빨강</button>
                    <button class="color-preset" data-color="#ffffff" style="background:#fff;border:1px solid #888" title="흰색">흰색</button>
                    <button class="color-preset" data-color="#000000" style="background:#000;color:#fff" title="검정">검정</button>
                    <input type="color" class="custom-color" id="cc-${idx}" value="#00ff00">
                </div>
                <div class="slider-group">
                    <label>색상 허용 범위 <span class="range-val" id="sv-${idx}">0.40</span></label>
                    <input type="range" id="ss-${idx}" min="0.1" max="0.8" step="0.05" value="0.4">
                </div>
                <div class="slider-group">
                    <label>경계 부드러움 <span class="range-val" id="smv-${idx}">0.10</span></label>
                    <input type="range" id="sms-${idx}" min="0.0" max="0.3" step="0.02" value="0.1">
                </div>
                <button class="preview-btn" data-idx="${idx}">미리보기</button>
            </div>`;
        slotsContainer.appendChild(div);
        bindEvents(idx, div);
    }

    function bindEvents(idx, div) {
        const dz          = div.querySelector(`#dz-${idx}`);
        const fi          = div.querySelector(`#fi-${idx}`);
        const selectBtn   = div.querySelector('.select-btn');
        const removeBtn   = div.querySelector('.remove-btn');
        const audioChk    = div.querySelector(`#aud-${idx}`);
        const presets     = div.querySelectorAll('.color-preset');
        const customColor = div.querySelector(`#cc-${idx}`);
        const simSlider   = div.querySelector(`#ss-${idx}`);
        const smoothSlider = div.querySelector(`#sms-${idx}`);
        const previewBtn  = div.querySelector('.preview-btn');

        selectBtn.addEventListener('click', () => fi.click());
        dz.addEventListener('click', e => { if (e.target !== selectBtn) fi.click(); });
        fi.addEventListener('change', e => { if (e.target.files[0]) selectFile(idx, e.target.files[0]); });

        dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
        dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
        dz.addEventListener('drop', e => {
            e.preventDefault(); dz.classList.remove('dragover');
            if (e.dataTransfer.files[0]) selectFile(idx, e.dataTransfer.files[0]);
        });

        removeBtn.addEventListener('click', () => clearSlot(idx));
        audioChk.addEventListener('change', e => { slots[idx].audio = e.target.checked; });

        presets.forEach(btn => {
            btn.addEventListener('click', () => {
                presets.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                slots[idx].color = btn.dataset.color;
                customColor.value = btn.dataset.color;
                if (previewingIdx === idx) renderFrame(idx);
            });
        });

        customColor.addEventListener('input', e => {
            presets.forEach(b => b.classList.remove('active'));
            slots[idx].color = e.target.value;
            if (previewingIdx === idx) renderFrame(idx);
        });

        simSlider.addEventListener('input', e => {
            slots[idx].similarity = parseFloat(e.target.value);
            div.querySelector(`#sv-${idx}`).textContent = slots[idx].similarity.toFixed(2);
            if (previewingIdx === idx) renderFrame(idx);
        });

        smoothSlider.addEventListener('input', e => {
            slots[idx].smoothness = parseFloat(e.target.value);
            div.querySelector(`#smv-${idx}`).textContent = slots[idx].smoothness.toFixed(2);
            if (previewingIdx === idx) renderFrame(idx);
        });

        previewBtn.addEventListener('click', () => showPreview(idx));
    }

    // ─── 파일 선택 ───────────────────────────────────────────────

    function selectFile(idx, file) {
        const allowed = ['image/jpeg', 'image/png', 'video/mp4', 'video/webm'];
        if (!allowed.includes(file.type)) { alert('지원하지 않는 파일 형식입니다.\n(jpg, png, mp4, webm만 가능)'); return; }
        if (file.size > 50 * 1024 * 1024) { alert('파일 크기는 50MB 이하여야 합니다.'); return; }

        const slot = slots[idx];
        if (slot.mediaEl && slot.mediaEl.tagName === 'VIDEO') {
            slot.mediaEl.pause();
            URL.revokeObjectURL(slot.mediaEl.src);
        }
        slot.file = file;
        slot.mediaEl = null;

        const div = slotsContainer.querySelector(`[data-idx="${idx}"]`);
        div.querySelector(`#dz-${idx}`).classList.add('hidden');
        div.querySelector(`#sc-${idx}`).classList.remove('hidden');
        div.querySelector(`#fn-${idx}`).textContent = `${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`;

        const isVideo = file.type.startsWith('video/');
        div.querySelector(`#ar-${idx}`).classList.toggle('hidden', !isVideo);
        if (!isVideo) { slot.audio = false; div.querySelector(`#aud-${idx}`).checked = false; }

        const url = URL.createObjectURL(file);
        if (isVideo) {
            const v = document.createElement('video');
            v.muted = true; v.loop = true; v.playsInline = true; v.src = url;
            v.addEventListener('loadeddata', () => { slot.mediaEl = v; v.play(); }, { once: true });
            v.load();
        } else {
            const img = new Image();
            img.onload = () => { slot.mediaEl = img; };
            img.src = url;
        }
        updateUI();
    }

    function clearSlot(idx) {
        const slot = slots[idx];
        if (slot.mediaEl && slot.mediaEl.tagName === 'VIDEO') {
            slot.mediaEl.pause();
            URL.revokeObjectURL(slot.mediaEl.src);
        }
        slot.file = null; slot.mediaEl = null; slot.audio = false;

        const div = slotsContainer.querySelector(`[data-idx="${idx}"]`);
        div.querySelector(`#dz-${idx}`).classList.remove('hidden');
        div.querySelector(`#sc-${idx}`).classList.add('hidden');
        div.querySelector(`#fi-${idx}`).value = '';
        div.querySelector(`#aud-${idx}`).checked = false;

        if (previewingIdx === idx) {
            previewingIdx = -1;
            if (previewingRAF) { cancelAnimationFrame(previewingRAF); previewingRAF = null; }
            previewSection.classList.add('hidden');
        }
        updateUI();
    }

    function updateUI() {
        const filled = slots.filter(s => s.file !== null);
        const allFilled = slots.length > 0 && slots.every(s => s.file !== null);
        addSlotBtn.classList.toggle('hidden', !(allFilled && slots.length < MAX_SLOTS));
        generateSection.classList.toggle('hidden', filled.length === 0);
    }

    addSlotBtn.addEventListener('click', () => {
        if (slots.length < MAX_SLOTS) { createSlot(); updateUI(); }
    });

    // ─── 미리보기 ─────────────────────────────────────────────────

    function showPreview(idx) {
        const slot = slots[idx];
        if (!slot.mediaEl) { alert('파일이 아직 로드 중입니다.'); return; }

        if (previewingRAF) { cancelAnimationFrame(previewingRAF); previewingRAF = null; }
        previewingIdx = idx;
        previewSection.classList.remove('hidden');
        previewSection.scrollIntoView({ behavior: 'smooth' });

        const media = slot.mediaEl;
        const isVideo = media.tagName === 'VIDEO';
        const maxW = Math.min(480, window.innerWidth - 32);
        const w = isVideo ? media.videoWidth : media.width;
        const h = isVideo ? media.videoHeight : media.height;
        const scale = w > maxW ? maxW / w : 1;
        previewCanvas.width = Math.round(w * scale);
        previewCanvas.height = Math.round(h * scale);
        offCanvas.width = previewCanvas.width;
        offCanvas.height = previewCanvas.height;

        if (isVideo) {
            (function loop() {
                if (previewingIdx !== idx) return;
                renderFrame(idx);
                previewingRAF = requestAnimationFrame(loop);
            })();
        } else {
            renderFrame(idx);
        }
    }

    function renderFrame(idx) {
        const slot = slots[idx];
        if (!slot.mediaEl) return;
        const w = previewCanvas.width, h = previewCanvas.height;

        // 체크무늬 배경
        previewCtx.fillStyle = '#333'; previewCtx.fillRect(0, 0, w, h);
        previewCtx.fillStyle = '#444';
        const sz = 10;
        for (let y = 0; y < h; y += sz)
            for (let x = 0; x < w; x += sz)
                if ((~~(x / sz) + ~~(y / sz)) % 2 === 0) previewCtx.fillRect(x, y, sz, sz);

        offCtx.drawImage(slot.mediaEl, 0, 0, w, h);
        const imgData = offCtx.getImageData(0, 0, w, h);
        const d = imgData.data;
        const c = slot.color;
        const kr = parseInt(c.slice(1, 3), 16) / 255;
        const kg = parseInt(c.slice(3, 5), 16) / 255;
        const kb = parseInt(c.slice(5, 7), 16) / 255;
        const ku = kr * -0.169 + kg * -0.331 + kb * 0.5 + 0.5;
        const kv = kr * 0.5 + kg * -0.419 + kb * -0.081 + 0.5;
        const sim = slot.similarity, smooth = slot.smoothness;

        for (let i = 0; i < d.length; i += 4) {
            const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
            const u = r * -0.169 + g * -0.331 + b * 0.5 + 0.5;
            const v = r * 0.5 + g * -0.419 + b * -0.081 + 0.5;
            const dist = Math.sqrt((u - ku) ** 2 + (v - kv) ** 2);
            d[i + 3] = dist < sim ? 0 : dist < sim + smooth ? Math.round((dist - sim) / smooth * 255) : 255;
        }
        offCtx.putImageData(imgData, 0, 0);
        previewCtx.drawImage(offCanvas, 0, 0);
    }

    // ─── 업로드 ───────────────────────────────────────────────────

    generateBtn.addEventListener('click', async () => {
        const filled = slots.filter(s => s.file !== null);
        if (!filled.length) return;

        generateBtn.disabled = true;
        uploadProgress.classList.remove('hidden');
        progressFill.style.width = '10%';
        progressText.textContent = '업로드 중...';

        try {
            const fd = new FormData();
            const title = (document.getElementById('project-title').value || '').trim();
            if (title) fd.append('title', title);
            filled.forEach((slot, i) => {
                fd.append(`file${i}`, slot.file);
                fd.append(`color${i}`, slot.color);
                fd.append(`similarity${i}`, String(slot.similarity));
                fd.append(`smoothness${i}`, String(slot.smoothness));
                fd.append(`audio${i}`, String(slot.audio));
            });

            progressFill.style.width = '40%';
            const res = await fetch('/api/upload', { method: 'POST', body: fd });
            progressFill.style.width = '80%';

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || '업로드 실패');
            }

            const result = await res.json();
            progressFill.style.width = '100%';
            progressText.textContent = '완료!';

            resultLink.value = window.location.origin + result.url;
            openArLink.href = result.url;
            generateSection.classList.add('hidden');
            resultSection.classList.remove('hidden');
        } catch (err) {
            alert('업로드 실패: ' + err.message);
            progressFill.style.width = '0%';
            uploadProgress.classList.add('hidden');
            generateBtn.disabled = false;
        }
    });

    // ─── 결과 액션 ────────────────────────────────────────────────

    copyLinkBtn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(resultLink.value); }
        catch { resultLink.select(); document.execCommand('copy'); }
        copyLinkBtn.textContent = '복사됨!';
        setTimeout(() => { copyLinkBtn.textContent = '복사'; }, 2000);
    });

    newUploadBtn.addEventListener('click', () => {
        if (previewingRAF) { cancelAnimationFrame(previewingRAF); previewingRAF = null; }
        previewingIdx = -1;

        slots.forEach(slot => {
            if (slot.mediaEl && slot.mediaEl.tagName === 'VIDEO') {
                slot.mediaEl.pause();
                URL.revokeObjectURL(slot.mediaEl.src);
            }
        });
        slotsContainer.innerHTML = '';
        slots.length = 0;
        createSlot();

        previewSection.classList.add('hidden');
        generateSection.classList.add('hidden');
        generateBtn.disabled = false;
        uploadProgress.classList.add('hidden');
        progressFill.style.width = '0%';
        resultSection.classList.add('hidden');
        updateUI();
    });
})();
