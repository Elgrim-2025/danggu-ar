/**
 * ar-engine.js
 *
 * ar-engine/src/js/AREngine.js 를 Cloudflare Workers 메인 앱에서
 * 바로 쓸 수 있도록 ES 모듈 없이 plain script로 변환한 버전.
 *
 * window.AREngine 으로 전역 접근 가능.
 * WASM 파일 경로: /wasm/ar-engine.js, /wasm/ar-engine.wasm
 */
(function () {
    'use strict';

    class AREngine {
        constructor() {
            this.module = null;
            this.tracker = null;
            this.isInitialized = false;

            // 매 프레임 캔버스 재생성 방지용 캐시
            this.canvas = null;
            this.ctx = null;
        }

        /**
         * WASM 모듈 로드 및 ARTracker 인스턴스 생성
         * @returns {Promise<boolean>} 초기화 성공 여부
         */
        async init() {
            try {
                console.log('[AREngine] WASM 초기화 중...');

                await this._loadWasmScript('/wasm/ar-engine.js');

                if (typeof window.createARModule !== 'function') {
                    throw new Error('createARModule 함수를 찾을 수 없음 (WASM 로드 실패)');
                }

                this.module = await window.createARModule();
                this.tracker = new this.module.ARTracker();

                this.isInitialized = true;
                console.log('[AREngine] 초기화 완료');
                return true;
            } catch (err) {
                console.warn('[AREngine] 초기화 실패 (SLAM 비활성화):', err.message);
                return false;
            }
        }

        /**
         * WASM 글루 스크립트를 동적으로 <script> 태그로 로드
         * @param {string} src
         * @returns {Promise<void>}
         */
        _loadWasmScript(src) {
            return new Promise((resolve, reject) => {
                if (typeof window.createARModule === 'function') {
                    resolve();
                    return;
                }
                const script = document.createElement('script');
                script.src = src;
                script.async = true;
                script.onload = resolve;
                script.onerror = () => reject(new Error('스크립트 로드 실패: ' + src));
                document.head.appendChild(script);
            });
        }

        /**
         * 비디오 프레임을 SLAM 트래커에 전달
         * @param {HTMLVideoElement} videoEl
         * @returns {boolean} 추적 성공 여부
         */
        processFrame(videoEl) {
            if (!this.isInitialized || !this.tracker) return false;

            try {
                const w = videoEl.videoWidth;
                const h = videoEl.videoHeight;
                if (w === 0 || h === 0) return false;

                // 캔버스 크기가 달라진 경우에만 재생성
                if (!this.canvas || this.canvas.width !== w || this.canvas.height !== h) {
                    this.canvas = document.createElement('canvas');
                    this.canvas.width = w;
                    this.canvas.height = h;
                    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
                }

                this.ctx.drawImage(videoEl, 0, 0);
                const imageData = this.ctx.getImageData(0, 0, w, h);
                return this.tracker.processFrame(w, h, imageData.data);
            } catch (err) {
                console.error('[AREngine] 프레임 처리 오류:', err);
                return false;
            }
        }

        /**
         * 현재 View Matrix(16 요소 배열) 반환
         * @returns {number[]|null}
         */
        getViewMatrix() {
            if (!this.tracker) return null;
            try {
                const raw = this.tracker.getViewMatrix();
                const out = new Array(16);
                for (let i = 0; i < 16; i++) out[i] = raw[i];
                return out;
            } catch (err) {
                return null;
            }
        }

        /**
         * Projection Matrix 반환
         * @param {number} width
         * @param {number} height
         * @returns {number[]|null}
         */
        getProjectionMatrix(width, height) {
            if (!this.tracker) return null;
            try {
                const raw = this.tracker.getProjectionMatrix(width, height);
                const out = new Array(16);
                for (let i = 0; i < 16; i++) out[i] = raw[i];
                return out;
            } catch (err) {
                return null;
            }
        }

        /** @returns {boolean} */
        isSlamTracking() {
            if (!this.tracker) return false;
            try { return this.tracker.isTracking(); } catch { return false; }
        }

        /** @returns {number} */
        getMapPointCount() {
            if (!this.tracker) return 0;
            try { return this.tracker.getMapPointCount(); } catch { return 0; }
        }

        /** WASM 리소스 해제 */
        destroy() {
            if (this.tracker) {
                try { this.tracker.delete(); } catch (_) {}
                this.tracker = null;
            }
            this.isInitialized = false;
            this.canvas = null;
            this.ctx = null;
            console.log('[AREngine] 종료');
        }
    }

    // 전역 노출
    window.AREngine = AREngine;
})();
