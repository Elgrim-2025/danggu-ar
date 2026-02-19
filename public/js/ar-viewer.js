(function () {
    'use strict';

    // ─── DOM (먼저 선언해야 showError 호출 가능) ─────────────────
    const errorScreen = document.getElementById('error-screen');
    const errorMessage = document.getElementById('error-message');
    const startScreen = document.getElementById('start-screen');
    const startBtn = document.getElementById('start-btn');
    const permissionStatus = document.getElementById('permission-status');
    const loadingScreen = document.getElementById('loading-screen');
    const loadingText = document.getElementById('loading-text');
    const arContainer = document.getElementById('ar-container');
    const videoBackground = document.getElementById('video-background');
    const instruction = document.getElementById('instruction');
    const adjustToggleBtn = document.getElementById('adjust-toggle-btn');
    const colorAdjustPanel = document.getElementById('color-adjust-panel');
    const panelCloseBtn = document.getElementById('panel-close-btn');
    const adjustColor = document.getElementById('adjust-color');
    const adjustSimilarity = document.getElementById('adjust-similarity');
    const adjustSmoothness = document.getElementById('adjust-smoothness');
    const adjSimVal = document.getElementById('adj-sim-val');
    const adjSmoothVal = document.getElementById('adj-smooth-val');

    // ─── Extract AR ID from URL ──────────────────────────────────
    const pathParts = window.location.pathname.split('/ar/');
    const arId = pathParts[1];
    if (!arId) {
        showError('잘못된 링크입니다.');
        return;
    }

    // ─── State ───────────────────────────────────────────────────
    let arMeta = null;
    let scene, camera, renderer;
    let hudMesh = null;
    let hudBaseScale = 1.0;
    let mediaVideoEl = null;
    let mediaTexture = null;

    const gesture = {
        isDragging: false,
        isPinching: false,
        dragStartX: 0,
        dragStartY: 0,
        objStartX: 0,
        objStartY: 0,
        pinchStartDist: 0,
        pinchStartScale: 1
    };

    // ─── Fetch Metadata ──────────────────────────────────────────
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
            arMeta = await res.json();

            // Set adjustment panel defaults from metadata
            adjustColor.value = arMeta.color;
            adjustSimilarity.value = arMeta.similarity;
            adjustSmoothness.value = arMeta.smoothness;
            adjSimVal.textContent = arMeta.similarity.toFixed(2);
            adjSmoothVal.textContent = arMeta.smoothness.toFixed(2);

            startBtn.disabled = false;
            startBtn.textContent = '시작하기';
        } catch (e) {
            showError('네트워크 오류가 발생했습니다.');
        }
    }

    // ─── Start Button (Permission Request) ───────────────────────
    startBtn.addEventListener('click', async () => {
        if (!arMeta) {
            permissionStatus.textContent = '메타데이터를 불러오는 중입니다...';
            return;
        }

        startBtn.disabled = true;
        permissionStatus.textContent = '권한 요청 중...';

        try {
            // Request camera
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: 'environment',
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                },
                audio: false
            });

            videoBackground.srcObject = stream;
            await videoBackground.play();

            // Request sensor permissions on iOS 13+
            if (typeof DeviceOrientationEvent !== 'undefined' &&
                typeof DeviceOrientationEvent.requestPermission === 'function') {
                try {
                    await DeviceOrientationEvent.requestPermission();
                } catch (e) {
                    console.warn('Sensor permission denied:', e);
                }
            }

            // Hide start screen, show loading
            startScreen.classList.add('hidden');
            loadingScreen.classList.remove('hidden');
            loadingText.textContent = '파일 불러오는 중...';

            // Initialize AR
            await initAR();
        } catch (e) {
            permissionStatus.textContent = '카메라 권한이 거부되었습니다. 브라우저 설정에서 허용해주세요.';
            startBtn.disabled = false;
            console.error('Permission error:', e);
        }
    });

    // ─── Initialize AR ───────────────────────────────────────────

    async function initAR() {
        initScene();
        await loadMedia();
        setupGestures();
        setupAdjustPanel();

        // Hide loading, show AR
        loadingScreen.classList.add('hidden');
        arContainer.classList.remove('hidden');

        // Fade out instruction after 4s
        setTimeout(() => {
            instruction.classList.add('fade-out');
            setTimeout(() => { instruction.style.display = 'none'; }, 500);
        }, 4000);

        // Start render loop
        animate();
    }

    // ─── Three.js Scene ──────────────────────────────────────────

    function initScene() {
        scene = new THREE.Scene();
        scene.background = null;

        camera = new THREE.PerspectiveCamera(
            70,
            window.innerWidth / window.innerHeight,
            0.01,
            1000
        );
        camera.position.set(0, 0, 0);
        scene.add(camera);

        renderer = new THREE.WebGLRenderer({
            antialias: true,
            alpha: true,
            premultipliedAlpha: false
        });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setClearColor(0x000000, 0);

        document.getElementById('canvas-container').appendChild(renderer.domElement);

        // Lighting
        scene.add(new THREE.AmbientLight(0xffffff, 0.7));
        const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
        dirLight.position.set(1, 2, 1);
        scene.add(dirLight);

        // Handle resize
        window.addEventListener('resize', () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        });
    }

    // ─── Load Media & Create Chroma Key Mesh ─────────────────────

    async function loadMedia() {
        const isVideo = arMeta.type.startsWith('video/');
        const fileUrl = '/api/file/' + arId;

        if (isVideo) {
            const video = document.createElement('video');
            video.loop = true;
            video.muted = true;
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

            const aspect = video.videoWidth / video.videoHeight;
            createHudMesh(texture, aspect);
        } else {
            const texture = await new Promise((resolve, reject) => {
                new THREE.TextureLoader().load(fileUrl, resolve, undefined, reject);
            });
            texture.colorSpace = THREE.SRGBColorSpace;

            mediaTexture = texture;

            const aspect = texture.image.width / texture.image.height;
            createHudMesh(texture, aspect);
        }
    }

    function createHudMesh(texture, aspect) {
        const material = createChromaMaterial(
            texture,
            arMeta.color,
            arMeta.similarity,
            arMeta.smoothness
        );

        const planeHeight = 0.5;
        const geometry = new THREE.PlaneGeometry(planeHeight * aspect, planeHeight);
        hudMesh = new THREE.Mesh(geometry, material);

        // Parent to camera (screen-fixed HUD)
        hudMesh.position.set(0, 0, -1.5);
        hudBaseScale = 1.0;
        hudMesh.scale.set(1, 1, 1);
        camera.add(hudMesh);
    }

    // ─── Chroma Key Shader (from ar-engine/src/js/main.js) ──────

    function createChromaMaterial(texture, colorHex, sim, smooth) {
        const color = new THREE.Color(colorHex);

        return new THREE.ShaderMaterial({
            uniforms: {
                videoTexture: { value: texture },
                keyColor: { value: new THREE.Vector3(color.r, color.g, color.b) },
                similarity: { value: sim },
                smoothness: { value: smooth }
            },
            vertexShader: [
                'varying vec2 vUv;',
                'void main() {',
                '    vUv = uv;',
                '    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
                '}'
            ].join('\n'),
            fragmentShader: [
                'uniform sampler2D videoTexture;',
                'uniform vec3 keyColor;',
                'uniform float similarity;',
                'uniform float smoothness;',
                'varying vec2 vUv;',
                '',
                'vec2 RGBtoUV(vec3 rgb) {',
                '    return vec2(',
                '        rgb.r * -0.169 + rgb.g * -0.331 + rgb.b * 0.5 + 0.5,',
                '        rgb.r * 0.5 + rgb.g * -0.419 + rgb.b * -0.081 + 0.5',
                '    );',
                '}',
                '',
                'void main() {',
                '    vec4 texColor = texture2D(videoTexture, vUv);',
                '    vec2 chromaVec = RGBtoUV(texColor.rgb) - RGBtoUV(keyColor);',
                '    float chromaDist = sqrt(dot(chromaVec, chromaVec));',
                '    float alpha = smoothstep(similarity, similarity + smoothness, chromaDist);',
                '    gl_FragColor = vec4(texColor.rgb, texColor.a * alpha);',
                '}'
            ].join('\n'),
            transparent: true,
            side: THREE.DoubleSide
        });
    }

    // ─── Gesture System (from ar-engine/src/js/main.js) ──────────

    function setupGestures() {
        const touchArea = document.getElementById('touch-area');
        let lastTap = 0;

        // === Touch Events (Mobile) ===
        touchArea.addEventListener('touchstart', (e) => {
            e.preventDefault();
            if (!hudMesh) return;

            if (e.touches.length === 1) {
                gesture.isDragging = true;
                gesture.isPinching = false;
                gesture.dragStartX = e.touches[0].clientX;
                gesture.dragStartY = e.touches[0].clientY;
                gesture.objStartX = hudMesh.position.x;
                gesture.objStartY = hudMesh.position.y;
            } else if (e.touches.length === 2) {
                gesture.isDragging = false;
                gesture.isPinching = true;
                gesture.pinchStartDist = getTouchDistance(e.touches);
                gesture.pinchStartScale = hudBaseScale;
            }
        }, { passive: false });

        touchArea.addEventListener('touchmove', (e) => {
            e.preventDefault();
            if (!hudMesh) return;

            if (gesture.isDragging && e.touches.length === 1) {
                const dx = e.touches[0].clientX - gesture.dragStartX;
                const dy = e.touches[0].clientY - gesture.dragStartY;
                const scale = screenPixelToLocal();
                hudMesh.position.x = gesture.objStartX + dx * scale;
                hudMesh.position.y = gesture.objStartY - dy * scale;
            } else if (gesture.isPinching && e.touches.length === 2) {
                const dist = getTouchDistance(e.touches);
                const ratio = dist / gesture.pinchStartDist;
                const newScale = Math.max(0.3, Math.min(20.0, gesture.pinchStartScale * ratio));
                hudBaseScale = newScale;
                hudMesh.scale.set(newScale, newScale, newScale);
            }
        }, { passive: false });

        touchArea.addEventListener('touchend', (e) => {
            if (e.touches.length === 0) {
                gesture.isDragging = false;
                gesture.isPinching = false;
            } else if (e.touches.length === 1) {
                gesture.isPinching = false;
                gesture.isDragging = true;
                gesture.dragStartX = e.touches[0].clientX;
                gesture.dragStartY = e.touches[0].clientY;
                gesture.objStartX = hudMesh ? hudMesh.position.x : 0;
                gesture.objStartY = hudMesh ? hudMesh.position.y : 0;
            }
        });

        // === Mouse Events (Desktop) ===
        let mouseDown = false;

        touchArea.addEventListener('mousedown', (e) => {
            if (!hudMesh) return;
            mouseDown = true;
            gesture.dragStartX = e.clientX;
            gesture.dragStartY = e.clientY;
            gesture.objStartX = hudMesh.position.x;
            gesture.objStartY = hudMesh.position.y;
        });

        touchArea.addEventListener('mousemove', (e) => {
            if (!mouseDown || !hudMesh) return;
            const dx = e.clientX - gesture.dragStartX;
            const dy = e.clientY - gesture.dragStartY;
            const scale = screenPixelToLocal();
            hudMesh.position.x = gesture.objStartX + dx * scale;
            hudMesh.position.y = gesture.objStartY - dy * scale;
        });

        touchArea.addEventListener('mouseup', () => { mouseDown = false; });
        touchArea.addEventListener('mouseleave', () => { mouseDown = false; });

        // Mouse wheel: scale
        touchArea.addEventListener('wheel', (e) => {
            if (!hudMesh) return;
            e.preventDefault();
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            hudBaseScale = Math.max(0.3, Math.min(5.0, hudBaseScale * delta));
            hudMesh.scale.set(hudBaseScale, hudBaseScale, hudBaseScale);
        }, { passive: false });
    }

    function getTouchDistance(touches) {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    function screenPixelToLocal() {
        const distance = 1.5;
        const fovRad = THREE.MathUtils.degToRad(camera.fov);
        return (2 * distance * Math.tan(fovRad / 2)) / window.innerHeight;
    }

    // ─── Color Adjustment Panel ──────────────────────────────────

    function setupAdjustPanel() {
        adjustToggleBtn.addEventListener('click', () => {
            colorAdjustPanel.classList.toggle('hidden');
        });

        panelCloseBtn.addEventListener('click', () => {
            colorAdjustPanel.classList.add('hidden');
        });

        adjustColor.addEventListener('input', (e) => {
            if (!hudMesh) return;
            const c = new THREE.Color(e.target.value);
            hudMesh.material.uniforms.keyColor.value.set(c.r, c.g, c.b);
        });

        adjustSimilarity.addEventListener('input', (e) => {
            if (!hudMesh) return;
            const val = parseFloat(e.target.value);
            hudMesh.material.uniforms.similarity.value = val;
            adjSimVal.textContent = val.toFixed(2);
        });

        adjustSmoothness.addEventListener('input', (e) => {
            if (!hudMesh) return;
            const val = parseFloat(e.target.value);
            hudMesh.material.uniforms.smoothness.value = val;
            adjSmoothVal.textContent = val.toFixed(2);
        });
    }

    // ─── Render Loop ─────────────────────────────────────────────

    function animate() {
        requestAnimationFrame(animate);

        if (mediaTexture && mediaVideoEl) {
            mediaTexture.needsUpdate = true;
        }

        renderer.render(scene, camera);
    }

    // ─── Helpers ─────────────────────────────────────────────────

    function showError(msg) {
        startScreen.classList.add('hidden');
        loadingScreen.classList.add('hidden');
        errorMessage.textContent = msg;
        errorScreen.classList.remove('hidden');
    }
})();
