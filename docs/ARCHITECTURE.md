# COLORFRONT 아키텍처 (Phase 2 + 그래픽 고도화 기준)

GDD와 달라진 결정은 [DECISIONS.md](DECISIONS.md)에 있다.

## 1. 원칙

1. **게임 규칙은 `packages/shared`의 순수 함수.** 렌더러·DOM·네트워크에 의존하지 않는다. 클라이언트 예측과 (Phase 3) 서버 권위 시뮬레이션이 같은 코드를 실행한다.
2. **고정 30 Hz 틱** (`TICK_RATE = 30`, GDD 7.3). 렌더는 브라우저 프레임 속도로 돌고, 두 틱 사이를 보간한다.
3. **입력만 보낸다.** `PlayerInput`은 이동 축, 시점 각도, 버튼 비트만 담는다. 위치·피격·도색 결과는 절대 클라이언트가 정답으로 보내지 않는다 (GDD 2.2, 7.2).
4. **렌더와 충돌의 분리.** 충돌 데이터(`MapDefinition`)가 기준이고, 렌더는 그것을 그릴 뿐이다. GLB로 바꿔도 충돌은 바뀌지 않는다.

## 2. 패키지

| 경로 | 역할 | 의존 |
|---|---|---|
| `packages/shared` | 타입, 상수, 규칙, 시뮬레이션, 맵, 프로토콜 초안 | 없음 (TS 소스 그대로 export) |
| `apps/client` | PlayCanvas 렌더, 입력, HUD, 설정 | shared, playcanvas |
| `apps/server` | **없음** (Phase 3에서 Colyseus 0.18로 생성) | — |
| `tests/unit` | shared 단위 테스트 | shared, vitest |

`@colorfront/shared`는 빌드 단계 없이 `.ts` 소스를 export 한다. 내부 import는 `.ts` 확장자와 지워지는 문법(`erasableSyntaxOnly`)만 쓰므로, Node 24의 타입 스트리핑으로도 직접 import 가능하다 (Phase 3 서버에서 별도 번들러 없이 사용 가능할 것으로 보이나, 서버 생성 시 검증 필요).

## 3. 핵심 타입 (`packages/shared/src/types`)

- `PlayerInput { seq, moveX, moveZ, yaw, pitch, buttons }` — `sanitizeInput()`이 NaN·범위 초과·잘못된 타입을 모두 정리. 서버는 모든 메시지에 이 함수를 적용해야 한다.
- `InputButton` 비트: Jump, Sprint, Dash, Fire, Aim, Reload. 점프·대시·재장전은 **상승 에지**(`buttons & ~lastButtons`)로 판정 → 키를 누르고 있어도 1회만 발동.
- `PlayerState` — 위치(발 기준), 속도, 접지, 대시/쿨다운(틱 단위 정수), HP, 무기·탄약·재장전 틱.
- `WeaponDefinition` — GDD 4.2 표 그대로. GDD에 없는 값은 `null`.
- `MatchPhase` — WAITING / COUNTDOWN / PLAYING / RESULTS / CLOSED 와 허용 전이표. JUDGING 없음: 점수는 PLAYING 종료 시 `finalizeRound`로 확정되고, RESULTS는 `reveal → summary` (D-001).

## 4. 시뮬레이션 (`packages/shared/src/simulation`)

### 4.1 이동 `stepMovement(state, input, world, dt, groundSpeedMultiplier)`
- 가속 기반 이동(지상 60 m/s², 공중 14 m/s²), 걷기 6 / 달리기 8 m/s, 조준 중 달리기 불가.
- 페인트 배율(`groundSpeedMultiplier`)은 접지 상태의 걷기·달리기 목표 속도에만 한 번 곱한다 (D-003).
- 대시: 5틱 동안 24 m/s → 정확히 4 m. 끝나면 현재 입력의 목표 속도로 바로 넘어가므로 추가 미끄러짐 없음. 쿨다운 180틱 = 6초.
- 점프 8 m/s, 중력 25 m/s² → 최고 약 1.3 m.
- 수평 이동을 0.2 m 이하 서브스텝으로 나눠 벽 관통 방지 (반경 0.4 m).
- 공중에서는 수직 이동 뒤에 한 번 더 수평으로 밀어내서, 모서리 옆으로 떨어질 때 겹친 채 틱이 끝나지 않게 한다 (D-008).
- 최종 안전망: 아레나 경계 클램프, `killY` 아래로 떨어지면 `fellOut` 반환 (호출 측이 리스폰).

