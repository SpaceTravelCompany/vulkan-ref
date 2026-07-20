# Vulkan Reference

Vulkan API 참조 사이트. 빌더는 [`topic-pages`](https://github.com/SpaceTravelCompany/topic-pages) 패키지를 사용한다.

- 코드 하이라이트: `prism.css`, `prism.js`

## 사용법

```bash
cd vulkan-ref
npm install         # topic-pages 의존성 설치
npm run build       # dist/ 정적 HTML 생성
```

`dist/index.html` 하나로 동작하는 **단일 페이지 앱**이다.

서빙은 사용자 환경의 도구로 (VS Code Live Server, `npx serve`, `python -m http.server` 등).
`content/*.md` 또는 `site.json` 수정 후 `npm run build` 다시 실행 → `dist/` 갱신.

## 로컬 개발 (topic-pages 동시 수정)

이 절은 `topic-pages` 빌더 자체를 로컬에서 수정하며 테스트하는 개발자용이다. 일반 사용자는 이 절을 건너뛰고 위 "사용법"대로 수행한다.

```bash
# topic-pages를 전역 링크로 등록 (topic-pages 디렉토리에서 1회)
cd ../topic-pages
npm link

# vulkan-ref에서 링크 연결 (vulkan-ref 디렉토리에서)
cd ../vulkan-ref
npm link topic-pages
```

이후 `topic-pages` 코드를 수정하면 push 없이 `vulkan-ref`에서 `npm run build`로 즉시 확인 가능하다.

- `package.json`은 변경하지 않는다. github: 의존성은 그대로 유지되며, 로컬 링크가 `node_modules`를 오버라이드한다.
- 링크 해제(원래 github: 의존성으로 복귀)하려면:
  ```bash
  npm unlink topic-pages
  npm install
  ```
- 참고: 링크는 현재 머신에서만 유효하며, CI/배포/다른 clone 환경은 `package.json`의 github: 참조를 그대로 사용한다.

## UI

- **왼쪽**: 주제 버튼 (스크롤 없이 클릭으로 전환)
- **상단**: 섹션 탭 버튼 (`##` 단위, 본문 전체 유지)
- **본문**: 선택한 섹션만 표시 (`‹` `›` 또는 ← → 키로 이동)
- 긴 섹션만 본문 영역 내부에서 스크롤 (내용 생략 없음)

## 사이트 정의 변경

`site.json`에서 다음을 조정한다:

- `title` / `subtitle` — 사이트 이름
- `brandMark` — nav 좌측 2글자 마크
- `theme` — CSS 변수 (primary, primaryFg, accent, link)
- `references` — nav 하단 외부 링크
- `sections` — 주제 그룹과 토픽

## 콘텐츠 추가

`content/<slug>.md` 파일을 직접 작성한다. 슬러그는 `site.json`의 토픽과 일치해야 한다.

```markdown
---
title: 새 주제
slug: new-topic
---

## 첫 섹션

본문...
```

## 주제 구성

| 분류 | 주제 |
|------|------|
| 문제 해결 | 그래픽이 안 나올 때 · Validation & Debug |
| 파이프라인 | 그래픽스 · 컴퓨트 · 메시 셰이더 |
| 리소스 | Descriptor · 버퍼/이미지 · 메모리 |
| 렌더링 | 스왑체인 · Render Pass & 서브패스 · Dynamic Rendering |
| 동기화 | 동기화 전체 |
| 엔진 실전 | 성능 최적화 · 멀티스레딩 |
| 확장기능 | 핵심 · 렌더링 · 고급 |

## 구조

- `site.json` — 섹션·주제·테마 정의
- `content/` — 주제별 마크다운
- `package.json` — `topic-pages` 의존성 + 빌드 스크립트
- `topic-pages` (의존성) — 빌더 + 라이브러리 + 에셋

빌드 파이프라인의 상세 인터페이스(스키마, CLI 옵션)는 [topic-pages README](https://github.com/SpaceTravelCompany/topic-pages#readme) 참고.

## 라이선스

[MIT](LICENSE)
