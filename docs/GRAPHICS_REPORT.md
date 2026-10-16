# 그래픽 고도화 보고서

작성일: 2026-10-16 · 관련 문서: [GRAPHICS_REFERENCE.md](GRAPHICS_REFERENCE.md), [DECISIONS.md](DECISIONS.md) D-009~D-014

> **먼저 밝혀 둘 사실.** 지시서는 "기존 Phase 3~7을 이어가며"라고 했지만, 실제로 완료된 것은 **Phase 1~2(오프라인 1인 도색 코어)까지**다. 서버와 멀티플레이는 아직 없다.
> 그래서 "두 플레이어 동시 전투"와 "30인 부하" 장면은 **같은 브라우저 안의 로컬 봇**(공유 `MatchSimulation` + `SimpleBot`)으로 만들었다. 네트워크 30인 검증이 아니다.

## 1. 참고 자료에서 확인한 그래픽 특징
상세는 [GRAPHICS_REFERENCE.md](GRAPHICS_REFERENCE.md)에 있다. **영상은 재생하지 못했고, 공식 스크린샷 10장을 분석했다.** 핵심은 다음과 같다.
- 저채도 환경 대 고채도 젤 잉크의 대비
- 두께와 광택이 있는 불규칙한 웅덩이 모양 잉크
- 큰 머리의 4등신 캐릭터와 투명 탱크
- 리본 형태의 사격 줄기와 화려한 착탄 효과
- 대기 원근감과 밀도 높은 배경

## 2. 실제 적용한 그래픽 개선

### 2.1 페인트 (최우선)
- **셰이더 교체**: 표준 PBR 재질의 4개 청크(opacity, diffuse, normal, gloss)와 emissive 청크를 바꿨다.
  - 셀 소유권 텍스처를 쌍선형 보간한 필드에 월드 좌표 노이즈 두 겹을 더해 **불규칙한 경계**를 만든다.
  - 팀 경계에도 별도 노이즈를 넣어 덮어쓴 경계가 유기적으로 보인다.
  - 필드 높이로 법선을 계산해 **부풀어 오른 테두리**를 만든다(탄젠트가 필요 없는 미분 기반 범프).
  - 광택 0.8~0.95와 IBL 반사로 **액체 광택**을 낸다. high에서는 미세한 물결 하이라이트를 추가한다.
  - 얇은 가장자리는 밝게, 고인 중심은 진하게 그린다.
- **데이터 일치 보장**: 노이즈 폭을 경계 판정 임계값보다 작게 제한했다(가장자리 ±0.42 < 0.5, 팀 경계 ±0.8 < 1).
  - 그래서 **모든 셀 중심에서 그려지는 색 = 서버 격자 소유자**가 수학적으로 보장된다.
  - 브라우저 실측: 셀 중심 1,625개(바닥, 덮어쓰기 후 바닥, 다리 위, 경사로)가 **100% 일치**했다(`tests/visual/paintConsistency.js`).
- **날아가는 페인트**: 총구에서 늘어난 광택 슬러그가 꼬리 방울을 남기며 85m/s로 날아간다. 사거리 끝에서는 떨어진다.
  - 판정은 기존대로 즉시 히트스캔이다. 화면의 새 페인트만 슬러그가 닿을 때까지(최대 0.35초) 공개를 늦춘다.
- **착탄 효과**:
  - 사격 방향을 면 법선에 반사시킨 방향성 물방울
  - 도색 반경까지 0.09초 만에 퍼지는 방사형 스플랫(절차적 실루엣)
  - 총구 섬광
  - 처치 시 대형 페인트 폭발과 바닥 스플랫
  - 피격 시 물방울
- **성능 구조**:
  - 물방울은 팀별 **하드웨어 인스턴싱 1회 드로우**로 그리고, 품질별 상한(48/160/320개)을 둔다.
  - 페인트 텍스처는 **바뀐 사각형 영역만 CPU에서 다시 쓴다**(PaintGrid의 dirty rect, 단위 테스트 포함).

