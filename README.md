# KSA 1인가구 데이터 허브 (참고형)

KSA 1인가구협회가 흩어진 공공 1인가구 데이터를 한곳에 모아 안내하는 **참고형 데이터 허브**. 정적 페이지(서버 불필요) — GitHub Pages로 외부 공개.

## 배포 (GitHub Pages)
```bash
cd D:\claude-work\ksa-datahub
gh auth login                       # 최초 1회 (브라우저 로그인)
gh repo create ksa-datahub --public --source=. --remote=origin --push
gh api -X POST repos/{owner}/ksa-datahub/pages -f "source[branch]=main" -f "source[path]=/"
```
공개 주소: **https://<GitHub아이디>.github.io/ksa-datahub/**

## 특징
- 1인가구 핵심 지표(출처·기준연도 표기), 공공데이터 바로가기, 데이터 브리핑
- 다크모드·모바일 대응, 외부 의존성 없는 단일 `index.html`
- 협업·서버 확보 시 실시간 자동 갱신 허브로 확장(현재는 협회 수기 정리 참고본)
