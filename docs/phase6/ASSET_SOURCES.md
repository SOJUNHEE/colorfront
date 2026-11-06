# Phase 6 에셋 출처·라이선스 추적표

작성: 2026-11-05 · 대상: Gate 1에서 만든 모든 3D 에셋과 텍스처

## 요약

- **외부 3D 모델, 텍스처, 이미지, 애니메이션: 0개.** Mixamo, Meshy, Tripo, Kenney, Quaternius 등 외부 에셋은 쓰지 않았다.
- 모든 형상, 리그, 웨이트, 텍스처(팔레트, 얼굴 표정, 팀 엠블럼)는 `assets-src/blender/scripts/build_courier.py`가 처음부터 생성한다. 이 스크립트가 원본이다.
- 같은 스크립트를 다시 실행하면 같은 결과물이 나온다(재현 가능).
- 레퍼런스 게임의 캐릭터, 헤어 실루엣, 귀·촉수, 눈 마스크 띠, 무기, 로고는 쓰지 않았다.
  - 헤어: 비대칭 사이드 스우프, 카울릭, 스포츠 헤드밴드
  - 장비: 사선 아치 프레임 탱크
  - 엠블럼: 블루는 사선 두 줄, 오렌지는 방패와 점
  - 모두 COLORFRONT 고유 디자인이다.

## 도구

| 도구 | 버전 | 출처 | 비고 |
|---|---|---|---|
| Blender (포터블) | 5.2.3 LTS, build e13b728c6880 | https://download.blender.org/release/Blender5.2/blender-5.2.3-windows-x64.zip | SHA-256 `723f08a4…c2dfb`이 공식 체크섬과 일치한다. `C:\Users\user\tools\`에 압축 해제했고, 시스템 설치는 하지 않았다. Blender로 만든 결과물은 GPL 적용 대상이 아니다. |

## 파일별

| 배포 파일 | 원본 | 라이선스 | 생성 방법 |
|---|---|---|---|
| `apps/client/public/assets/characters/courier_default_lod{0,1,2}.glb` | `assets-src/blender/colorfront_courier_master.blend` | 프로젝트 자체 제작 | `build_courier.py` |
| `apps/client/public/assets/characters/courier_base_lod{0,1,2}.glb` (부위별 베이스 몸체. LOD0에만 공용 텍스처 내장) | 위 `.blend` | 자체 제작 | 위와 같음 |
| `apps/client/public/assets/clothes/<item>_lod{0,1,2}.glb` (이미지 미포함). 헤어: sidepart·crew·ponytail·buzz / 모자: cap·beanie / 얼굴: goggles·glasses / 목: scarf·headphones / 상의: bomber·hardshell·tee·hoodie / 하의: cargo·short·jogger / 신발: runner·boots / 등: tank_standard·tank_twin | 위 `.blend` | 자체 제작 | `build_courier.py` |
| `apps/client/public/assets/characters/courier_anims.glb` (클립 16종: 스켈레톤 + glTF 애니메이션, 메시 없음) | `assets-src/blender/colorfront_courier_anims.blend` (클립별 Action) | 자체 제작 | `build_anims.py`. Blender에서 키프레임을 직접 저작했다. 클립 표: `assets-src/blender/anim_clips.json` |
| `apps/client/public/assets/weapons/{paint_rifle,weapon_shotgun,weapon_smg,weapon_sniper}_lod{0,1,2}.glb` | 위 `.blend` | 자체 제작 | 위와 같음. 실총 형상이 아닌 장난감풍 페인트 분사기 디자인 |
| `assets-src/blender/textures/courier_{atlas,emissive,orm}.png` (GLB에는 `courier_base_lod0.glb`에만 내장) | 같음 | 자체 제작 | numpy로 그린 절차적 텍스처. 아틀라스 1장에 피부 4톤·머리색 8·옷 색 4·팀 2색 팔레트 칸과 표정 4종 × 피부 4톤 얼굴 타일이 들어 있다(배치: `assets-src/blender/atlas_layout.json`) |