### 2.2 조명과 렌더링
- **절차적 하늘 큐브맵**: 해 질 녘 그라디언트, 구름, 태양 원반을 생성한다. 이를 엔진 `EnvLighting`으로 사전 필터링해 **IBL 환경 아틀라스**(환경광과 반사)를 만든다. 외부 HDRI는 쓰지 않는다.
- 낮은 태양(약 32°)의 따뜻한 직사광과 그림자(PCF3/PCF5, high는 2 캐스케이드), 원경 대기 안개를 적용했다.
- **HDR 후처리**(`CameraFrame`)는 품질별로 다르다.
  - low: 끔(직접 렌더 + Neutral 톤매핑)
  - medium: HDR + Bloom(임계값 0.9) + 컬러 그레이딩 + 비네트 + 2x MSAA + 샤프닝
  - high: medium + SSAO + 4x MSAA
- Bloom 임계값을 0.9로 두어 네온·총구 섬광·페인트 하이라이트만 빛나고 캐릭터와 환경은 번지지 않는다(적 식별 유지).
- TAA는 움직이는 캐릭터의 잔상 위험 때문에 쓰지 않았다.

### 2.3 맵 (충돌·스폰·동선 무변경)
- **절차적 PBR 재질 7종**: 콘크리트 데크 판넬, 금속 외장, 골판 컨테이너, 체크무늬 강판, 경고 줄무늬, 창문이 빛나는 건물 파사드, 물결.
  - 모두 알베도 + 노멀 + 광택맵이고, 파사드는 발광 맵도 있다. 코드로 생성하므로 외부 텍스처와 라이선스가 없다.
- 컨테이너는 ID별 고정 색과 모서리 기둥, 낮은 엄폐물은 콘크리트 방호벽과 경고 띠로 바꿨다.
- **장식 데이터 631개**(밀도 1 기준, medium 530개, low 407개)를 배치했다.
  - 지붕 설비·물탱크·안테나·비콘, 건물 네온 라인, 벽 간판 16개, 광장 위 **실시간 점령률 홀로그램**
  - 바닥 표시, 다리 하부 거더
  - 아레나 밖: 컨테이너 야적장, 갠트리 크레인 4기, 조명탑, 원경 스카이라인, 바다
- **장식 안전성 자동 검증**: 장식은 충돌하지 않으므로, 모든 항목이 다음 중 하나여야 한다. 밀도 3단계 모두 위반 0건이다(`tests/unit/decor.test.ts`).
  - 아레나 밖
  - 손이 닿지 않는 높이
  - 벽면 6cm 이하 부착물
  - 바닥 표시
- 정적 지오메트리는 재질별 메시 하나로 합쳐 맵 전체가 수십 회 드로우콜이다.

### 2.4 캐릭터 (오리지널 "컬러 러너")
- 외부 모델 없이 **코드로 생성한 22본 스키닝 캐릭터**다. 원형 프리미티브 91개(원거리 LOD 55개)를 본에 강체로 묶어 메시 2개(몸체, 광택·발광층)로 합쳤다.
  - 얼굴: 큰 눈과 홍채·하이라이트, 눈썹, 입, 귀
  - 머리: 팀 색 젤 스파이크 헤어, 헤드폰 LED, 이마 고글
  - 옷: 팀 색 재킷, 카고 바지, 무릎 보호대, 장갑, 부츠
  - 장비: **탄약량만큼 차는 페인트 탱크**, 호스, 페인트 라이플
  - 다양성: ID별 피부색 5종과 헤어 변형
- **애니메이션 12종(코드 구동)**: 대기, 걷기, 달리기(보폭을 이동 거리에 동기화해 미끄러짐 억제), 대시, 점프, 착지, 조준, 사격 반동, 재장전, 피격, 부활, 승리.
  - 처치는 캐릭터가 사라지고 페인트가 폭발하는 연출이다.
- **조준 = 총구 방향**: 총은 매 프레임 조준 yaw·pitch로 회전한다. 양팔은 2본 IK로 손잡이와 앞손잡이를 잡는다. 페인트 슬러그는 모델의 총구에서 출발한다.
- 다른 플레이어(봇)도 같은 리그와 애니메이션으로 보인다.
- 기존 이동·충돌 판정은 그대로다(시각 모델은 판정에 영향 없음).

