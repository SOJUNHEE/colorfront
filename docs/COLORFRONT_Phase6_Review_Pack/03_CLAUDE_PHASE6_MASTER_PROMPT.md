# VS Code Claude 전달용 통합 프롬프트 — COLORFRONT Phase 6

당신은 COLORFRONT의 시니어 게임 아트 테크니컬 디렉터이자 PlayCanvas/TypeScript 엔지니어, Blender Python 아티스트, 애니메이션 리거, 그래픽 성능 엔지니어다. 나는 1인 개발자이며 3D 전문 모델러가 아니다. **말로만 설명하지 말고, 실제 저장소와 프로젝트 파일을 분석하고, 동작하는 파일·변경 코드·테스트·스크린샷을 단계별로 남겨라.**

## 0. 절대적인 목표와 제약

- 목표: COLORFRONT를 상용 스타일라이즈드 페인트 TPS처럼 매력적인 3D 화면으로 발전시킨다. 현대적인 색 대비·젤 페인트·대비감 있는 애니메이션을 달성하되, 닌텐도 스플래툰의 **캐릭터·고유 헤어·무기·맵·로고·UI·효과 구성 등 보호되는 시각적 표현은 복제하지 말 것**. 오리지널 네온 항만 페인트 배달원 정체성을 수립한다.
- 게임: PlayCanvas 2.23.x + TypeScript + Vite + Colyseus 0.18, 서버 권위형 30명 15v15.
- 변경 금지: 서버 히트 판정(키 1.65m, 반지름 0.4m, 눈높이 1.45m), 맵 충돌 및 판정 면/지형/스폰/경기 동선, 페인트 0.5m 격자 좌표 및 서버 소유권·동기화, 네트워크 프로토콜과 기존 게임 규칙(단, 나중에 승인된 순수 외형 ID 복제만 작은 별도 변경 가능).
- 기존 게임 코드/디자인의 정상 작동과 동기화를 유지하면서 **시각 아바타·시각 맵·애니메이션·의상 커스터마이징 기능만 최소 범위로 교체**한다. 코드 전체 재작성/게임 엔진 전환 금지.
- 장비: Intel 내장 GPU, 1366×768, 60fps 목표. **최대 30명 동시 화면 노출**을 별도로 검증한다. 임시 스크린샷의 FPS 숫자만 보고 완료하지 않는다.
- 새로운 외부 에셋은 라이선스 증빙(URL/작성일/원본 파일/상업적 이용 조건)을 파일별로 기록하고, 마스터 `.blend`와 배포 GLB를 모두 보관한다. 임의 웹 이미지의 3D 변환/타사 게임 캐릭터 이미지→3D를 수행하지 않는다.
- 모델이 없거나 Blender/Mixamo 실행 환경이 없다면 **실제 GLB가 생성됐다고 주장하지 말 것**. 가능한 순수 코드/지시서·스켈레톤 규격·모델 제작 스크립트를 제공하고 검증 가능 여부와 차단 요인을 기록한다. 개별 단계는 완료 증거가 있어야 다음으로 넘어간다.
- `fps.zip`의 `docs/GRAPHICS_REPORT.md`는 Phase 3 이전 문서다. `docs/PHASE3_REPORT.md`와 현재 코드를 최신 기준으로 한다.

## 1. 실제 읽을 파일 (먼저 확인하고 적기)

```
COLORFRONT_GDD_v1.md                   # 4.1, 9, Phase 6, 검증 기준
colorfront/docs/GRAPHICS_REPORT.md     # 과거 그래픽 수치와 미해결 과제
colorfront/docs/PHASE3_REPORT.md       # 최근 네트워크 구현·제한
colorfront/apps/client/src/player/CharacterRig.ts
colorfront/apps/client/src/game/Game.ts
colorfront/apps/client/src/network/OnlineSession.ts
colorfront/apps/client/src/scenes/ArenaBuilder.ts
colorfront/apps/client/src/render/{MeshBatch,Materials,ProceduralTextures,Environment,PostEffects}.ts
colorfront/apps/client/src/paint/{PaintRenderer,PaintEffects}.ts
colorfront/apps/client/src/settings/settings.ts
colorfront/apps/client/src/ui/{Hud,SettingsMenu}.ts
colorfront/packages/shared/src/map/{neonTerminal,neonTerminalDecor,decor}.ts
colorfront/apps/server/src/rooms/MatchRoom.ts
colorfront/tests/{unit,integration,visual}/
colorfront/docs/screenshots/after/{01-character-front,02-character-back,03-map-overview,04-central-plaza,10-thirty-players-load,11-gameplay-hud,anim-1-idle-walk-run-dash-jump-land,anim-2-aim-fire-reload-hit-respawn-victory}.png
```

