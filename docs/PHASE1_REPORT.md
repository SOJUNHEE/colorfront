# Phase 1 보고서 — 1인 오프라인 TPS 원형

작성일: 2026-10-16 · 기준 문서: `COLORFRONT_GDD_v1.md`, `COLORFRONT_CLAUDE_PHASE1_PROMPT.md`

## (1) 작업 전 분석

### 폴더 및 환경
| 항목 | 결과 |
|---|---|
| 작업 폴더 | `C:\Users\user\Desktop\fps` — GDD/프롬프트 md 2개만 존재, `package.json` 없음 → 덮어쓸 기존 코드 없음 |
| git | **저장소 아님** (초기화하지 않음, 필요 시 `git init` 권장) |
| Node / npm | v24.20.0 / 11.19.0 · pnpm 미설치 → **npm workspaces** 선택 |
| 공식 스캐폴드 | `create-playcanvas@0.10.1` (engines `>=22.23.2`, 현재 Node 충족). `-f engine` 형식 확인 후 `npm create playcanvas@0.10.1 client -- -f engine -y --no-skills` 로 `apps/client` 생성 |
| 생성 결과 버전 | playcanvas 2.23.3, vite 8.3.4, typescript 6.0.x, vitest 5.0.5 |

새 프로젝트는 GDD 14절대로 `fps/colorfront/`에 만들었다. 원본 md 2개는 수정하지 않았다.

### GDD 모순 · 누락 · 위험 (짧게)
1. **페이즈 불일치** — 2.1은 "판정 15초"가 있으나 2.4 페이즈 목록에 JUDGING이 없다. 현재 타입은 2.4를 따르고 `MATCH_TIMING.judgingSeconds`만 보존.
2. **단일 격자 vs 다층 바닥** — 6.1의 `Uint8Array(76800)` 한 장으로는 고지대·다리처럼 바닥 위에 겹친 면을 표현할 수 없다. surfaceId별 격자가 필요하다. 실측: 현재 블록아웃의 지상 도색 가능 비율은 **54%** (목표 65% 미달, 고지대가 바닥을 가림), 고지대·경사로·다리 상면 약 13,900셀을 더하면 약 72%.
3. **Phase 1 카메라** — GDD 10절은 "FPS·TPS 카메라", 프롬프트는 TPS만 요구 → **TPS만 구현**.
4. **미정 수치** — 대시 지속시간, 점프 높이, 가속도, Charge Cannon/Roller 재장전·피해량. 시뮬레이션 값은 가정으로 정하고 `constants/simulation.ts`에 표시.
5. **도색 속도 보정(1.15/0.8)과 달리기·대시 중첩 규칙** 미정.
6. **VSync 설정**(5.1)은 브라우저에서 제어 불가 → 넣지 않음.
7. **`reload` 메시지 중복** — 7.2의 `reload` 메시지와 `input`의 재장전 플래그가 겹친다. 하나로 통일 권장(입력 비트).
8. **물리 엔진 선택 누락** — 서버와 같은 함수를 공유하려면 엔진 물리를 쓸 수 없다 → 순수 TS 충돌을 직접 구현 (위험: 회전·임의 메시 충돌 없음).
9. **크로스 엔진 결정성** — `Math.sin/cos` 차이 가능. 재조정 구조로 흡수 예정, Phase 3에서 측정 필요.

## (2) 구현 요약

### 생성/변경 파일
| 파일 | 이유 |
|---|---|
| `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`, `.npmrc` | npm workspaces 루트, 공통 TS 설정, 테스트 실행 |
| `packages/shared/src/types/{player,weapon,match,math}.ts` | 요구된 `PlayerInput`, `PlayerState`, `WeaponDefinition`, `MatchPhase` |
| `packages/shared/src/input/buttons.ts` | 버튼 비트, `sanitizeInput` (서버 검증 겸용) |
| `packages/shared/src/constants/simulation.ts` | 30 Hz, 아레나 160×120, 이동 수치 |
| `packages/shared/src/rules/{weapons,match}.ts` | GDD 4.2 무기 표, 탄약/재장전 틱 로직, 경기 타이밍 |
| `packages/shared/src/simulation/{collision,movement,player,fixedStep}.ts` | 순수 충돌·이동·고정 스텝 (서버 공유 대상) |
| `packages/shared/src/map/{types,neonTerminal}.ts` | 블록아웃: A/B 스폰 25×30, 중앙 광장 50×45, 북쪽 고지대 7 m + 경사로 4개 + 횡단 다리, 남쪽 우회로, 서쪽 절반 저작 후 x=0 대칭 복제 |
| `packages/shared/src/protocol/messages.ts` | GDD 7.2 메시지 **초안 타입만** (구현 없음) |
| `apps/client/` (스캐폴드 기반) | 이름 `@colorfront/client`, shared 의존 추가, `starter.css` 삭제, `.gitignore/.npmrc`는 루트로 이동, Vite 포트 5173 고정 |
| `apps/client/src/main.ts`, `game/*`, `player/*`, `scenes/*`, `settings/*`, `ui/*` | 게임 루프, 입력, 카메라, 임시 캐릭터, 맵 렌더, HUD, ESC 설정 |
| `apps/client/src/inspector.css` | 개발용 Inspector 안내 칩을 우상단으로 이동 (HP 패널을 가리던 문제) |
| `tests/unit/*.test.ts` | 38개 테스트 |