### 4.2 충돌 `collision.ts`
엔진 물리(ammo.js 등)를 쓰지 않은 이유: 서버(Node)에서 **같은 결과**를 내야 하고, 30명 × 30 Hz에서 가벼워야 하기 때문.

- 플레이어 = 수직 원기둥 (반경 0.4, 높이 1.65). GDD의 "히트캡슐"은 Phase 2 피격 판정에서 별도로 정의.
- 고체 = 축 정렬 박스 + 축 정렬 쐐기(경사로). 경사로는 축 방향으로 높이가 선형 증가.
- `resolveHorizontal` — 원 vs 사각 발자국 밀어내기, 스텝 높이(0.4 m) 이하는 올라탐, 벽 방향 속도 제거(슬라이딩).
- `findGround` / `findCeiling` — 착지·천장 판정 (다리 밑 통과, 다리 위 착지 모두 지원).
- `raycast` — 반공간 교차(slab 일반화), 충돌면 법선 반환. 경사로는 경사면으로 정확히 판정. 카메라 충돌, 히트스캔, 페인트 시야 검사에 사용.
- 한계: 회전된 박스·임의 메시 충돌 없음. 최종 GLB 맵도 충돌은 박스/쐐기 프록시로 저작해야 한다 (또는 이후 별도 메시 충돌 도입).

### 4.3 플레이어 틱 `stepPlayer(state, input, world, paint?)`
1. `stepWeapon` — 발사 간격(라이플 5틱), 탄약, 재장전(54틱), R 에지, 빈 탄창 자동 재장전.
2. `paintSpeedMultiplier` → `stepMovement`.
3. 발사했다면 이동 후 위치에서 `traceShot` → `paint.paintSphere(impact, 1.2, team, normal)`.
결과(`movement`, `weapon`, `shot`, `paintedCells`)는 클라이언트 연출과 (Phase 3) 서버 이벤트 생성에 쓴다.

### 4.4 히트스캔 `combat/hitscan.ts` (D-004)
`aimPivot`(머리 1.55m + 오른쪽 어깨 0.8m, 벽에 막히면 안쪽으로 당김) → 시선 광선으로 조준점 → 가슴 높이 총구에서 사거리 25m 광선 → 맞은 것이 없으면 사거리 끝에서 수직으로 떨어뜨림. 카메라도 같은 `aimPivot`을 쓰므로 크로스헤어 = 판정 광선이다.

### 4.5 페인트 `paint/PaintGrid.ts` (D-002, D-005)
- 칠할 수 있는 고체(floor/platform/ramp/bridge)마다 독립된 0.5m XZ 격자: `owners[surface]`, `masks[surface]`, `surfaceRevisions[surface]`.
- 마스크: 스폰 구역, 그 면 위에 올라선 다른 고체에 덮인 셀은 0. 현재 맵 기준 55,192셀.
- `paintSphere` — 구체와 면의 교차 + 착탄면에서의 시야 검사. 같은 팀 재도색은 변화 없음(멱등). 카운트(`blueCount/orangeCount`)는 증분으로 갱신하고 `recount()`로 전체 검증.
- `ownerAt(x,y,z)` — 발 위치 아래 셀의 소유자 (속도 배율, HUD).
- `revision`, `surfaceRevisions` — 렌더 업로드와 (Phase 3) `paint:delta` 배치 기준.

