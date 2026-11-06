# Phase 6 진행 로그 — 3D 캐릭터·아바타·맵 그래픽

기준 문서: `docs/COLORFRONT_Phase6_Review_Pack/` (README, 01_AUDIT, 02_ART_WARDROBE_SPEC, 03_CLAUDE_PHASE6_MASTER_PROMPT, 04_WARDROBE_CATALOG_EXAMPLE.json, 05_VALIDATION)

> 참고: 요청서에는 경로가 `docs/phase6_review/`로 적혀 있지만, 실제 파일은 `docs/COLORFRONT_Phase6_Review_Pack/`에 있다.

---

## GATE 0 — 회귀 기준 고정, 모델 교체 어댑터

| 항목 | 내용 |
|---|---|
| 진행 GATE | 0 (완료) |
| 목적 / 비교 기준 | 현재 상태를 동결하고, 렌더러를 교체해도 게임 코드가 바뀌지 않도록 경계를 만든다. |
| 실행 환경 | Windows 11 Pro 26200, Node 24.22.0, npm 11.19.1. 실행 시각 2026-11-05 20:33–20:45 (KST) |

### Git

- `feat/phase3-multiplayer` 브랜치에 커밋하지 않은 Phase 3 작업이 있었다. 이를 `72fe953`으로 커밋해 동결했다.
- 그 위에 `feat/phase6-graphics` 브랜치를 만들었다. push는 하지 않았다.

### 발견해서 고친 환경 문제

프로젝트 폴더를 옮긴 뒤 `node_modules/@colorfront/{client,server,shared}` 정션이 예전 경로(`C:\Users\user\Desktop\fps\…`)를 가리키고 있었다. 그래서 typecheck, test, lint, build가 모두 실패했다. 정션 3개만 현재 경로로 다시 만들었다. lockfile과 패키지는 바꾸지 않았다.

### Baseline 결과 (`docs/phase6/baseline/*.txt`)

| 명령 | 결과 |
|---|---|
| typecheck | PASS |
| lint | PASS |
| build | PASS |
| test | **108/109**. `network.test.ts › cannot be sped up by flooding inputs`가 실패했다(4.40m, 한도 4.36–4.38m). |

이 테스트는 20:34–20:36에 단독으로 3회 연속 재현됐다. 하지만 21:19 전체 실행에서는 통과했다. 따라서 **간헐 실패(타이밍 의존)**다.

- 원인 추정: D-016 크레딧 따라잡기 때문에 입력 폭주 시 최대 약 0.1m를 더 움직일 수 있다.
- 서버 규칙 변경은 Gate 0에서 금지되어 있어 손대지 않았다. **별도 작업으로 남긴다.**

### 어댑터

- `apps/client/src/player/AvatarView.ts`: Game이 의존하는 공개 계약은 `root`, `currentLod`, `update(dt, RigPose, camDist, lodDist)`, `setTeam`, `setVisible`, `muzzle`, `fired`, `hit`, `respawned`, `celebrate`다.
- `createAvatar()` 팩토리: Gate 0 시점에는 legacy `CharacterRig`를 반환한다. 예외를 던지지 않고 기다리지도 않는다.
- `Game.ts`: `new CharacterRig(...)` 두 곳(로컬 액터, 네트워크 액터)을 `createAvatar(...)`로 바꿨다.
- 동작은 바뀌지 않았다. 신호 흐름은 아래와 같다.

```text
Game.update ─RigPose(보간 위치, 속도, 조준, 대시, 재장전, 탄약)─▶ AvatarView.update
Game.handleEvents ─shot─▶ AvatarView.fired / muzzle(out) ─▶ PaintEffects(시각 전용)
              ─hit/splat/respawn─▶ hit / setVisible / respawned
서버·시뮬레이션·페인트 판정 ◀── (역방향 의존 없음)
```

### Baseline 스크린샷

`docs/screenshots/phase6-baseline/01~10`은 `tests/visual/captureShots.js`와 같은 구도로 찍었다. 오류는 0건, 드로우콜은 133이다.

### 측정 체계 메모