### 기능 상태 (정직한 구분)
| 기능 | 상태 |
|---|---|
| 3D 아레나 블록아웃, 그림자, 격자 텍스처 | 동작 |
| TPS 카메라, Pointer Lock, 줌(휠), 조준(우클릭), 벽 회피 | 동작 |
| WASD / Shift / Space / Q, 중력·충돌·경사로·다리 | 동작 |
| 크로스헤어, HP 바, 탄약·재장전 HUD, 대시 쿨다운, FPS 표시 | 동작 (HP는 고정 100, 피해 없음) |
| 좌클릭 사격 | **모의** — 탄약만 감소, 투사체·피격·도색 없음 (HUD에 명시) |
| ESC 설정: 품질, 렌더 스케일, 감도, FOV, Y반전, FPS, 전체화면, 기본값 | 동작, localStorage 저장 |
| 서버, 매칭, 멀티플레이 | **없음** |

## (3) 실제 검증

### 자동 검증 (모두 최종 코드 기준으로 재실행)
| 명령 | 결과 |
|---|---|
| `npm run typecheck` | 통과 (shared, tests, client) |
| `npm run lint` | 통과 (PlayCanvas 공식 ESLint 규칙, 자동 수정 후 수동 3건 수정) |
| `npm test` | **38/38 통과** (5 파일) |
| `npm run build` | 통과. 경고: JS 청크 1.17 MB (gzip 313 KB) — 대부분 PlayCanvas 엔진 |
| `npm install` | 취약점 0건. 경고: eslint 9.39.5 deprecated (스캐폴드 지정 버전), `unrs-resolver` postinstall 미승인 (lint 정상 동작) |

테스트 내용: 걷기/달리기 속도, 조준 시 달리기 해제, 대각선 속도 제한, 점프 높이·에지 판정, 대시 4 m·쿨다운, 경계벽 슬라이딩, 건물/엄폐물 차단, 경사로 오르기·내려오기 접지 유지, 다리 밑 통과·위 착지, 결정성, 경사면 레이캐스트, 입력 정제(NaN·타입 오류), 라이플 6발/초·자동 재장전·R 에지, 페이즈 전이, 고정 스텝, 맵 치수(160×120, 25×30, 50×45)·대칭·스폰 15개씩 자유 공간, **5분(9000틱) 랜덤 입력 소크 × 4 시드**: 지오메트리 매몰·NaN·이탈 0건.

> 소크 테스트는 Phase 1 통과 조건("1인 오프라인 5분 충돌 없이 이동")의 **자동 대리 지표**일 뿐이다. 사람이 브라우저에서 5분 직접 플레이하는 확인은 아직 하지 않았다.

### 브라우저 검증 (Playwright, Chrome 155, Intel 내장 GPU / ANGLE D3D11, 1366×768)
| 항목 | 결과 |
|---|---|
| 페이지 로드, 시작 메뉴 | 통과, 콘솔 오류 0 (첫 404는 dev 스크립트 인자 오류로 잘못 띄운 서버 때문, 수정함) |
| Pointer Lock | 자동화 창에서 Chrome이 **거부** → 게임이 안내 메시지를 정상 표시. 이후 검증은 테스트 세션에서만 `document.pointerLockElement`를 대체(shim)해서 실제 키보드·마우스 이벤트로 진행. **실제 Pointer Lock 획득은 사람이 직접 확인 필요.** |
| 이동 | W 1초 ≈ 6.2 m, Shift+W 1초 ≈ 8.3 m, Q 대시 ≈ 4.2 m (4 m + 감속), 쿨다운 표시, 점프 후 착지 |
| 마우스 회전 | 오른쪽 이동 → 오른쪽 회전 확인 |
| 사격/재장전 (모의) | 1초 연사 36→30발, R 후 1.8초 뒤 36발 |
| 조준 | FOV 70°→50°, 카메라 근접 |
| 경사로 → 고지대 | 스폰 경사로로 y=7 고지대 도달 (스크린샷 확인) |
| ESC | 메뉴 "일시정지" 표시, HUD 숨김, 일시정지 중 입력 무시 |
| 설정 | low: 그림자·안개 꺼짐, 50% → 백버퍼 683px. high: 캐스케이드 2. 새로고침 후 유지 |
| 크기 변경 | 1366×768, 1920×1080, 2560×1440 — 가로 스크롤 없음, 백버퍼가 창 크기 따라감 |