### 2.5 전투 연출과 UI
- 카메라: 발사 반동 킥(스프링 감쇠, 화면만 움직이고 판정 조준은 그대로), 피격·근처 처치 시 흔들림, FOV 미세 펀치. 설정에서 끌 수 있다.
- HUD: 명중 표시(크로스헤어 확장·흰색, 처치 시 빨강), 피격 시 적 팀 색 화면 가장자리, 킬 피드, 부활 카운트다운.
- 메뉴: 카메라 흔들림 설정, 로컬 봇 1:1·4:4·15:15, 승리 포즈(개발용).

### 2.6 공유 로직 추가 (서버에서 재사용 예정)
- 히트스캔 플레이어 판정(원기둥), 피해 14, 처치, 5초 부활, 2초 무적(사격하면 해제), 자기 팀 스폰 안 피격 불가.
- `MatchSimulation`(여러 플레이어 틱 + 이벤트), `SimpleBot`(일반 입력만 생성).

## 3. 변경한 파일과 3D 에셋
- **외부 3D 에셋·텍스처·HDRI 0개.** 캐릭터, 텍스처, 하늘, 간판은 모두 코드로 생성했다. 라이선스 문제가 없다.
- 레퍼런스 이미지는 분석용 임시 폴더에만 있고 프로젝트에는 없다.

| 구분 | 파일 |
|---|---|
| 신규 (client) | `render/Environment.ts`, `render/PostEffects.ts`, `render/ProceduralTextures.ts`, `render/Materials.ts`, `render/MeshBatch.ts`, `render/Signs.ts`, `paint/PaintEffects.ts`, `player/CharacterRig.ts` |
| 재작성 (client) | `paint/PaintRenderer.ts`(셰이더), `scenes/ArenaBuilder.ts`, `game/Game.ts`(MatchSimulation·봇·이펙트 통합) |
| 수정 (client) | `player/ThirdPersonCamera.ts`(반동·흔들림), `settings/settings.ts`(품질 프로파일 확장, 카메라 흔들림), `ui/Hud.ts`, `ui/SettingsMenu.ts`, `ui/ui.css` |
| 삭제 (client) | `player/CharacterView.ts`, `combat/ShotEffects.ts`(새 리그·이펙트로 대체) |
| 신규 (shared) | `map/decor.ts`, `map/neonTerminalDecor.ts`, `rules/combat.ts`, `simulation/match.ts`, `bots/simpleBot.ts` |
| 수정 (shared) | `combat/hitscan.ts`(플레이어 판정), `simulation/player.ts`, `types/player.ts`, `paint/PaintGrid.ts`(dirty rect), `simulation/movement.ts` |
| 테스트 | `tests/unit/decor.test.ts`, `tests/unit/match.test.ts`, `paint.test.ts`(dirty rect) — 총 76개 |
| 검증 도구 | `tests/visual/captureShots.js`, `captureAnimations.js`, `measurePerf.js`, `paintConsistency.js` |

## 4. 변경 전후 스크린샷
동일한 위치, 카메라 각도, 페인트 배치다(`captureShots.js`). 1366×768, 기본 품질 high, UI는 숨겼다.

