/**
 * 강진 AR - 3 Layer AR System
 *
 * Layer 1: Background (현실 세계) - 카메라 비디오
 * Layer 2: Virtual (가상 객체) - Three.js 3D 렌더링 (투명 배경)
 * Layer 3: Compositing (합성) - 알파 블렌딩으로 실시간 합성
 *
 * iOS 13+ Safari / Android Chrome 공통 지원
 * 사용자 제스처를 통한 권한 요청 필수
 *
 * Wasm SLAM과 Three.js 카메라 연동
 */

import * as THREE from 'three';
import { CameraPoseManager, ARObjectPlacer } from './CameraPoseManager.js';

// Visual Odometry는 동적 로드 (Wasm 빌드 후 사용 가능)
let VisualOdometry = null;

class ARApp {
    constructor() {
        // === Layer 1: Background ===
        this.video = null;

        // === Layer 2: Virtual ===
        this.scene = null;
        this.camera = null;
        this.renderer = null;

        // === SLAM / Pose ===
        this.visualOdometry = null;      // Wasm Visual Odometry
        this.cameraPoseManager = null;   // Three.js 카메라 매니저
        this.objectPlacer = null;        // AR 객체 배치 헬퍼

        // === AR Objects ===
        this.cubes = [];
        this.originCube = null;          // 바닥 원점의 빨간 큐브
        this.floorGrid = null;           // 바닥 그리드
        this.axesHelper = null;          // 축 헬퍼

        // === HUD 오브젝트 (화면에 붙어다니는 영상) ===
        this.hudCube = null;             // 화면에 고정된 메시
        this.hudCubeBaseScale = 1.0;     // 핀치 기준 스케일
        this.hudVideo = null;            // webm 비디오 엘리먼트
        this.hudVideoTexture = null;     // VideoTexture
        this.currentVideoSrc = 'kim-cos-chroma.mp4'; // 현재 영상 소스

        // === 제스처 상태 ===
        this.gesture = {
            isDragging: false,
            isPinching: false,
            // 드래그 상태
            dragStartX: 0,
            dragStartY: 0,
            objStartX: 0,
            objStartY: 0,
            // 핀치 상태
            pinchStartDist: 0,
            pinchStartScale: 1.0,
        };

        // === Sensor (폴백용) ===
        this.deviceOrientation = { alpha: 0, beta: 0, gamma: 0 };
        this.initialOrientation = null;
        this.useGyroscope = false;

        // === 모드 ===
        this.trackingMode = 'sensor';    // 'sensor' | 'slam' | 'hybrid'

        // === State ===
        this.isRunning = false;
        this.isReady = false;

        // === 프레임 처리용 Canvas ===
        this.processCanvas = null;
        this.processCtx = null;

        console.log('[AR] 3-Layer AR System 초기화');
    }

    /**
     * 권한이 이미 승인된 후 호출되는 초기화 함수
     * (시작 버튼 클릭 → 권한 승인 → 이 함수 호출)
     */
    async init() {
        console.log('========================================');
        console.log('    강진 AR - 3 Layer System');
        console.log('========================================');

        try {
            // Step 1: Layer 1 - 카메라 비디오 초기화 (이미 권한 승인됨)
            window.updateLoadingProgress(30, '카메라 연결 중...');
            await this.initBackgroundLayer();

            // Step 2: Layer 2 - Three.js 가상 레이어 초기화
            window.updateLoadingProgress(60, '3D 엔진 초기화...');
            this.initVirtualLayer();

            // Step 3: 센서 리스너 등록 (권한은 이미 승인됨)
            window.updateLoadingProgress(80, '센서 연결 중...');
            this.initSensors();

            // Step 4: 이벤트 설정
            window.updateLoadingProgress(90, '이벤트 설정...');
            this.setupEvents();

            // 완료
            window.updateLoadingProgress(100, '완료!');
            this.isRunning = true;
            this.isReady = true;

            setTimeout(() => {
                window.hideLoadingScreen();
                // 초기 HUD 큐브 자동 배치
                this.placeCube();
                // 안내 오버레이 표시 (터치 시 사라짐)
                if (window.showInstruction) window.showInstruction();
                console.log('========================================');
                console.log('          AR 준비 완료!');
                console.log('========================================');
            }, 500);

            // 렌더 루프 시작
            this.animate();

        } catch (e) {
            console.error('[AR] 초기화 실패:', e);
            this.updateStatus('초기화 실패: ' + e.message);
        }
    }

