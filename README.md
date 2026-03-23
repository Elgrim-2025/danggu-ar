# AR 크로마키 웹앱

이미지 또는 영상을 업로드하면 크로마키(배경 제거) 처리된 AR 링크를 생성해주는 웹앱.
QR코드로 공유하면 누구든 카메라를 켜서 실시간 AR 효과를 체험할 수 있다.

---

## 주요 기능

- **크로마키 AR**: WebGL2 셰이더로 실시간 배경 제거 (색상·허용범위·부드러움 조정 가능)
- **다중 파일**: 하나의 AR 링크에 이미지/영상 최대 3개 → 전환 버튼으로 교체
- **사진·영상 캡처**: AR 화면 그대로 사진 촬영 및 영상 녹화 후 저장/공유
- **Android 최적화**: WebM alpha channel 업로드 시 크로마키 없이 네이티브 투명도 사용
- **조회수 통계**: 프로젝트별 일별 접속 통계 (최근 30일 그래프)
- **QR코드**: 생성된 AR 링크 QR코드 즉시 표시

---

## 기술 스택

| 구분 | 기술 |
|------|------|
| 호스팅 | Cloudflare Workers (서버리스 엣지) |
| 파일 저장 | Cloudflare R2 (S3 호환 객체 스토리지) |
| 메타/통계 저장 | Cloudflare KV |
| 렌더링 | WebGL2 + GLSL (실시간 크로마키) |
| 영상 변환 | FFmpeg WASM (WebM → MP4) |
| 녹화 | MediaRecorder API |
| 공유 | Web Share API |

---

## 프로젝트 구조

```
photo-ar-website/
├── src/
│   └── worker.js           # Cloudflare Worker (API 전체)
├── public/
│   ├── index.html          # 업로드 페이지
│   ├── ar.html             # AR 뷰어 페이지
│   ├── manage.html         # 관리자 페이지
│   ├── css/
│   │   ├── ar-viewer.css
│   │   ├── manage.css
│   │   └── upload.css
│   └── js/
│       ├── ar-viewer.js    # AR 뷰어 로직 (WebGL, 캡처, 녹화)
│       ├── upload.js       # 업로드 & 생성 로직
│       ├── manage.js       # 관리자 로직
│       └── qrcode.min.js   # QR코드 생성 라이브러리
├── wrangler.jsonc          # Cloudflare Workers 설정
└── package.json
```

---

## API 엔드포인트

| 메서드 | 경로 | 설명 | 인증 |
|--------|------|------|------|
| `POST` | `/api/auth` | 비밀번호 검증 | — |
| `POST` | `/api/upload` | 파일 업로드 & AR 프로젝트 생성 | UPLOAD_SECRET |
| `GET` | `/api/meta/:id` | 프로젝트 메타데이터 조회 (조회수 증가) | — |
| `GET` | `/api/file/:fileId` | 파일 다운로드 (Range 요청 지원) | — |
| `GET` | `/api/list` | 프로젝트 목록 조회 | DELETE_SECRET |
| `GET` | `/api/stats/:id` | 일별 조회수 통계 | DELETE_SECRET |
| `PATCH` | `/api/project/:id` | 제목·크로마키 설정 수정 | DELETE_SECRET |
| `PATCH` | `/api/project/:id/file/:idx` | 파일 교체 | DELETE_SECRET |
| `PATCH` | `/api/project/:id/file/:idx/android` | Android WebM variant 업로드 | DELETE_SECRET |
| `DELETE` | `/api/project/:id/file/:idx/android` | Android variant 삭제 | DELETE_SECRET |
| `DELETE` | `/api/delete/:id` | 프로젝트 전체 삭제 | DELETE_SECRET |

---

## 데이터 구조

### R2 버킷 (`ar-uploads`)

```
{fileId}.{ext}              # 이미지/영상 원본
{androidId}.webm            # Android용 WebM alpha (선택)
wasm/ffmpeg-core.wasm       # FFmpeg WASM (25MB+, 정적)
```

### KV 네임스페이스 (`AR_META`)

