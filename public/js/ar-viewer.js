(function () {
    'use strict';

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
    if (!arId) {
        showError('잘못된 링크입니다.');
        return;
    }

    // ─── State ───────────────────────────────────────────────────
    let arFiles = [];           // 파일 배열
    let currentFileIdx = 0;     // 현재 표시 중인 파일 인덱스
    let scene, camera, renderer;
    let hudMesh = null;
    let hudBaseScale = 1.0;
    let mediaVideoEl = null;
    let mediaTexture = null;
    let videoAudioCtx  = null;  // 녹화 시 생성, 파일 전환 시 닫힘
    let videoAudioDest = null;

    const gesture = {
        isDragging: false, isPinching: false,
        dragStartX: 0, dragStartY: 0,
        objStartX: 0, objStartY: 0,
        pinchStartDist: 0, pinchStartScale: 1
    };

    // ─── 메타데이터 로드 ─────────────────────────────────────────
    startBtn.disabled = true;
    startBtn.textContent = '로딩 중...';
    fetchMeta();

    async function fetchMeta() {
        try {
            const res = await fetch('/api/meta/' + arId);
            if (!res.ok) {
                showError('AR 콘텐츠를 찾을 수 없습니다.\n링크가 만료되었거나 잘못되었습니다.');
                return;
            }
            const meta = await res.json();

            // 새 형식: { files: [...] } / 구 형식: { id, type, ... }
            if (meta.files && meta.files.length > 0) {
                arFiles = meta.files;
            } else {
                // 구 형식 호환
                arFiles = [{ id: meta.id, type: meta.type, ext: meta.ext,
                    color: meta.color, similarity: meta.similarity,
                    smoothness: meta.smoothness, audio: false }];
            }

            // 제목 표시
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
                try { await DeviceOrientationEvent.requestPermission(); } catch (e) { /* ignore */ }
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
        initScene();
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

    // ─── 파일 로드 ───────────────────────────────────────────────
    async function loadFile(idx) {
        // 이전 리소스 정리
        if (mediaVideoEl) { mediaVideoEl.pause(); mediaVideoEl = null; }
        if (mediaTexture) { mediaTexture.dispose(); mediaTexture = null; }
        if (videoAudioCtx) { videoAudioCtx.close(); videoAudioCtx = null; videoAudioDest = null; }
        if (hudMesh) {
            camera.remove(hudMesh);
            hudMesh.geometry.dispose();
            hudMesh.material.dispose();
            hudMesh = null;
        }

        currentFileIdx = idx;
        const file = arFiles[idx];
        const isVideo = file.type.startsWith('video/');
        const fileUrl = '/api/file/' + file.id;

        if (isVideo) {
            const video = document.createElement('video');
            video.loop = true;
            video.muted = false;   // 항상 소리 재생
            video.playsInline = true;
            video.setAttribute('playsinline', '');
            video.setAttribute('webkit-playsinline', '');
            video.crossOrigin = 'anonymous';
            video.src = fileUrl;
            video.load();

            await new Promise((resolve, reject) => {
                video.addEventListener('loadeddata', resolve, { once: true });
                video.addEventListener('error', reject, { once: true });
            });
            await video.play();

            const texture = new THREE.VideoTexture(video);
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.minFilter = THREE.LinearFilter;
            texture.magFilter = THREE.LinearFilter;

            mediaVideoEl = video;
            mediaTexture = texture;
            createHudMesh(texture, video.videoWidth / video.videoHeight, file);
        } else {
            const texture = await new Promise((resolve, reject) => {
                new THREE.TextureLoader().load(fileUrl, resolve, undefined, reject);
            });
            texture.colorSpace = THREE.SRGBColorSpace;
            mediaTexture = texture;
            createHudMesh(texture, texture.image.width / texture.image.height, file);
        }

        // 색상 조정 패널 초기값 업데이트
        adjustColor.value = file.color;
        adjustSimilarity.value = file.similarity;
        adjustSmoothness.value = file.smoothness;
        adjSimVal.textContent = file.similarity.toFixed(2);
        adjSmoothVal.textContent = file.smoothness.toFixed(2);
    }

    // ─── 파일 전환 버튼 ──────────────────────────────────────────
    function setupFileSwitchBtns() {
        if (arFiles.length <= 1) return;   // 1개면 버튼 없음

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

    // ─── Three.js Scene ──────────────────────────────────────────
    function initScene() {
        scene = new THREE.Scene();
        scene.background = null;

        camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 1000);
        camera.position.set(0, 0, 0);
        scene.add(camera);

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setClearColor(0x000000, 0);
        document.getElementById('canvas-container').appendChild(renderer.domElement);

        scene.add(new THREE.AmbientLight(0xffffff, 0.7));
        const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
        dirLight.position.set(1, 2, 1);
        scene.add(dirLight);

        window.addEventListener('resize', () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        });
    }

    function createHudMesh(texture, aspect, file) {
        const material = createChromaMaterial(texture, file.color, file.similarity, file.smoothness);
        const planeHeight = 1.8;  // 첫 등장 시 큰 크기 (Cloudflare 배포용)
        const geometry = new THREE.PlaneGeometry(planeHeight * aspect, planeHeight);
        hudMesh = new THREE.Mesh(geometry, material);
        hudMesh.position.set(0, 0, -1.5);
        hudBaseScale = 1.0;
        hudMesh.scale.set(1, 1, 1);
        camera.add(hudMesh);
    }

    // ─── 크로마키 셰이더 ─────────────────────────────────────────
    function createChromaMaterial(texture, colorHex, sim, smooth) {
        const color = new THREE.Color(colorHex);
        return new THREE.ShaderMaterial({
            uniforms: {
                videoTexture: { value: texture },
                keyColor:     { value: new THREE.Vector3(color.r, color.g, color.b) },
                similarity:   { value: sim },
                smoothness:   { value: smooth }
            },
            vertexShader: [
                'varying vec2 vUv;',
                'void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }'
            ].join('\n'),
            fragmentShader: [
                'uniform sampler2D videoTexture;',
                'uniform vec3 keyColor;',
                'uniform float similarity;',
                'uniform float smoothness;',
                'varying vec2 vUv;',
                'vec2 RGBtoUV(vec3 rgb) {',
                '  return vec2(rgb.r*-0.169+rgb.g*-0.331+rgb.b*0.5+0.5, rgb.r*0.5+rgb.g*-0.419+rgb.b*-0.081+0.5);',
                '}',
                'void main() {',
                '  vec4 texColor = texture2D(videoTexture, vUv);',
                '  vec2 chromaVec = RGBtoUV(texColor.rgb) - RGBtoUV(keyColor);',
                '  float chromaDist = sqrt(dot(chromaVec, chromaVec));',
                '  float alpha = smoothstep(similarity, similarity + smoothness, chromaDist);',
                '  gl_FragColor = vec4(texColor.rgb, texColor.a * alpha);',
                '}'
            ].join('\n'),
            transparent: true,
            side: THREE.DoubleSide
        });
    }

    // ─── 카메라 전환 ─────────────────────────────────────────────
    let facingMode = 'environment';
    let cameraStream = null;

    document.getElementById('flip-btn').addEventListener('click', async () => {
        facingMode = facingMode === 'environment' ? 'user' : 'environment';
        if (cameraStream) {
            cameraStream.getTracks().forEach(t => t.stop());
        }
        try {
            cameraStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: false
            });
            videoBackground.srcObject = cameraStream;
            await videoBackground.play();
            videoBackground.style.transform = facingMode === 'user' ? 'scaleX(-1)' : '';
        } catch (e) {
            facingMode = facingMode === 'environment' ? 'user' : 'environment'; // 되돌리기
        }
    });

    // ─── 캡처 (사진) / 녹화 (토글) ──────────────────────────────
    const captureBtn = document.getElementById('capture-btn');
    const recordBtn  = document.getElementById('record-btn');

    function doCapture() {
        const W = window.innerWidth;
        const H = window.innerHeight;
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        const vw = videoBackground.videoWidth;
        const vh = videoBackground.videoHeight;
        if (vw && vh) {
            const scale = Math.max(W / vw, H / vh);
            const dw = vw * scale, dh = vh * scale;
            const mirror = facingMode === 'user';
            if (mirror) {
                ctx.save();
                ctx.scale(-1, 1);
                ctx.drawImage(videoBackground, -W - (W - dw) / 2, (H - dh) / 2, dw, dh);
                ctx.restore();
            } else {
                ctx.drawImage(videoBackground, (W - dw) / 2, (H - dh) / 2, dw, dh);
            }
        }
        renderer.render(scene, camera);
        ctx.drawImage(renderer.domElement, 0, 0, W, H);
        const link = document.createElement('a');
        link.download = 'ar-capture.png';
        link.href = canvas.toDataURL('image/png');
        link.click();
    }

    function drawVideoCover(ctx, video, w, h, mirror) {
        const vw = video.videoWidth, vh = video.videoHeight;
        if (!vw || !vh) return;
        const vr = vw / vh;
        const cr = w / h;
        let sx, sy, sw, sh;
        if (vr > cr) {
            sh = vh; sw = vh * cr; sx = (vw - sw) / 2; sy = 0;
        } else {
            sw = vw; sh = vw / cr; sx = 0; sy = (vh - sh) / 2;
        }
        if (mirror) {
            ctx.save();
            ctx.scale(-1, 1);
            ctx.drawImage(video, sx, sy, sw, sh, -w, 0, w, h);
            ctx.restore();
        } else {
            ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
        }
    }

    let mediaRecorder = null, recordedChunks = [], recStream = null;
    let isRecording = false;
    let recFormat = null, recAnimId = null;

    function getRecFormat() {
        const types = [
            { mimeType: 'video/mp4', ext: 'mp4' },
            { mimeType: 'video/mp4;codecs=avc1', ext: 'mp4' },
            { mimeType: 'video/webm;codecs=vp9', ext: 'webm' },
            { mimeType: 'video/webm', ext: 'webm' }
        ];
        for (const t of types) {
            if (MediaRecorder.isTypeSupported(t.mimeType)) return t;
        }
        return { mimeType: '', ext: 'mp4' };
    }

    function startRecording() {
        const arCanvas = document.querySelector('#canvas-container canvas');
        if (!videoBackground || !arCanvas) return;
        if (typeof MediaRecorder === 'undefined') {
            console.warn('[Record] MediaRecorder 미지원');
            return;
        }
        try {
            recFormat = getRecFormat();
            const pr = window.devicePixelRatio || 1;
            const cw = window.innerWidth * pr, ch = window.innerHeight * pr;
            const comp = document.createElement('canvas');
            comp.width = cw;
            comp.height = ch;
            const cctx = comp.getContext('2d', { alpha: false, desynchronized: true });
            const mirror = facingMode === 'user';

            function drawFrame() {
                if (!isRecording) return;
                drawVideoCover(cctx, videoBackground, cw, ch, mirror);
                cctx.drawImage(arCanvas, 0, 0, arCanvas.width, arCanvas.height, 0, 0, cw, ch);
                recAnimId = requestAnimationFrame(drawFrame);
            }

            recStream = comp.captureStream(30);

            // 오디오 캡처: 최초 녹화 버튼 클릭(user gesture)에서 Web Audio API 설정
            if (mediaVideoEl && !videoAudioCtx) {
                try {
                    videoAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
                    videoAudioCtx.resume();
                    const src = videoAudioCtx.createMediaElementSource(mediaVideoEl);
                    videoAudioDest = videoAudioCtx.createMediaStreamDestination();
                    src.connect(videoAudioCtx.destination); // 스피커 유지
                    src.connect(videoAudioDest);            // 녹음 전용
                } catch(e) {
                    console.warn('[Record] 오디오 설정 실패:', e);
                    videoAudioCtx = null; videoAudioDest = null;
                }
            }
            if (videoAudioDest) {
                videoAudioDest.stream.getAudioTracks().forEach(t => recStream.addTrack(t));
            }

            recordedChunks = [];
            const opts = recFormat.mimeType
                ? { mimeType: recFormat.mimeType, videoBitsPerSecond: 5000000 }
                : { videoBitsPerSecond: 5000000 };
            mediaRecorder = new MediaRecorder(recStream, opts);
            mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
            mediaRecorder.onstop = () => {
                isRecording = false;
                cancelAnimationFrame(recAnimId);
                recordBtn.classList.remove('recording');
                const blob = new Blob(recordedChunks, { type: recFormat.ext === 'mp4' ? 'video/mp4' : 'video/webm' });
                const a = document.createElement('a');
                a.download = 'ar-recording-' + Date.now() + '.' + recFormat.ext;
                a.href = URL.createObjectURL(blob);
                a.click();
                URL.revokeObjectURL(a.href);
            };
            mediaRecorder.start(100);
            isRecording = true;
            recordBtn.classList.add('recording');
            drawFrame();
        } catch (e) {
            console.error('[Record] 녹화 실패:', e);
            isRecording = false;
            recordBtn.classList.remove('recording');
        }
    }

    function stopRecording() {
        isRecording = false;
        if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
        cancelAnimationFrame(recAnimId);
        recordBtn.classList.remove('recording');
    }

    // 사진 버튼: 탭 = 사진 저장
    captureBtn.addEventListener('click', () => doCapture());

    // 녹화 버튼: 탭 = 녹화 시작/정지 토글
    recordBtn.addEventListener('click', () => {
        if (isRecording) stopRecording();
        else startRecording();
    });

    // ─── 색상 조정 패널 ──────────────────────────────────────────
    function setupAdjustPanel() {
        adjustToggleBtn.addEventListener('click', () => colorAdjustPanel.classList.toggle('hidden'));
        panelCloseBtn.addEventListener('click', () => colorAdjustPanel.classList.add('hidden'));

        adjustColor.addEventListener('input', e => {
            if (!hudMesh) return;
            const c = new THREE.Color(e.target.value);
            hudMesh.material.uniforms.keyColor.value.set(c.r, c.g, c.b);
        });
        adjustSimilarity.addEventListener('input', e => {
            if (!hudMesh) return;
            hudMesh.material.uniforms.similarity.value = parseFloat(e.target.value);
            adjSimVal.textContent = parseFloat(e.target.value).toFixed(2);
        });
        adjustSmoothness.addEventListener('input', e => {
            if (!hudMesh) return;
            hudMesh.material.uniforms.smoothness.value = parseFloat(e.target.value);
            adjSmoothVal.textContent = parseFloat(e.target.value).toFixed(2);
        });
    }

    // ─── 제스처 ──────────────────────────────────────────────────
    function setupGestures() {
        const touchArea = document.getElementById('touch-area');

        touchArea.addEventListener('touchstart', e => {
            e.preventDefault();
            if (!hudMesh) return;
            if (e.touches.length === 1) {
                gesture.isDragging = true; gesture.isPinching = false;
                gesture.dragStartX = e.touches[0].clientX; gesture.dragStartY = e.touches[0].clientY;
                gesture.objStartX = hudMesh.position.x; gesture.objStartY = hudMesh.position.y;
            } else if (e.touches.length === 2) {
                gesture.isDragging = false; gesture.isPinching = true;
                gesture.pinchStartDist = getTouchDist(e.touches);
                gesture.pinchStartScale = hudBaseScale;
            }
        }, { passive: false });

        touchArea.addEventListener('touchmove', e => {
            e.preventDefault();
            if (!hudMesh) return;
            if (gesture.isDragging && e.touches.length === 1) {
                const scale = screenToLocal();
                hudMesh.position.x = gesture.objStartX + (e.touches[0].clientX - gesture.dragStartX) * scale;
                hudMesh.position.y = gesture.objStartY - (e.touches[0].clientY - gesture.dragStartY) * scale;
            } else if (gesture.isPinching && e.touches.length === 2) {
                const ratio = getTouchDist(e.touches) / gesture.pinchStartDist;
                hudBaseScale = Math.max(0.3, Math.min(20.0, gesture.pinchStartScale * ratio));
                hudMesh.scale.set(hudBaseScale, hudBaseScale, hudBaseScale);
            }
        }, { passive: false });

        touchArea.addEventListener('touchend', e => {
            if (e.touches.length === 0) { gesture.isDragging = false; gesture.isPinching = false; }
            else if (e.touches.length === 1) {
                gesture.isPinching = false; gesture.isDragging = true;
                gesture.dragStartX = e.touches[0].clientX; gesture.dragStartY = e.touches[0].clientY;
                gesture.objStartX = hudMesh ? hudMesh.position.x : 0;
                gesture.objStartY = hudMesh ? hudMesh.position.y : 0;
            }
        });

        let mouseDown = false;
        touchArea.addEventListener('mousedown', e => {
            if (!hudMesh) return;
            mouseDown = true;
            gesture.dragStartX = e.clientX; gesture.dragStartY = e.clientY;
            gesture.objStartX = hudMesh.position.x; gesture.objStartY = hudMesh.position.y;
        });
        touchArea.addEventListener('mousemove', e => {
            if (!mouseDown || !hudMesh) return;
            const scale = screenToLocal();
            hudMesh.position.x = gesture.objStartX + (e.clientX - gesture.dragStartX) * scale;
            hudMesh.position.y = gesture.objStartY - (e.clientY - gesture.dragStartY) * scale;
        });
        touchArea.addEventListener('mouseup', () => { mouseDown = false; });
        touchArea.addEventListener('mouseleave', () => { mouseDown = false; });
        touchArea.addEventListener('wheel', e => {
            if (!hudMesh) return;
            e.preventDefault();
            hudBaseScale = Math.max(0.3, Math.min(5.0, hudBaseScale * (e.deltaY > 0 ? 0.9 : 1.1)));
            hudMesh.scale.set(hudBaseScale, hudBaseScale, hudBaseScale);
        }, { passive: false });
    }

    function getTouchDist(touches) {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    function screenToLocal() {
        return (2 * 1.5 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / window.innerHeight;
    }

    // ─── 렌더 루프 ───────────────────────────────────────────────
    function animate() {
        requestAnimationFrame(animate);
        if (mediaTexture && mediaVideoEl) mediaTexture.needsUpdate = true;
        renderer.render(scene, camera);
    }

    // ─── 헬퍼 ────────────────────────────────────────────────────
    function showError(msg) {
        startScreen.classList.add('hidden');
        loadingScreen.classList.add('hidden');
        errorMessage.textContent = msg;
        errorScreen.classList.remove('hidden');
    }
})();
