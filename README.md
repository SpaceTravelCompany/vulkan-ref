# Vulkan Reference

Vulkan API 참조 사이트. 빌더는 [`topic-pages`](https://github.com/SpaceTravelCompany/topic-pages) 패키지를 사용한다.

- 코드 하이라이트: `prism.css`, `prism.js`

## 사용법

```bash
cd vulkan-ref
npm install         # topic-pages 의존성 설치
npm run build       # dist/ 정적 HTML 생성
npm run dev         # 빌드 후 로컬 서버 (http://localhost:4321)
```

`dist/index.html` 하나로 동작하는 **단일 페이지 앱**이다.

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
| 문제 해결 | 그래픽이 안 나올 때 |
| 파이프라인 | 그래픽스 · 컴퓨트 · 메시 셰이더 |
| 리소스 | Descriptor · 버퍼/이미지 · 메모리 |
| 렌더링 | Render Pass & 서브패스 · Dynamic Rendering |
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

- 사이트 코드: [MIT License](LICENSE-CODE)
- 문서/콘텐츠: [CC BY-NC-SA 4.0](LICENSE-CONTENT)
- 빌더 코드(topic-pages): [MIT](https://github.com/SpaceTravelCompany/topic-pages/blob/main/LICENSE)
- 전체 정책: [LICENSE](LICENSE)
