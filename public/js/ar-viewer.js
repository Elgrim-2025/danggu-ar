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
    const playBtn          = document.getElementById('play-btn');
    const adjustToggleBtn  = document.getElementById('adjust-toggle-btn');
    const colorAdjustPanel = document.getElementById('color-adjust-panel');
    const panelCloseBtn    = document.getElementById('panel-close-btn');
    const adjustColor      = document.getElementById('adjust-color');
    const adjustSimilarity = document.getElementById('adjust-similarity');
    const adjustSmoothness = document.getElementById('adjust-smoothness');
    const adjSimVal        = document.getElementById('adj-sim-val');
    const adjSmoothVal     = document.getElementById('adj-smooth-val');

    // ─── 회전 패널 DOM ──────────────────────────────────────────
    const rotateToggleBtn  = document.getElementById('rotate-toggle-btn');
    const rotatePanel      = document.getElementById('rotate-panel');
    const rotatePanelClose = document.getElementById('rotate-panel-close');
    const rotateResetBtn   = document.getElementById('rotate-reset-btn');
    const rotXInput        = document.getElementById('rot-x');
    const rotYInput        = document.getElementById('rot-y');
    const rotZInput        = document.getElementById('rot-z');
    const rotXVal          = document.getElementById('rot-x-val');
    const rotYVal          = document.getElementById('rot-y-val');
    const rotZVal          = document.getElementById('rot-z-val');
    const opacityInput     = document.getElementById('opacity-range');
    const opacityVal       = document.getElementById('opacity-val');

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
    let glBuffer = null;
    let glUniforms = {};

    // ─── 오버레이 상태 (화면 픽셀 좌표) ─────────────────────────
    const overlay = {
        x: 0, y: 0,          // 중심 위치 (css px)
        baseW: 0, baseH: 0,   // 종횡비 기준 크기 (css px)
        scale: 1.0,
        color: [0, 1, 0],
        similarity: 0.4,
        smoothness: 0.1,
        // 회전 (도 단위, 쿼터니언으로 변환하여 셰이더에 전달)
        rotX: 0, rotY: 0, rotZ: 0,
        opacity: 1.0,
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
    let useChromaKey = true;

    // ─── 플랫폼 ──────────────────────────────────────────────────
    const isAndroid = /Android/i.test(navigator.userAgent);

    // ─── WebXR 상태 ────────────────────────────────────────────
    let xrMode = false;
    let xrSession = null;
    let xrRefSpace = null;
    let xrHitTestSource = null;
    let xrProgram = null;
    let xrUniforms = {};
    let xrPlaced = false;
    let xrPlacementMatrix = null;   // Float32Array(16)
    let xrReticleMatrix = null;
    let xrReticleVisible = false;
    let xrVideoScale = 0.3;        // 미터 단위
    let xrVideoAspect = 16 / 9;

    // ─── 녹화 ────────────────────────────────────────────────────
    let mediaRecorder = null, recordedChunks = [], recStream = null;
    let isRecording = false;
    let recAnimId = null;
    let _ffmpegCore = null;
    let _ffmpegLog = '';

    // ─── WakeLock (녹화 중 화면 꺼짐 방지) ──────────────────────
    let wakeLock = null;
    async function acquireWakeLock() {
        if (!('wakeLock' in navigator)) return;
        try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
    }
    function releaseWakeLock() {
        if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    }

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

            // WebXR 지원 감지
            if (navigator.xr) {
                navigator.xr.isSessionSupported('immersive-ar').then(supported => {
                    if (supported) {
                        const xrBtn = document.getElementById('xr-start-btn');
                        if (xrBtn) xrBtn.classList.remove('hidden');
                    }
                }).catch(() => {});
            }
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
        } catch (e) {
            // 카메라 없이도 계속 진행 (검은 배경)
            console.warn('카메라 사용 불가, 배경 없이 진행:', e.message);
        }

        if (typeof DeviceOrientationEvent !== 'undefined' &&
            typeof DeviceOrientationEvent.requestPermission === 'function') {
            try { await DeviceOrientationEvent.requestPermission(); } catch (e) {}
        }

        startScreen.classList.add('hidden');
        loadingScreen.classList.remove('hidden');
        loadingText.textContent = '파일 불러오는 중...';
        await initAR();
    });

    // ─── 로딩 진행률 ─────────────────────────────────────────────
    const loadingBar  = document.getElementById('loading-bar');
    function setLoadingProgress(pct, text) {
        if (loadingBar) loadingBar.style.width = pct + '%';
        if (text) loadingText.textContent = text;
    }

    // ─── AR 초기화 ───────────────────────────────────────────────
    async function initAR() {
        setLoadingProgress(10, '그래픽 초기화 중...');
        initWebGL();
        setLoadingProgress(30, '파일 불러오는 중...');
        await loadFile(0);
        setLoadingProgress(80, '컨트롤 설정 중...');
        setupFileSwitchBtns();
        setupGestures();
        setupAdjustPanel();
        setupRotatePanel();
        setLoadingProgress(100, '완료!');
        await new Promise(r => setTimeout(r, 280));

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

        // WebGL 컨텍스트 소멸 처리 (기기 메모리 부족 시 발생)
        glCanvas.addEventListener('webglcontextlost', e => {
            e.preventDefault();
            cancelAnimationFrame(animId);
            animId = null;
            showError('그래픽 메모리가 부족합니다.\n페이지를 새로고침해 주세요.');
        }, false);

        gl = glCanvas.getContext('webgl2', {
            alpha: true,
            premultipliedAlpha: false,
            preserveDrawingBuffer: true,  // 캡처/녹화용
            xrCompatible: true
        });
        if (!gl) throw new Error('WebGL2 미지원');

        // ── 버텍스 셰이더 ──────────────────────────────────────
        // a_pos: 단위 사각형 (-1..1), 3D 회전 후 화면 픽셀 좌표 → clip space 변환
        const vsrc = `#version 300 es
        in vec2 a_pos;
        uniform vec2 u_res;      // 캔버스 해상도 (실제 픽셀)
        uniform vec2 u_center;   // 오버레이 중심 (실제 픽셀)
        uniform vec2 u_half;     // 오버레이 반폭/반높이 (실제 픽셀)
        uniform mat4 u_rot;      // 쿼터니언 기반 회전 행렬
        out vec2 vUv;
        void main() {
            // UV: a_pos.y=-1(화면 상단) → vUv.y=0(이미지 상단)
            vUv = vec2(a_pos.x * 0.5 + 0.5, a_pos.y * 0.5 + 0.5);
            // 로컬 좌표를 3D로 확장 후 회전
            vec4 local = u_rot * vec4(a_pos, 0.0, 1.0);
            // 간단한 원근감 (z가 카메라 쪽으로 오면 커짐)
            float persp = 1.0 / (1.0 - local.z * 0.4);
            vec2 sp = u_center + local.xy * u_half * persp;
            vec2 clip = sp / u_res * 2.0 - 1.0;
            clip.y = -clip.y;
            gl_Position = vec4(clip, 0.0, 1.0);
        }`;

        // ── 프래그먼트 셰이더 (크로마키 / WebM alpha 분기) ─────
        const fsrc = `#version 300 es
        precision mediump float;
        uniform sampler2D u_tex;
        uniform vec3 u_key;
        uniform float u_sim;
        uniform float u_smooth;
        uniform bool u_useChroma;
        uniform float u_opacity;
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
            if (u_useChroma) {
                vec2 cv = rgb2uv(col.rgb) - rgb2uv(u_key);
                float d = sqrt(dot(cv, cv));
                float a = smoothstep(u_sim, u_sim + u_smooth, d);
                outColor = vec4(col.rgb, col.a * a * u_opacity);
            } else {
                outColor = vec4(col.rgb, col.a * u_opacity);
            }
        }`;

        const vs = compileShader(gl.VERTEX_SHADER,   vsrc);
        const fs = compileShader(gl.FRAGMENT_SHADER, fsrc);
        glProgram = gl.createProgram();
        gl.attachShader(glProgram, vs);
        gl.attachShader(glProgram, fs);
        gl.linkProgram(glProgram);
        if (!gl.getProgramParameter(glProgram, gl.LINK_STATUS))
            throw new Error(gl.getProgramInfoLog(glProgram));

        // 세분화된 사각형 VAO (원근 보정을 위해 격자 분할)
        const SEG = 16;
        const verts = [];
        const indices = [];
        for (let j = 0; j <= SEG; j++) {
            for (let i = 0; i <= SEG; i++) {
                verts.push(-1 + 2 * i / SEG, -1 + 2 * j / SEG);
            }
        }
        for (let j = 0; j < SEG; j++) {
            for (let i = 0; i < SEG; i++) {
                const a = j * (SEG + 1) + i;
                const b = a + 1;
                const c = a + SEG + 1;
                const d = c + 1;
                indices.push(a, b, c, b, d, c);
            }
        }
        glVao = gl.createVertexArray();
        gl.bindVertexArray(glVao);
        glBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, glBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(glProgram, 'a_pos');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        const ibo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);

        glUniforms = {
            res:       gl.getUniformLocation(glProgram, 'u_res'),
            center:    gl.getUniformLocation(glProgram, 'u_center'),
            half:      gl.getUniformLocation(glProgram, 'u_half'),
            rot:       gl.getUniformLocation(glProgram, 'u_rot'),
            tex:       gl.getUniformLocation(glProgram, 'u_tex'),
            key:       gl.getUniformLocation(glProgram, 'u_key'),
            sim:       gl.getUniformLocation(glProgram, 'u_sim'),
            smooth:    gl.getUniformLocation(glProgram, 'u_smooth'),
            opacity:   gl.getUniformLocation(glProgram, 'u_opacity'),
            useChroma: gl.getUniformLocation(glProgram, 'u_useChroma'),
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
    let isLoadingFile = false;

    /** @param {number} idx */
    async function loadFile(idx) {
        if (isLoadingFile) return;
        isLoadingFile = true;
        try {
        if (mediaVideoEl) { mediaVideoEl.pause(); mediaVideoEl = null; }
        if (videoAudioCtx) { videoAudioCtx.close(); videoAudioCtx = null; videoAudioDest = null; }

        currentFileIdx = idx;
        const file = arFiles[idx];
        const isVideo = file.type.startsWith('video/');

        // 안드로이드 + androidId 있으면 WebM alpha variant 사용 (크로마키 불필요)
        const useAndroid = isAndroid && !!file.androidId;
        useChromaKey = !useAndroid;
        const fileUrl = useAndroid ? '/api/file/' + file.androidId : '/api/file/' + file.id;

        const c = hexToRgb(file.color);
        overlay.color      = [c.r / 255, c.g / 255, c.b / 255];
        overlay.similarity = file.similarity;
        overlay.smoothness = file.smoothness;

        if (isVideo) {
            const video = document.createElement('video');
            video.loop = true;
            video.muted = !file.audio; // 업로드 시 설정한 소리 여부 반영
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

            // 재생/정지 버튼 — 비디오일 때만 표시
            playBtn.classList.remove('hidden');
            const iconPause = document.getElementById('play-icon-pause');
            const iconPlay  = document.getElementById('play-icon-play');
            function syncPlayIcon() {
                const paused = video.paused;
                iconPause.style.display = paused ? 'none'  : '';
                iconPlay.style.display  = paused ? ''      : 'none';
            }
            syncPlayIcon();
            video.addEventListener('play',  syncPlayIcon);
            video.addEventListener('pause', syncPlayIcon);
        } else {
            const img = await loadImage(fileUrl);
            setOverlaySize(img.naturalWidth, img.naturalHeight);
            uploadTexture(img);
            playBtn.classList.add('hidden');
        }

        adjustColor.value      = file.color;
        adjustSimilarity.value = file.similarity;
        adjustSmoothness.value = file.smoothness;
        adjSimVal.textContent  = file.similarity.toFixed(2);
        adjSmoothVal.textContent = file.smoothness.toFixed(2);
        } finally {
            isLoadingFile = false;
        }
    }

    /**
     * 화면의 85% 높이 기준으로 오버레이 크기/위치 초기화
     * @param {number} srcW @param {number} srcH
     */
    function setOverlaySize(srcW, srcH) {
        overlay.baseH = window.innerHeight * 0.85;
        overlay.baseW = overlay.baseH * (srcW / srcH);
        overlay.x     = window.innerWidth  / 2 - 57;
        overlay.y     = window.innerHeight / 2;
        overlay.scale = 1.0;
        overlay.rotX = overlay.rotY = overlay.rotZ = 0;
        overlay.opacity = 1.0;
        // 회전/투명도 슬라이더가 있으면 동기화
        if (rotXInput) {
            rotXInput.value = rotYInput.value = rotZInput.value = 0;
            rotXVal.textContent = rotYVal.textContent = rotZVal.textContent = '0°';
            opacityInput.value = 100;
            opacityVal.textContent = '100%';
        }
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

    // ─── 쿼터니언 회전 ──────────────────────────────────────────
    /** 오일러(도) → 쿼터니언 [x,y,z,w] (XYZ 순서) */
    function eulerToQuat(degX, degY, degZ) {
        const hx = degX * Math.PI / 360, hy = degY * Math.PI / 360, hz = degZ * Math.PI / 360;
        const cx = Math.cos(hx), sx = Math.sin(hx);
        const cy = Math.cos(hy), sy = Math.sin(hy);
        const cz = Math.cos(hz), sz = Math.sin(hz);
        return [
            sx * cy * cz + cx * sy * sz,
            cx * sy * cz - sx * cy * sz,
            cx * cy * sz + sx * sy * cz,
            cx * cy * cz - sx * sy * sz,
        ];
    }

    /** 쿼터니언 → column-major 4×4 회전 행렬 (Float32Array) */
    function quatToMat4(q) {
        const [x, y, z, w] = q;
        const x2 = x + x, y2 = y + y, z2 = z + z;
        const xx = x * x2, xy = x * y2, xz = x * z2;
        const yy = y * y2, yz = y * z2, zz = z * z2;
        const wx = w * x2, wy = w * y2, wz = w * z2;
        return new Float32Array([
            1 - yy - zz, xy + wz,     xz - wy,     0,
            xy - wz,     1 - xx - zz, yz + wx,     0,
            xz + wy,     yz - wx,     1 - xx - yy, 0,
            0,           0,           0,           1,
        ]);
    }

    /** overlay 회전 상태로부터 4×4 행렬 계산 */
    function getRotationMatrix() {
        const q = eulerToQuat(overlay.rotX, overlay.rotY, overlay.rotZ);
        return quatToMat4(q);
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
        gl.uniformMatrix4fv(glUniforms.rot, false, getRotationMatrix());
        gl.uniform3f(glUniforms.key,      overlay.color[0], overlay.color[1], overlay.color[2]);
        gl.uniform1f(glUniforms.sim,      overlay.similarity);
        gl.uniform1f(glUniforms.smooth,   overlay.smoothness);
        gl.uniform1i(glUniforms.useChroma, useChromaKey ? 1 : 0);
        gl.uniform1f(glUniforms.opacity, overlay.opacity);
        gl.drawElements(gl.TRIANGLES, 16 * 16 * 6, gl.UNSIGNED_SHORT, 0);
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

        // 워터마크 합성
        const wmEl = document.getElementById('watermark');
        if (wmEl && wmEl.complete && wmEl.naturalWidth) {
            const wmW = Math.round(W * 0.24);
            const wmH = Math.round(wmEl.naturalHeight * (wmW / wmEl.naturalWidth));
            const margin = Math.round(W * 0.04);
            ctx.globalAlpha = 0.72;
            ctx.drawImage(wmEl, W - wmW - margin, H - wmH - margin, wmW, wmH);
            ctx.globalAlpha = 1;
        }

        const filename = 'ar-capture-' + Date.now() + '.png';
        canvas.toBlob(blob => showSaveOverlay(blob, filename), 'image/png');
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
            fetch('/wasm/ffmpeg-core.wasm'),
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
        // 인스턴스 유지 → 다음 변환 시 WASM 재다운로드 없이 재사용
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

            const recWmEl = document.getElementById('watermark');
            function drawFrame() {
                if (!isRecording) return;
                // facingMode를 매 프레임 참조 → 녹화 중 카메라 전환해도 미러 즉시 반영
                drawVideoCover(cctx, videoBackground, cw, ch, facingMode === 'user');
                cctx.drawImage(arCanvas, 0, 0, arCanvas.width, arCanvas.height, 0, 0, cw, ch);
                // 워터마크 합성
                if (recWmEl && recWmEl.complete && recWmEl.naturalWidth) {
                    const wmW = Math.round(cw * 0.24);
                    const wmH = Math.round(recWmEl.naturalHeight * (wmW / recWmEl.naturalWidth));
                    const margin = Math.round(cw * 0.04);
                    cctx.globalAlpha = 0.72;
                    cctx.drawImage(recWmEl, cw - wmW - margin, ch - wmH - margin, wmW, wmH);
                    cctx.globalAlpha = 1;
                }
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

                if (recStream) {
                    recStream.getTracks().forEach(t => t.stop());
                    recStream = null;
                }
                releaseWakeLock();

                const recBlob = new Blob(recordedChunks, { type: recFormat.mimeType || 'video/mp4' });
                recordedChunks = [];
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
            acquireWakeLock();
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

    playBtn.addEventListener('click', () => {
        if (!mediaVideoEl) return;
        if (mediaVideoEl.paused) mediaVideoEl.play();
        else mediaVideoEl.pause();
    });

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

    // ─── 3D 회전 패널 ─────────────────────────────────────────
    function setupRotatePanel() {
        rotateToggleBtn.addEventListener('click', () => {
            const open = rotatePanel.classList.toggle('hidden');
            rotateToggleBtn.classList.toggle('active', !rotatePanel.classList.contains('hidden'));
        });
        rotatePanelClose.addEventListener('click', () => {
            rotatePanel.classList.add('hidden');
            rotateToggleBtn.classList.remove('active');
        });

        function syncSlider(input, valEl, axis) {
            input.addEventListener('input', () => {
                const v = parseFloat(input.value);
                overlay['rot' + axis] = v;
                valEl.textContent = v + '°';
            });
        }
        syncSlider(rotXInput, rotXVal, 'X');
        syncSlider(rotYInput, rotYVal, 'Y');
        syncSlider(rotZInput, rotZVal, 'Z');

        opacityInput.addEventListener('input', () => {
            const v = parseInt(opacityInput.value);
            overlay.opacity = v / 100;
            opacityVal.textContent = v + '%';
        });

        rotateResetBtn.addEventListener('click', () => {
            overlay.rotX = overlay.rotY = overlay.rotZ = 0;
            overlay.opacity = 1.0;
            rotXInput.value = rotYInput.value = rotZInput.value = 0;
            rotXVal.textContent = rotYVal.textContent = rotZVal.textContent = '0°';
            opacityInput.value = 100;
            opacityVal.textContent = '100%';
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
        const isImage     = blob.type.startsWith('image/');
        const saveOverlay = document.getElementById('save-overlay');
        const link        = document.getElementById('save-link');
        const shareBtn    = document.getElementById('share-btn');
        const msg         = document.getElementById('save-msg');
        const progress    = document.getElementById('convert-progress');
        const closeBtn    = document.getElementById('save-close-btn');

        progress.classList.add('hidden');
        link.classList.remove('hidden');
        link.href = url;

        // 공유용: 타임스탬프 없는 깔끔한 이름 + 정규화된 MIME 타입
        const shareTitle    = 'AR 포토존';
        const shareFilename = isImage ? '사진.png' : '영상.mp4';
        const shareType     = isImage ? 'image/png' : 'video/mp4';
        const shareFile     = new File([blob], shareFilename, { type: shareType });
        const canFileShare  = navigator.canShare && navigator.canShare({ files: [shareFile] });

        if (isIOS) {
            shareBtn.classList.add('hidden');
            if (canFileShare) {
                link.removeAttribute('download');
                link.removeAttribute('href');
                link.removeAttribute('target');
                link.textContent = '저장 / 공유';
                msg.textContent  = '완료! 저장하거나 다른 앱으로 공유하세요.';
                link.onclick = async (e) => {
                    e.preventDefault();
                    try { await navigator.share({ files: [shareFile], title: shareTitle }); }
                    catch (err) { if (err.name !== 'AbortError') window.open(url, '_blank'); }
                };
            } else {
                link.removeAttribute('download');
                link.href    = url;
                link.target  = '_blank';
                link.onclick = null;
                link.textContent = isImage ? '이미지 열기' : '영상 열기';
                msg.textContent  = '완료! 열기 후 공유 버튼 → 저장';
            }
        } else {
            link.setAttribute('download', filename);
            link.target  = '_self';
            link.onclick = null;
            link.textContent = isImage ? '사진 저장하기' : '영상 저장하기';
            msg.textContent  = isImage ? '촬영 완료!' : '녹화 완료!';

            if (navigator.share) {
                shareBtn.classList.remove('hidden');
                shareBtn.onclick = async () => {
                    try {
                        if (canFileShare) {
                            await navigator.share({ files: [shareFile], title: shareTitle });
                        } else {
                            alert('이 기기에서는 파일 직접 공유가 지원되지 않습니다.\n저장하기로 저장 후 갤러리에서 공유해보세요.');
                        }
                    } catch (err) {
                        if (err.name === 'AbortError') return;
                        alert('공유에 실패했습니다.\n저장하기로 저장 후 갤러리에서 공유해보세요.');
                    }
                };
            } else {
                shareBtn.classList.add('hidden');
            }
        }

        saveOverlay.classList.remove('hidden');
        closeBtn.onclick = () => {
            saveOverlay.classList.add('hidden');
            shareBtn.classList.add('hidden');
            URL.revokeObjectURL(url);
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // ═══ WebXR 평면 트래킹 모드 ═══════════════════════════════════
    // ═══════════════════════════════════════════════════════════════

    // ─── 4×4 행렬 연산 헬퍼 ────────────────────────────────────
    function mat4Multiply(a, b) {
        const o = new Float32Array(16);
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                o[j * 4 + i] = a[i] * b[j * 4] + a[4 + i] * b[j * 4 + 1] +
                                a[8 + i] * b[j * 4 + 2] + a[12 + i] * b[j * 4 + 3];
            }
        }
        return o;
    }

    function mat4Scale(sx, sy, sz) {
        const m = new Float32Array(16);
        m[0] = sx; m[5] = sy; m[10] = sz; m[15] = 1;
        return m;
    }

    // ─── XR 셰이더 프로그램 초기화 ─────────────────────────────
    function initXRProgram() {
        // XR 버텍스 셰이더: MVP 기반, 쿼드를 XZ 평면에 눕힘
        const xrVsrc = `#version 300 es
        in vec2 a_pos;
        uniform mat4 u_mvp;
        out vec2 vUv;
        void main() {
            vUv = vec2(a_pos.x * 0.5 + 0.5, 1.0 - (a_pos.y * 0.5 + 0.5));
            gl_Position = u_mvp * vec4(a_pos.x, 0.0, a_pos.y, 1.0);
        }`;

        // 프래그먼트 셰이더는 기존 것 그대로 재사용
        const xrFsrc = `#version 300 es
        precision mediump float;
        uniform sampler2D u_tex;
        uniform vec3 u_key;
        uniform float u_sim;
        uniform float u_smooth;
        uniform bool u_useChroma;
        uniform float u_opacity;
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
            if (u_useChroma) {
                vec2 cv = rgb2uv(col.rgb) - rgb2uv(u_key);
                float d = sqrt(dot(cv, cv));
                float a = smoothstep(u_sim, u_sim + u_smooth, d);
                outColor = vec4(col.rgb, col.a * a * u_opacity);
            } else {
                outColor = vec4(col.rgb, col.a * u_opacity);
            }
        }`;

        const vs = compileShader(gl.VERTEX_SHADER, xrVsrc);
        const fs = compileShader(gl.FRAGMENT_SHADER, xrFsrc);
        xrProgram = gl.createProgram();
        gl.attachShader(xrProgram, vs);
        gl.attachShader(xrProgram, fs);
        gl.linkProgram(xrProgram);
        if (!gl.getProgramParameter(xrProgram, gl.LINK_STATUS))
            throw new Error(gl.getProgramInfoLog(xrProgram));

        xrUniforms = {
            mvp:       gl.getUniformLocation(xrProgram, 'u_mvp'),
            tex:       gl.getUniformLocation(xrProgram, 'u_tex'),
            key:       gl.getUniformLocation(xrProgram, 'u_key'),
            sim:       gl.getUniformLocation(xrProgram, 'u_sim'),
            smooth:    gl.getUniformLocation(xrProgram, 'u_smooth'),
            useChroma: gl.getUniformLocation(xrProgram, 'u_useChroma'),
            opacity:   gl.getUniformLocation(xrProgram, 'u_opacity'),
        };

        // a_pos attribute는 같은 VAO/VBO를 공유
        const loc = gl.getAttribLocation(xrProgram, 'a_pos');
        gl.bindVertexArray(glVao);
        gl.enableVertexAttribArray(loc);
    }

    // ─── XR 세션 시작 ──────────────────────────────────────────
    const xrStartBtn = document.getElementById('xr-start-btn');
    const xrOverlay  = document.getElementById('xr-overlay');
    const xrPlaceMsg = document.getElementById('xr-place-msg');
    const xrExitBtn  = document.getElementById('xr-exit-btn');
    const xrScaleInput   = document.getElementById('xr-scale');
    const xrScaleVal     = document.getElementById('xr-scale-val');
    const xrOpacityInput = document.getElementById('xr-opacity');
    const xrOpacityVal   = document.getElementById('xr-opacity-val');
    const xrControls     = document.getElementById('xr-controls');

    if (xrStartBtn) {
        xrStartBtn.addEventListener('click', async () => {
            if (!arFiles.length) return;
            xrStartBtn.disabled = true;

            try {
                // WebGL 초기화 (아직 안 했으면)
                if (!gl) {
                    initWebGL();
                }
                // XR 프로그램 초기화
                if (!xrProgram) {
                    initXRProgram();
                }

                // 파일 로드
                if (!mediaVideoEl && arFiles[0].type.startsWith('video/')) {
                    startScreen.classList.add('hidden');
                    loadingScreen.classList.remove('hidden');
                    await loadFile(0);
                    loadingScreen.classList.add('hidden');
                } else if (!mediaVideoEl) {
                    startScreen.classList.add('hidden');
                    loadingScreen.classList.remove('hidden');
                    await loadFile(0);
                    loadingScreen.classList.add('hidden');
                }

                // 영상 종횡비 저장
                if (mediaVideoEl) {
                    xrVideoAspect = mediaVideoEl.videoWidth / mediaVideoEl.videoHeight;
                }

                await startXRSession();
            } catch (e) {
                console.error('XR 세션 시작 실패:', e);
                xrStartBtn.disabled = false;
                showError('AR 배치 모드를 시작할 수 없습니다.\n' + (e.message || ''));
            }
        });
    }

    async function startXRSession() {
        const sessionInit = {
            requiredFeatures: ['hit-test', 'local'],
            optionalFeatures: ['dom-overlay'],
        };
        if (xrOverlay) {
            sessionInit.domOverlay = { root: xrOverlay };
        }

        xrSession = await navigator.xr.requestSession('immersive-ar', sessionInit);

        // XR 렌더 레이어 설정
        const glLayer = new XRWebGLLayer(xrSession, gl);
        xrSession.updateRenderState({ baseLayer: glLayer });

        // 참조 공간
        xrRefSpace = await xrSession.requestReferenceSpace('local');

        // Hit-test 소스 (뷰어 중심에서 레이 캐스트)
        const viewerSpace = await xrSession.requestReferenceSpace('viewer');
        xrHitTestSource = await xrSession.requestHitTestSource({ space: viewerSpace });

        // 기존 렌더 루프 정지
        if (animId) { cancelAnimationFrame(animId); animId = null; }

        xrMode = true;
        xrPlaced = false;
        xrPlacementMatrix = null;
        xrReticleVisible = false;

        // UI 전환
        startScreen.classList.add('hidden');
        arContainer.classList.add('hidden');
        if (xrOverlay) xrOverlay.classList.remove('hidden');
        if (xrPlaceMsg) xrPlaceMsg.classList.remove('hidden');
        if (xrControls) xrControls.classList.add('hidden');

        // 세션 종료 이벤트
        xrSession.addEventListener('end', onXRSessionEnd);

        // 탭하여 배치
        if (xrOverlay) {
            xrOverlay.addEventListener('click', onXRTap);
        }

        // XR 렌더 루프 시작
        xrSession.requestAnimationFrame(xrAnimate);
    }

    // ─── XR 탭하여 배치 ────────────────────────────────────────
    function onXRTap(e) {
        // UI 버튼 클릭은 무시
        if (e.target.closest('button, input, label')) return;
        if (xrPlaced || !xrReticleVisible || !xrReticleMatrix) return;

        xrPlacementMatrix = new Float32Array(xrReticleMatrix);
        xrPlaced = true;

        // Hit-test 더 이상 불필요
        if (xrHitTestSource) {
            xrHitTestSource.cancel();
            xrHitTestSource = null;
        }

        // UI 전환
        if (xrPlaceMsg) xrPlaceMsg.classList.add('hidden');
        if (xrControls) xrControls.classList.remove('hidden');
    }

    // ─── XR 렌더 루프 ─────────────────────────────────────────
    function xrAnimate(time, frame) {
        if (!xrSession) return;
        xrSession.requestAnimationFrame(xrAnimate);

        const glLayer = xrSession.renderState.baseLayer;
        gl.bindFramebuffer(gl.FRAMEBUFFER, glLayer.framebuffer);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        const pose = frame.getViewerPose(xrRefSpace);
        if (!pose) return;

        // 비디오 텍스처 업데이트
        if (mediaVideoEl && mediaVideoEl.readyState >= 2) {
            uploadTexture(mediaVideoEl);
        }

        // 배치 전: hit-test로 리티클 표시
        if (!xrPlaced && xrHitTestSource) {
            const hitResults = frame.getHitTestResults(xrHitTestSource);
            if (hitResults.length > 0) {
                const hitPose = hitResults[0].getPose(xrRefSpace);
                xrReticleMatrix = hitPose.transform.matrix;
                xrReticleVisible = true;
            } else {
                xrReticleVisible = false;
            }
        }

        // 각 뷰에 대해 렌더링
        for (const view of pose.views) {
            const vp = glLayer.getViewport(view);
            gl.viewport(vp.x, vp.y, vp.width, vp.height);

            const projMatrix = view.projectionMatrix;
            const viewMatrix = view.transform.inverse.matrix;

            if (xrPlaced && xrPlacementMatrix) {
                renderXRQuad(projMatrix, viewMatrix, xrPlacementMatrix, overlay.opacity);
            } else if (xrReticleVisible && xrReticleMatrix) {
                // 배치 전 미리보기 (반투명)
                renderXRQuad(projMatrix, viewMatrix, xrReticleMatrix, 0.4);
            }
        }
    }

    // ─── XR 쿼드 렌더링 ───────────────────────────────────────
    function renderXRQuad(projMatrix, viewMatrix, modelMatrix, opacity) {
        const scaleX = xrVideoScale * xrVideoAspect;
        const scaleZ = xrVideoScale;
        const scaledModel = mat4Multiply(modelMatrix, mat4Scale(scaleX, 1, scaleZ));
        const mv = mat4Multiply(viewMatrix, scaledModel);
        const mvp = mat4Multiply(projMatrix, mv);

        gl.useProgram(xrProgram);
        gl.bindVertexArray(glVao);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, glTexture);

        gl.uniformMatrix4fv(xrUniforms.mvp, false, mvp);
        gl.uniform1i(xrUniforms.tex, 0);
        gl.uniform3f(xrUniforms.key, overlay.color[0], overlay.color[1], overlay.color[2]);
        gl.uniform1f(xrUniforms.sim, overlay.similarity);
        gl.uniform1f(xrUniforms.smooth, overlay.smoothness);
        gl.uniform1i(xrUniforms.useChroma, useChromaKey ? 1 : 0);
        gl.uniform1f(xrUniforms.opacity, opacity);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawElements(gl.TRIANGLES, 16 * 16 * 6, gl.UNSIGNED_SHORT, 0);
    }

    // ─── XR 세션 종료 ─────────────────────────────────────────
    function onXRSessionEnd() {
        xrMode = false;
        xrSession = null;
        xrPlaced = false;
        xrPlacementMatrix = null;
        xrHitTestSource = null;
        xrReticleMatrix = null;
        xrReticleVisible = false;

        // 프레임버퍼 복원
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        onResize();

        // UI 복원
        if (xrOverlay) {
            xrOverlay.classList.add('hidden');
            xrOverlay.removeEventListener('click', onXRTap);
        }
        if (xrStartBtn) xrStartBtn.disabled = false;
        startScreen.classList.remove('hidden');
    }

    // ─── XR UI 이벤트 ─────────────────────────────────────────
    if (xrExitBtn) {
        xrExitBtn.addEventListener('click', () => {
            if (xrSession) xrSession.end();
        });
    }
    if (xrScaleInput) {
        xrScaleInput.addEventListener('input', () => {
            const cm = parseInt(xrScaleInput.value);
            xrVideoScale = cm / 100;
            if (xrScaleVal) xrScaleVal.textContent = cm + 'cm';
        });
    }
    if (xrOpacityInput) {
        xrOpacityInput.addEventListener('input', () => {
            const v = parseInt(xrOpacityInput.value);
            overlay.opacity = v / 100;
            if (xrOpacityVal) xrOpacityVal.textContent = v + '%';
        });
    }

    // ─── 페이지 종료 시 리소스 정리 ──────────────────────────────
    function cleanup() {
        cancelAnimationFrame(animId);
        releaseWakeLock();
        if (xrSession) { xrSession.end().catch(() => {}); xrSession = null; }
        if (recStream)    { recStream.getTracks().forEach(t => t.stop()); recStream = null; }
        if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); }
        if (mediaVideoEl) { mediaVideoEl.pause(); mediaVideoEl = null; }
        if (videoAudioCtx) { videoAudioCtx.close(); videoAudioCtx = null; }
        if (gl && glTexture) { gl.deleteTexture(glTexture); }
        if (gl && glProgram) { gl.deleteProgram(glProgram); }
        if (gl && xrProgram) { gl.deleteProgram(xrProgram); }
        if (gl && glVao)     { gl.deleteVertexArray(glVao); }
        if (gl && glBuffer)  { gl.deleteBuffer(glBuffer); }
        _ffmpegCore = null;
    }
    window.addEventListener('beforeunload', cleanup);

    // ─── 백그라운드 전환 시 녹화 자동 중단 ──────────────────────
    // requestAnimationFrame은 탭/앱이 백그라운드되면 중단됨
    // → drawFrame 루프가 멈춰 captureStream에 새 프레임이 공급되지 않음
    // → MediaRecorder가 빈 프레임 또는 마지막 프레임을 반복 기록
    // 해결: visibilitychange 시 녹화 중이면 즉시 stop() 호출
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && isRecording) {
            stopRecording();
        }
    });

    // ─── 헬퍼 ────────────────────────────────────────────────────
    function showError(msg) {
        startScreen.classList.add('hidden');
        loadingScreen.classList.add('hidden');
        errorMessage.textContent = msg;
        errorScreen.classList.remove('hidden');
    }
})();