- **30명 네트워크 봇 부하(`npm run load`)와 30명이 한 화면에 나오는 렌더링은 별개의 시험이다.** 후자는 Gate 6에서 실제 온라인 밀집 장면으로 측정한다.
- 페인트 정합성은 기존 셀 중심 검사 외에 경계, 다리 위·아래, 경사로 검사를 추가한다(Gate 5·6).

---

## GATE 1 — 오리지널 마스터 3D 캐릭터 "Neon Courier"

| 항목 | 내용 |
|---|---|
| 진행 GATE | 1. 산출물과 검증은 완료했다. **다음 Gate 진입은 사용자 이미지 승인 후다.** |
| 목적 | 블록 인형(프리미티브 91개, 강체 스키닝)을 연결된 곡면, 가중치 스키닝, GLB 캐릭터로 교체하기 위한 원본을 만든다. |

### 제작 방식

Blender 5.2.3 LTS(포터블)를 headless로 실행해 Python 스크립트로 만든다.

1. **몸체·의상:** Skin 모디파이어로 연결된 헐을 만들고, Subdivision으로 매끄럽게 한 뒤, 부위별 목표 삼각형 수까지 Decimate한다.
   - 그다음 색 경계 평면으로 bisect해서 경계선을 깔끔하게 만들고, 팔레트 UV를 지정한다.
   - 데시메이트를 UV 지정 **전에** 하므로 색이 번지지 않는다.
2. **헤어:** 테이퍼 베지어 튜브 8개(비대칭 스우프, 카울릭, 뒤쪽 볼륨)와 캡으로 만든다. 원뿔을 방사형으로 배열하지 않았다.
3. **리그:** CharacterRig.ts와 같은 22본 이름과 계층을 쓴다. 팔은 A-pose(42°)다.
   - **Blender bone heat** 자동 웨이트를 쓴다. 이번 빌드에서 heat가 실패해 fallback한 정점은 0개다.
   - 액세서리(주머니, 무릎 패드, 칼라, 커프스, 지퍼, 패치)는 KD-tree로 가장 가까운 헐 정점의 웨이트를 받는다. 그래서 몸에서 떨어지지 않는다.
   - 머리카락, 신발, 장갑, 탱크, 총은 소켓 본에 강체로 붙였다.
4. **본 정렬:** 웨이트를 계산한 뒤 모든 본을 +Z(roll 0)로 정렬한다. 그래서 GLB 조인트의 rest 회전이 **identity**다. 기존 절차적 애니메이션 코드와 같은 규약이다.
5. **텍스처:** 1024×512 아틀라스 하나에 팔레트 셀 22개, 얼굴 표정 타일 4개(neutral, blink, happy, surprised), 팀 엠블럼이 들어 있다.
   - ORM(거칠기·금속)과 Emissive(LED, 탱크 액체)는 별도 맵이다.
   - 팀 전환은 블루·오렌지 아틀라스를 교체해서 한다(공유 재질 캐시).

### 변경·추가 파일

| 구분 | 경로 |
|---|---|
| Blender 원본 | `assets-src/blender/colorfront_courier_master.blend` (LOD0/1/2 컬렉션, 리그, 의상 사본) |
| 제작 스크립트 | `assets-src/blender/scripts/build_courier.py` |
| 검증 스크립트 | `assets-src/blender/scripts/validate_avatar.py` (`npm run avatar:validate`) |
| 시트 도구 | `assets-src/blender/scripts/contact_sheet.py` |
| 텍스처 원본 | `assets-src/blender/textures/*.png` |
| 배포 GLB (캐릭터) | `apps/client/public/assets/characters/courier_default_lod{0,1,2}.glb`, `courier_base_lod0.glb` |
| 배포 GLB (의상·무기) | `apps/client/public/assets/clothes/*.glb`(5종), `weapons/paint_rifle.glb` |
| 팀 텍스처 | `apps/client/public/assets/characters/courier_{atlas,emissive}_{blue,orange}.png` |
| GLB 렌더러 (게임 미연결) | `apps/client/src/player/GlbAvatar.ts` (`AvatarLibrary`, `GlbAvatar implements AvatarView`) |
| 독립 프리뷰 | `apps/client/avatar-preview.html`, `apps/client/src/preview/avatarPreview.ts` |
| 문서 | `docs/phase6/ASSET_SOURCES.md` |

### 검증 결과