작업 전 `git status`, 현 상태 브랜치, `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`를 보고한다. 사용자 파일/다른 프로젝트 삭제 금지. 불필요한 패키지 추가 금지. 기존 테스트가 실패하면 원인 추적 후 기록한다. 파일명이나 함수명은 추측하지 말고 반드시 실제 소스에서 찾는다.

## GATE 0 — 회귀 기준 고정 / 빌드 기준 / 모델 교체 어댑터 설계

**구현 내용**

1. 현 상태의 코드 의존성/신호 흐름 `RigPose` → `CharacterRig` → `muzzle`/PaintEffects와 `Game.ts` Actor 생성 경로(로컬/온라인)를 정리한다.
2. `CharacterRig`의 공개 계약은 계속 유지한다: `root`, `update(dt, RigPose, cameraDistance, lodDistance)`, `setTeam`, `setVisible`, `setLod`, `currentLod`, `muzzle(Vec3)`, `fired`, `hit`, `respawned`, `celebrate`.
3. `AvatarRenderer`/`AvatarRigAdapter` 같은 **작은 인터페이스+어댑터 계층**을 설계하고, 현재 `CharacterRig`를 legacy fallback으로 동작시킨다.
4. GLB asynchronous load 실패, 텍스처 실패, 네트워크 늦은 입장에도 게임 루프가 멈추지 않게 설계한다. 현재 캐릭터를 바로 삭제하지 않는다.
5. 고정 스크린샷/구간, 아바타 1명과 30명, 서버 동기화, 페인트 테스트의 A/B 측정 체계를 정리한다. 셀 중심 이외에 경계·다리 상하까지 포함한다.
6. 30명 네트워크 봇 부하와 30명 **같은 화면 렌더링**은 별개라고 명시한다.

**산출물**: 변경 요약, API 다이어그램, 리스크/의존성 표, 기존/새 렌더러 폴백 인터페이스, baseline 사진과 성능 원본 로그, `docs/PHASE6_LOG.md`의 첫 섹션.

**검증**: 기존 명령 통과. 로컬/온라인 1v1에서 입력·총구 효과·도색 해시와 스폰 유지. baseline 사진 파일 존재. 모든 테스트 결과 실제 실행 시각/환경 기록.

**금지**: `packages/shared/src/simulation`, `paint`, `combat` 게임 규칙 변경, 맵 충돌/스폰 편집, 기존 `CharacterRig` 일괄 삭제, 아직 없는 GLB가 로딩된 것처럼 가짜 성공 보고.

**Gate**: 여기까지 확인된 경우에만 아래 GATE 1을 시작.

## GATE 1 — 오리지널 마스터 3D 캐릭터 모델을 실제로 만든다

**미술 지침**

- 주제: 'COLORFRONT Neon Courier'. 이동과 장비에 특화된 미래형 도시 작업복, 4등신 안팎, 둥글지만 운동감 있는 실루엣. 머리 크기/손/신발 크기로 개성을 만들고 몸통·다리·무릎이 부드럽게 이어진다.
- *고유성*: 유명 게임의 오징어/문어 촉수 머리·신체 형태, 특정 눈/무기/장비/로고·브랜드를 재현하지 않는다. 머리는 짧은 비대칭 스포츠 헤어, 천/고무/섬유 기하로 고유한 형태를 디자인.
- 고품질 외형이 가장 중요하다. 프리미티브 수를 91개→150개로 늘린 모델은 **불합격**. Blender의 편집 가능한 연결 메시/서브디비전/수작업 조형+리토폴로지 또는 재현 가능한 Python 스크립트로 실제 사람형 곡면을 만든다.
- `02_ART_WARDROBE_SPEC.md`의 비율/슬롯/축/본/공간/의상 마스크 규격을 따른다.
- A-pose/정면·측면·후면, 실제 게임카메라 거리 스크린샷을 보여 사용자 확인을 받는다.

