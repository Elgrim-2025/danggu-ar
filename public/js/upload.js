(function () {
    'use strict';

    // ─── State ───────────────────────────────────────────────────
    let selectedFile = null;
    let selectedColor = '#00ff00';
    let similarity = 0.4;
    let smoothness = 0.1;
    let mediaElement = null; // <img> or <video>
    let previewRAF = null;

    // ─── DOM Elements ────────────────────────────────────────────
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const selectFileBtn = document.getElementById('select-file-btn');
    const fileInfo = document.getElementById('file-info');
    const colorSection = document.getElementById('color-section');
    const previewSection = document.getElementById('preview-section');
    const generateSection = document.getElementById('generate-section');
    const resultSection = document.getElementById('result-section');
    const presetButtons = document.querySelectorAll('.color-preset');
    const customColor = document.getElementById('custom-color');
    const simSlider = document.getElementById('similarity-slider');
    const smoothSlider = document.getElementById('smoothness-slider');
    const simValue = document.getElementById('sim-value');
    const smoothValue = document.getElementById('smooth-value');
    const previewCanvas = document.getElementById('preview-canvas');
    const generateBtn = document.getElementById('generate-btn');
    const uploadProgress = document.getElementById('upload-progress');
    const progressFill = document.getElementById('progress-fill');
    const progressText = document.getElementById('progress-text');
    const resultLink = document.getElementById('result-link');
    const copyLinkBtn = document.getElementById('copy-link-btn');
    const openArLink = document.getElementById('open-ar-link');
    const newUploadBtn = document.getElementById('new-upload-btn');

    const previewCtx = previewCanvas.getContext('2d');
    const offCanvas = document.createElement('canvas');
    const offCtx = offCanvas.getContext('2d');

    // ─── File Selection ──────────────────────────────────────────
    selectFileBtn.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('click', (e) => {
        if (e.target !== selectFileBtn) fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) handleFile(e.target.files[0]);
    });

    // Drag & Drop
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('dragover');
    });
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0]);
    });

    function handleFile(file) {
        const allowedTypes = ['image/jpeg', 'image/png', 'video/mp4', 'video/webm'];
        if (!allowedTypes.includes(file.type)) {
            alert('지원하지 않는 파일 형식입니다.\n(jpg, png, mp4, webm만 가능)');
            return;
        }
        if (file.size > 50 * 1024 * 1024) {
            alert('파일 크기는 50MB 이하여야 합니다.');
            return;
        }

        selectedFile = file;
        const sizeMB = (file.size / 1024 / 1024).toFixed(1);
        fileInfo.textContent = `${file.name} (${sizeMB}MB)`;
        fileInfo.classList.remove('hidden');

        // Show next sections
        colorSection.classList.remove('hidden');
        previewSection.classList.remove('hidden');
        generateSection.classList.remove('hidden');
        resultSection.classList.add('hidden');

        loadMediaForPreview(file);
    }

    function loadMediaForPreview(file) {
        // Cancel previous preview loop
        if (previewRAF) {
            cancelAnimationFrame(previewRAF);
            previewRAF = null;
        }
        if (mediaElement && mediaElement.tagName === 'VIDEO') {
            mediaElement.pause();
            URL.revokeObjectURL(mediaElement.src);
        }

        const isVideo = file.type.startsWith('video/');
        const objectURL = URL.createObjectURL(file);

        if (isVideo) {
            const video = document.createElement('video');
            video.muted = true;
            video.loop = true;
            video.playsInline = true;
            video.src = objectURL;
            video.addEventListener('loadeddata', () => {
                mediaElement = video;
                video.play();
                setupPreviewCanvas(video.videoWidth, video.videoHeight);
                startVideoPreviewLoop();
            }, { once: true });
            video.load();
        } else {
            const img = new Image();
            img.onload = () => {
                mediaElement = img;
                setupPreviewCanvas(img.width, img.height);
                renderPreviewFrame();
            };
            img.src = objectURL;
        }
    }

    function setupPreviewCanvas(w, h) {
        // Limit preview size for performance
        const maxW = 480;
        const scale = w > maxW ? maxW / w : 1;
        const cw = Math.round(w * scale);
        const ch = Math.round(h * scale);

        previewCanvas.width = cw;
        previewCanvas.height = ch;
        offCanvas.width = cw;
        offCanvas.height = ch;
    }

    function startVideoPreviewLoop() {
        function loop() {
            if (!mediaElement || mediaElement.tagName !== 'VIDEO') return;
            renderPreviewFrame();
            previewRAF = requestAnimationFrame(loop);
        }
        loop();
    }

    // ─── Chroma Key Preview ──────────────────────────────────────

    function renderPreviewFrame() {
        if (!mediaElement) return;

        const w = previewCanvas.width;
        const h = previewCanvas.height;

        // Draw checkerboard background
        drawCheckerboard(previewCtx, w, h);

        // Draw source to offscreen canvas
        offCtx.drawImage(mediaElement, 0, 0, w, h);
        const imageData = offCtx.getImageData(0, 0, w, h);
        const data = imageData.data;

        // Parse key color
        const keyR = parseInt(selectedColor.slice(1, 3), 16) / 255;
        const keyG = parseInt(selectedColor.slice(3, 5), 16) / 255;
        const keyB = parseInt(selectedColor.slice(5, 7), 16) / 255;

        // Key color in UV space
        const keyU = keyR * -0.169 + keyG * -0.331 + keyB * 0.5 + 0.5;
        const keyV = keyR * 0.5 + keyG * -0.419 + keyB * -0.081 + 0.5;

        for (let i = 0; i < data.length; i += 4) {
            const r = data[i] / 255;
            const g = data[i + 1] / 255;
            const b = data[i + 2] / 255;

            const u = r * -0.169 + g * -0.331 + b * 0.5 + 0.5;
            const v = r * 0.5 + g * -0.419 + b * -0.081 + 0.5;

            const du = u - keyU;
            const dv = v - keyV;
            const dist = Math.sqrt(du * du + dv * dv);

            let alpha;
            if (dist < similarity) {
                alpha = 0;
            } else if (dist < similarity + smoothness) {
                alpha = (dist - similarity) / smoothness;
            } else {
                alpha = 1;
            }

            data[i + 3] = Math.round(alpha * 255);
        }

        offCtx.putImageData(imageData, 0, 0);
        previewCtx.drawImage(offCanvas, 0, 0);
    }

    function drawCheckerboard(ctx, w, h) {
        const size = 10;
        ctx.fillStyle = '#333';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#444';
        for (let y = 0; y < h; y += size) {
            for (let x = 0; x < w; x += size) {
                if ((Math.floor(x / size) + Math.floor(y / size)) % 2 === 0) {
                    ctx.fillRect(x, y, size, size);
                }
            }
        }
    }

    // ─── Color Selection ─────────────────────────────────────────

    presetButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            presetButtons.forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            selectedColor = btn.dataset.color;
            customColor.value = selectedColor;
            onColorChange();
        });
    });

    customColor.addEventListener('input', (e) => {
        selectedColor = e.target.value;
        presetButtons.forEach((b) => b.classList.remove('active'));
        onColorChange();
    });

    simSlider.addEventListener('input', (e) => {
        similarity = parseFloat(e.target.value);
        simValue.textContent = similarity.toFixed(2);
        onColorChange();
    });

    smoothSlider.addEventListener('input', (e) => {
        smoothness = parseFloat(e.target.value);
        smoothValue.textContent = smoothness.toFixed(2);
        onColorChange();
    });

    function onColorChange() {
        // For images, re-render immediately
        if (mediaElement && mediaElement.tagName === 'IMG') {
            renderPreviewFrame();
        }
        // For video, the loop already handles it
    }

    // ─── Upload ──────────────────────────────────────────────────

    generateBtn.addEventListener('click', async () => {
        if (!selectedFile) return;

        generateBtn.disabled = true;
        uploadProgress.classList.remove('hidden');
        progressFill.style.width = '10%';
        progressText.textContent = '업로드 중...';

        try {
            const formData = new FormData();
            formData.append('file', selectedFile);
            formData.append('color', selectedColor);
            formData.append('similarity', similarity.toString());
            formData.append('smoothness', smoothness.toString());

            progressFill.style.width = '40%';

            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });

            progressFill.style.width = '80%';

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || '업로드 실패');
            }

            const result = await response.json();

            progressFill.style.width = '100%';
            progressText.textContent = '완료!';

            // Show result
            const fullUrl = window.location.origin + result.url;
            resultLink.value = fullUrl;
            openArLink.href = result.url;
            resultSection.classList.remove('hidden');
            generateSection.classList.add('hidden');
        } catch (err) {
            alert('업로드 실패: ' + err.message);
            progressFill.style.width = '0%';
            uploadProgress.classList.add('hidden');
            generateBtn.disabled = false;
        }
    });

    // ─── Result Actions ──────────────────────────────────────────

    copyLinkBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(resultLink.value);
            copyLinkBtn.textContent = '복사됨!';
            setTimeout(() => { copyLinkBtn.textContent = '복사'; }, 2000);
        } catch {
            resultLink.select();
            document.execCommand('copy');
            copyLinkBtn.textContent = '복사됨!';
            setTimeout(() => { copyLinkBtn.textContent = '복사'; }, 2000);
        }
    });

    newUploadBtn.addEventListener('click', () => {
        // Reset state
        selectedFile = null;
        if (mediaElement && mediaElement.tagName === 'VIDEO') {
            mediaElement.pause();
            URL.revokeObjectURL(mediaElement.src);
        }
        mediaElement = null;
        if (previewRAF) cancelAnimationFrame(previewRAF);
        previewRAF = null;
        fileInput.value = '';

        // Reset UI
        fileInfo.classList.add('hidden');
        colorSection.classList.add('hidden');
        previewSection.classList.add('hidden');
        generateSection.classList.remove('hidden');
        generateBtn.disabled = false;
        uploadProgress.classList.add('hidden');
        progressFill.style.width = '0%';
        resultSection.classList.add('hidden');
    });
})();