**1) GLB 계약 검사** (`npm run avatar:validate`, `docs/phase6/gate1/validation.json`): 10개 파일 모두 PASS다.

| 파일 | 삼각형 | 목표 | 드로우콜(프리미티브) | 기타 |
|---|---:|---|---:|---|
| courier_default_lod0 | 7,984 | 5,000–8,000 | 2 (불투명 + 탱크 유리) | 높이 1.763m (몸 1.65m + 헤어), 바닥 y = 0.0008 |
| courier_default_lod1 | 2,994 | 1,800–3,000 | 2 | |
| courier_default_lod2 | 1,075 | 500–1,200 | 2 | |

- 22 조인트의 이름과 부모가 일치한다.
- rest 회전은 identity이고 스케일은 1이다.
- inverse bind 오차는 0이다.
- 정점당 영향 본은 4개 이하이고 가중치 합은 1이다.
- `muzzle` 노드는 `gun` 조인트 아래 `(0, 0.03, -0.64)`에 있다. 기존 값과 같다.

**2) Blender 렌더** (`docs/phase6/gate1/`):
- `turnaround_lod0.png`: 정면, 측면, 후면, 3/4
- `lod0_face.png`
- `lod_compare.png`
- `pose_test.png`: 달리기, 조준, 깊은 굽힘. 팔꿈치·무릎 90° 이상과 고관절 90°에서 의상 액세서리가 따라오는지 확인했다.

**3) PlayCanvas 독립 프리뷰** (`docs/phase6/gate1/playcanvas/`, `http://localhost:5174/avatar-preview.html`):
- 배치: GLB LOD0 블루, LOD0 오렌지, LOD1, LOD2, 기존 CharacterRig. 모두 같은 RigPose 스트림을 받는다.
- `sheet_views.png`: 정면, 측면, 후면, 3/4, 얼굴, 게임 카메라, 라인업, 게임 카메라 조준
- `sheet_poses.png`: 12개 상태(idle → victory)
- 로드 시간은 0.6–1.4초이고, 페이지 오류는 0건이다. 404 1건은 favicon이다.
- 프리뷰 장면 드로우콜은 총 52(forward 18, shadow 14)다. 캐릭터 5명과 바닥, 후처리를 포함한 값이다.
- **총구 위치:** GLB와 기존 리그가 같은 포즈에서 (y 1.1614, z -0.6998)로 소수점 넷째 자리까지 일치한다.
- 팀 전환(오렌지 재질 캐시), 탱크 수위(ammo), 양손 IK 그립, 재장전 시 왼손이 탱크로 가는 동작, LOD2 원거리 팔 처리를 확인했다.

**4) 회귀** (2026-11-05 21:19): typecheck, lint, build PASS. 테스트 **109/109 PASS**.

### 성능

- 캐릭터 1명 LOD0의 불투명 드로우콜은 1회, 유리는 1회다. 기존 리그는 2회였다.
- 메시와 재질은 모든 아바타가 공유한다. 아바타마다 SkinInstance만 따로 가진다.
- **30인 밀집 FPS는 아직 측정하지 않았다.** 게임에 연결하지 않았으므로 Gate 2·6에서 측정한다.

### 남은 결함·한계

1. **신발 밑창이 걸을 때 평평한 판처럼 보인다.** 발끝 굽힘 본이 없고 밑창이 강체다. Gate 4에서 toe 보조본을 넣거나 밑창 형상을 고친다.
2. **얼굴 표정 타일 4종은 아틀라스에 있지만 런타임 전환은 아직 없다.** UV 오프셋 셰이더 청크로 Gate 4에서 구현한다.
3. **애니메이션은 아직 기존 절차적(사인파) 모델을 GLB 본에 이식한 것이다.** 키프레임 클립과 state graph는 Gate 4 범위다.
4. **팀 색 외 개인화(피부 5톤, 헤어 색, colorVariant)는 아직 없다.** Gate 3 의상 시스템에서 팔레트 행을 교체하는 방식으로 넣는다.
5. **휴식 자세(A-pose)에서는 총이 가슴 앞에 떠 있다.** 게임에서는 IK로 잡으므로 문제없다.
6. **의상 GLB 5종과 베이스는 만들고 계약 검사도 통과했다.** 하지만 개별 착용 시스템은 Gate 3 범위다.
7. **팔레트 명도를 게임 조명 기준으로 한 번 올렸다**(Blender 스튜디오 조명에서는 밝아 보였다). 실제 게임 맵에서 최종 대비를 다시 검수해야 한다.
8. Blender는 시스템에 설치하지 않았다. 포터블 경로 `C:\Users\user\tools\blender-5.2.3-windows-x64\blender.exe`를 쓴다.

