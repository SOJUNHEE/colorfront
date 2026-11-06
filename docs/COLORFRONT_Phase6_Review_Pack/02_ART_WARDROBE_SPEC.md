# 2. COLORFRONT 아바타 아트 바이블·GLB 의상 시스템 계약

## 디자인 원칙: 'COLORFRONT / Neon Couriers'

장르상 팀 페인트 전투의 강한 가독성은 유지하지만, 다른 게임 캐릭터를 복제하지 않는 **도시형 페인트 배달원/도장 작업자** 정체성을 강조한다.

- **비율**: 키 1.65m(시각적 목표), 3.7~4.2등신. 둥글고 넓은 머리/짧은 목, 큰 장갑·운동화, 좁은 허리, 활동적인 발 자세. 피부/의상은 한 덩어리로 보이지 않도록 실루엣 재배치.
- **캐릭터 얼굴**: 손그림 같은 과장된 눈썹/눈꺼풀, 분리된 입(표정용 shape key). 눈 위치·비례·헤어/눈 색은 COLORFRONT 독자 설계. 표정은 '당당함/놀람/집중/기쁨'. 촉수/오징어 신체 요소 금지.
- **헤어**: 섬유/고무/패브릭 질감의 큼직한 3~5개 볼륨, 비대칭 모자 챙이나 스포츠 헤드밴드. 원뿔 7개 방사형 배열 금지. 바람·착지 시 보조본 1~3개 정도만 흔들림.
- **상체**: 짧은 레이어드 윈드브레이커, 비대칭 앞판, 광학 식별용 컬러 패치, 어깨/팔꿈치의 고무 패널. 팀색은 넓은 소매·어깨·탱크 액센트에서 읽혀야 함.
- **하체**: 넓은 무릎 부분, 반바지/팬츠 변형, 적당히 두꺼운 밑창, 몸통/다리 이음새 자연스럽게. 옷 고유 폴리곤은 실루엣 중심으로 배분.
- **장비**: 등 뒤 **사선형 아치 프레임 안 투명 수위창**이라는 고유 형태의 페인트 팩. 탱크 수위 = 권위 서버 탄약 비율. 소품은 장식이 아닌 게임 정보 기능 유지.
- **색**: 저채도 남색/그래파이트(#1C2533), 따뜻한 아이보리(#EEE8DB), 팀 블루(#2876F2)/코랄 오렌지(#FF6E35). 실제 컬러코드는 아트 제안값으로, 렌더링 후 대비 검수 필요.
- **팀 식별**: 색만 의존하지 말고 블루=사선 두 줄, 오렌지=점·방패 패턴처럼 서로 다른 도형/패턴 보조. 적/아군 식별은 HUD/게임 기존 로직 우선.
- **유사 디자인 배제**: Nintendo의 고유 캐릭터/전용 헤어 실루엣/변신형태/특정 무기 디자인/브랜드/맵 구성/아이콘/로고/UI의 보호되는 표현은 사용하지 않는다.

### 반드시 3가지 구도로 승인

1. 정면 T/A 포즈에서 머리-몸통-다리 비율, 관절, 옷 분리 확인
2. 뒷면에서 탱크/의상 착용 보이고 팀색 식별
3. 실제 `11-gameplay-hud.png` 같은 카메라 거리에서 1366×768 스크린샷: 장비 정보와 팀색이 보이는지 확인

## 필수 제작 산출물

```text
assets-src/
  blender/
    colorfront_base_avatar.blend
    colorfront_apparel_master.blend
    scripts/
      export_avatar.py
      validate_avatar.py
  art/
    colorfront_character_front_back_side.png    # 참고용 오리지널 컨셉 시트
    wardrobe_style_guide.png
apps/client/public/assets/
  characters/
    courier_base_lod0.glb
    courier_base_lod1.glb
    courier_base_lod2.glb
  clothes/
    top_bomber.glb
    top_hardshell.glb
    top_utility.glb
    bottom_cargo.glb
    bottom_short.glb
    shoes_runner.glb
    shoes_grip.glb
    hair_sidepart.glb
    hair_swoop.glb
    hair_crew.glb
    headwear_cap.glb
    headwear_visor.glb
    back_tank_standard.glb
  weapons/
    paint_rifle.glb
```

위는 **만들어야 할 미래 목표 파일명**이다. 지금 프로젝트에 존재하는 것으로 간주하면 안 된다. 첫 승인에는 **base + top 1 + shoes 1 + hair 1 + back tank 1 + gun 1**만 구현해서 속도/형상 검증 후 품목을 늘린다.

## 좌표·본·메시 계약

- glTF 및 런타임: **Y-up, -Z 앞, 단위 m, 발바닥 접지 y=0**, 캐릭터 높이 1.65m 근사. Blender의 Z-up → glTF 변환은 **내보낸 실제 GLB**를 PlayCanvas로 재임포트해 검증. 3D 편집기 화면만 믿지 말 것.
- 본 이름, 상하 구조는 현재 `apps/client/src/player/CharacterRig.ts` 26~50행의 22본 계약을 기본으로 함:
  `root -> hips -> spine -> chest -> neck -> head`, `chest -> shoulderL/R -> upperArmL/R -> foreArmL/R -> handL/R`, `hips -> thighL/R -> shinL/R -> footL/R`, `chest -> gun`, `chest -> liquid`.
- **오른쪽/왼쪽 이름은 현재 소스와 동일하게 유지**. 파일 소스의 X 좌표 부호와 `L/R` 표기(소스는 `shoulderL`이 x=-0.17임)를 반드시 확인. 임의로 바꾸지 말고 런타임 동작으로 검증.
- 본의 위치/로컬축/이름을 맞췄다는 것만으로 호환이 완료되지 않음. `inverseBindMatrices`, rest transform, animation, GLB 노드 계층을 함께 검증.
- **몸/소매/바지/신발**은 공통 본에 바인딩된 스킨 메시. 목·어깨·팔꿈치·무릎은 인접 본 2~4개에 가중치 분포. 동일해 보이는 옷도 무조건 rigid attach 하지 말 것.
- **모자·헤드셋·안경**은 head socket의 경량 rigid attachment 가능. **등 탱크**는 chest socket에 붙이고 수위 메시(또는 셰이더)만 ammo로 변화. **총**은 gun socket에 고정, 총구의 시각 효과 위치 정확히 검증.
- 각 의상 메시는 동일 기준 바디/본 배열과 스킨 transform에 기반. 아이템 GLB 자체 Armature와 플레이어 Armature 두 벌이 중복되지 않도록 런타임에서 명확한 binding/retarget 로직 도입.
- **의상 관통 방지**: body-under-top 등 구역별 피부/바디 하위 메시 숨기기 혹은 mask. 성능상 투명 마스크보다 mesh-group hide가 유리한지 측정. 품목 교체 때 몸통 원본이 겉으로 비치지 않아야 함.
- **리깅/3D 리소스 공유**: 메시는 같은 품목을 착용한 캐릭터들 사이 공유 가능, `SkinInstance`는 각 캐릭터별 독립. 각 캐릭터가 본과 애니메이션 포즈를 다르게 재생해야 하므로 서로의 `SkinInstance` 공유 금지.
- 파일별 검증: height, bounds, transformed rest pose, UV 섬/여백, 4 weights, 겹침, 텍스처 및 본 수, 삼각형 LOD 예산, 초기 포즈, 샘플 애니메이션, 라이선스 기록.

## 의상 시스템(플레이어 커스터마이징)

### 카테고리 및 착용 우선순위

| Slot | 초기 제공 | 런타임 방식 | 기본 가려짐 |
|---|---|---|---|
| hair | 3 스타일 | head bone 붙이기 또는 저비용 보조본 | headwear 착용 시 일부 hair mesh hide |
| headwear | 캡/바이저/없음 | head socket attach | 헤어 외곽 일부 hide |
| top | 봄버/하드셸/유틸리티 | 공통 skeleton skinned mesh | base torso + upper arms |
| bottom | 카고/쇼츠 | 공통 skeleton skinned mesh | base hips + thighs |
| shoes | 러너/그립 | footL/footR 및 shin에 바인딩 | base feet |
| back | 기본 탱크 | chest socket + liquid | 변경해도 탱크 수위의 판독성 고정 |
| weaponSkin | 기본 라이플 외형 | gun socket, **사격 원점/판정 불변** | 해당 외형만 변경 |

### 장착 데이터는 순수 데이터로 관리

- `AvatarAppearance`: `{version, hairId, headwearId, topId, bottomId, shoesId, backId, weaponSkinId, colorVariant}`. 임의 URL·스크립트·외부 자산 경로를 사용자가 직접 넣지 못하게 **카탈로그 ID allowlist**로 검증.
- `WardrobeCatalog`: slot/assetURL/LOD/hiddenBodyRegions/socket/compatibleRig/paletteMask/licenseSource/checksum 식별자. 검증 및 배포를 위한 메타데이터를 가진다.
- `AvatarFactory`: GLB 사전 로드/캐시(동일 메모리 리소스 공유) → `SkinnedAvatarView` 생성 → `attachOutfit`/`swapOutfit` → 이전 장비 객체 해제 → team tint와 텍스처 mask 적용.
- `AvatarRigAdapter`: 기존 `CharacterRig`와 호환되는 공개 API (`root`, `update(dt, pose, dist, lodDist)`, `setVisible`, `setTeam`, `muzzle`, `fired`, `hit`, `respawned`, `celebrate`, `currentLod`, `setLod`) 유지. 로딩 실패하면 legacy 캐릭터로 **실패 없이 폴백**.
- `AvatarPreviewScene`: 메뉴용 별도 3D 미리보기. 회전, 줌, 착용 슬롯, 기본색/팀색 선택, 초기화, 저장. 게임 서버를 실행하지 않아도 로컬 화면에서 사용 가능. 사용자 설정은 우선 `localStorage`에 유효한 카탈로그 ID만 저장.
- 멀티플레이에 적용할 경우 **서버가 검증된 ID와 외형 데이터만 복제**. 서버 공격/도색/이동/스폰/히트 판정은 변화하지 않음. 성능과 UI 승인 후 별도의 작은 PR에서 `MatchRoom`의 외형 필드만 추가하며 네트워크 테스트 확장.
- 아이템은 **외형만** 변경하며 속도·데미지·탄약·히트박스·가시성에 게임 유리함이 없어야 함(크기 편차 제한). 상태가 중요한 팀색·탱크 수위를 완전히 가리는 장비 금지.
- 30명이 모두 다른 의상을 착용해도 CPU/GPU 자원 사용 한계 설정: 품목별 메시·아틀라스 공유, 로드된 품목 캐시, 원거리 의상 세부 메시 통합/숨김, 리소스 cleanup 및 스트레스 테스트.

## 애니메이션 설계

- `Anim` component + GLB `AnimTrack`/state graph(PlayCanvas 공식 방식). 신규 파일에서 구현 후 기존 수학적 포즈를 fallback으로 남김.
- **Base locomotion**: idle / walk / run / strafe L/R / dash / jump start-loop / land / hit / reload / victory / respawn. 초기에는 8개 클립으로 최소 기능을 검증, 이후 확장.
- **Upper body**: aim yaw/pitch additive 또는 별도 마스크 레이어, fire recoil, gun pose. IK는 양손을 총 그립 socket에 붙이는 단계에서 적용. **클립 + 본 회전**이 충돌하지 않도록 frame 적용 순서 정의: ① anim sampling → ② locomotion blending → ③ aim offset → ④ arm IK → ⑤ recoil, facial + hair secondary → ⑥ muzzle/tank update.
- 키프레임은 *in-place* 이동, 실제 위치는 `RigPose.x/y/z`(서버·예측)에 따름. Root motion이 서버 이동을 덮어쓰면 실패.
- 액션 캔슬, crouch 등 없는 상태를 꾸며 넣지 말고 현재 게임 이벤트를 사용.
- 탱크 액체/탄약 시각 연출은 interpolation 가능하지만 사실적인 용량 표시/방향을 해치지 않을 것.

## 맵 모듈

- `ArenaBuilder`의 충돌 솔리드는 건드리지 않고 **VisualSkinLayer** 별도 추가. 바닥 paintable surface 위에 임의 불투명 메쉬 덮으면 페인트를 가리므로 금지.
- 씬 구조 `visual/{facade-kit,trim,signage,ground-detail,far-background}`. 파사드/크레인은 GLB 또는 절차적 메시로 공급, 먼 배경은 unlit/atlas, 배치/LOD·재질 batching.
- 장식은 `decorViolations` 테스트에서 허용된 위치만. 시각 장식에 충돌이 없으므로 허공에 떠 있는 난간/통행 불가 크레이트를 동선에 둘 수 없음.
- 2D 그래픽/텍스처에 불과한 균열/타이어 자국 등은 paint occupancy shader와 **양립하는 밑색/마스킹 경로**로 적용.
