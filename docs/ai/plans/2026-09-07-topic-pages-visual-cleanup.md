# 2026-09-07 topic-pages 시각 정리 (화살표·외각선·밝은모드 버튼·서브타이틀)

## 배경
- `vulkan-ref` 랜딩/토픽 화면에서 (1) relflow·flowchart 화살표가 어색하고,
  (2) 사이트 크롬·카드의 외각선이 촌스러우며,
  (3) 밝은 모드에서 아이콘 버튼이 헤더 배경과 같은 색으로 묻히고,
  (4) `Vulkan 정보를 주제별로 정리` 서브타이틀 + 구분선이 불필요하다는 지적.
- (4)는 템플릿(`topic-pages`)을 건드리므로 4개 사이트에 동일 적용:
  `vulkan-ref`, `mathematics`, `game-math`, `blender-hardops-boxcutter`.
- 근본 수정 위치: `C:\Users\lmsd1\Documents\projects\topic-pages`
  (`assets/main.css`, `lib/relflow.js`, `scripts/build.mjs`).

## 원인 파악 (검증됨)
- `lib/relflow.js:57`: 푸터 전 항목에 `↕` 아이콘 하드코딩.
  `memory.md`의 `vkMapMemory`·`memcpy` 같은 전송 단계에 상하 화살표가 붙어 어색함.
  `.relflow-foot-icon` CSS도 없음.
- `assets/main.css`: `.relflow-arrow` 1.35rem·얇음, 모바일에서 텍스트 `→`를
  `rotate(90deg)`라 베이스라인이 어색. `.fc-conn-arrow` 1.1rem `↓` similarly 약함.
  `.cmdstack-arrow`는 `lib/cmdstack.js:58`에서 빈 `<span>`만 렌더하고 CSS 정의가 없어
  화살표가 사라짐.
- 외각선: `.nav-panel{border-right}`, `.nav-brand{border-bottom}`,
  `.main-header{border-bottom}`, `.toc-panel{border-left}`, `.topic-card{border}`,
  `.relflow/.cmdstack` 외곽 컨테이너 `border`가 구식 하이라인처럼 보임.
- 밝은 모드 버튼: `.icon-btn{background:var(--bg)}` + `.main-header{background:var(--bg-elevated)}`가
  라이트에서 둘 다 `#fff`라 버튼이 묻힘. 다크에서는 `#0d1117` vs `#1f2630`이라 대비됨.
  `.toc-toggle`도 동일(`background:var(--bg)`).
- 서브타이틀: `scripts/build.mjs` `renderNav`는 `brand-sub`를 항상,
  `renderLandingPage`는 `landing-subtitle`를 항상 렌더(빈 문자열이어도 `<p>` 출력).
  `site.json` 4곳에 모두 `subtitle`이 있어 nav + 랜딩에 중복 노출.
  `nav-brand{border-bottom}`이 함께 구분선으로 보임.

## Steps
- [x] 1. `topic-pages` 화살표 근본 수정
  - `lib/relflow.js`: 푸터 아이콘 `↕` → `→` (전송 단계 의미에 맞게).
  - `assets/main.css`: `.relflow-arrow` 확대·굵게·flex 중앙정렬, 모바일 회전 시 중앙 고정.
    `.relflow-foot-icon` 신규 스타일(accent·굵게·간격).
    `.fc-conn-arrow` 확대·굵게·중앙정렬.
    `.cmdstack-arrow` 신규 스타일(`::after{content:"↓"}` accent·중앙).
  - 검증: `memory.md` relflow + `graphics-pipeline.md` flowchart 스크린샷(라이트/다크).
  - 완료: `git diff --ignore-all-space`로 4파일 변경 확인
    (`README.md`, `assets/main.css`, `lib/relflow.js`, `scripts/build.mjs`).
- [x] 2. 외각선 제거 (촌스러운 하이라인)
  - `assets/main.css`: `.nav-panel` border-right 제거, `.nav-brand` border-bottom 제거(구분선),
    `.main-header` border-bottom 제거, `.toc-panel` border-left 제거(데스크톱·모바일 drawer 포함),
    `.topic-card` border 제거 → `border:none` + `box-shadow:var(--shadow-1)` 유지,
    `.relflow`·`.cmdstack` 외곽 컨테이너 border 제거(내부 박스·노드 border는 유지).
  - 검증: 랜딩·토픽 스크린샷에서 크롬 구분선 없음, 카드·다이어그램 구조 유지.
  - 완료: 위 diff에 포함됨.
- [x] 3. 밝은 모드 버튼 대비
  - `assets/main.css`: `.icon-btn`·`.toc-toggle` background를 `var(--bg)` → `var(--surface)`로.
    라이트: 버튼 `#f7f7f7` vs 헤더 `#fff`. 다크: `#161b22` vs `#1f2630` 유지.
  - 검증: 라이트 스크린샷에서 검색·A·테마 버튼 경계 확인.
  - 완료: 위 diff에 포함됨.