### 재현 방법

```powershell
& "C:\Users\user\tools\blender-5.2.3-windows-x64\blender.exe" -b --factory-startup `
  --python assets-src/blender/scripts/build_courier.py -- --renders
npm run avatar:validate
npm run dev   # → http://localhost:5173/avatar-preview.html
```

### 다음 GATE 진입 가능 여부

기술 검증(계약, 회귀, 프리뷰)은 통과했다. 마스터 프롬프트의 게이트 조건에 따라, **사용자가 세 각도와 애니메이션 이미지를 승인한 뒤** Gate 2(게임 통합)를 시작한다.

> 2026-11-06: 사용자가 Gate 1 이미지를 승인했다. Gate 2를 시작했다.

---

## GATE 2 — GLB 캐릭터 실제 게임 교체 (기존 기능 불변)

| 항목 | 내용 |
|---|---|
| 진행 GATE | 2 (완료) |
| 목적 / 비교 기준 | 오프라인·온라인 게임의 모든 플레이어를 GLB 아바타로 교체한다. 판정, 페인트, 네트워크는 바꾸지 않는다. 비교 기준은 Gate 0 baseline(`docs/screenshots/phase6-baseline/`)이다. |
| 실행 환경 | Windows 11, Intel Graphics (ANGLE D3D11, `0x0000A7AC`), Chrome headless(GPU), 1366×768. 2026-11-06 09:50–10:05 (KST) |

### 구조

```text
Game ──create(team, seed)──▶ AvatarFactory ──▶ SwitchableAvatar (root 고정, Game이 destroy/enabled 사용)
                                │                    └─ inner: CharacterRig(legacy) → GlbAvatar (로드 완료 시 즉시 교체)
                                └─ AvatarLibrary.load(): LOD0~2 GLB + 오렌지 텍스처 (한 번만)
```

- **즉시 반환:** 생성은 기다리지 않는다. 로드 중에는 legacy 리그로 그리다가 로드가 끝나면 살아 있는 아바타 전부를 제자리에서 교체한다. 팀, 승리 포즈, 위치·회전은 교체 시 이어받는다.
- **폴백:** GLB 로드에 실패하면 `status=failed`가 되고 legacy를 계속 쓴다. 게임은 멈추지 않는다.
- **강제 legacy:** `?avatar=legacy`(A/B 비교, 긴급 폴백).
- **공유와 분리:**
  - 메시, 재질, 텍스처, 스켈레톤 템플릿은 라이브러리에서 한 번만 로드한다.
  - 아바타는 각자 스켈레톤 복제본과 **SkinInstance 1개**(LOD 3개 × 프리미티브 2개가 공유)를 가진다.
  - 다른 플레이어끼리 SkinInstance를 공유하지 않는다.
- **팀 색:** 정점 버퍼를 다시 쓰지 않는다. 오렌지 재질을 한 번만 만들어 캐시하고 바꿔 끼운다.
- **LOD:** 품질 프로필의 `characterLodDistance` 기준으로 고른다.
  - LOD0: 이 거리 이하
  - LOD1: 이 거리 초과 ~ 2.5배
  - LOD2: 2.5배 초과
  - 그림자는 LOD0만 드리운다. 1.6배를 넘으면 팔 IK를 생략한다.
- **총구:** GLB의 `muzzle` 노드를 쓴다. 기존 리그와 0.1mm 이내로 일치한다(Gate 1).
- **판정 불변:** 서버, `packages/shared`, 페인트, 프로토콜 코드는 바꾸지 않았다.

### 변경 파일

| 파일 | 변경 |
|---|---|
| `apps/client/src/player/AvatarView.ts` | `SwitchableAvatar`, `AvatarFactory`, `avatarKindFromUrl` 추가 |
| `apps/client/src/player/GlbAvatar.ts` | 스켈레톤 템플릿 복제, 아바타당 SkinInstance 1개, LOD 재질 공유, 파괴 시 본 텍스처 해제 |
| `apps/client/src/player/CharacterRig.ts` | 파괴 시 SkinInstance 해제(기존 누수 수정) |
| `apps/client/src/game/Game.ts` | `AvatarFactory` 연결, `debugAvatars` 진단 추가 |
| `tests/unit/avatarAsset.test.ts` | 신규. GLB 계약 13개 |
| `tests/visual/captureShots.js`, `measurePerf.js` | 아바타 로드 대기 추가, `#label?avatar=legacy` A/B 옵션 추가 |
| `tests/visual/twoBrowser/1-setup.js` | 스크린샷 경로를 현재 폴더로 수정(옛 경로 하드코딩), `#폴더명` 지정 기능 추가 |

