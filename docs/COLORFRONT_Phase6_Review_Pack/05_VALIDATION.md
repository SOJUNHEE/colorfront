# 5. 실무 검증·수락 체크리스트

## 사전 준비

Windows에서 Node.js가 저장소의 `engines.node >=22.23.2` 조건을 충족하는지 확인. 프로젝트 루트 `colorfront`에서:

```powershell
node -v
npm install
npm run typecheck
npm test
npm run lint
npm run build
```

서버(터미널 A):

```powershell
npm run start:server
```

클라이언트(터미널 B):

```powershell
npm run dev
```

브라우저: `http://localhost:5173` 와 별도 시크릿 창. 2개 클라이언트가 같은 방 참가해서 이동·사격·도색 일치 확인.

**주의**: 이 문서 제작 환경은 Windows 전용 의존성 압축본을 Linux에서 실행해야 했으므로 Vitest 런타임 실행에 실패했다. 로컬 Windows에서 위 명령을 직접 실행해 사실관계를 확인한다. 작성 환경에서 TypeScript 공유/테스트/클라이언트/서버 typecheck는 통과했다.

## Gate별 승인 체크

| Gate | 핵심 증거 | 실패 예시 |
|---|---|---|
| 0 baseline | commit/branch, 테스트, 고정 스크린샷과 렌더 비용 | 기준 없이 다른 시점 측정 |
| 1 3D 조형 | `.blend`+실제 `.glb`+정면/후면/게임 카메라 | Blender 소스 없이 AI 이미지 한 장 |
| 2 게임 통합 | legacy fallback, 로컬/온라인 게임에서 모델 렌더 | 독립 뷰어에만 GLB 재생 |
| 3 의상 | top A/B+hair A/B 착용, 클리핑 없음, UI 저장 | 색만 바꾸고 의상 교체라 주장 |
| 4 애니메이션 | walk→run→jump→aim→reload 연결 영상 | 정지 포즈 사진만 |
| 5 맵 | 동일 지점 A/B, 도색·지오메트리 무변경 | paintable 면 위 불투명 장식 |
| 6 성능 | 실제 iGPU/1366×768 온라인 30밀집 p95 | 30인이 다른 곳에 흩어져 있음 |

## 최소 테스트 세트

1. `npm test`: 기존 단위·통합 테스트 모두. 보고서의 109개는 과거 기준이며 새 테스트 개수는 실제 출력으로 기록.
2. `npm run typecheck` / `npm run lint` / `npm run build`.
3. `tests/visual/paintConsistency.js`: 셀 중심/경계/덮어쓰기/다리 상하/경사로별 **수치와 시각** 검증. 하나라도 실패하면 paint shader 수정 대신 시각 메시 오버레이를 먼저 의심.
4. `tests/visual/twoBrowser/1-setup.js` 등 실제 2브라우저 스크립트: 동일 paint 해시, 사격 이벤트, 재접속, 서버 판정.
5. `npm run load -- --players 30 --seconds 60`: 서버 30봇 테스트. 이것은 렌더링 30밀집 시험이 **아님**.
6. 30 플레이어 밀집 같은 카메라에서 로컬/온라인 **각각** FPS p50/p95, drawcall, triangles, memory, 장시간 진행(적어도 5분) 기록.
7. 의상 교체 20회, 첫 입장/늦은 입장/재접속 및 장비/탱크 수위 동기화.
8. 접근성: 팀색 외 패턴, low 품질 상태, 1366×768 HUD 가독성.

## 성능 해석

- 프레임타임 16.7ms ≈ 60 FPS 예산. p95는 프레임의 95%가 그 시간 이하라는 의미로, 평균만 좋아도 버벅일 수 있음.
- GPU draw calls의 실제 카운트 방식은 shadow/post/paint 패스 포함 여부를 문서화해야 전후 비교 가능.
- Draco는 파일 크기/다운로드 절약 위주이며, 삼각형 수 자체·스키닝 비용을 줄이는 수단이 아님. KTX2는 VRAM·다운로드/성능에 도움이 될 수 있지만 지원 GPU별 GPU 압축 형식과 트랜스코딩 초기화 검증이 필요.
- 프레임타임 등 수치는 실제 계측 전까지 예산/권고치. 재측정한 결과만 '실측'이라고 표시.