    /**
     * Layer 1: Background - 카메라 비디오
     * 권한은 index.html에서 이미 승인됨
     */
    async initBackgroundLayer() {
        console.log('[Layer1] 카메라 비디오 연결');

        this.video = document.getElementById('video-background');
        if (!this.video) {
            throw new Error('video-background 엘리먼트 없음');
        }

        // 권한이 이미 승인되어 cameraStream이 존재하는 경우
        if (window.cameraStream) {
            console.log('[Layer1] 기존 카메라 스트림 사용');
            this.video.srcObject = window.cameraStream;

            // 비디오가 아직 재생 중이 아니면 재생 시작
            if (this.video.paused) {
                this.video.muted = true;
                this.video.playsInline = true;
                await this.video.play();
            }

            console.log('[Layer1] 카메라 연결됨:', this.video.videoWidth, 'x', this.video.videoHeight);
            return true;
        }

        // 폴백: 직접 권한 요청 (데스크탑 등에서)
        console.log('[Layer1] 카메라 스트림 직접 요청');
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: 'environment',
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                }
            });

            this.video.srcObject = stream;
            window.cameraStream = stream;

            this.video.muted = true;
            this.video.playsInline = true;
            await this.video.play();

            console.log('[Layer1] 카메라 시작:', this.video.videoWidth, 'x', this.video.videoHeight);
            return true;

        } catch (e) {
            console.error('[Layer1] 카메라 에러:', e);
            throw e;
        }
    }

    /**
     * Layer 2: Virtual - Three.js 3D 렌더링
     */
    initVirtualLayer() {
        console.log('[Layer2] Three.js 초기화');

        const container = document.getElementById('canvas-container');

        // Scene
        this.scene = new THREE.Scene();
        // 배경을 완전 투명하게 (Layer 1이 비쳐 보이도록)
        this.scene.background = null;

        // Camera
        this.camera = new THREE.PerspectiveCamera(
            70,
            window.innerWidth / window.innerHeight,
            0.01,
            1000
        );
        this.camera.position.set(0, 0, 0);
        this.scene.add(this.camera); // 카메라 자식 오브젝트 렌더링을 위해 씬에 추가

        // Renderer - 투명 배경 필수!
        this.renderer = new THREE.WebGLRenderer({
            antialias: true,
            alpha: true,           // 투명 배경
            premultipliedAlpha: false,
            preserveDrawingBuffer: true  // 캡처/녹화용
        });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setClearColor(0x000000, 0); // 완전 투명
        this.renderer.domElement.style.position = 'absolute';
        this.renderer.domElement.style.top = '0';
        this.renderer.domElement.style.left = '0';
        this.renderer.domElement.style.zIndex = '1';
        this.renderer.domElement.style.pointerEvents = 'none'; // 클릭 통과

        container.appendChild(this.renderer.domElement);

        // Lighting
        const ambient = new THREE.AmbientLight(0xffffff, 0.7);
        this.scene.add(ambient);

        const directional = new THREE.DirectionalLight(0xffffff, 0.8);
        directional.position.set(1, 2, 1);
        this.scene.add(directional);

        // === CameraPoseManager 초기화 ===
        this.cameraPoseManager = new CameraPoseManager(this.camera);
        this.cameraPoseManager.setSmoothing(true, 0.2);  // 부드러운 움직임

        // === ARObjectPlacer 초기화 ===
        this.objectPlacer = new ARObjectPlacer(this.scene, this.camera);

        // 원점 마커 제거됨 (HUD 모드 사용)

        console.log('[Layer2] Three.js 준비 완료');
    }

    /**
     * 바닥 원점에 빨간 큐브 배치
     */
    setupOriginMarker() {
        // 빨간 큐브 생성 (10cm x 10cm x 10cm)
        const cubeSize = 0.1;
        const geometry = new THREE.BoxGeometry(cubeSize, cubeSize, cubeSize);
        const material = new THREE.MeshPhongMaterial({
            color: 0xff0000,
            shininess: 100,
            transparent: true,
            opacity: 0.9
        });
        this.originCube = new THREE.Mesh(geometry, material);

        // 바닥 (y=0)에 맞추어 배치 (큐브 중심이 바닥 위에 오도록)
        this.originCube.position.set(0, cubeSize / 2, 0);
        this.scene.add(this.originCube);

        // 바닥 그리드 (2m x 2m, 20칸)
        this.floorGrid = new THREE.GridHelper(2, 20, 0x4da6ff, 0x1a5580);
        this.floorGrid.position.y = 0;
        this.scene.add(this.floorGrid);

        // 축 헬퍼 (X=빨강, Y=초록, Z=파랑)
        this.axesHelper = new THREE.AxesHelper(0.5);
        this.axesHelper.position.set(0, 0.001, 0);  // 그리드 위에
        this.scene.add(this.axesHelper);

        console.log('[Layer2] 원점 마커 배치 완료 (빨간 큐브 @ 0,0,0)');
    }

    /**
     * 센서 초기화 (DeviceOrientation)
     * 권한은 index.html에서 이미 승인됨
     */
    initSensors() {
        console.log('[Sensor] 센서 리스너 등록');

        // 센서 권한이 승인되었는지 확인
        if (window.sensorPermissionGranted !== false) {
            this.useGyroscope = true;
        }

        // DeviceOrientation 리스너 등록 (iOS/Android 공통)
        window.addEventListener('deviceorientation', (e) => this.onDeviceOrientation(e), true);
        console.log('[Sensor] DeviceOrientation 리스너 등록됨');

        // DeviceMotion 리스너도 등록 (가속도계)
        window.addEventListener('devicemotion', (e) => this.onDeviceMotion(e), true);
        console.log('[Sensor] DeviceMotion 리스너 등록됨');
    }

    /**
     * DeviceMotion 이벤트 핸들러 (가속도계)
     */
    onDeviceMotion(event) {
        // 가속도 데이터 (나중에 SLAM에서 사용)
        if (event.acceleration) {
            this.acceleration = {
                x: event.acceleration.x || 0,
                y: event.acceleration.y || 0,
                z: event.acceleration.z || 0
            };
        }
    }

    /**
     * DeviceOrientation 이벤트 핸들러
     */
    onDeviceOrientation(event) {
        if (event.alpha === null) return;

        this.deviceOrientation = {
            alpha: event.alpha,
            beta: event.beta,
            gamma: event.gamma
        };

        // 초기 방향 저장
        if (!this.initialOrientation) {
            this.initialOrientation = { ...this.deviceOrientation };
            console.log('[Sensor] 초기 방향 저장:', this.initialOrientation);
        }
    }

    /**
     * 이벤트 설정 (드래그 + 핀치 제스처)
     */
    setupEvents() {
        console.log('[Event] 이벤트 설정');

        const touchArea = document.getElementById('touch-area');
        if (!touchArea) {
            console.error('[Event] touch-area 없음!');
            return;
        }

        // 더블탭으로 큐브 배치/제거
        let lastTap = 0;

        // === 터치 이벤트 (모바일) ===
        touchArea.addEventListener('touchstart', (e) => {
            e.preventDefault();

            if (e.touches.length === 1 && this.hudCube) {
                // 한 손가락: 드래그 시작
                this.gesture.isDragging = true;
                this.gesture.isPinching = false;
                this.gesture.dragStartX = e.touches[0].clientX;
                this.gesture.dragStartY = e.touches[0].clientY;
                this.gesture.objStartX = this.hudCube.position.x;
                this.gesture.objStartY = this.hudCube.position.y;
            } else if (e.touches.length === 2 && this.hudCube) {
                // 두 손가락: 핀치 시작
                this.gesture.isDragging = false;
                this.gesture.isPinching = true;
                this.gesture.pinchStartDist = this.getTouchDistance(e.touches);
                this.gesture.pinchStartScale = this.hudCubeBaseScale;
            }
        }, { passive: false });

        touchArea.addEventListener('touchmove', (e) => {
            e.preventDefault();
            if (!this.hudCube) return;

            if (this.gesture.isDragging && e.touches.length === 1) {
                // 드래그: 화면 좌표 → 카메라 로컬 좌표
                const dx = e.touches[0].clientX - this.gesture.dragStartX;
                const dy = e.touches[0].clientY - this.gesture.dragStartY;

                // 화면 픽셀을 3D 로컬 좌표로 변환
                const scale = this.screenPixelToLocal();
                this.hudCube.position.x = this.gesture.objStartX + dx * scale;
                this.hudCube.position.y = this.gesture.objStartY - dy * scale; // Y축 반전
            } else if (this.gesture.isPinching && e.touches.length === 2) {
                // 핀치: 거리 비율로 스케일 조절
                const dist = this.getTouchDistance(e.touches);
                const ratio = dist / this.gesture.pinchStartDist;
                const newScale = Math.max(0.3, Math.min(20.0, this.gesture.pinchStartScale * ratio));

                this.hudCubeBaseScale = newScale;
                this.hudCube.scale.set(newScale, newScale, newScale);
            }
        }, { passive: false });

        touchArea.addEventListener('touchend', (e) => {
            if (e.touches.length === 0) {
                // 모든 손가락 뗌
                if (this.gesture.isDragging && !this.gesture.isPinching) {
                    // 드래그 거리가 매우 짧으면 탭으로 간주
                    const dx = Math.abs((e.changedTouches[0]?.clientX || 0) - this.gesture.dragStartX);
                    const dy = Math.abs((e.changedTouches[0]?.clientY || 0) - this.gesture.dragStartY);
                    if (dx < 10 && dy < 10) {
                        const now = Date.now();
                        if (now - lastTap < 300) {
                            // 더블탭: 큐브 배치
                            this.placeCube();
                        }
                        lastTap = now;
                    }
                }
                this.gesture.isDragging = false;
                this.gesture.isPinching = false;
            } else if (e.touches.length === 1) {
                // 핀치 → 드래그로 전환
                this.gesture.isPinching = false;
                this.gesture.isDragging = true;
                this.gesture.dragStartX = e.touches[0].clientX;
                this.gesture.dragStartY = e.touches[0].clientY;
                this.gesture.objStartX = this.hudCube ? this.hudCube.position.x : 0;
                this.gesture.objStartY = this.hudCube ? this.hudCube.position.y : 0;
            }
        });

        // === 마우스 이벤트 (데스크탑) ===
        let mouseDown = false;
        touchArea.addEventListener('mousedown', (e) => {
            if (!this.hudCube) {
                this.placeCube();
                return;
            }
            mouseDown = true;
            this.gesture.dragStartX = e.clientX;
            this.gesture.dragStartY = e.clientY;
            this.gesture.objStartX = this.hudCube.position.x;
            this.gesture.objStartY = this.hudCube.position.y;
        });

        touchArea.addEventListener('mousemove', (e) => {
            if (!mouseDown || !this.hudCube) return;

            const dx = e.clientX - this.gesture.dragStartX;
            const dy = e.clientY - this.gesture.dragStartY;
            const scale = this.screenPixelToLocal();

            this.hudCube.position.x = this.gesture.objStartX + dx * scale;
            this.hudCube.position.y = this.gesture.objStartY - dy * scale;
        });

        touchArea.addEventListener('mouseup', () => { mouseDown = false; });
        touchArea.addEventListener('mouseleave', () => { mouseDown = false; });

        // 마우스 휠: 스케일 조절 (데스크탑에서 핀치 대체)
        touchArea.addEventListener('wheel', (e) => {
            if (!this.hudCube) return;
            e.preventDefault();

            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            this.hudCubeBaseScale = Math.max(0.3, Math.min(5.0, this.hudCubeBaseScale * delta));
            this.hudCube.scale.set(this.hudCubeBaseScale, this.hudCubeBaseScale, this.hudCubeBaseScale);
        }, { passive: false });

        // 카메라 전환 버튼
        const switchBtn = document.getElementById('camera-switch');
        if (switchBtn) {
            switchBtn.addEventListener('click', () => this.switchCamera());
        }

        // 리사이즈
        window.addEventListener('resize', () => this.onResize());

        console.log('[Event] 제스처 이벤트 설정 완료 (드래그/핀치/휠)');
    }

    /**
     * 두 터치 포인트 사이 거리 계산
     */
    getTouchDistance(touches) {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /**
     * 화면 1px을 카메라 로컬 좌표 단위로 변환
     * (카메라 앞 1.5m 거리에서의 비율)
     */
    screenPixelToLocal() {
        const distance = 1.5; // hudCube의 z 거리
        const fovRad = THREE.MathUtils.degToRad(this.camera.fov);
        const screenHeight = window.innerHeight;
        // 카메라 시야각 기반 변환: 1px = 얼마의 3D 단위인지
        return (2 * distance * Math.tan(fovRad / 2)) / screenHeight;
    }

    /**
     * HUD 영상 배치 (화면에 고정, 드래그/핀치 가능)
     * 크로마키(초록색) 배경 제거 셰이더 적용
     * @param {string} videoSrc - 재생할 영상 파일명 (옵션)
     */
    placeCube(videoSrc = null) {
        if (!this.isReady) {
            console.log('[AR] 아직 준비 안됨');
            return;
        }

        // 영상 소스 업데이트
        if (videoSrc) {
            this.currentVideoSrc = videoSrc;
        }

        // 기존 HUD 오브젝트 정리
        this.cleanupHud();

        console.log('[AR] ===== HUD 영상 배치 (크로마키) =====');
        console.log('[AR] 영상 소스:', this.currentVideoSrc);

        // 비디오 엘리먼트 생성
        this.hudVideo = document.createElement('video');
        this.hudVideo.loop = true;
        // ★ muted=false로 설정해야 Web Audio API(createMediaElementSource)로 오디오를 캡처할 수 있음
        // 사운드가 없는 영상은 volume=0으로 무음 처리 (muted 대신)
        this.hudVideo.muted = false;
        const hasSoundSrc = this.currentVideoSrc.includes('singgang2');
        this.hudVideo.volume = hasSoundSrc ? 0.8 : 0;  // 일반 영상은 volume=0 (무음)
        this.hudVideo.playsInline = true;
        this.hudVideo.setAttribute('playsinline', '');
        this.hudVideo.setAttribute('webkit-playsinline', '');
        this.hudVideo.crossOrigin = 'anonymous';
        this.hudVideo.preload = 'auto';
        this.hudVideo.src = this.currentVideoSrc;
        
        if (hasSoundSrc) {
            console.log('[AR] 사운드 활성화 (볼륨: 80%)');
            this.showNotification('2번째는 음악이 나옵니다', 3000);
        } else {
            console.log('[AR] 영상 무음 모드 (volume=0, 녹화 시 오디오 포함 가능)');
        }

        // 비디오 로드 및 재생
        this.hudVideo.load();
        
        this.hudVideo.addEventListener('loadeddata', () => {
            console.log('[AR] 비디오 로드 완료, 재생 시작');
            this.hudVideo.play().catch(e => {
                console.warn('[AR] 자동재생 실패:', e.message);
            });
        }, { once: true });

        // VideoTexture 생성
        this.hudVideoTexture = new THREE.VideoTexture(this.hudVideo);
        this.hudVideoTexture.colorSpace = THREE.SRGBColorSpace;
        this.hudVideoTexture.minFilter = THREE.LinearFilter;
        this.hudVideoTexture.magFilter = THREE.LinearFilter;

        // 크로마키 제거 + 검은 줄 크롭 셰이더 머티리얼
        const material = new THREE.ShaderMaterial({
            uniforms: {
                videoTexture: { value: this.hudVideoTexture },
                keyColor: { value: new THREE.Color(0.0, 1.0, 0.0) }, // 초록
                similarity: { value: 0.4 },  // 색상 허용 범위
                smoothness: { value: 0.1 },  // 경계 부드러움
                cropTop: { value: 0.0 },     // 상단 크롭 비율 (기본값)
                cropBottom: { value: 0.0 },  // 하단 크롭 비율 (기본값)
            },
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform sampler2D videoTexture;
                uniform vec3 keyColor;
                uniform float similarity;
                uniform float smoothness;
                uniform float cropTop;
                uniform float cropBottom;
                varying vec2 vUv;

                vec2 RGBtoUV(vec3 rgb) {
                    return vec2(
                        rgb.r * -0.169 + rgb.g * -0.331 + rgb.b * 0.5 + 0.5,
                        rgb.r * 0.5 + rgb.g * -0.419 + rgb.b * -0.081 + 0.5
                    );
                }

                void main() {
                    // UV 좌표 조정 (상단/하단 크롭)
                    vec2 croppedUV = vUv;
                    float cropRange = 1.0 - cropTop - cropBottom;
                    croppedUV.y = cropBottom + vUv.y * cropRange;
                    
                    vec4 texColor = texture2D(videoTexture, croppedUV);

                    vec2 chromaVec = RGBtoUV(texColor.rgb) - RGBtoUV(keyColor);
                    float chromaDist = sqrt(dot(chromaVec, chromaVec));

                    float alpha = smoothstep(similarity, similarity + smoothness, chromaDist);

                    gl_FragColor = vec4(texColor.rgb, texColor.a * alpha);
                }
            `,
            transparent: true,
            side: THREE.DoubleSide,
        });

        // 평면 지오메트리 (기본 1:1 비율, 영상 로드 후 조정)
        const geometry = new THREE.PlaneGeometry(0.5, 0.5);
        this.hudCube = new THREE.Mesh(geometry, material);
        
        // 2번 영상(singgang2.mp4)은 상단/하단 검은 줄 크롭
        if (this.currentVideoSrc.includes('singgang2')) {
            material.uniforms.cropTop.value = 0.03;    // 상단 3% 크롭
            material.uniforms.cropBottom.value = 0.03; // 하단 3% 크롭
            console.log('[AR] 검은 줄 크롭 적용 (상단/하단 3%)');
        }

        // 카메라의 자식으로 추가 → 화면에 고정
        this.hudCube.position.set(0, 0, -1.5);
        this.hudCubeBaseScale = 1.0;
        this.hudCube.scale.set(1, 1, 1);

        this.camera.add(this.hudCube);

        // 영상 메타데이터 로드 후 비율 조정
        this.hudVideo.addEventListener('loadedmetadata', () => {
            let aspect = this.hudVideo.videoWidth / this.hudVideo.videoHeight;
            
            // 2번 영상(singgang2.mp4)은 1080x1920 세로 영상
            // 크롭으로 인해 가로가 눌려 보이므로 보정
            if (this.currentVideoSrc.includes('singgang2')) {
                // 크롭된 비율 계산 (상하단 3%씩 제거 = 94% 높이)
                const cropFactor = 1.0 - 0.03 - 0.03; // 0.94
                // 실제 표시 비율 조정 (약간 넓게)
                aspect = aspect * 1.15; // 15% 넓게 보정
                console.log('[AR] 2번 영상 비율 보정:', aspect);
            }
            
            const height = 0.5;
            const width = height * aspect;
            this.hudCube.geometry.dispose();
            this.hudCube.geometry = new THREE.PlaneGeometry(width, height);
            console.log('[AR] 영상 크기:', this.hudVideo.videoWidth, 'x', this.hudVideo.videoHeight, '| 비율:', aspect.toFixed(2));
        });

        console.log('[AR] HUD 영상 배치됨 (크로마키 제거)');
    }

    /**
     * HUD 오브젝트 정리
     */
    cleanupHud() {
        if (this.hudCube) {
            this.camera.remove(this.hudCube);
            this.hudCube.geometry.dispose();
            this.hudCube.material.dispose();
            this.hudCube = null;
        }
        if (this.hudVideoTexture) {
            this.hudVideoTexture.dispose();
            this.hudVideoTexture = null;
        }
        if (this.hudVideo) {
            this.hudVideo.pause();
            this.hudVideo.src = '';
            this.hudVideo = null;
        }
    }

    /**
     * 카메라 전환
     */
    async switchCamera() {
        // window.switchCamera 사용 (index.html에서 정의)
        if (window.switchCamera && typeof window.switchCamera === 'function') {
            await window.switchCamera();

            // 비디오 엘리먼트 업데이트
            if (window.cameraStream && this.video) {
                this.video.srcObject = window.cameraStream;
            }
        }
    }

    /**
     * 리사이즈 핸들러
     */
    onResize() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
    }

    /**
     * 상태 표시 업데이트
     */
    updateStatus(text) {
        const el = document.getElementById('status');
        if (el) el.textContent = text;
    }

    /**
     * 메인 렌더 루프 (Layer 3: Compositing)
     */
    animate() {
        if (!this.isRunning) return;
        requestAnimationFrame(() => this.animate());

        // === SLAM 처리 (Wasm Visual Odometry) ===
        if (this.trackingMode === 'slam' || this.trackingMode === 'hybrid') {
            this.processSLAM();
        }

        // === 카메라 업데이트 ===
        if (this.trackingMode === 'sensor' || this.trackingMode === 'hybrid') {
            this.updateCameraFromSensor();
        }

        // === HUD 영상 텍스처 갱신 ===
        if (this.hudVideoTexture) {
            this.hudVideoTexture.needsUpdate = true;
        }

        // === Layer 3: 렌더링 (합성) ===
        this.renderer.render(this.scene, this.camera);
    }

    /**
     * SLAM 처리 (Wasm Visual Odometry)
     */
    processSLAM() {
        if (!this.visualOdometry || !this.video) return;

        // Canvas가 없으면 생성
        if (!this.processCanvas) {
            this.processCanvas = document.createElement('canvas');
            this.processCtx = this.processCanvas.getContext('2d', { willReadFrequently: true });
        }

        // 비디오 크기 확인
        if (this.video.videoWidth === 0) return;

        // Canvas 크기 조정 (처리 속도를 위해 축소 가능)
        const scale = 0.5;  // 50% 크기로 처리
        const w = Math.floor(this.video.videoWidth * scale);
        const h = Math.floor(this.video.videoHeight * scale);

        if (this.processCanvas.width !== w || this.processCanvas.height !== h) {
            this.processCanvas.width = w;
            this.processCanvas.height = h;
        }

        // 비디오 프레임 추출
        this.processCtx.drawImage(this.video, 0, 0, w, h);
        const imageData = this.processCtx.getImageData(0, 0, w, h);

        // Wasm VO 처리
        const result = this.visualOdometry.processFrame(w, h, imageData.data);

        if (result && result.tracking) {
            // View Matrix를 Three.js 카메라에 적용
            this.cameraPoseManager.applyViewMatrix(result.viewMatrix, true);

            // 상태 업데이트
            const info = this.cameraPoseManager.getDebugInfo();
            this.updateStatus(
                `추적중 | 특징점: ${result.featureCount} | ` +
                `위치: (${info.position.x}, ${info.position.y}, ${info.position.z})`
            );
        }
    }

    /**
     * 센서 기반 카메라 업데이트 (폴백/하이브리드용)
     */
    updateCameraFromSensor() {
        if (!this.initialOrientation) return;

        // SLAM이 추적 중이면 센서는 보조로만 사용
        if (this.trackingMode === 'hybrid' && this.cameraPoseManager?.isTracking) {
            return;
        }

        // CameraPoseManager를 통해 적용
        if (this.cameraPoseManager) {
            const screenOrientation = window.orientation || 0;
            this.cameraPoseManager.applyDeviceOrientation(
                this.deviceOrientation.alpha,
                this.deviceOrientation.beta,
                this.deviceOrientation.gamma,
                screenOrientation
            );
        } else {
            // 폴백: 직접 적용
            const alpha = THREE.MathUtils.degToRad(this.deviceOrientation.alpha - this.initialOrientation.alpha);
            const beta = THREE.MathUtils.degToRad(this.deviceOrientation.beta);
            const gamma = THREE.MathUtils.degToRad(this.deviceOrientation.gamma);

            const euler = new THREE.Euler(beta, alpha, -gamma, 'YXZ');
            this.camera.quaternion.setFromEuler(euler);

            const screenOrientation = window.orientation || 0;
            const screenQuat = new THREE.Quaternion();
            screenQuat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -THREE.MathUtils.degToRad(screenOrientation));
            this.camera.quaternion.multiply(screenQuat);
        }
    }

    /**
     * Visual Odometry 초기화 (비동기)
     */
    async initVisualOdometry() {
        try {
            // 동적 임포트 (Wasm 빌드 후 사용 가능)
            const voModule = await import('./VisualOdometry.js');
            VisualOdometry = voModule.VisualOdometry;

            this.visualOdometry = new VisualOdometry();
            await this.visualOdometry.init({
                fastThreshold: 20,
                maxFeatures: 300
            });

            // 카메라 파라미터 동기화
            if (this.video && this.video.videoWidth > 0) {
                this.visualOdometry.autoConfigureCamera(
                    this.video.videoWidth,
                    this.video.videoHeight
                );
            }

            this.trackingMode = 'hybrid';  // SLAM + 센서 하이브리드
            console.log('[AR] Visual Odometry 초기화 완료');
            return true;

        } catch (e) {
            console.warn('[AR] Visual Odometry 로드 실패 (센서 모드로 폴백):', e.message);
            this.trackingMode = 'sensor';
            return false;
        }
    }

    /**
     * 추적 모드 변경
     * @param {'sensor'|'slam'|'hybrid'} mode
     */
    setTrackingMode(mode) {
        this.trackingMode = mode;
        console.log('[AR] 추적 모드:', mode);

        if (mode === 'slam' || mode === 'hybrid') {
            if (!this.visualOdometry) {
                this.initVisualOdometry();
            }
        }
    }

    /**
     * 포즈 리셋 (현재 위치를 원점으로)
     */
    resetPose() {
        if (this.cameraPoseManager) {
            this.cameraPoseManager.reset();
        }
        if (this.visualOdometry) {
            this.visualOdometry.reset();
        }
        this.initialOrientation = null;
        console.log('[AR] 포즈 리셋됨');
    }

    /**
     * 정리
     */
    destroy() {
        this.isRunning = false;
        this.cleanupHud();
        if (this.video && this.video.srcObject) {
            this.video.srcObject.getTracks().forEach(t => t.stop());
        }
        if (this.renderer) {
            this.renderer.dispose();
        }
        if (this.visualOdometry) {
            this.visualOdometry.destroy();
        }
        console.log('[AR] 종료');
    }

    /**
     * 화면 중앙에 알림 표시
     * @param {string} message - 표시할 메시지
     * @param {number} duration - 표시 시간 (밀리초)
     */
    showNotification(message, duration = 3000) {
        // 기존 알림이 있으면 제거
        const existing = document.getElementById('ar-notification');
        if (existing) {
            existing.remove();
        }

        // 알림 엘리먼트 생성
        const notification = document.createElement('div');
        notification.id = 'ar-notification';
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.95);
            color: #fff;
            padding: 15px 30px;
            border-radius: 10px;
            font-size: 18px;
            font-weight: bold;
            z-index: 10000;
            pointer-events: none;
            text-align: center;
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.6);
            animation: fadeInOut 3s ease-in-out;
            white-space: nowrap;
        `;

        // CSS 애니메이션 추가
        if (!document.getElementById('ar-notification-style')) {
            const style = document.createElement('style');
            style.id = 'ar-notification-style';
            style.textContent = `
                @keyframes fadeInOut {
                    0% { opacity: 0; transform: translate(-50%, -50%) scale(0.95); }
                    10% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
                    90% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
                    100% { opacity: 0; transform: translate(-50%, -50%) scale(0.95); }
                }
            `;
            document.head.appendChild(style);
        }

        document.body.appendChild(notification);

        // 지정된 시간 후 제거
        setTimeout(() => {
            notification.remove();
        }, duration);

        console.log('[AR] 알림 표시:', message);
    }
}

// ==================== 앱 시작 ====================

// AR 앱 인스턴스 생성
const app = new ARApp();

// 전역 노출
window.arApp = app;
window.addEventListener('beforeunload', () => app.destroy());

// 추가 전역 함수
window.resetARPose = () => app.resetPose();
window.setARTrackingMode = (mode) => app.setTrackingMode(mode);

// 영상 전환 함수 (개선 버전)
window.changeARVideo = (videoSrc) => {
    console.log('[AR] 영상 전환 요청:', videoSrc);
    
    // 이미 같은 영상이면 무시
    if (app.currentVideoSrc === videoSrc) {
        console.log('[AR] 이미 재생 중인 영상');
        return;
    }
    
    // 현재 영상 정리
    app.cleanupHud();
    
    // 영상 소스 변경
    app.currentVideoSrc = videoSrc;
    
    // 새 영상 배치
    app.placeCube();
    
    console.log('[AR] 영상 전환 완료:', videoSrc);
};

/**
 * 권한 승인 후 앱 시작
 * index.html에서 permissionsGranted 이벤트 발생 시 호출
 */
function startARApp() {
    console.log('[Main] 권한 승인 완료 - AR 앱 시작');
    app.init();
}

// 권한 승인 이벤트 리스너
window.addEventListener('permissionsGranted', startARApp);

// 이미 권한이 승인된 경우 (페이지 새로고침 등)
if (window.permissionsGranted) {
    startARApp();
}

// 데스크탑에서 시작 화면 없이 바로 시작하는 경우
// (권한 요청이 필요 없는 환경)
window.addEventListener('DOMContentLoaded', () => {
    // 시작 화면이 없거나 이미 숨겨진 경우
    const startScreen = document.getElementById('start-screen');
    if (!startScreen || startScreen.classList.contains('hidden')) {
        // 바로 시작
        if (!window.permissionsGranted) {
            console.log('[Main] 시작 화면 대기 중...');
        }
    }
});