### 발견해서 고친 결함

| 결함 | 원인 | 조치 | 결과 |
|---|---|---|---|
| **본 텍스처 누수.** legacy에도 있던 문제로, 아바타를 생성·파괴할 때마다 늘었다(legacy 약 1.1KB/명, GLB 약 2.2KB/명). | PlayCanvas 렌더 컴포넌트는 `_clearSkinInstances()`로 연결을 먼저 끊은 뒤 MeshInstance를 파괴한다. 그래서 직접 붙인 SkinInstance는 해제되지 않는다. | 두 리그 모두 루트가 `destroy`될 때 자신이 만든 SkinInstance를 직접 해제한다. | 30명 생성·제거 20회 후 텍스처 VRAM이 76.559MB → 76.559MB(변화 없음). 남은 skin 텍스처는 legacy 1개, GLB 1개. |
| GLB 아바타마다 엔진 캐시 skin 객체 6개가 남음 | `instantiateRenderEntity()` 후 render 컴포넌트를 지우면서 캐시 SkinInstance가 남았다. | 라이브러리에서 한 번만 인스턴스화한다. 엔진 SkinInstance는 해제하고, 아바타는 뼈대만 `clone()`한다. | 아바타당 본 텍스처 6개 → 1개 |
| LOD GLB 3개가 같은 텍스처 3장을 중복 업로드 | LOD 파일마다 텍스처가 내장되어 있다. | LOD1·2 재질을 LOD0 재질로 바꿔 끼운다. | VRAM -11MB |

### 검증

**1) 로드 경로** (네트워크 조작):

| 경우 | 결과 |
|---|---|
| 정상 | `status=ready`. 로컬 플레이어와 봇 29명 모두 GLB(`kinds: glb 30`) |
| GLB 응답 2.5초 지연 | 로드 중에는 legacy 6명으로 게임이 진행된다. 로드가 끝나면 전원이 GLB로 바뀐다(`pending 0`). 이후 팀 전환과 봇 제거도 정상이며, 아바타 루트 수가 액터 수와 같다. |
| GLB 요청 차단 | `status=failed`, legacy 유지, 게임 정상. 콘솔에는 차단한 요청의 실패와 경고 1건만 남는다. |
| `?avatar=legacy` | `status=legacy`, 전원 legacy |

**2) 오프라인 A/B 스크린샷** (같은 카메라와 페인트 배치. `docs/screenshots/phase6-gate2/`, 비교 시트 `docs/phase6/gate2/ab_characters.png`):
- 페인트 점수(블루 3,539 / 오렌지 3,162 / 칠할 수 있는 셀 55,192)가 baseline과 **동일**하다.
- 장면 드로우콜 133이 baseline과 **동일**하다. 페이지 오류는 0건이다.
- 후면 근접 화면 `docs/phase6/gate2/back-closeup.png`: 탄약 24/36에서 탱크 액체 본 스케일이 0.667로 정확하다.

**3) 실제 온라인 2브라우저** (Chrome 프로세스 2개 + 실제 Colyseus 서버, `docs/screenshots/phase6-gate2-online/`):

