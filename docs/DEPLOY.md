# 배포 (Phase 7)

## 구조

Render 웹 서비스 **1개**로 동작한다. Node 프로세스가 두 가지를 함께 처리한다.

- 권위 게임 서버(Colyseus)
- 빌드된 클라이언트(`apps/client/dist`) 제공

페이지와 게임 소켓의 출처(origin)가 같다. 그래서 TLS는 Render가 처리하고 클라이언트는 `wss://<같은 호스트>`로 접속한다. CORS 설정이나 별도 도메인 연결은 필요 없다.

```
브라우저 ──https──▶ Render(TLS) ──▶ node: express(정적 파일, /health, /metrics)
         ──wss────▶               ──▶       Colyseus(/matchmake, 게임 소켓)
```

## 환경 변수 (`render.yaml`에 정의)

| 변수 | 값 | 의미 |
|---|---|---|
| `NODE_ENV` | `production` | `/metrics`를 토큰 없이 열지 않는다. |
| `HOST` | `0.0.0.0` | 컨테이너 바인딩. 로컬 기본값은 127.0.0.1이다. |
| `PORT` | (Render가 지정) | |
| `STATIC_DIR` | `apps/client/dist` | 저장소 루트 기준 상대 경로다. `index.html`이 없으면 클라이언트를 제공하지 않고 경고만 남긴다. |
| `ALLOWED_ORIGINS` | 쉼표 구분 | 게임 소켓과 매칭 응답을 허용할 브라우저 출처. 서버 자신의 호스트는 항상 허용된다. 비워 두면 출처를 제한하지 않는다. 다만 이 경우에도 다른 출처 페이지는 매칭 응답을 읽을 수 없다. |
| `METRICS_TOKEN` | 자동 생성 | `GET /metrics`에 `Authorization: Bearer <토큰>` 또는 `?token=`으로 전달한다. |

## 보안 동작 (로컬 프로덕션 모드에서 확인)

| 요청 | 결과 |
|---|---|
| 다른 출처(`https://evil.example`)의 WebSocket 업그레이드 | **401** |
| 허용된 출처나 같은 호스트의 업그레이드 | 101 |
| 다른 출처의 `/matchmake` 요청 | `Access-Control-Allow-Origin: null`. 브라우저가 응답을 읽지 못한다. |
| 토큰 없는 `/metrics` | 404 |
| 토큰 있는 `/metrics` | 200 |
| `index.html` | `no-cache` |
| 해시가 붙은 JS·CSS | 1년 `immutable` |
| GLB 모델 | 1일 |
| 모든 응답 | `nosniff`, `X-Frame-Options: DENY`, `x-powered-by` 제거 |

## 배포 절차

1. 이 폴더(`colorfront/`)를 GitHub 저장소로 푸시한다(비공개 저장소 가능).
2. Render 대시보드 → **New → Blueprint**에서 저장소를 선택한다. `render.yaml`이 서비스를 만든다.
3. 첫 배포가 끝나면 `https://<서비스>.onrender.com`을 `ALLOWED_ORIGINS`에 넣는다(선택 사항).
4. 확인할 항목:
   - `/health`
   - 브라우저 2개로 같은 방에 입장
   - 채팅
   - 무기 교체
   - 외형이 서로에게 보이는지

## 요금제

| 플랜 | CPU / 메모리 | 비고 |
|---|---|---|
| Free | 0.1 CPU / 512MB | 15분간 접속이 없으면 잠든다. 깨어나는 데 약 1분 걸린다. 30인 시뮬레이션은 CPU가 부족할 가능성이 크다. |
| **Starter (권장)** | 0.5 CPU / 512MB | 월 약 $7. 잠들지 않는다. |

리전은 `singapore`로 정했다. 한국에서 가장 가까운 Render 리전이다.

## 알려진 한계

- **서버 인스턴스는 1개다.** Colyseus 방이 프로세스 메모리에 있으므로 수평 확장에는 Redis 프레젠스와 드라이버가 필요하다.
- **배포하면 방이 끊긴다.** 재배포·재시작 시 진행 중인 방이 끊기고, 클라이언트는 재접속을 시도한다.
- **`avatar-preview.html`은 개발 서버 전용이다.** 빌드에 포함되지 않는다.
