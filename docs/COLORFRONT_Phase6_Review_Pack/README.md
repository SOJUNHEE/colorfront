# COLORFRONT Phase 6 — 3D 그래픽·아바타 의상 시스템 검토 패키지

작성: 2026-11-05. 분석 근거: 사용자 제공 `fps.zip`의 실제 소스, `GRAPHICS_REPORT.md`, `PHASE3_REPORT.md`, GDD, after 스크린샷.

## 순서

1. `01_AUDIT.md`: 스크린샷/코드 근거, 위험, 에셋 제작방법, 우선순위, 성능 예산, 출처.
2. `02_ART_WARDROBE_SPEC.md`: COLORFRONT 고유 디자인 방향, GLB·Blender 스켈레톤 계약, 옷 입히기 데이터 구조, 리깅·애니메이션·에셋 체크리스트.
3. `03_CLAUDE_PHASE6_MASTER_PROMPT.md`: VS Code Claude에 그대로 전달할 통합 프롬프트. 단계마다 산출물·검증·금지 사항 포함.
4. `04_WARDROBE_CATALOG_EXAMPLE.json`: **예시 스키마**. 기술 사양/경로/ID 가이드일 뿐, 해당 GLB 파일들은 아직 존재하지 않음.
5. `05_VALIDATION.md`: 초보자용 실행·검증·A/B 스크린샷 기준.

### 검증 및 한계

- 사용자 압축파일에는 Blender 원본 `.blend` 또는 실제 리깅된 GLB가 없음. **완성 GLB나 의상 착용 기능을 구현·실행했다고 주장하지 않는다.** 이 패키지는 구현 지시·기술 명세·검수 기준임.
- 실제 소스를 읽고 `CharacterRig.ts`, `Game.ts`, `ArenaBuilder.ts`, `settings.ts`, 리포트의 현재 구조와 대조함.
- 로컬 Linux 컨테이너에서 Windows용 `node_modules` 압축본의 native Rolldown 바이너리가 맞지 않아 Vitest 실행은 못함. 압축본을 풀고 워크스페이스 심볼릭 링크만 복구하여 공유/테스트/클라이언트/서버 **4개 TypeScript 프로젝트의 typecheck는 통과**함. 이것은 새 기능이나 기존 네트워크 테스트 실행 완료를 의미하지 않음.
- 속도, FPS, 모델 용량 예산은 **권고 목표치**이지 실제 측정값이 아님. 실기기 A/B 측정에 따라 재조정해야 함.

### 처음 시작

`03_CLAUDE_PHASE6_MASTER_PROMPT.md` 전체를 VS Code Claude에 붙여넣고, 먼저 Gate 0(현 상태 동결·코드 분석)과 Gate 1(캐릭터 한 명의 미술 제작·미리보기)만 수행하도록 한다. 통과 전에 다른 단계 진행 금지.