| 항목 | 결과 |
|---|---|
| 입장 | 같은 방(A=블루, B=오렌지). 양쪽 모두 GLB 2명(`kinds: glb 2`) |
| 이동 | A 이동 후 B가 본 A 위치 오차 **1mm**. 점프 최고 1.14m, 대시 4.00m (Phase 3과 같음) |
| 페인트 | 리셋, 블루 18셀, 오렌지 덮어쓰기 16셀의 모든 시점에서 A·B 해시가 같고 서버 점수와도 같다. |
| 전투 | 피격 이벤트가 양쪽 8회로 같다. 처치 이벤트 동일, Alice K1/D0 · Bob K0/D1, B 부활 정상 |
| 원격 연출 | B가 A의 사격 이벤트 17회를 받았다(GLB 사격 동작과 총구 이펙트를 그림). |
| 새로고침 재접속 | 같은 세션과 팀으로 복귀. B가 다시 GLB 2명을 그린다. 페인트 해시 동일, 불일치 0 |
| 클라이언트 FPS | 양쪽 HUD 60 FPS (750×500) |

**4) 성능** (`measurePerf.js`, 로컬 봇 29명 + 플레이어 = 30명. update + render + gl.finish 동기 측정, 같은 카메라, 1366×768):

| 품질 | legacy 평균 / p95 | GLB 평균 / p95 (최종) | 드로우콜 legacy → GLB | 삼각형 legacy → GLB | VRAM legacy → GLB |
|---|---|---|---|---|---|
| low | 9.08 / 12.3 ms | 8.83 / 11.8 ms | 84 → 84 | 62.9k → 40.6k | 32 → 47 MB |
| medium | 11.63 / 16.2 ms | 10.99 / 15.0 ms | 131 → 131 | 150.8k → 148.7k | 53 → 67 MB |
| high | 14.03 / 18.4 ms | 14.17 / 18.3 ms | 261 → 245 | 391.9k → 457.2k | 71 → 86 MB |

- 프레임 시간은 legacy와 **같은 수준**이다(측정 편차 ±2ms). medium p95 15.0ms로 60fps 예산(16.7ms) 안이다.
- GLB 첫 측정에서 high가 평균 33ms, p95 112ms였다. 같은 페이지에서 다시 재면 11.9–14.3ms였다. **처음 쓰는 high 셰이더 조합(스킨 + 텍스처 + SSAO)의 컴파일 히치**로 판단한다. 실제 플레이에서도 처음 한 번 생길 수 있으므로 Gate 6에서 셰이더 워밍업을 넣는다.
- high에서 요소별 비용: 캐릭터 30명 전체 약 5ms, 캐릭터 그림자 약 2.3ms, 탱크 유리 약 1ms.
- VRAM +15MB는 GLB 텍스처(1024×512 3장 + 오렌지 2장, 밉맵 포함)다. Gate 6에서 KTX2 압축 대상이다.
- **아직 측정하지 않은 것:**
  - 실제 온라인 30명이 한 화면에 모인 장면. 이번 30인 측정은 로컬 봇이다.
  - 다른 GPU
  - 5분 이상 장시간 측정
  - 모두 Gate 6에서 한다.

**5) 회귀** (2026-11-06 10:04): typecheck, lint, build PASS. 테스트 **122/122 PASS**(기존 109 + 신규 13). `npm run avatar:validate` PASS. 빌드 결과물 `dist/assets/{characters,clothes,weapons}`에 GLB가 포함된다(dist 전체 3.2MB).

### 남은 결함·한계

1. 처음 쓰는 셰이더 조합의 컴파일 히치(위 4). Gate 6에서 워밍업한다.
2. 아바타별 개인화(seed → 피부, 헤어 색)는 GLB에 아직 반영하지 않았다. legacy는 seed로 피부 5종을 썼다. Gate 3 의상·팔레트 시스템에서 다룬다.
3. 서버 간헐 테스트 실패(Gate 0 기록)는 이번 전체 실행에서는 통과했다. 별도 작업으로 남긴다.
4. Gate 1 한계(신발 밑창, 표정 전환, 키프레임 애니메이션)는 그대로 Gate 3·4 범위다.

### 다음 GATE 진입 가능 여부

통과했다. 오프라인·온라인 렌더, 판정·페인트·네트워크 불변, 폴백, 누수 없음, 성능 동등을 모두 확인했다. Gate 3(의상 시스템)으로 진행할 수 있다.
