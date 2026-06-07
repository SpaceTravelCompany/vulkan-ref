# Vulkan Reference

블로그와 **독립된** Vulkan 참조 사이트.

- 원본 글 백업: `E:\vulkan_posts_backup\posts`
- 확장 가이드: `E:\Note\Programming\research\vulkan-essential-extensions-guide_20260607.md`
- 코드 하이라이트: `prism.css`, `prism.js`만 블로그에서 가져옴

## 사용법

```bash
cd vulkan-ref
npm install
npm run seed   # posts + 연구 노트 → content/*.md
npm run build  # dist/ 정적 HTML 생성
npm run dev    # 빌드 후 로컬 서버 (http://localhost:4321)
```

`dist/index.html` 하나로 동작하는 **단일 페이지 앱**이다. 블로그 Astro 빌드와 무관하다.

## UI

- **왼쪽**: 주제 버튼 (스크롤 없이 클릭으로 전환)
- **상단**: 섹션 탭 버튼 (`##` 단위, 본문 전체 유지)
- **본문**: 선택한 섹션만 표시 (`‹` `›` 또는 ← → 키로 이동)
- 긴 섹션만 본문 영역 내부에서 스크롤 (내용 생략 없음)

## 주제 구성 (블로그 글 1:1 아님)

| 분류 | 주제 | 합성 소스 |
|------|------|-----------|
| 문제 해결 | 그래픽이 안 나올 때 | 체크리스트 |
| 파이프라인 | 그래픽스 · 컴퓨트 · 메시 셰이더 | 31, 32, 3 |
| 리소스 | Descriptor · 메모리 | 28, 33 |
| 렌더링 | Render Pass & 서브패스 | 29 + 35§1 |
| 동기화 | 동기화 전체 | 27 + 4 + 35§2 |
| 엔진 실전 | 성능 최적화 · 멀티스레딩 | 35§3–8, 30 |
| 확장기능 | 핵심 · 렌더링 · 고급 | 연구 노트 1–6 / 7–12 / 13–20 |

`npm run seed`가 `lib/compose-content.mjs`로 위 규칙에 따라 `content/*.md`를 생성한다.

## 구조

- `site.json` — 섹션·주제 네비게이션
- `content/` — 주제별 합성 마크다운 (`npm run seed`)
- `lib/` — compose · 마크다운 · cmdstack · relflow
- `assets/` — 스타일, prism, 클라이언트 스크립트
- `dist/` — `index.html` + `assets/`