**리깅 지침**

- Blender `.blend` 원본과 최종 `.glb`를 같이 남긴다. 런타임 Y-up -Z 앞, 1.65m, 발 y=0. Blender→glTF 좌표계 변환을 실제 재임포트해 검증.
- 현재 `CharacterRig.ts` 22본 이름과 가능한 계층 유지. L/R 방향, rest pose, inverse bind matrix, 바인딩 후 전체 12개 포즈 테스트. 부드러운 관절: 2~4 bone influences/vertex. 머리·탱크 rigid part는 제한적으로 허용.
- 구체적인 눈꺼풀/표정 3~4개 형태 키 혹은 간단한 얼굴 시스템, 앉는 동작이 없어도 무릎/팔꿈치와 옷이 클리핑 안 됨.
- 첫 조형은 base + 의상 top 1 + shoes 1 + 헤어 1 + 탱크 1 + 총 1개로 제한. 다른 옷은 Gate 3에서.

**산출물**: 원본 `.blend`, 최적화된 rigged GLB(LOD0, LOD1, LOD2), 오리지널 컨셉/정면·후면·측면 이미지, 삼각형/재질/텍스처/본 사용량 보고서, 소스 및 라이선스 추적표. 도구를 실제 실행할 수 없으면 **자체 제작 Blender Python 스크립트와 실행/검수 절차**, 실패 근거를 제출.

**검증**: glTF 파싱/스킨/축/투명 탱크/총구/애니메이션 재생. 90°, 180° 회전 후 관절 자연스러움; 대시·조준·팔꿈치 근접 캡처. 전통적 블록인형이 아닌지 이미지 기준(실루엣/관절 분할/코너 하이라이트)으로 합격 판정. 한 캐릭터 총 tris 5~8k LOD0, 1.8~3k LOD1, 0.5~1.2k LOD2 초기 목표. 최적화 전 원본은 더 클 수 있음.

**금지**: AI가 생성한 대략적인 고밀도 무정형 메시를 그대로 GLB 생산품이라고 납품, 타사 캐릭터 1:1 재현, Mixamo 리깅을 자체 22본과 동일하다고 가정, 본 이름만 바꾸고 실제 retarget 미검증.

**Gate**: 모델을 실제 PlayCanvas 독립 preview에 띄워 세 각도와 애니메이션이 검수되기 전에는 30명 게임 코드에 통합 금지.

## GATE 2 — PlayCanvas GLB 캐릭터 실제 교체 / 기존 기능 불변

**구현**

1. PlayCanvas `Asset` type `container` 및 `instantiateRenderEntity`로 GLB 로드, `anim` 사용. 현재 빌드(`AppBase`)에 필요한 asset/anim/render handler가 초기화되는지 확인.
2. 공용 `Mesh`/`Skin`/Texture/Material asset cache와 캐릭터별 skeleton `SkinInstance`/pose를 분리. ID·머리스타일마다 새 vertex/index buffers를 생성하는 현재 방식을 그대로 복제하지 않는다.
3. `Game.ts:217,289` actor 경로를 작은 팩토리로 연결하고, `Game.ts:544-565` pose 계약은 유지. 모든 Actor가 GLB ready 이전에도 legacy로 안전하게 그려진다. 타입 보장 및 리소스 destroy 처리.
4. `setTeam`은 공유 vertex buffer 수정 금지. 팀 색 마스크 기반 머티리얼 파라미터/아틀라스/작은 팀별 재질 캐시 설계. 30명 각각 수십 개 Material 생성 금지.
5. `muzzle`, `gun`, `liquid` anchor를 원본 총구와 동일하게 보정한다. 소스 `muzzle` 현재 로컬 좌표 `(0,0.03,-0.64)`는 원본 기준이므로 새 모델은 실제 muzzle socket/보정행렬 사용.
6. 각 품질 프로필과 화면 점유에 따른 LOD. 저사양에서는 그림자/보조본/표정/헤어 흔들림을 거리별로 억제.