### 4.5.1 다인원 시뮬레이션 `simulation/match.ts`, `rules/combat.ts`, `bots/simpleBot.ts`
- `MatchSimulation.step(inputs)`는 플레이어를 참가 순서대로 처리한다. 각 플레이어는 `stepPlayer`(적 목록을 히트스캔 대상으로 전달)를 거치고, 결과로 이벤트(`shot`, `hit`, `splat`, `respawn`, `move`)를 낸다.
- 피해·처치·부활·무적·스폰 보호 규칙은 [DECISIONS.md](DECISIONS.md) D-013에 있다.
- `SimpleBot`은 일반 `PlayerInput`만 만든다. 오프라인 대전과 부하 테스트용이다.
- Phase 3 서버 Room은 이 클래스를 그대로 감싸는 형태를 목표로 한다.

### 4.5.2 장식 데이터 `map/decor.ts`, `map/neonTerminalDecor.ts`
충돌하지 않는 장식 배치 데이터와 안전 검사기다(D-014).

### 4.6 고정 틱 `FixedStepper`
누적기 방식. 한 프레임에 최대 8틱까지만 따라잡고 나머지는 버린다 (탭 비활성 후 폭주 방지). PlayCanvas 자체도 프레임 dt를 0.1초로 제한하므로 10 FPS 미만에서는 게임이 느려진다 (의도된 동작).

### 4.7 결정성
같은 입력 시퀀스 → 같은 결과 (테스트로 검증). `Math.sin/cos`를 쓰므로 **서로 다른 JS 엔진 간 비트 단위 일치는 보장하지 않는다.** 서버 권위 + 클라이언트 재조정(reconciliation) 구조에서는 작은 오차가 허용되므로 문제 없다고 판단하지만, Phase 3에서 오차 크기를 측정해야 한다.

## 5. 클라이언트 (`apps/client/src`)

| 파일 | 역할 |
|---|---|
| `main.ts` | WebGL2 디바이스 생성(GDD 5.2), AppBase 초기화, 실패 시 안내 |
| `game/Game.ts` | 30 Hz 틱 루프, 입력 샘플링 → `sanitizeInput` → `stepPlayer`, 보간, 설정 적용 |
| `game/InputManager.ts` | Pointer Lock, 키/마우스, 틱 사이 짧은 탭을 래치해서 유실 방지 |
| `player/ThirdPersonCamera.ts` | 어깨너머 카메라, 휠 줌, 조준 블렌드, 화면 전용 반동·흔들림. shared `aimPivot`/`raycast` 사용 → 크로스헤어 = 판정 광선 |
| `player/CharacterRig.ts` | 코드로 생성한 22본 스키닝 캐릭터, 절차적 애니메이션 12종, 팔 IK, LOD (D-012) |
| `paint/PaintRenderer.ts` | 셀 소유권 필드 텍스처 + 커스텀 셰이더 청크(불규칙 경계, 부푼 테두리, 광택). 변경 영역만 갱신 (D-010) |
| `paint/PaintEffects.ts` | 날아가는 슬러그, 방향성 물방울(인스턴싱), 방사형 스플랫, 처치 폭발 — 순수 연출 (D-011) |
| `render/Environment.ts` | 절차적 하늘 → IBL 아틀라스, 태양, 안개 (D-009) |
| `render/PostEffects.ts` | `CameraFrame` HDR: Bloom, 그레이딩, 비네트, MSAA, (high) SSAO |
| `render/ProceduralTextures.ts`, `render/Materials.ts` | 절차적 PBR 텍스처 세트와 재질 라이브러리 |
| `render/MeshBatch.ts` | 정적 지오메트리를 재질별 메시 하나로 합침 (탄젠트 포함) |
| `render/Signs.ts` | 간판 아틀라스(드로우 1회), 실시간 점령률 홀로그램 |
| `player/CharacterView.ts` | `CharacterVisual` 인터페이스 + 프리미티브 임시 캐릭터 |
| `scenes/ArenaBuilder.ts` | 맵 고체를 태그별 **1개 메시로 일괄 생성**(드로우콜 최소화), 월드 좌표 UV 격자 텍스처 |
| `settings/settings.ts` | 설정 타입·검증·저장, 품질 프로파일 |
| `ui/Hud.ts`, `ui/SettingsMenu.ts`, `ui/ui.css` | DOM HUD(점령률 바: 아이콘·텍스트·줄무늬 병행), 시작/ESC 메뉴, 개발자 도구(팀 전환, 페인트 초기화) |

