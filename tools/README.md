# tools/ — SGIS 빌드타임 스냅샷 갱신 도구

정적 사이트(`index.html`)는 실시간으로 SGIS API를 부를 수 없다(consumer_secret 노출 + CORS). 대신
로컬에서 `fetch-datahub.mjs`를 실행해 `data/hub.json` 스냅샷을 만들고, 그 JSON을 페이지가 읽어 렌더한다.

- **생산자:** `tools/fetch-datahub.mjs` (Node 내장 모듈만, 외부 npm 0)
- **설정:** `tools/indicators.config.json` (연동할 지표 목록·파라미터)
- **소비자:** `index.html`의 "1인가구 핵심 지표" 섹션 (`data/hub.json`을 fetch)
- **스키마 계약(SSOT):** `_workspace/01_architect_plan.md` §A

> 스냅샷이 없거나 깨져도 페이지는 하드코딩된 기본 4개 카드로 자동 폴백한다. 즉 이 도구를
> 실행하지 않아도 사이트는 정상 동작한다.

---

## 1. SGIS 인증 키 발급

1. [SGIS 오픈플랫폼](https://sgis.kostat.go.kr/developer/) 회원가입 후 로그인.
2. "서비스 신청/등록"에서 앱을 등록하면 **서비스 ID(consumer_key)** 와 **보안 Key(consumer_secret)** 발급.
3. "지방의 변화보기(jibang)" 서비스 사용 권한이 포함됐는지 확인.

## 2. 키 설정 (둘 중 하나 — 키는 절대 커밋 금지)

**방법 A. 환경변수 (권장, 파일에 안 남음)**

```bash
# PowerShell
$env:SGIS_CONSUMER_KEY="발급받은_키"
$env:SGIS_CONSUMER_SECRET="발급받은_시크릿"

# bash
export SGIS_CONSUMER_KEY="발급받은_키"
export SGIS_CONSUMER_SECRET="발급받은_시크릿"
```

**방법 B. 로컬 파일**

`tools/secrets.local.example.json`을 복사해 `tools/secrets.local.json`을 만들고 값을 채운다.

```json
{ "consumerKey": "발급받은_키", "consumerSecret": "발급받은_시크릿" }
```

`tools/secrets.local.json`은 `.gitignore`에 등록돼 있어 커밋되지 않는다. 환경변수가 있으면 그쪽이 우선한다.

## 3. 연동할 지표 확정 (`tools/indicators.config.json`)

초기값의 `jibang_idx_id`는 `REPLACE_AFTER_CATALOG` 플레이스홀더다(그대로 두면 해당 지표는 건너뛴다).
실제 지표 ID는 카탈로그로 확인한 뒤 채운다.

1. 키 설정 후 스크립트를 한 번 실행하면 로그에 `카탈로그 N건 수신`이 찍힌다. 상세 목록이 필요하면
   브라우저/`curl`로 아래를 직접 열어 `jibang_idx_id`(항목 ID), `jibang_idx_nm`(항목명),
   `data_unit`(단위), `yearinfo`(연도)를 확인한다.
   `https://sgisapi.mods.go.kr/OpenAPI3/jibang/category_a/list.json?accessToken=<토큰>`
2. 1인가구 관련 항목의 `jibang_idx_id`를 config의 각 지표에 넣는다.

`indicators.config.json` 필드 의미:

| 필드 | 설명 |
|------|------|
| `base` | SGIS OpenAPI3 베이스 URL (기본값 유지) |
| `service` | 서비스 경로. 기본 `jibang/category_a` |
| `region.adm_cd` / `region.label` | 기본 대상 지역 코드/라벨. 전국 = `"00"` |
| `source` / `sourceUrl` | 카드에 표기할 출처명·링크(전 지표 공통 기본값) |
| `indicators[].jibang_idx_id` | **필수.** SGIS 항목 ID. 미설정/플레이스홀더면 건너뜀 |
| `indicators[].name` | 카드 라벨. 없으면 카탈로그 `jibang_idx_nm` 사용 |
| `indicators[].unit` | 값 접미사(`%`, `가구` 등). 없으면 카탈로그 `data_unit` |
| `indicators[].year` | 카드에 표기할 기준연도(문자열) |
| `indicators[].params` | `data.json` 쿼리에 그대로 병합할 파라미터. `adm_cd`로 지역 지정, `label`로 지역 표기 override |
| `indicators[].valueField` | 값이 든 응답 필드명. **비우면**(`""`) `adm_cd`/`adm_nm` 등 메타 필드를 제외한 **첫 숫자 필드**를 자동 사용 — 오연동 방지를 위해 응답 확인 후 명시 권장 |

## 4. 실행

```bash
node tools/fetch-datahub.mjs
```

- 성공: `data/hub.json`이 원자적으로 갱신되고(`... .tmp` → rename), `기록 완료:` 로그가 뜬다.
- 실패(키 없음/인증 실패/네트워크·JSON 오류/유효 지표 0개): `FATAL` 로그 후 종료하며
  **기존 `data/hub.json`은 변경하지 않는다.** 반쪽·깨진 파일은 절대 생기지 않는다.
- 특정 지표만 실패(빈 결과/값 추출 실패/미설정 ID): `WARN` 로그로 **그 지표만 건너뛰고** 계속 진행한다.

## 5. 결과 확인 (로컬)

같은-출처 fetch가 필요하므로 정적 서버로 연다(파일 직접 열기는 fetch가 막힐 수 있음).

```bash
python -m http.server 8000
# → http://localhost:8000/ 접속, "1인가구 핵심 지표" 카드가 hub.json 값으로 바뀌고
#    그리드 아래 "자동 스냅샷 · <시각>" 표기가 뜨는지 확인
```

## 6. 커밋 / 배포 (GitHub Desktop)

1. GitHub Desktop에서 변경 파일 확인 — `data/hub.json`(+ 최초엔 `tools/*`, `index.html`)만 있어야 하고
   `tools/secrets.local.json`은 **목록에 없어야 한다**(있으면 커밋 중단, `.gitignore` 확인).
2. 커밋 메시지 예: `data: SGIS 스냅샷 갱신` → Commit → Push (`main`).
3. 1~2분 후 https://thepmdmanage-rgb.github.io/ksa-datahub/ 에 반영.

---

### 참고: 데이터 흐름

```
SGIS API ──(auth→list→data)──> fetch-datahub.mjs ──(원자적 기록)──> data/hub.json
                                                                        │ 같은-출처 fetch
                                                                        ▼
                                                                   index.html 렌더
                                                            (없거나 깨지면 하드코딩 카드 폴백)
```