- [x] 4. 서브타이틀 + 구분선 제거 (템플릿 + 4 사이트)
  - `scripts/build.mjs`: `renderNav`는 `site.subtitle` 있을 때만 `brand-sub` 렌더.
    `renderLandingPage`는 있을 때만 `landing-subtitle` 렌더.
  - 4개 `site.json`에서 `subtitle` 키 제거:
    `vulkan-ref`(Vulkan 정보를 주제별로 정리), `mathematics`(선형대수 · 미적분 · 확률통계),
    `game-math`(게임 개발자를 위한 수학 레퍼런스),
    `blender-hardops-boxcutter`(하드서페이스 모델링 가이드).
  - `README.md`의 `subtitle` 예시·스키마는 유지(선택 필드임을 명시) — 템플릿 하위호환.
  - 검증: 4 사이트 재빌드 후 nav·랜딩에 서브타이틀 없음, `<p class="brand-sub">`·`landing-subtitle` 미출력.
  - 완료: 4× `site.json` subtitle 제거, `build.mjs` 조건부 렌더.
    `blender-hardops-boxcutter`는 git 저장소가 아니라 파일 직접 수정.
    - 최종 검증 (final-conformance): 4 사이트 `site.json`·`dist/index.html` grep 0건,
      vulkan-ref 템플릿 싱크 3파일 동일, 재빌드 성공 (26 topics / 279 records).
- [x] 5. 4 사이트 재빌드 + 검증
  - `topic-pages` 수정분을 각 사이트 `node_modules/topic-pages`에 동기화 후
    `npm run build`(또는 `node node_modules/topic-pages/scripts/build.mjs`) 실행.
    (`blender-hardops-boxcutter`는 `.bin` 심이 깨져 있어 `node` 직접 실행.
    `mathematics`·`game-math`는 `node_modules`가 없어 `npm install` 후 동기화.)
  - 검증: 각 `dist/index.html`에 subtitle 문자열 없음, 에셋 해시/복사 정상,
    `search-index.json` 레코드 수 유지.
  - 완료: 4 사이트 빌드 성공 —
    vulkan-ref 26 topics, blender 16, mathematics 73, game-math 26.
    `grep`으로 subtitle 문자열·`brand-sub`·`landing-subtitle` 0건 확인.
    스크린샷: vulkan-ref 랜딩(다크/라이트)·memory relflow·graphics-pipeline flowchart·
    game-math 랜딩(라이트, `querySelector` null 확인).
- [x] 6. 개행 LF 통일 + 전체 커밋 (후속 요청)
  - 현황: `topic-pages` 작업트리 21파일 CRLF(인덱스는 LF)·`.gitattributes` 없음.
    `vulkan-ref`·`game-math`는 LF + `.gitattributes` 이미 있음.
    `mathematics`는 LF이나 `.gitattributes` 없음. `blender-hardops-boxcutter`는 git 저장소 아님.
  - `topic-pages`·`mathematics`에 game-math 검증된 `.gitattributes` 추가 후
    `git add --renormalize` + 작업트리 LF 확인 → 저장소별 커밋.
  - 검증: `git ls-files --eol`에서 `w/crlf` 0건, 커밋 전 `status`·`diff` 확인, `nul` 없음.
  - 완료: 4 저장소 커밋, 작업트리 clean —
    `topic-pages@5a2104b`(5파일), `vulkan-ref@8da6d42`(site.json+계획문서),
    `mathematics@00c2585`(.gitattributes+site.json), `game-math@319dd84`(site.json).
    `topic-pages`는 renormalize 후 `status` 고스트(un staged 표시·`diff` empty)가 남아
    `git add -A`로 확정 → staged 5파일·미세 diff 확인 후 커밋. push는 요청 없어서 생략.

## Deviations (final-conformance에서 확인·승인)
- `.relflow`·`.cmdstack` 외곽 컨테이너: border 제거와 함께
  `background: var(--bg-elevated)` → `var(--surface)` + `box-shadow: var(--shadow-1)` 적용.
  근거: border 없이 `--bg-elevated`(라이트 `#fff`)면 페이지 배경과 같아져 컨테이너가 사라져 보이므로,
  acceptance criteria(그림자로 구분 유지)를 만족하기 위한 필요 조치.
- `lib/relflow.js` 푸터 prefix 제거 정규식 `^[↕↔⇅]` → `^[↕↔⇅→↓←↑]` 확장.
  근거: 푸터 아이콘이 `→`가 된 이상 기존 소스의 방향 prefix가 중복 화살표로 남지 않게 하기 위함.
  footer 단계 라인에만 적용되므로 headers/panels에 영향 없음.

## Acceptance criteria
- 랜딩 nav에 서브타이틀·구분선 없음, 랜딩 본문에 서브타이틀 없음 (4 사이트).
- 크롬 외각선 없음 + 카드 그림자로 구분 유지.
- 라이트 모드 버튼이 헤더와 구분됨.
- relflow 푸터가 `→`, flowchart·relflow 화살표가 확대·중앙정렬, cmdstack 화살표 표시.
- 4 사이트 빌드 성공, 기존 토픽 수·검색 인덱스 유지.

## Scope fidelity (사용자 지정 범위 verbatim)
- `C:\Users\lmsd1\Documents\projects\mathematics`
- `C:\Users\lmsd1\Documents\projects\blender-hardops-boxcutter`
- `C:\Users\lmsd1\Documents\projects\game-math`
- (+ `vulkan-ref` 본 사이트, + `topic-pages` 근본 수정)