```
{projectId}                         → 프로젝트 메타데이터 (JSON)
file:{fileId}                       → 파일 확장자/타입 정보 (JSON)
views:{projectId}                   → 누적 조회수
daily:{projectId}:{YYYY-MM-DD}      → 일별 조회수
rl:{ip}                             → 레이트리밋 (TTL 60s)
rl:auth:{ip}                        → 인증 레이트리밋 (TTL 300s)
rl:upload:{ip}                      → 업로드 레이트리밋 (TTL 600s)
```

### 프로젝트 메타데이터 (JSON)

```json
{
  "id": "abc12345",
  "title": "프로젝트 이름",
  "files": [
    {
      "id": "fileId",
      "filename": "원본파일명.mp4",
      "type": "video/mp4",
      "ext": "mp4",
      "size": 5242880,
      "color": "#00ff00",
      "similarity": 0.4,
      "smoothness": 0.1,
      "audio": true,
      "androidId": "androidFileId",
      "androidExt": "webm"
    }
  ],
  "createdAt": 1703001600000,
  "updatedAt": 1703001605000
}
```

---

## 보안

| 항목 | 내용 |
|------|------|
| 비밀번호 검증 | HMAC-SHA256 상수시간 비교 (타이밍 공격 방지) |
| 레이트 리미팅 | IP당 인증 10회/5분, 업로드 5회/10분, 일반 10회/60초 |
| 파일 검증 | 허용 타입: JPEG·PNG·MP4·WebM / 최대 100MB |
| CSP | `script-src 'self' 'wasm-unsafe-eval'` 등 |
| CORS | 관리 엔드포인트는 CORS 헤더 없음 (크로스오리진 차단) |
| 인증 저장 | 비밀번호 메모리 변수에만 보관 (sessionStorage 미사용) |

---

## 환경변수 / 시크릿

| 변수명 | 용도 |
|--------|------|
| `UPLOAD_SECRET` | 업로드 페이지 인증 비밀번호 |
| `DELETE_SECRET` | 관리자 페이지 인증 비밀번호 |

### 설정 방법

```bash
wrangler secret put UPLOAD_SECRET
wrangler secret put DELETE_SECRET
```

또는 Cloudflare 대시보드 → Workers → Settings → Variables → Add Secret

---

## 배포

```bash
# 의존성 설치
npm install

# 로컬 개발 서버
npm run dev

# 배포
npm run deploy
```

### 최초 설정

```bash
# R2 버킷 생성
npm run r2:create

# KV 네임스페이스 생성
npm run kv:create
# → 출력된 id를 wrangler.jsonc의 kv_namespaces[0].id에 입력

# FFmpeg WASM을 R2에 업로드 (25MB+, ASSETS에 올릴 수 없음)
wrangler r2 object put ar-uploads/wasm/ffmpeg-core.wasm --file ./path/to/ffmpeg-core.wasm
```

---

## 페이지 구성

| 경로 | 설명 |
|------|------|
| `/` | 업로드 페이지 — 파일 선택 → 크로마키 설정 → AR 링크 생성 |
| `/ar/:id` | AR 뷰어 — 카메라 + 실시간 크로마키 AR 체험 |
| `/manage` | 관리자 페이지 — 프로젝트 목록, 수정, 삭제, 통계 확인 |

---

## AR 뷰어 동작 방식

1. `/api/meta/:id` 호출 → 파일 목록·크로마키 설정 로드
2. 카메라 스트림 + WebGL2 초기화
3. Fragment shader에서 매 프레임마다:
   - 카메라 텍스처 렌더링
   - 업로드된 이미지/영상 텍스처를 그 위에 합성
   - 크로마키 색상과 유사한 픽셀의 알파값을 0으로 처리
4. 드래그/핀치 제스처로 위치·크기 조정
5. 캡처 → Canvas 스냅샷 → 저장·공유 오버레이
6. 녹화 → MediaRecorder → WebM 생성 → FFmpeg WASM으로 MP4 변환

### iOS / Android 차이

| | iOS | Android |
|--|-----|---------|
| 저장 | Web Share API (share sheet) | 직접 다운로드 |
| 공유 | share sheet (저장과 동일) | Web Share API (share sheet) |
| WebM alpha | 미지원 → MP4 + 크로마키 | 지원 → 크로마키 불필요 |
