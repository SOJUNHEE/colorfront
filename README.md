# COLORFRONT

웹 기반 3D 페인트 TPS 게임 (기획: `../COLORFRONT_GDD_v1.md`).

> **현재 상태: Phase 3 — 권위 서버 실시간 멀티플레이.**
> - Colyseus 0.18 서버가 이동, 사격 판정, 도색, 점령률, 경기 흐름(대기 → 카운트다운 → 경기 → 결과)을 결정합니다. 클라이언트는 입력만 보냅니다.
> - 실제 브라우저 두 개에서 같은 경기 상태와 같은 페인트 결과(해시 일치)를 확인했습니다.
> - 네트워크 봇 30명 부하 테스트도 통과했습니다. 결과는 `docs/PHASE3_REPORT.md`에 있습니다.
> - 오프라인 연습(로컬 봇)은 네트워크와 분리된 연습·그래픽 도구로 남아 있습니다.
> - 배포 준비 완료: `render.yaml`(Render 웹 서비스 1개 — 게임 서버가 빌드된 클라이언트도 함께 제공, 같은 출처 wss). 실제 배포는 저장소 연결과 요금제 승인 후 진행합니다. 자세한 내용은 `docs/DEPLOY.md`.

## 실행 (Windows PowerShell)

필요: Node.js 22.23.2 이상 (검증 환경: Node 24.20.0, npm 11.19.0)

```powershell
cd C:\Users\user\Desktop\fps\colorfront
npm install              # 최초 1회
npm run start:server     # 터미널 1: 게임 서버 ws://127.0.0.1:2567 (개발 중 자동 재시작: npm run dev:server)
npm run dev              # 터미널 2: 클라이언트 http://localhost:5173
```

- 브라우저에서 닉네임을 넣고 **온라인 매치 참가**를 누릅니다. 두 번째 브라우저(또는 다른 PC)도 같은 서버에 접속하면 같은 방에 들어가고, 팀은 자동으로 나뉩니다.
- 대기실에서 모두 **G(준비)**를 누르면 카운트다운이 시작됩니다. 정식 경기는 5분입니다.
- 개발 중 짧은 경기: `http://localhost:5173/?mode=online&seconds=60`(개발 빌드 전용, 새로 만드는 방에만 적용).
- 특정 방 참가: `?room=<방 ID>`(화면 왼쪽 위 배지에 표시). 다른 서버 주소는 `.env`의 `VITE_SERVER_URL`로 지정합니다(`.env.example` 참고).
- **오프라인 연습 (로컬 봇)**은 서버 없이 동작합니다.

| 명령 | 내용 |
|---|---|
| `npm run dev` | 클라이언트 개발 서버 (포트 5173, 사용 중이면 다음 포트) |
| `npm run start:server` / `npm run dev:server` | 게임 서버 (`PORT`, `HOST`, `SIMULATE_LATENCY_MS` 환경 변수) |
| `npm test` | 단위 + 네트워크 통합 테스트 (Vitest, 통합 테스트는 서버를 임의 포트에 직접 띄움) |
| `npm run test:unit` / `npm run test:net` | 단위만 / 네트워크 통합만 |
| `npm run load -- --players 30 --seconds 60` | 네트워크 봇 부하 테스트 (게임 서버 실행 필요) |
| `npm run typecheck` | shared · tests · client · server 타입 검사 |
| `npm run lint` | 클라이언트 ESLint (PlayCanvas 공식 규칙) |
| `npm run build` | 프로덕션 빌드 → `apps/client/dist` |
| `npm run preview` | 빌드 결과 로컬 확인 |

## 조작