**산출물**: 실제 GLB 렌더러 TS, 모델 로더·캐시, 기존 API adapter, 폴백, 로드·해제 테스트, 설정 호환과 전후 스크린샷.

**검증**: 오프라인/실제 온라인 2브라우저 모두 렌더. 똑같은 shot/paint 이벤트, hitbox와 muzzle 오차, 3가지 LOD 교체 안정성, 30인 장면. typecheck/test/lint/build 통과, FPS p95 등 원본 로그. GLB 없으면 Gate 2 미완료로 표시.

**금지**: PlayCanvas 로컬 예제만 띄운 뒤 실제 게임 적용 완료 주장, GPU 스킨 포즈 30명 모두 같은 인스턴스 공유, 서버 좌표 이동·총구 물리 히트박스 변경, 게임 상태를 애니메이션 root motion에 종속시킴.

## GATE 3 — 아바타 옷 입히기(게임 내 커스터마이징)

**먼저 1개 슬롯 end-to-end proof**

1. `hair`, `headwear`, `top`, `bottom`, `shoes`, `back`, `weaponSkin` 슬롯·allowlisted ID·호환성·기본 장비·숨김 바디 영역을 정의한다. `04_WARDROBE_CATALOG_EXAMPLE.json`을 실제 자산으로 매핑하되 예시 URL을 존재한다고 간주하지 않는다.
2. **첫 번째는 상의(top) 2벌 교체 + 헤어 2종**을 실제 엔진에서 구현: 스킨드 상의는 같은 Skeleton+bind pose, 머리는 head socket. 원형 바디 상체를 hide하여 클리핑 금지. 새로운 상의를 입혀도 애니메이션/색상/LOD가 정상.
3. 아이템별 render entity를 풀링/재사용하고 착용 해제 시 보조 오브젝트를 제거. 자주 갈아입어도 GPU 메모리/이벤트 핸들러 증가 금지.
4. 의상 재료는 가능한 한 공통 아틀라스와 팀색 mask. 모자/머리는 headwear와 겹칠 수 있으므로 compatibility/hide region 처리.
5. 등 탱크 `back`은 게임 성능·정보 기능이 유지되어야 함. 탱크 수위, 팀색, 총구, 손 위치는 변하지 않아야 하고 모든 상의에서 팩이 몸을 관통하면 안 됨.
6. SPA 메뉴 안에 **`아바타 꾸미기` 화면**: 3D 회전/확대·축소, 아이템 슬롯 버튼, 장착/해제, 미리보기, 초기화, localStorage 저장. 한국어 라벨, 키보드/마우스 동작, 모바일 최소 레이아웃도 확인. 기존 UI 톤 유지.
7. 처음에는 **로컬 시각 설정**으로 완성. 온라인 외형 공유는 Gate 3-B 별도 작업: `MatchRoom`에서 ID만 검증해 복제하고 신규 입장/재접속시 올바른 외형 적용. 서버의 히트박스, 점수, 이동, paint 코드 영향 0. 모든 필드에 호환 기본값.
8. 다른 캐릭터의 30종 조합과 스킨/아틀라스/가려짐 성능 측정.

**산출물**: `AvatarAppearance` 타입, catalogue+validator, AvatarFactory/equip/unequip, AvatarPreviewScene 및 UI, 의상 GLB/Blender 원본, 기본 코디 최소 3개, API/자산 사용권 문서, 스크린샷 3종(상의A/상의B/모자·헤어).

**검증**: 다른 상의로 교체 시 어깨/팔꿈치 변형, 전후면, 총/탱크 간섭, 재접속·입장/폴백, 30인 의상 조합. 외형 ID 주입 시 validator reject. 코드의 기본값으로 이전 사용자/서버와 호환. 저장/리셋 잘 됨. 20회 연속 옷 교체 후 GPU memory/mesh instance 카운트 누수 없는지 확인.