| 장면 | 변경 전 | 변경 후 |
|---|---|---|
| 캐릭터 정면 | [before](screenshots/before/01-character-front.png) | [after](screenshots/after/01-character-front.png) |
| 캐릭터 후면 | [before](screenshots/before/02-character-back.png) | [after](screenshots/after/02-character-back.png) |
| 맵 전체 | [before](screenshots/before/03-map-overview.png) | [after](screenshots/after/03-map-overview.png) |
| 중앙 전투 구역 | [before](screenshots/before/04-central-plaza.png) | [after](screenshots/after/04-central-plaza.png) |
| 넓은 점령 구역 | [before](screenshots/before/05-large-paint-area.png) | [after](screenshots/after/05-large-paint-area.png) |
| 다리·고지대 | [before](screenshots/before/06-bridge-and-highground.png) | [after](screenshots/after/06-bridge-and-highground.png) |
| 페인트 발사 | [before](screenshots/before/07-firing.png) | [after](screenshots/after/07-firing.png) |
| 페인트 착탄 | [before](screenshots/before/08-impact-closeup.png) | [after](screenshots/after/08-impact-closeup.png) |
| 두 플레이어 전투 (로컬 봇) | 없음 (기능 없음) | [after](screenshots/after/09-two-player-duel.png) |
| 30인 장면 (로컬 봇 29 + 플레이어) | 없음 (기능 없음) | [after](screenshots/after/10-thirty-players-load.png) |
| 실제 플레이 화면 + HUD | — | [after](screenshots/after/11-gameplay-hud.png) |
| 애니메이션 시트 | — | [1](screenshots/after/anim-1-idle-walk-run-dash-jump-land.png) · [2](screenshots/after/anim-2-aim-fire-reload-hit-respawn-victory.png) |

## 5. 그래픽 설정별 성능

측정 방법: `measurePerf.js` — 같은 카메라와 페인트 배치에서 `update + render + gl.finish`를 동기 측정했다(GPU 작업 포함, 창이 가려져 생기는 rAF 스로틀링과 무관). 환경은 Chrome 155, Intel 내장 GPU(ANGLE D3D11), 1366×768이다.

> **측정 신뢰도 주의.** 같은 코드에서도 측정 시점에 따라 **2~3배** 차이가 났다(작업 중 기기의 다른 부하로 추정). 그래서 범위로 적었다.
> 변경 전 코드는 git 스냅샷이 없어 **같은 시점에 다시 측정할 수 없었다.** 변경 전 값은 작업 초반에 한 번 잰 값이다.

### 5.1 1인 화면
| 품질 | 변경 전 ms | 변경 후 ms (여러 회차) | 드로우콜 전→후 | 삼각형 전→후 | VRAM 전→후 |
|---|---|---|---|---|---|
| low | 3.1 | 2.1 ~ 4.5 | 19 → 32 | 1.5k → 12k | 1 → 18 MB |
| medium | 2.6 | 2.8 ~ 6.4 | 27 → 62 | 2.9k → 25k | 5 → 38 MB |
| high | 4.1 | 7.7 ~ 10.0 | 35 → 108 | 4.4k → 55k | 17 → 56 MB |

### 5.2 30명(로컬 봇 29 + 플레이어, 전투·도색 중)
| 품질 | 최적화 전 ms | 최적화 후, 부하 낮을 때 (update + render) | 최적화 후, 부하 높을 때 | 드로우콜 | 삼각형 | VRAM |
|---|---|---|---|---|---|---|
| low | 8.4 | 1.4 + 2.7 = **4.1** | 12.9 | 84 | 63k | 32 MB |
| medium | 12.2 | 2.0 + 4.3 = **6.3** | 15.9 ~ 17.5 | 131 | 151k | 53 MB |
| high | 18.3 | 2.4 + 9.5 = **11.9** | 19.8 ~ 20.9 | 261 | 391k | 71 MB |

- 60fps 예산(16.7ms) 대비, 부하가 낮을 때는 30명 기준 low·medium·high 모두 예산 안이다. 부하가 높을 때는 medium 약 57~63fps, high 약 48fps다.
- JS 힙은 90~180 MB다. 페이지 준비 시간(개발 서버)은 약 2.8초이고, 절차적 텍스처·하늘 생성이 포함된다.
- **적용한 최적화**
  - 캐릭터당 스킨 인스턴스 1개 공유: 렌더 low 7.3 → 2.7ms
  - 캐릭터 폴리곤 감축(LOD0 7,008 → 6,068 삼각형, LOD1 3,188 → 2,700)과 LOD 거리 조정
  - 원거리 캐릭터는 그림자를 그리지 않음
  - 물방울 인스턴싱과 품질별 상한
  - 페인트 텍스처 변경 영역만 갱신
  - 정적 맵을 재질별로 일괄 합침
  - 간판을 아틀라스 1장으로 묶음
  - SSAO와 4x MSAA는 high에만 적용