### FPS 관측
- 창이 전면일 때 HUD/rAF 측정 **60 FPS** (medium, 1366×768, 모니터 주사율 상한으로 보임).
- 렌더 비용 직접 측정(`app.render()` 30회 + `gl.finish()`): low 1.2 ms, medium 1.6–3.2 ms, high 1.5–2.0 ms / 프레임.
- 측정 중 rAF가 1–5 FPS로 떨어지는 현상이 있었으나, 같은 시점의 렌더 비용은 1–3 ms로 정상이었고 빈 rAF 루프도 똑같이 느렸다 → VS Code 창에 가려진 자동화 브라우저를 Chrome이 스로틀링한 것으로 판단 (게임 버그 아님).
- **미측정:** p50/p95 프레임 타임, 장시간 플레이, 다른 PC, 1080p 중급 PC 기준 (GDD 8.1). 캐릭터 1명·정적 맵 기준 수치이므로 30인 성능을 의미하지 않는다.

### 알려진 문제 / 한계
1. 실제 Pointer Lock과 사람 5분 플레이 미확인 (위 참조).
2. 캐릭터 애니메이션 없음 (프리미티브 캡슐). 카메라가 아주 가까워지면 캐릭터가 화면을 가릴 수 있음 (페이드 미구현).
3. 사격 판정·도색·피해·리스폰 타이머 없음 (Phase 2).
4. 충돌은 축 정렬 박스/쐐기만 지원.
5. 맵 수치(시야선, 이동 시간, 경로 가치)는 실측 플레이테스트 전 가설.
6. 빌드 청크 1.17 MB — 엔진 포함. 필요 시 코드 분할 검토.
7. 10 FPS 미만에서는 PlayCanvas dt 제한(0.1초)으로 게임이 느려짐.

## (4) 다음 작업 — Phase 2 페인트 영역 점령 코어 설계

### 데이터 (shared, 서버 권위 대상)
- `PaintSurface { id, origin, axisU, axisV, width, height, cellSize=0.5, solidId }` — 바닥, 고지대 상면(서/동), 경사로 4개(경사면 길이 기준 격자), 다리 상면을 **각각 별도 surface**로. 지상 바닥 320×240.
- `PaintGrid` — surface별 `owner: Uint8Array`, `mask: Uint8Array`, `blueCount/orangeCount/paintableCount`, `revision`.
- 마스크 자동 생성: 지면에 놓인 고체 발자국, 스폰 구역, 상면이 가려진 셀 → false. 맵 정의에서 계산하므로 맵을 고치면 마스크도 따라감.
- `paintCircle(surfaceId, worldPoint, radius, team)` → 변경 셀 인덱스 목록. 같은 팀 재도색은 카운트 변화 없음(멱등), 적 셀 덮으면 적 -1 / 아군 +1.
- 테스트: GDD 6.4 전부 + 1000회 랜덤 후 증분 카운트 = 전체 스캔.

### 사격
- 히트스캔: 카메라 중심 레이로 조준점 결정 → 총구에서 조준점으로 shared `raycast` → 첫 충돌 고체의 상면이면 surface 좌표로 변환 후 `paintCircle`. 벽은 시각 효과만 (GDD 3.2).
- 기존 `stepWeapon`의 `fired`를 실제 발사 이벤트로 연결, 사거리 25 m.
- 더미 표적(정지 캡슐)로 피해 14·HP·5초 리스폰·2초 무적 확인.

### 렌더
- surface마다 owner를 담은 작은 텍스처(바닥 320×240)를 만들고, 변경된 행만 부분 업로드. surface 위에 약간 띄운 오버레이 메시가 팀 색(블루/오렌지 + 패턴)으로 그린다. 데이터 1셀 = 텍스처 1텍셀이므로 "보이는 색 = 점수 데이터"가 구조적으로 보장된다 (GDD 6.2).
- HUD 상단 점령 바: 블루 % / 미점령 % / 오렌지 %, 판정은 셀 수.

### 확인이 필요한 질문
1. **판정 페이즈** — `PLAYING → JUDGING(15초) → RESULTS`로 페이즈를 하나 추가할까요, 아니면 RESULTS 안의 연출로 처리할까요?
2. **점수에 포함되는 면** — 고지대·경사로·다리 상면을 점수에 포함할까요(포함 시 약 72%, 지상만은 54%)? 엄폐물 상면은 제외로 가정합니다.
3. **도색 위 속도 보정(1.15× / 0.8×)** — 달리기에는 곱하고 대시(고정 4 m)에는 적용하지 않는 것으로 가정해도 될까요?
