(function () {
    'use strict';

    /**
     * @typedef {Object} ArFile
     * @property {string} id
     * @property {string} type
     * @property {string} ext
     * @property {string} color       - 크로마키 색상 hex
     * @property {number} similarity  - 허용범위 (0~1)
     * @property {number} smoothness  - 경계 부드러움 (0~1)
     * @property {boolean} audio
     */

    // ─── DOM ─────────────────────────────────────────────────────
    const errorScreen      = document.getElementById('error-screen');
    const errorMessage     = document.getElementById('error-message');
    const startScreen      = document.getElementById('start-screen');
    const startBtn         = document.getElementById('start-btn');
    const permissionStatus = document.getElementById('permission-status');
    const loadingScreen    = document.getElementById('loading-screen');
    const loadingText      = document.getElementById('loading-text');
    const arContainer      = document.getElementById('ar-container');
    const videoBackground  = document.getElementById('video-background');
    const instruction      = document.getElementById('instruction');
    const fileSwitchBtns   = document.getElementById('file-switch-btns');
    const adjustToggleBtn  = document.getElementById('adjust-toggle-btn');
    const colorAdjustPanel = document.getElementById('color-adjust-panel');
    const panelCloseBtn    = document.getElementById('panel-close-btn');
    const adjustColor      = document.getElementById('adjust-color');
    const adjustSimilarity = document.getElementById('adjust-similarity');
    const adjustSmoothness = document.getElementById('adjust-smoothness');
    const adjSimVal        = document.getElementById('adj-sim-val');
    const adjSmoothVal     = document.getElementById('adj-smooth-val');

    // ─── URL에서 AR ID 추출 ──────────────────────────────────────
    const pathParts = window.location.pathname.split('/ar/');
    const arId = pathParts[1];
    if (!arId) { showError('잘못된 링크입니다.'); return; }

    // ─── State ───────────────────────────────────────────────────
    /** @type {ArFile[]} */
    let arFiles = [];
    let currentFileIdx = 0;
    let mediaVideoEl = null;
    let videoAudioCtx  = null;
    let videoAudioDest = null;

    // ─── WebGL2 ──────────────────────────────────────────────────
    let gl = null;
    let glCanvas = null;
    let glProgram = null;
    let glTexture = null;
    let glVao = null;
    let glUniforms = {};

    // ─── 오버레이 상태 (화면 픽셀 좌표) ─────────────────────────
    const overlay = {
        x: 0, y: 0,          // 중심 위치 (css px)
        baseW: 0, baseH: 0,   // 종횡비 기준 크기 (css px)
        scale: 1.0,
        color: [0, 1, 0],
        similarity: 0.4,
        smoothness: 0.1,
    };

    // ─── 제스처 ──────────────────────────────────────────────────
    const gesture = {
        isDragging: false, isPinching: false,
        dragStartX: 0, dragStartY: 0,
        objStartX: 0, objStartY: 0,
        pinchStartDist: 0, pinchStartScale: 1.0,
    };

    // ─── 카메라 ──────────────────────────────────────────────────
    let facingMode = 'environment';
    let cameraStream = null;

    // ─── 렌더링 ──────────────────────────────────────────────────
    let animId = null;

    // ─── 녹화 ────────────────────────────────────────────────────
    let mediaRecorder = null, recordedChunks = [], recStream = null;
    let isRecording = false;
    let recAnimId = null;
    let _ffmpegCore = null;
    let _ffmpegLog = '';

    // ─── 메타데이터 로드 ─────────────────────────────────────────
    startBtn.disabled = true;
    startBtn.textContent = '로딩 중...';
    fetchMeta();

    async function fetchMeta() {
        try {
            const res = await fetch('/api/meta/' + arId);
            if (!res.ok) { showError('AR 콘텐츠를 찾을 수 없습니다.\n링크가 만료되었거나 잘못되었습니다.'); return; }
            const meta = await res.json();

            if (meta.files && meta.files.length > 0) {
                arFiles = meta.files;
            } else {
                arFiles = [{ id: meta.id, type: meta.type, ext: meta.ext,
                    color: meta.color, similarity: meta.similarity,
                    smoothness: meta.smoothness, audio: false }];
            }

            if (meta.title) {
                const titleEl = document.getElementById('ar-title-display');
                titleEl.textContent = meta.title;
                titleEl.classList.remove('hidden');
                document.title = meta.title + ' · AR';
            }

            startBtn.disabled = false;
            startBtn.textContent = '시작하기';
        } catch (e) {
            showError('네트워크 오류가 발생했습니다.');
        }
    }

    // ─── 시작 버튼 ───────────────────────────────────────────────
    startBtn.addEventListener('click', async () => {
        if (!arFiles.length) return;
        startBtn.disabled = true;
        permissionStatus.textContent = '권한 요청 중...';

        try {
            cameraStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: false
            });
            videoBackground.srcObject = cameraStream;
            await videoBackground.play();
            videoBackground.style.transform = facingMode === 'user' ? 'scaleX(-1)' : '';

            if (typeof DeviceOrientationEvent !== 'undefined' &&
                typeof DeviceOrientationEvent.requestPermission === 'function') {
                try { await DeviceOrientationEvent.requestPermission(); } catch (e) {}
            }

            startScreen.classList.add('hidden');
            loadingScreen.classList.remove('hidden');
            loadingText.textContent = '파일 불러오는 중...';
            await initAR();
        } catch (e) {
            permissionStatus.textContent = '카메라 권한이 거부되었습니다. 브라우저 설정에서 허용해주세요.';
            startBtn.disabled = false;
        }
    });

    // ─── AR 초기화 ───────────────────────────────────────────────
    async function initAR() {
        initWebGL();
        await loadFile(0);
        setupFileSwitchBtns();
        setupGestures();
        setupAdjustPanel();

        loadingScreen.classList.add('hidden');
        arContainer.classList.remove('hidden');

        setTimeout(() => {
            instruction.classList.add('fade-out');
            setTimeout(() => { instruction.style.display = 'none'; }, 500);
        }, 4000);

        animate();
    }

    // ─── WebGL2 초기화 ───────────────────────────────────────────
    function initWebGL() {
        glCanvas = document.createElement('canvas');
        glCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';
        document.getElementById('canvas-container').appendChild(glCanvas);

        onResize();
        window.addEventListener('resize', onResize);

        gl = glCanvas.getContext('webgl2', {
            alpha: true,
            premultipliedAlpha: false,
            preserveDrawingBuffer: true   // 캡처/녹화용
        });
        if (!gl) throw new Error('WebGL2 미지원');

        // ── 버텍스 셰이더 ──────────────────────────────────────
        // a_pos: 단위 사각형 (-1..1), 화면 픽셀 좌표로 변환 후 clip space로 변환
        const vsrc = `#version 300 es
        in vec2 a_pos;
        uniform vec2 u_res;      // 캔버스 해상도 (실제 픽셀)
        uniform vec2 u_center;   // 오버레이 중심 (실제 픽셀)
        uniform vec2 u_half;     // 오버레이 반폭/반높이 (실제 픽셀)
        out vec2 vUv;
        void main() {
            // UV: a_pos.y=-1(화면 상단) → vUv.y=0(이미지 상단)
            vUv = vec2(a_pos.x * 0.5 + 0.5, a_pos.y * 0.5 + 0.5);
            vec2 sp = u_center + a_pos * u_half;
            vec2 clip = sp / u_res * 2.0 - 1.0;
            clip.y = -clip.y;
            gl_Position = vec4(clip, 0.0, 1.0);
        }`;

        // ── 프래그먼트 셰이더 (크로마키) ───────────────────────
        const fsrc = `#version 300 es
        precision mediump float;
        uniform sampler2D u_tex;
        uniform vec3 u_key;
        uniform float u_sim;
        uniform float u_smooth;
        in vec2 vUv;
        out vec4 outColor;
        vec2 rgb2uv(vec3 c) {
            return vec2(
                c.r * -0.169 + c.g * -0.331 + c.b * 0.5 + 0.5,
                c.r * 0.5   + c.g * -0.419  + c.b * -0.081 + 0.5
            );
        }
        void main() {
            vec4 col = texture(u_tex, vUv);
            vec2 cv = rgb2uv(col.rgb) - rgb2uv(u_key);
            float d = sqrt(dot(cv, cv));
            float a = smoothstep(u_sim, u_sim + u_smooth, d);
            outColor = vec4(col.rgb, col.a * a);
        }`;

        const vs = compileShader(gl.VERTEX_SHADER,   vsrc);
        const fs = compileShader(gl.FRAGMENT_SHADER, fsrc);
        glProgram = gl.createProgram();
        gl.attachShader(glProgram, vs);
        gl.attachShader(glProgram, fs);
        gl.linkProgram(glProgram);
        if (!gl.getProgramParameter(glProgram, gl.LINK_STATUS))
            throw new Error(gl.getProgramInfoLog(glProgram));

        // 단위 사각형 VAO
        glVao = gl.createVertexArray();
        gl.bindVertexArray(glVao);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER,
            new Float32Array([-1,-1,  1,-1,  -1,1,  1,1]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(glProgram, 'a_pos');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

        glUniforms = {
            res:    gl.getUniformLocation(glProgram, 'u_res'),
            center: gl.getUniformLocation(glProgram, 'u_center'),
            half:   gl.getUniformLocation(glProgram, 'u_half'),
            tex:    gl.getUniformLocation(glProgram, 'u_tex'),
            key:    gl.getUniformLocation(glProgram, 'u_key'),
            sim:    gl.getUniformLocation(glProgram, 'u_sim'),
            smooth: gl.getUniformLocation(glProgram, 'u_smooth'),
        };

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        glTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, glTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    /** @param {number} type @param {string} src @returns {WebGLShader} */
    function compileShader(type, src) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
            throw new Error(gl.getShaderInfoLog(s));
        return s;
    }

    function onResize() {
        if (!glCanvas) return;
        glCanvas.width  = window.innerWidth  * devicePixelRatio;
        glCanvas.height = window.innerHeight * devicePixelRatio;
        if (gl) gl.viewport(0, 0, glCanvas.width, glCanvas.height);
    }

    // ─── 파일 로드 ───────────────────────────────────────────────
    /** @param {number} idx */
    async function loadFile(idx) {
        if (mediaVideoEl) { mediaVideoEl.pause(); mediaVideoEl = null; }
        if (videoAudioCtx) { videoAudioCtx.close(); videoAudioCtx = null; videoAudioDest = null; }

        currentFileIdx = idx;
        const file = arFiles[idx];
        const isVideo = file.type.startsWith('video/');
        const fileUrl = '/api/file/' + file.id;

        const c = hexToRgb(file.color);
        overlay.color      = [c.r / 255, c.g / 255, c.b / 255];
        overlay.similarity = file.similarity;
        overlay.smoothness = file.smoothness;

        if (isVideo) {
            const video = document.createElement('video');
            video.loop = true;
            video.muted = false;
            video.playsInline = true;
            video.setAttribute('playsinline', '');
            video.setAttribute('webkit-playsinline', '');
            video.crossOrigin = 'anonymous';
            video.src = fileUrl;
            video.load();
            await new Promise((resolve, reject) => {
                video.addEventListener('loadeddata', resolve, { once: true });
                video.addEventListener('error', reject,  { once: true });
            });
            await video.play();
            mediaVideoEl = video;
            setOverlaySize(video.videoWidth, video.videoHeight);
        } else {
            const img = await loadImage(fileUrl);
            setOverlaySize(img.naturalWidth, img.naturalHeight);
            uploadTexture(img);
        }

        adjustColor.value      = file.color;
        adjustSimilarity.value = file.similarity;
        adjustSmoothness.value = file.smoothness;
        adjSimVal.textContent  = file.similarity.toFixed(2);
        adjSmoothVal.textContent = file.smoothness.toFixed(2);
    }

    /**
     * 화면의 85% 높이 기준으로 오버레이 크기/위치 초기화
     * @param {number} srcW @param {number} srcH
     */
    function setOverlaySize(srcW, srcH) {
        overlay.baseH = window.innerHeight * 0.85;
        overlay.baseW = overlay.baseH * (srcW / srcH);
        overlay.x     = window.innerWidth  / 2;
        overlay.y     = window.innerHeight / 2;
        overlay.scale = 1.0;
    }

    /** @param {string} hex @returns {{r:number,g:number,b:number}} */
    function hexToRgb(hex) {
        return {
            r: parseInt(hex.slice(1, 3), 16),
            g: parseInt(hex.slice(3, 5), 16),
            b: parseInt(hex.slice(5, 7), 16),
        };
    }

    /** @param {string} url @returns {Promise<HTMLImageElement>} */
    function loadImage(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload  = () => resolve(img);
            img.onerror = reject;
            img.src = url;
        });
    }

    /** @param {HTMLImageElement|HTMLVideoElement} source */
    function uploadTexture(source) {
        gl.bindTexture(gl.TEXTURE_2D, glTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }

    // ─── 파일 전환 버튼 ──────────────────────────────────────────
    function setupFileSwitchBtns() {
        if (arFiles.length <= 1) return;
        fileSwitchBtns.classList.remove('hidden');
        arFiles.forEach((_, i) => {
            const btn = document.createElement('button');
            btn.className = 'file-btn' + (i === 0 ? ' active' : '');
            btn.textContent = i + 1;
            btn.addEventListener('click', async () => {
                if (i === currentFileIdx) return;
                fileSwitchBtns.querySelectorAll('.file-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                await loadFile(i);
            });
            fileSwitchBtns.appendChild(btn);
        });
    }

    // ─── 렌더 루프 ───────────────────────────────────────────────
    function animate() {
        animId = requestAnimationFrame(animate);
        if (!gl) return;

        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        // 비디오라면 매 프레임 텍스처 업데이트
        if (mediaVideoEl && mediaVideoEl.readyState >= 2) {
            uploadTexture(mediaVideoEl);
        }

        const dpr = devicePixelRatio;
        const W   = glCanvas.width;
        const H   = glCanvas.height;

        gl.useProgram(glProgram);
        gl.bindVertexArray(glVao);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, glTexture);
        gl.uniform1i(glUniforms.tex, 0);
        gl.uniform2f(glUniforms.res,    W, H);
        gl.uniform2f(glUniforms.center, overlay.x * dpr, overlay.y * dpr);
        gl.uniform2f(glUniforms.half,   overlay.baseW * overlay.scale * 0.5 * dpr,
                                        overlay.baseH * overlay.scale * 0.5 * dpr);
        gl.uniform3f(glUniforms.key,    overlay.color[0], overlay.color[1], overlay.color[2]);
        gl.uniform1f(glUniforms.sim,    overlay.similarity);
        gl.uniform1f(glUniforms.smooth, overlay.smoothness);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // ─── 카메라 전환 ─────────────────────────────────────────────
    document.getElementById('flip-btn').addEventListener('click', async () => {
        facingMode = facingMode === 'environment' ? 'user' : 'environment';
        if (cameraStream) cameraStream.getTracks().forEach(t => t.stop());
        try {
            cameraStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: false
            });
            videoBackground.srcObject = cameraStream;
            await videoBackground.play();
            videoBackground.style.transform = facingMode === 'user' ? 'scaleX(-1)' : '';
        } catch (e) {
            facingMode = facingMode === 'environment' ? 'user' : 'environment';
        }
    });

    // ─── 캡처 (사진) / 녹화 (토글) ──────────────────────────────
    const captureBtn = document.getElementById('capture-btn');
    const recordBtn  = document.getElementById('record-btn');

    function doCapture() {
        const W = window.innerWidth, H = window.innerHeight;
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');

        const vw = videoBackground.videoWidth, vh = videoBackground.videoHeight;
        if (vw && vh) {
            const scale = Math.max(W / vw, H / vh);
            const dw = vw * scale, dh = vh * scale;
            const mirror = facingMode === 'user';
            if (mirror) {
                ctx.save(); ctx.scale(-1, 1);
                ctx.drawImage(videoBackground, -W - (W - dw) / 2, (H - dh) / 2, dw, dh);
                ctx.restore();
            } else {
                ctx.drawImage(videoBackground, (W - dw) / 2, (H - dh) / 2, dw, dh);
            }
        }
        // glCanvas는 preserveDrawingBuffer:true 로 생성했으므로 읽기 가능
        ctx.drawImage(glCanvas, 0, 0, W, H);

        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
        const filename = 'ar-capture-' + Date.now() + '.png';

        if (isIOS) {
            canvas.toBlob(async (blob) => {
                const shareFile = new File([blob], filename, { type: 'image/png' });
                if (navigator.canShare && navigator.canShare({ files: [shareFile] })) {
                    try { await navigator.share({ files: [shareFile], title: filename }); }
                    catch (err) { if (err.name !== 'AbortError') window.open(canvas.toDataURL('image/png'), '_blank'); }
                } else {
                    window.open(canvas.toDataURL('image/png'), '_blank');
                }
            }, 'image/png');
        } else {
            const link = document.createElement('a');
            link.download = filename;
            link.href = canvas.toDataURL('image/png');
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }
    }

    function drawVideoCover(ctx, video, w, h, mirror) {
        const vw = video.videoWidth, vh = video.videoHeight;
        if (!vw || !vh) return;
        const vr = vw / vh, cr = w / h;
        let sx, sy, sw, sh;
        if (vr > cr) { sh = vh; sw = vh * cr; sx = (vw - sw) / 2; sy = 0; }
        else         { sw = vw; sh = vw / cr; sx = 0; sy = (vh - sh) / 2; }
        if (mirror) {
            ctx.save(); ctx.scale(-1, 1);
            ctx.drawImage(video, sx, sy, sw, sh, -w, 0, w, h);
            ctx.restore();
        } else {
            ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
        }
    }

    // ─── FFmpeg (WebM → MP4 변환) ─────────────────────────────────
    // ffmpeg-core.js 자체 호스팅 + WASM을 미리 fetch해서 직접 전달
    async function loadFfmpeg() {
        if (_ffmpegCore) return _ffmpegCore;
        const [{ default: createFFmpegCore }, wasmResp] = await Promise.all([
            import('/js/ffmpeg-core.js'),
            fetch('https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm'),
        ]);
        const wasmBinary = await wasmResp.arrayBuffer();
        _ffmpegLog = '';
        _ffmpegCore = await createFFmpegCore({
            wasmBinary,
            print:    (msg) => { _ffmpegLog += msg + '\n'; },
            printErr: (msg) => { _ffmpegLog += msg + '\n'; },
        });
        return _ffmpegCore;
    }

    async function convertToMp4(webmBlob, onProgress) {
        onProgress(5);
        const core = await loadFfmpeg();
        onProgress(20);

        core.FS.writeFile('/input.webm', new Uint8Array(await webmBlob.arrayBuffer()));

        let exitCode = 0;
        try {
            core.callMain([
                '-i', '/input.webm',
                '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
                '-c:a', 'aac',
                '-movflags', '+faststart',
                '/output.mp4'
            ]);
        } catch (e) {
            exitCode = (e && typeof e.status === 'number') ? e.status : -1;
            if (exitCode !== 0) {
                try { core.FS.unlink('/input.webm'); } catch (_) {}
                _ffmpegCore = null;
                const logTail = _ffmpegLog.trim().split('\n').slice(-3).join(' | ');
                throw new Error(`exit ${exitCode}: ${logTail}`);
            }
        }

        onProgress(90);

        let data;
        try {
            data = core.FS.readFile('/output.mp4');
        } catch (e) {
            try { core.FS.unlink('/input.webm'); } catch (_) {}
            _ffmpegCore = null;
            throw new Error('output.mp4 생성 실패 — ffmpeg 변환이 완료되지 않음');
        }

        try { core.FS.unlink('/input.webm'); } catch (_) {}
        try { core.FS.unlink('/output.mp4'); } catch (_) {}
        _ffmpegCore = null;
        onProgress(100);
        return new Blob([data.buffer], { type: 'video/mp4' });
    }

    // ─── 녹화 ────────────────────────────────────────────────────
    function startRecording() {
        const arCanvas = document.querySelector('#canvas-container canvas');
        if (!videoBackground || !arCanvas) return;
        startRecordingMediaRecorder(arCanvas);
    }

    function startRecordingMediaRecorder(arCanvas) {
        if (typeof MediaRecorder === 'undefined') { console.warn('[Record] MediaRecorder 미지원'); return; }
        try {
            const allTypes = [
                { mimeType: 'video/mp4;codecs=avc1,mp4a.40.2', ext: 'mp4' },
                { mimeType: 'video/mp4;codecs=avc1',            ext: 'mp4' },
                { mimeType: 'video/mp4',                        ext: 'mp4' },
                { mimeType: 'video/webm;codecs=vp9,opus',       ext: 'webm' },
                { mimeType: 'video/webm;codecs=vp8,opus',       ext: 'webm' },
                { mimeType: 'video/webm',                       ext: 'webm' },
            ];
            const recFormat = allTypes.find(t => MediaRecorder.isTypeSupported(t.mimeType)) || { mimeType: '', ext: 'mp4' };
            const pr = window.devicePixelRatio || 1;
            const rawCw = Math.round(window.innerWidth * pr);
            const rawCh = Math.round(window.innerHeight * pr);
            const sc = Math.min(1, 1280 / rawCw);
            const cw = Math.floor(rawCw * sc / 2) * 2;
            const ch = Math.floor(rawCh * sc / 2) * 2;
            const comp = document.createElement('canvas');
            comp.width = cw; comp.height = ch;
            const cctx = comp.getContext('2d', { alpha: false, desynchronized: true });
            const mirror = facingMode === 'user';

            function drawFrame() {
                if (!isRecording) return;
                drawVideoCover(cctx, videoBackground, cw, ch, mirror);
                cctx.drawImage(arCanvas, 0, 0, arCanvas.width, arCanvas.height, 0, 0, cw, ch);
                recAnimId = requestAnimationFrame(drawFrame);
            }

            recStream = comp.captureStream(30);

            if (mediaVideoEl) {
                let audioAdded = false;
                if (mediaVideoEl.captureStream) {
                    try {
                        const tracks = mediaVideoEl.captureStream().getAudioTracks();
                        tracks.forEach(t => recStream.addTrack(t));
                        audioAdded = tracks.length > 0;
                    } catch (e) {}
                }
                if (!audioAdded && !videoAudioCtx) {
                    try {
                        videoAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
                        videoAudioCtx.resume();
                        const src = videoAudioCtx.createMediaElementSource(mediaVideoEl);
                        videoAudioDest = videoAudioCtx.createMediaStreamDestination();
                        src.connect(videoAudioCtx.destination);
                        src.connect(videoAudioDest);
                    } catch (e) { videoAudioCtx = null; videoAudioDest = null; }
                }
                if (!audioAdded && videoAudioDest) {
                    videoAudioDest.stream.getAudioTracks().forEach(t => recStream.addTrack(t));
                }
            }

            recordedChunks = [];
            const opts = recFormat.mimeType
                ? { mimeType: recFormat.mimeType, videoBitsPerSecond: 5000000, audioBitsPerSecond: 128000 }
                : { videoBitsPerSecond: 5000000, audioBitsPerSecond: 128000 };
            mediaRecorder = new MediaRecorder(recStream, opts);
            mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
            mediaRecorder.onstop = async () => {
                isRecording = false;
                cancelAnimationFrame(recAnimId);
                recordBtn.classList.remove('recording');
                const recBlob = new Blob(recordedChunks, { type: recFormat.mimeType || 'video/mp4' });
                const filename = 'ar-recording-' + Date.now() + '.mp4';

                if (recFormat.ext === 'mp4') {
                    showSaveOverlay(recBlob, filename);
                } else {
                    showConvertingOverlay();
                    try {
                        const mp4Blob = await convertToMp4(recBlob, updateConvertProgress);
                        showSaveOverlay(mp4Blob, filename);
                    } catch (e) {
                        console.error('[Record] MP4 변환 실패:', e);
                        const saveOverlay = document.getElementById('save-overlay');
                        const msg  = document.getElementById('save-msg');
                        const prog = document.getElementById('convert-progress');
                        const link = document.getElementById('save-link');
                        if (msg)  msg.textContent = '변환 오류: ' + (e?.message || String(e)).slice(0, 80);
                        if (prog) prog.classList.add('hidden');
                        if (link) { link.href = URL.createObjectURL(recBlob); link.classList.remove('hidden'); link.setAttribute('download', 'ar.webm'); link.textContent = 'WebM으로 저장 (임시)'; }
                        if (saveOverlay) saveOverlay.classList.remove('hidden');
                    }
                }
            };
            mediaRecorder.start();
            isRecording = true;
            recordBtn.classList.add('recording');
            drawFrame();
        } catch (e) {
            console.error('[Record] 녹화 실패:', e);
            isRecording = false;
            recordBtn.classList.remove('recording');
            if (recStream) { recStream.getTracks().forEach(t => t.stop()); recStream = null; }
        }
    }

    function stopRecording() {
        isRecording = false;
        cancelAnimationFrame(recAnimId);
        recordBtn.classList.remove('recording');
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
        }
    }

    captureBtn.addEventListener('click', () => doCapture());
    recordBtn.addEventListener('click', () => {
        if (isRecording) stopRecording();
        else startRecording();
    });

    // ─── 색상 조정 패널 ──────────────────────────────────────────
    function setupAdjustPanel() {
        adjustToggleBtn.addEventListener('click', () => colorAdjustPanel.classList.toggle('hidden'));
        panelCloseBtn.addEventListener('click',  () => colorAdjustPanel.classList.add('hidden'));

        adjustColor.addEventListener('input', e => {
            const c = hexToRgb(e.target.value);
            overlay.color = [c.r / 255, c.g / 255, c.b / 255];
        });
        adjustSimilarity.addEventListener('input', e => {
            overlay.similarity = parseFloat(e.target.value);
            adjSimVal.textContent = overlay.similarity.toFixed(2);
        });
        adjustSmoothness.addEventListener('input', e => {
            overlay.smoothness = parseFloat(e.target.value);
            adjSmoothVal.textContent = overlay.smoothness.toFixed(2);
        });
    }

    // ─── 제스처 ──────────────────────────────────────────────────
    function setupGestures() {
        const touchArea = document.getElementById('touch-area');

        touchArea.addEventListener('touchstart', e => {
            e.preventDefault();
            if (e.touches.length === 1) {
                gesture.isDragging = true; gesture.isPinching = false;
                gesture.dragStartX = e.touches[0].clientX;
                gesture.dragStartY = e.touches[0].clientY;
                gesture.objStartX  = overlay.x;
                gesture.objStartY  = overlay.y;
            } else if (e.touches.length === 2) {
                gesture.isDragging = false; gesture.isPinching = true;
                gesture.pinchStartDist  = getTouchDist(e.touches);
                gesture.pinchStartScale = overlay.scale;
            }
        }, { passive: false });

        touchArea.addEventListener('touchmove', e => {
            e.preventDefault();
            if (gesture.isDragging && e.touches.length === 1) {
                overlay.x = gesture.objStartX + (e.touches[0].clientX - gesture.dragStartX);
                overlay.y = gesture.objStartY + (e.touches[0].clientY - gesture.dragStartY);
            } else if (gesture.isPinching && e.touches.length === 2) {
                const ratio = getTouchDist(e.touches) / gesture.pinchStartDist;
                overlay.scale = Math.max(0.3, Math.min(20.0, gesture.pinchStartScale * ratio));
            }
        }, { passive: false });

        touchArea.addEventListener('touchend', e => {
            if (e.touches.length === 0) {
                gesture.isDragging = false; gesture.isPinching = false;
            } else if (e.touches.length === 1) {
                gesture.isPinching = false; gesture.isDragging = true;
                gesture.dragStartX = e.touches[0].clientX;
                gesture.dragStartY = e.touches[0].clientY;
                gesture.objStartX  = overlay.x;
                gesture.objStartY  = overlay.y;
            }
        });

        let mouseDown = false;
        touchArea.addEventListener('mousedown', e => {
            mouseDown = true;
            gesture.dragStartX = e.clientX; gesture.dragStartY = e.clientY;
            gesture.objStartX  = overlay.x;  gesture.objStartY  = overlay.y;
        });
        touchArea.addEventListener('mousemove', e => {
            if (!mouseDown) return;
            overlay.x = gesture.objStartX + (e.clientX - gesture.dragStartX);
            overlay.y = gesture.objStartY + (e.clientY - gesture.dragStartY);
        });
        touchArea.addEventListener('mouseup',    () => { mouseDown = false; });
        touchArea.addEventListener('mouseleave', () => { mouseDown = false; });
        touchArea.addEventListener('wheel', e => {
            e.preventDefault();
            overlay.scale = Math.max(0.3, Math.min(5.0, overlay.scale * (e.deltaY > 0 ? 0.9 : 1.1)));
        }, { passive: false });
    }

    function getTouchDist(touches) {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    // ─── 영상 저장 오버레이 ───────────────────────────────────────
    function showConvertingOverlay() {
        const saveOverlay = document.getElementById('save-overlay');
        const msg         = document.getElementById('save-msg');
        const progress    = document.getElementById('convert-progress');
        const link        = document.getElementById('save-link');
        msg.textContent = '녹화 완료! MP4로 변환 중...';
        progress.classList.remove('hidden');
        link.classList.add('hidden');
        updateConvertProgress(0);
        saveOverlay.classList.remove('hidden');
    }

    function updateConvertProgress(pct) {
        const bar  = document.getElementById('convert-bar');
        const text = document.getElementById('convert-text');
        if (bar)  bar.style.width = pct + '%';
        if (text) text.textContent = pct < 5 ? '로딩 중... (최초 1회 ~10MB)' : `변환 중... ${pct}%`;
    }

    function showSaveOverlay(blob, filename) {
        const url         = URL.createObjectURL(blob);
        const isIOS       = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
        const saveOverlay = document.getElementById('save-overlay');
        const link        = document.getElementById('save-link');
        const msg         = document.getElementById('save-msg');
        const progress    = document.getElementById('convert-progress');
        const closeBtn    = document.getElementById('save-close-btn');

        progress.classList.add('hidden');
        link.classList.remove('hidden');
        link.href = url;

        if (isIOS) {
            const shareFile   = new File([blob], filename, { type: 'video/mp4' });
            const canWebShare = navigator.canShare && navigator.canShare({ files: [shareFile] });
            if (canWebShare) {
                link.removeAttribute('download');
                link.removeAttribute('href');
                link.removeAttribute('target');
                link.textContent = '사진 앱에 저장';
                msg.textContent  = '완료! 버튼을 눌러 사진 앱에 저장하세요.';
                link.onclick = async (e) => {
                    e.preventDefault();
                    try { await navigator.share({ files: [shareFile], title: filename }); }
                    catch (err) { if (err.name !== 'AbortError') window.open(url, '_blank'); }
                };
            } else {
                link.removeAttribute('download');
                link.href    = url;
                link.target  = '_blank';
                link.onclick = null;
                link.textContent = '영상 열기';
                msg.textContent  = '완료! 열기 후 공유 버튼 → 사진 앱에 저장';
            }
        } else {
            link.setAttribute('download', filename);
            link.target  = '_self';
            link.onclick = null;
            link.textContent = '영상 저장하기';
            msg.textContent  = '녹화 완료! 아래 버튼을 눌러 저장하세요.';
        }

        saveOverlay.classList.remove('hidden');
        closeBtn.onclick = () => {
            saveOverlay.classList.add('hidden');
            URL.revokeObjectURL(url);
        };
    }

    // ─── 페이지 종료 시 리소스 정리 ──────────────────────────────
    function cleanup() {
        cancelAnimationFrame(animId);
        if (recStream)    { recStream.getTracks().forEach(t => t.stop()); recStream = null; }
        if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); }
        if (mediaVideoEl) { mediaVideoEl.pause(); mediaVideoEl = null; }
        if (videoAudioCtx) { videoAudioCtx.close(); videoAudioCtx = null; }
        if (gl && glTexture) { gl.deleteTexture(glTexture); }
        if (gl && glProgram) { gl.deleteProgram(glProgram); }
    }
    window.addEventListener('beforeunload', cleanup);

    // ─── 헬퍼 ────────────────────────────────────────────────────
    function showError(msg) {
        startScreen.classList.add('hidden');
        loadingScreen.classList.add('hidden');
        errorMessage.textContent = msg;
        errorScreen.classList.remove('hidden');
    }
})();