- **미측정**: 다른 GPU와 PC, 장시간 메모리 추이, 실제 60Hz 플레이에서의 p95 프레임 시간.

## 6. 30인 멀티플레이에 미치는 영향
- **서버 부하**: 그래픽은 서버에 아무 부담을 주지 않는다. 서버가 돌릴 `MatchSimulation` 30명 틱은 브라우저 V8 기준 **0.39~0.64ms/틱**(봇 AI 포함)이다. 30Hz면 CPU 코어 하나의 약 1~2%다.
- **네트워크**: 이펙트와 애니메이션은 모두 시뮬레이션 상태와 이벤트(사격, 피격, 처치, 부활)에서 만들어지므로 추가 동기화 데이터가 없다.
  - Phase 3에서는 사격 이벤트(원점, 비행 끝점, 착탄점, 법선, 팀)를 보내거나, 클라이언트가 권위 상태로 재추적하면 된다.
  - 페인트 델타는 새로 만든 dirty rect를 `paint:delta`에 바로 쓸 수 있다.
- **클라이언트**: 30명이 동시에 사격해도 물방울은 상한(최대 320) 안에서 인스턴싱 2회, 페인트 업로드는 변경 영역만 처리한다. 캐릭터 30명의 추가 렌더 비용은 medium에서 약 1.5ms다(부하 낮을 때).
- **아직 검증하지 않은 것**: 실제 네트워크 30인(서버 없음)과 원격 플레이어 보간 상태에서의 애니메이션.

## 7. 참고 자료와 비교해 아직 부족한 부분
1. **캐릭터**: 프리미티브 조합이라 조각한 고해상도 모델보다 형태가 단순하다.
   - 강체 스키닝이라 관절이 꺾이는 부위가 매끄럽지 않다. 손가락, 표정 애니메이션, 천·머리카락 흔들림이 없다.
   - 애니메이션은 절차적이라 키프레임 애니메이션의 디테일(예비동작, 잔상 포즈)이 부족하다.
2. **페인트**: 0.5m 격자 해상도 때문에 단발 자국은 아직 둥근 사각형에 가깝다.
   - 실제 두께(변위), 벽면 도색과 흘러내림, 스크린 공간 반사가 없다. 사격 줄기는 리본 메시가 아니라 늘어난 덩어리다.
3. **환경**: 절차적 텍스처라 손으로 그린 텍스처의 디테일과 이야기성이 없다.
   - 식생, 물 시뮬레이션, 볼륨 안개·미스트, 베이크된 GI·AO 라이트맵이 없다.
4. **조명**: 캐릭터용 라이트 프로브와 국소 조명(네온의 실제 광원 효과)이 없다.
5. **연출**: 피해 숫자, 치명타 효과가 없다. 치명타는 GDD 4.2에 따라 MVP 판정에서 제외했다.
6. **측정**: 성능 수치의 편차가 크고, 같은 조건의 변경 전후 비교가 없다.

## 8. 다음 개선 작업 (Phase 3~7과 병행)
1. **Phase 3 서버(최우선)**: Colyseus 0.18 Room에 `MatchSimulation` 이식, 사격 이벤트와 페인트 델타(dirty rect) 전송, 원격 캐릭터 보간 + 리그.
2. 페인트: 리본 메시 사격 줄기, 벽면 시각 도색, 신선한 페인트 광택 감쇠, 착탄 지점 미세 높이맵(시각용, 데이터 경계 안에서만).
3. 캐릭터: 실제 GLB 파이프라인(Blender 원본 → glTF, 2~3본 가중 스키닝)으로 교체. `CharacterRig`의 본 이름과 애니메이션 상태 API를 그대로 쓸 수 있다.
4. 환경: 라이트 프로브와 베이크 AO, 네온 국소 조명(클러스터 라이팅) 실험, 볼륨 안개(CameraFrame volumetricFog) 측정.
5. 성능: git으로 버전을 고정한 뒤 같은 조건에서 반복 측정, 다른 GPU 2종 이상, 장시간 측정.
6. 로컬 봇 대신 실제 네트워크 클라이언트 30개 부하 테스트(GDD 8.2 6번).