**금지**: 옷을 본 위치에 비스킨으로 얹어 놓고 '입었다'고 주장, 모든 옷을 각각 별도 전체 캐릭터 GLB로 재로딩, 의상에 공격/이동 보너스 부여, 사용자 임의 URL을 원격으로 로드, 서버 히트 판정 변경.

## GATE 4 — 애니메이션 클립 + 조준 IK + 표정/세컨더리

**구현**

1. Blend가 가능한 GLB 키프레임 클립/PlayCanvas `anim` state graph로 기초 동작을 만들고 12종 현재 상태를 전부 유지. `Idle`, `Walk`, `Run`, `Dash`, `Jump`, `Land`, `Aim`, `Fire`, `Reload`, `Hit`, `Respawn`, `Victory`와 별도 Strafe L/R, JumpStart/Loop는 우선순위에 따라 확장.
2. 허리/다리 locomotion clip + 상체 aim mask 또는 additive yaw/pitch + 마지막 두 팔 2본 IK. 총과 손잡이 일치. 공중/대시 중 사격과 재장전이 포즈를 깨지 않게 우선순위 정의.
3. 준비동작/멈춤/착지 압축·반발 등 실제 '몸의 무게'를 연출. 3D 실루엣이 게임카메라 거리에서 구별되게.
4. 메쉬 움직임은 시각만. 서버 이동에 root motion 덮어쓰기 금지. 현재 `RigPose` 입력에서 속도/접지/대시/재장전/탄약을 파생.
5. 원거리 인물은 facial blendshape/IK/보조 흔들림을 줄여 비용을 보호. 저사양에서도 전투 의미 동작은 보이도록.

**산출물**: 애니메이션 GLB 클립/Blender Actions, 상태그래프, blend/IK adapter, 비교 GIF/동영상 또는 프레임 시트, footslide/check 자료.

**검증**: 고정 시퀀스 12종, `walk→run→jump→land→aim→fire→reload→dash` 끊김, 뒤로 걷기/측면이동, 손·총 정렬, fps p95. 같은 애니메이션 화면에서 이전보다 실루엣 차이·예비동작이 확인되어야 함.

**금지**: 코드 사인파를 이름만 `AnimClip`으로 감싼 가짜 키프레임, 애니메이션 재생 때문에 서버 위치 변경, 모든 원격 플레이어에 매 프레임 무거운 복잡 IK 실행.

## GATE 5 — 네온 터미널 VisualSkin/환경 디테일

**구현 우선순위**

1. `ArenaBuilder`의 shared collision solid를 소비하는 **별도 `ArenaVisualSkin`** 모듈 설계. 원본 collision world는 유지. `visual-only` 장식만 렌더. 3가지 랜드마크를 먼저 만들어 스크린샷에서 위치감을 강화한다.
2. 골판 컨테이너 표면+돌출 코너 프레임, 문틀/배관/드레인/연결부, 옥상 장비 등 **모듈 키트** 제작. 베벨은 시각 trim으로 도색/동선을 가리지 않는 곳에만.
3. 대형 바닥 타일의 반복은 알베도/노멀/거칠기 변주·페인트 셰이더 호환 방식으로 개선. 불투명 데칼이 도색을 가리거나 미끄러지는 z-fighting 금지.
4. 화면 가까운 '비전투 장애물이 아닌' 장식 밀도 강화. 의도치 않은 통행 불가 착시 금지. 기존 `decorViolations` 통과, 스폰/카메라/조준 궤적 확인.
5. 정적 배경 로우폴리·라이트맵/AO는 마지막에. low에서는 동적 네온 광원과 SSAO를 무리하게 늘리지 않는다. batching / culling / LOD / shared materials 유지.

**산출물**: 모듈 GLB/`.blend` 5~10종 또는 미관 수준이 검증된 절차적 모듈, 아틀라스, 레벨 스킨 코드, 확대/동일구도 전후 이미지, Batcher/LOD 측정 기록.

