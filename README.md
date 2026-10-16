# COLORFRONT

웹 기반 3D 페인트 TPS 게임 (기획: `../COLORFRONT_GDD_v1.md`).

> **현재 상태: Phase 2 + 그래픽 고도화.** 오프라인 도색·전투 코어와 고품질 스타일라이즈드 렌더링이 동작합니다.
> 페인트 히트스캔, Surface별 점령 격자, 피해·처치·부활, 로컬 봇(최대 15:15), 액체 페인트 셰이더, 오리지널 캐릭터와 애니메이션, HDR 후처리.
> 서버·네트워크 멀티플레이·경기 타이머는 아직 **구현되지 않았습니다.** 30인 화면은 로컬 봇이며 네트워크 30인 동작을 주장하지 않습니다.

## 실행 (Windows PowerShell)

필요: Node.js 22.23.2 이상 (검증 환경: Node 24.20.0, npm 11.19.0)

```powershell
cd C:\Users\user\Desktop\fps\colorfront
npm install          # 최초 1회
npm run dev          # http://localhost:5173 열기 → "클릭하여 플레이"
```

| 명령 | 내용 |
|---|---|
| `npm run dev` | 개발 서버 (포트 5173, 사용 중이면 다음 포트) |
| `npm test` | 단위 테스트 (Vitest) — 이동/충돌/무기/맵/페인트/히트스캔/속도/5분 랜덤 이동 소크 |
| `npm run typecheck` | shared · tests · client 타입 검사 |
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
| 좌클릭 | 페인트 사격 — 6발/초, 사거리 25m, 도색 반경 1.2m | 동작 (피해 판정 없음) |
| R | 재장전 1.8초 (빈 탄창이면 자동) | 동작 |
| T | 내 팀 전환 (블루/오렌지) — **개발용** | 동작 |
| ESC › 개발자 도구 | 로컬 봇 1:1·4:4·15:15, 페인트 초기화, 승리 포즈 | 동작 (네트워크 아님) |
| ESC | 일시정지 / 설정 | 동작 |
| Tab · M · 1~4 | 스코어보드 · 맵 · 무기 | 미구현 (Phase 4+) |

설정(그래픽 품질 low/medium/high, 렌더 스케일 50/75/100%, 감도, FOV, Y축 반전, FPS 표시, 카메라 반동·흔들림, 전체화면)은 브라우저 `localStorage`에 저장됩니다.
ESC 메뉴의 **개발자 도구**에서 팀 전환과 페인트 초기화를 할 수 있습니다. FPS 패널에는 현재 이동 속도와 발밑 페인트 배율(`PAINT x1.15` 등)이 표시됩니다.
개발 서버에서는 PlayCanvas Inspector가 붙어 있습니다 (`` ` `` 키, 프로덕션 빌드에는 포함되지 않음).

## 구조

```text
colorfront/
├── apps/client/            PlayCanvas Engine + TS + Vite (공식 create-playcanvas 0.10.1 -f engine 로 생성)
│   └── src/{game,player,paint,render,scenes,settings,ui}/
├── packages/shared/src/    클라이언트·향후 서버 공통: 타입, 규칙, 순수 시뮬레이션, 맵 데이터, 메시지 초안
│   └── {bots,combat,constants,input,map,paint,protocol,rules,simulation,types}/
├── tests/unit/             Vitest 단위 테스트
├── tests/visual/           브라우저 시각·성능 검증 스크립트
└── docs/                   ARCHITECTURE.md, DECISIONS.md, PHASE1/2_REPORT.md, GRAPHICS_REFERENCE.md, GRAPHICS_REPORT.md, screenshots/
```

자세한 설계는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), GDD 대비 결정 사항은 [docs/DECISIONS.md](docs/DECISIONS.md), 단계별 검증 결과는 [docs/PHASE1_REPORT.md](docs/PHASE1_REPORT.md) · [docs/PHASE2_REPORT.md](docs/PHASE2_REPORT.md) · [docs/GRAPHICS_REPORT.md](docs/GRAPHICS_REPORT.md)(그래픽, 변경 전후 스크린샷, 성능).

### 시각 검증 도구 (개발 서버 + Playwright MCP)
`tests/visual/`의 스크립트는 `about:blank#<label>`로 이동한 뒤 `browser_run_code_unsafe`의 filename 모드로 실행합니다.
- `captureShots.js`: 고정 카메라 비교 스크린샷 → `docs/screenshots/<label>/`
- `captureAnimations.js`: 애니메이션 시트
- `measurePerf.js`: 품질별 프레임 비용·드로우콜·VRAM. `#label:bots`로 30명 측정
- `paintConsistency.js`: 화면 페인트와 점령 데이터 대조