| 입력 | 동작 | 상태 |
|---|---|---|
| W A S D | 이동 (6 m/s) | 동작 |
| Shift | 달리기 (8 m/s) | 동작 |
| Space | 점프 | 동작 |
| Q | 대시 4 m, 쿨다운 6초 | 동작 |
| 마우스 | 카메라 회전 (Pointer Lock) | 동작 |
| 우클릭 | 어깨너머 조준 (FOV 축소, 카메라 근접) | 동작 |
| 휠 | 카메라 거리 | 동작 |
| 좌클릭 | 페인트 사격 — 6발/초, 사거리 25m, 피해 14 | 동작 (온라인: 서버 판정) |
| R | 재장전 1.8초 (빈 탄창이면 자동) | 동작 |
| G | 준비 / 준비 취소 (온라인 대기실) | 동작 |
| T | 내 팀 전환 (블루/오렌지) — **오프라인 개발용** | 동작 (온라인에서는 꺼짐) |
| ESC › 개발자 도구 | 로컬 봇 1:1·4:4·15:15, 페인트 초기화, 승리 포즈 | 오프라인 전용 (네트워크 아님) |
| ESC | 일시정지 / 설정 | 동작 |
| Tab · M · 1~4 | 스코어보드 · 맵 · 무기 | 미구현 (Phase 4+) |

설정(그래픽 품질 low/medium/high, 렌더 스케일 50/75/100%, 감도, FOV, Y축 반전, FPS 표시, 카메라 반동·흔들림, 전체화면)은 브라우저 `localStorage`에 저장됩니다.
ESC 메뉴의 **개발자 도구**에서 팀 전환과 페인트 초기화를 할 수 있습니다. FPS 패널에는 현재 이동 속도와 발밑 페인트 배율(`PAINT x1.15` 등)이 표시됩니다.
개발 서버에서는 PlayCanvas Inspector가 붙어 있습니다 (`` ` `` 키, 프로덕션 빌드에는 포함되지 않음).

## 구조

```text
colorfront/
├── apps/client/            PlayCanvas Engine + TS + Vite (공식 create-playcanvas 0.10.1 -f engine 로 생성)
│   └── src/{game,network,player,paint,render,scenes,settings,ui}/
├── apps/server/            Colyseus 0.18 권위 서버 (MatchRoom, Schema, 입력 검증, 지표)
├── packages/shared/src/    클라이언트·서버 공통: 타입, 규칙, 순수 시뮬레이션, 맵 데이터, 프로토콜, 페인트 동기화
│   └── {bots,combat,constants,input,map,paint,protocol,rules,simulation,types}/
├── tests/unit/             Vitest 단위 테스트
├── tests/integration/      실제 서버 + SDK 클라이언트 네트워크 테스트
├── tests/load/             네트워크 봇 부하 테스트
├── tests/visual/           브라우저 시각·성능 검증 스크립트
└── docs/                   ARCHITECTURE.md, DECISIONS.md, PHASE1/2/3_REPORT.md, GRAPHICS_REFERENCE.md, GRAPHICS_REPORT.md, screenshots/
```

자세한 설계는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), GDD 대비 결정 사항은 [docs/DECISIONS.md](docs/DECISIONS.md), 단계별 검증 결과는 [docs/PHASE1_REPORT.md](docs/PHASE1_REPORT.md) · [docs/PHASE2_REPORT.md](docs/PHASE2_REPORT.md) · [docs/GRAPHICS_REPORT.md](docs/GRAPHICS_REPORT.md)(그래픽, 변경 전후 스크린샷, 성능) · [docs/PHASE3_REPORT.md](docs/PHASE3_REPORT.md)(멀티플레이, 두 브라우저 검증, 부하 테스트).

### 시각 검증 도구 (개발 서버 + Playwright MCP)
`tests/visual/`의 스크립트는 `about:blank#<label>`로 이동한 뒤 `browser_run_code_unsafe`의 filename 모드로 실행합니다.
- `captureShots.js`: 고정 카메라 비교 스크린샷 → `docs/screenshots/<label>/`
- `captureAnimations.js`: 애니메이션 시트
- `measurePerf.js`: 품질별 프레임 비용·드로우콜·VRAM. `#label:bots`로 30명 측정
- `paintConsistency.js`: 화면 페인트와 점령 데이터 대조
- `twoBrowser/1-setup.js` ~ `5-reconnect-results.js`: 별도의 Chrome 프로세스 2개로 실제 온라인 경기를 검증. 게임 서버와 클라이언트 개발 서버를 켜고 순서대로 실행한다.