**검증**: `docs/screenshots/after/04-central-plaza.png`, `06-bridge-and-highground.png`, `11-gameplay-hud.png` 동일 시점 A/B. `decorViolations`, 충돌/페인트 해시, 페인트 셀 중심·경계·다리·경사로 정합성. GPU frame/ms·drawcalls 비교.

**금지**: shared 맵 지오메트리 변경, 페인트 셰이더에 무분별한 재질 덮어씌우기, 통과 가능한 길에 충돌 없는 막힌 문/상자 배치, drawcall 100건 증가하는 소품 수백 개.

## GATE 6 — Intel 내장 GPU 30인 성능/품질 마감

**예산(확정치가 아닌 최초 타깃)**

- 캐릭터 1명(착용 의상+머리+장비 포함) LOD0 5~8k / LOD1 1.8~3k / LOD2 0.5~1.2k triangles.
- 가급적 한 플레이어 near 기준 불투명 주요 아바타 패스 2~3 drawcalls, 재질 공통화. 탱크 투명 패스 비용은 별도 측정.
- 텍스처 atlas 중심 1024², 보조 512²~1024². KTX2/BasisU와 Draco는 사용 중 PlayCanvas 2.23.x loader 지원/품질/부팅 시간 검증 후 도입. 무조건 둘 다 강제하지 않는다.
- 1366×768/Intel iGPU/30명 **온라인에서 동일 화면 중앙 밀집**, low·medium·high 및 50/75/100% 스케일로 *실제 플레이 루프* p50/p95, draw call, triangles, JS heap, VRAM 추정, shader compilation hitches, 입장/재접속 프레임 스파이크 측정.
- medium에서 p95 16.7ms 이하를 1차 통과 목표, 여유 목표 15ms. Intel 내장 GPU 모델(정확한 SKU)을 기록. 안 되면 quality fallback/화면 스케일/LOD/그림자 우선 최적화 후 결과 보고. 수치 조작 금지.
- 팀별 최다 15명 전투 중 paint grid consistency와 서버 해시, spawn/시각 모델 범위, camera clip을 검증.

**산출물**: 전/후 동일 머신 성능 비교표, GPU/CPU 분리(가능할 때), 30인 밀집 실제 장면 캡처·녹화, 고질적인 프레임 스파이크 원인별 조치표, 기존 GDD 기능/플레이 테스트 회귀 결과, `docs/PHASE6_REPORT.md`.

**검증**: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, 2브라우저 페인트/재접속, 30봇 네트워크 + 실제 표시 30명, 모든 품질 프레임 로그. 성능 실패 시 명시적 '미통과' 표시하고 초과 원인을 남길 것.

**금지**: 콘솔에서 한순간 60fps 찍힌 것을 성공으로 기록, 로컬 봇 30명을 30명 온라인 테스트와 동일하다고 주장, p95 미기록, 서버 판정 바꾸기, 미검증 라이선스 에셋 제출.

## 단계별 보고서 형식(매번 반드시)

```
진행 GATE: 
목적 / 비교 기준: 
변경 파일(정확한 경로): 
만든 에셋(실존 경로 + 라이선스 + Blender 원본): 
변경 이유: 
동작 영상/스크린샷(기존과 같은 카메라): 
기능 회귀 확인(오프라인/온라인/페인트): 
테스트: typecheck / test / lint / build (PASS/FAIL/미실행 구분)
성능: 장비/해상도/설정/명시된 측정법, before/after p50,p95, drawcalls, tris, VRAM
남은 결함(재현 경로): 
완료/미완료 근거: 
다음 GATE 진입 가능 여부(근거): 
```

**작업 첫 응답에서는 GATE 0의 코드 감사와 GATE 1의 매우 구체적인 제작 계획을 제출하라. 가능하다면 첫 실행 산출물까지 만들되, 각 단계의 게이트를 통과하지 않은 상태로 다음 단계까지 '완료'라고 보고하지 말 것. 각 게이트가 끝나면 실제 파일/증거를 남기고 계속 진행하라.**