### 5.1 렌더 보간
매 틱 직전 위치를 저장하고, 렌더 프레임에서 `alpha = 누적시간 / 틱길이`로 보간. 시점(yaw/pitch)은 반응성을 위해 렌더 프레임마다 즉시 반영하고, 이동 방향은 틱 샘플 값을 사용한다.

### 5.2 품질 프로파일
| | low | medium | high |
|---|---|---|---|
| 그림자 | 끔 | 1024, 60 m | 2048, 110 m, 캐스케이드 2, PCF5 |
| 픽셀 비율 상한 | 1.0 | 1.5 | 2.0 |
| 안개 | 끔 | 선형 | 선형 |
| 후처리 | 없음 (직접 렌더 + Neutral 톤매핑) | HDR, Bloom, 그레이딩, 비네트, 2x MSAA | + SSAO, 4x MSAA |
| 페인트 셰이더 | 경계 노이즈만 | + 액체 테두리 노멀 | + 미세 물결 |
| 물방울 상한 | 48 | 160 | 320 |
| 장식 밀도 / 텍스처 | 0.35 / 256px | 0.75 / 512px | 1.0 / 512px |
| 캐릭터 LOD 거리 | 14 m | 24 m | 40 m |
최종 픽셀 비율 = `min(devicePixelRatio, 상한) × 렌더 스케일`.
GDD 5.1의 VSync 항목은 브라우저가 제어를 허용하지 않아 넣지 않았다. FPS 제한·파티클 한도·카메라 흔들림은 해당 기능이 생길 때 추가한다 (동작하지 않는 옵션을 만들지 않기 위해).

### 5.3 GLB 교체 경로
- 캐릭터: `CharacterRig`와 같은 공개 API(`update(dt, pose, …)`, `fired`, `hit`, `respawned`, `celebrate`, `setTeam`, `muzzle`)를 GLB 스킨 메시로 구현하면 된다. `ContainerHandler`가 이미 등록되어 있어 `app.assets.loadFromUrl(..., 'container')`로 GLB를 로드할 수 있다.
- 맵: `buildArena()`를 GLB 씬 로드로 교체하고, `MapDefinition`(충돌)은 그대로 유지.

### 5.4 보안 메모
HUD/메뉴의 `innerHTML`은 **고정 문자열 템플릿**에만 사용한다. 닉네임 등 사용자 입력(Phase 3+)은 반드시 `textContent`로 넣어야 한다 (GDD 7.4 XSS).

## 6. 네트워크 경계 (아직 미구현)
`packages/shared/src/protocol/messages.ts`에 GDD 7.2 메시지 이름과 페이로드 타입 **초안**만 있다. Colyseus 0.18 설치 후 실제 API(`room.send`/`onMessage`, Schema, 입력 큐/고정 스텝 API)와 대조해서 확정해야 한다. 이 시점 npm 기준 `colyseus` 0.18.9, `@colyseus/core` 0.18.18이 최신이다 (2026-10-16 조회, 설치하지 않음).

Phase 3 예상 흐름:
```text
Client tick:  input = sanitize(sample)  → stepPlayer(local)  → send(input)  → 버퍼에 보관
Server tick:  for each queued input: sanitize → stepPlayer(authoritative) → state.lastProcessedSeq
Client recv:  서버 상태로 되감기 → lastProcessedSeq 이후 입력 재적용 (reconciliation)
```
