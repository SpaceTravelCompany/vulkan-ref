import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripReferences } from "./strip-references.mjs";
import {
  composeFromSections,
  parseBodySections,
  filterSections,
  splitExtensionSections,
} from "../lib/compose-content.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const postsDir = "E:/vulkan_posts_backup/posts";
const contentDir = path.join(root, "content");
const extensionsSource = "E:/Note/Programming/research/vulkan-essential-extensions-guide_20260607.md";

const DRAW_NOT_SHOWING = `원문 메모: vkCmdDraw의 **instanceCount는 최소 1**이어야 한다. 인스턴싱을 쓰지 않아도 1로 설정해야 화면에 그려진다.

vkCmdDraw 계열을 호출했는데 화면이 비어 있을 때, 아래 순서대로 점검한다. 대부분은 **렌더 패스·파이프라인·버텍스·디스크립터** 중 하나가 빠졌거나, **instanceCount가 0**인 경우다.

---

## 1. Draw 파라미터

\`vkCmdDraw\`, \`vkCmdDrawIndexed\` 등에서 **instanceCount는 최소 1**이어야 한다. 인스턴싱을 쓰지 않더라도 1로 설정해야 화면에 그려진다.

\`\`\`c
// 잘못된 예 — 아무것도 그려지지 않음
vkCmdDraw(cmd, vertexCount, 0, firstVertex, firstInstance);

// 올바른 예
vkCmdDraw(cmd, vertexCount, 1, firstVertex, firstInstance);
\`\`\`

| 파라미터 | 흔한 실수 |
|---------|----------|
| \`vertexCount\` / \`indexCount\` | 0이면 드로우 없음 |
| \`instanceCount\` | 0이면 드로우 없음 (가장 흔한 함정) |
| \`firstVertex\` / \`firstIndex\` | 버퍼 범위를 벗어나면 검증 레이어에서 경고 |

---

## 2. 렌더 패스 / Dynamic Rendering

그래픽스 파이프라인 드로우는 **활성 렌더 패스 안**에서만 유효하다.

\`\`\`cmdstack
vkCmdBeginRenderPass / vkCmdBeginRendering ← 필수
---
vkCmdBindPipeline(GRAPHICS)
vkCmdBindVertexBuffers / vkCmdBindIndexBuffer
vkCmdBindDescriptorSets
vkCmdDraw(...)
---
vkCmdEndRenderPass / vkCmdEndRendering
\`\`\`

- Dynamic Rendering(\`vkCmdBeginRendering\`)을 쓰면 attachment \`imageView\`·\`loadOp\`·\`storeOp\`가 올바른지 확인
- \`renderArea.extent\`가 0이면 아무것도 그려지지 않음
- 스왑체인 이미지에 그릴 때 **올바른 image index**의 view를 썼는지 확인

---

## 3. 파이프라인 & 뷰포트

\`\`\`cmdstack
vkCmdBindPipeline(cmd, GRAPHICS, pipeline) ← 필수
vkCmdSetViewport / vkCmdSetScissor ← dynamic state면 필수
vkCmdDraw(...)
\`\`\`

- 파이프라인이 **GRAPHICS** 바인드 포인트인지
- \`VK_DYNAMIC_STATE_VIEWPORT\` / \`SCISSOR\`를 켰다면 \`vkCmdSetViewport\`·\`vkCmdSetScissor\` 호출 여부
- 뷰포트가 화면 밖이거나 scissor가 0×0이면 보이지 않음
- **컬링**: \`VK_CULL_MODE_BACK_BIT\` + 잘못된 \`frontFace\`면 삼각형이 전부 컬링될 수 있음

---

## 4. 버텍스 / 인덱스 버퍼

- \`vkCmdBindVertexBuffers\`로 올바른 버퍼·오프셋 바인딩
- \`vkCmdBindIndexBuffer\` + \`vkCmdDrawIndexed\` 사용 시 인덱스 타입(\`UINT16\`/\`UINT32\`) 일치
- 버텍스 입력 설명(\`VkPipelineVertexInputStateCreateInfo\`)과 실제 버퍼 레이아웃 일치
- GPU 메모리에 업로드되었는지, staging → device local 복사 후 **배리어**로 가시성 확보했는지

---

## 5. Descriptor / Push Constant

셰이더가 UBO·텍스처·샘플러를 읽는다면:

\`\`\`cmdstack
VkDescriptorSetLayout 정의
---
VkDescriptorSet 할당 + vkUpdateDescriptorSets
---
vkCmdBindDescriptorSets(cmd, ..., pipelineLayout)
---
vkCmdDraw
\`\`\`

- \`set\` / \`binding\` 번호가 GLSL \`layout(set=, binding=)\`와 일치
- 파이프라인 레이아웃이 descriptor set layout과 호환
- Push constant 크기·오프셋이 셰이더 \`layout(push_constant)\`와 일치

---

## 6. 셰이더 출력 & 깊이

- 프래그먼트가 **알파 0**이거나 discard하면 투명
- 깊이 테스트(\`depthTestEnable\`) + \`depthWriteEnable\` + clear 값으로 전부 가려짐
- \`colorWriteMask\`가 0이면 컬러 버퍼에 쓰지 않음
- 스왑체인 **surface format**과 attachment format·blend 설정 호환

---

## 7. 동기화 & 제출

\`\`\`cmdstack
vkAcquireNextImageKHR ← 스왑체인 이미지 획득
---
커맨드 버퍼 기록 (렌더링)
---
vkQueueSubmit ← semaphore/fence
---
vkQueuePresentKHR
\`\`\`

- 커맨드 버퍼를 \`vkEndCommandBuffer\` 후 \`vkQueueSubmit\` 했는지
- acquire semaphore를 submit의 wait로 연결했는지
- fence로 프레임 리소스 재사용 타이밍을 맞췄는지
- 검증 레이어(\`VK_LAYER_KHRONOS_validation\`)를 켜면 대부분의 실수가 로그로 나온다

---

## 8. 빠른 체크리스트

| # | 확인 항목 |
|---|----------|
| 1 | \`instanceCount >= 1\` |
| 2 | 렌더 패스 / BeginRendering 활성 |
| 3 | Graphics 파이프라인 바인딩 |
| 4 | Viewport / Scissor 설정 |
| 5 | 버텍스(·인덱스) 버퍼 바인딩 & GPU 업로드 |
| 6 | Descriptor set 바인딩 |
| 7 | 커맨드 버퍼 submit + present |
| 8 | 검증 레이어 메시지 |
`;

const OUTPUT_SLUGS = [
  "draw-not-showing",
  "graphics-pipeline",
  "compute-pipeline",
  "mesh-shader",
  "descriptors",
  "memory",
  "render-pass",
  "synchronization",
  "performance",
  "thread-safety",
  "extensions-foundation",
  "extensions-rendering",
  "extensions-advanced",
];

function stripBlogRefs(text) {
  return text
    .replace(/\[([^\]]+)\]\(\/posts\/\d+[^)]*\)/g, "$1")
    .replace(/https?:\/\/[^\s)]+\/posts\/\d+/g, "")
    .replace(/^공통 3D 최적화.*\n\n/m, "");
}

async function readPostBody(id) {
  const raw = await fs.readFile(path.join(postsDir, `${id}.md`), "utf-8");
  return stripReferences(stripBlogRefs(raw.replace(/^---[\s\S]*?---\n/, ""))).trim();
}

async function readPostSections(id) {
  return parseBodySections(await readPostBody(id));
}

function introOf(sections) {
  return sections.find((s) => s.title === "소개") ?? null;
}

function maybeIntro(section) {
  return section ? [section] : [];
}

function writeTopic(slug, title, body) {
  return `---
title: ${title}
slug: ${slug}
---

${body.trim()}
`;
}

async function main() {
  await fs.mkdir(contentDir, { recursive: true });

  const [
    graphics,
    compute,
    mesh,
    descriptors,
    memory,
    subpass,
    optimization,
    sync,
    barriers,
    threading,
  ] = await Promise.all([
    readPostSections("31"),
    readPostSections("32"),
    readPostSections("3"),
    readPostSections("28"),
    readPostSections("33"),
    readPostSections("29"),
    readPostSections("35"),
    readPostSections("27"),
    readPostSections("4"),
    readPostSections("30"),
  ]);

  const topics = {
    "draw-not-showing": {
      title: "그래픽이 안 나올 때",
      body: DRAW_NOT_SHOWING,
    },
    "graphics-pipeline": {
      title: "그래픽스 파이프라인",
      body: composeFromSections([
        filterSections(graphics, {
          exclude: [{ excludes: "Mesh Shader Pipeline" }],
        }),
      ]),
    },
    "compute-pipeline": {
      title: "컴퓨트 파이프라인",
      body: composeFromSections([compute]),
    },
    "mesh-shader": {
      title: "메시 셰이더",
      body: composeFromSections([
        mesh,
        filterSections(graphics, {
          include: [{ includes: "Mesh Shader Pipeline" }],
        }),
      ]),
    },
    descriptors: {
      title: "Descriptor & Layout",
      body: composeFromSections([descriptors]),
    },
    memory: {
      title: "메모리",
      body: composeFromSections([memory]),
    },
    "render-pass": {
      title: "Render Pass & 서브패스",
      body: composeFromSections([
        subpass,
        filterSections(optimization, {
          include: [{ startsWith: "1. 렌더 패스" }],
        }),
      ]),
    },
    synchronization: {
      title: "동기화 전체",
      body: composeFromSections([
        maybeIntro(introOf(sync)),
        filterSections(sync, {
          include: [
            { startsWith: "1. 개요" },
            { startsWith: "2. Fence" },
            { startsWith: "3. Semaphore" },
            { startsWith: "4. Event" },
            { startsWith: "5. Pipeline Barrier" },
          ],
        }),
        maybeIntro(introOf(barriers)),
        barriers.filter((s) => s.title !== "소개"),
        filterSections(sync, {
          include: [
            { startsWith: "6. 뭐부터" },
            { startsWith: "7. 비교" },
            { startsWith: "8. 타임라인" },
          ],
        }),
        filterSections(optimization, {
          include: [{ startsWith: "2. 파이프라인 배리어" }],
        }).map((s) => ({
          ...s,
          title: "배리어 최적화 팁",
        })),
      ]),
    },
    performance: {
      title: "성능 최적화",
      body: composeFromSections([
        maybeIntro(introOf(optimization)),
        filterSections(optimization, {
          include: [
            { startsWith: "3. 디스크립터" },
            { startsWith: "4. 메모리" },
            { startsWith: "5. 파이프라인 캐시" },
            { startsWith: "6. 커맨드 버퍼" },
            { startsWith: "7. 고급" },
            { startsWith: "8. 최적화 체크리스트" },
          ],
        }),
      ]),
    },
    "thread-safety": {
      title: "멀티스레딩",
      body: composeFromSections([threading]),
    },
  };

  const extensionsRaw = stripReferences(
    (await fs.readFile(extensionsSource, "utf-8"))
      .replace(/^# Vulkan 필수 확장기능 상세 가이드\n/, "")
      .trim(),
  );
  const extSections = parseBodySections(extensionsRaw);
  const extGroups = splitExtensionSections(extSections);

  topics["extensions-foundation"] = {
    title: "확장기능 — 핵심 기반",
    body: composeFromSections([extGroups.foundation]),
  };
  topics["extensions-rendering"] = {
    title: "확장기능 — 렌더링",
    body: composeFromSections([extGroups.rendering]),
  };
  topics["extensions-advanced"] = {
    title: "확장기능 — 고급",
    body: composeFromSections([extGroups.advanced]),
  };

  const existing = await fs.readdir(contentDir);
  for (const file of existing) {
    if (!file.endsWith(".md")) continue;
    const slug = file.replace(/\.md$/, "");
    if (!OUTPUT_SLUGS.includes(slug)) {
      await fs.unlink(path.join(contentDir, file));
      console.log(`  removed ${file}`);
    }
  }

  for (const slug of OUTPUT_SLUGS) {
    const { title, body } = topics[slug];
    await fs.writeFile(path.join(contentDir, `${slug}.md`), writeTopic(slug, title, body), "utf-8");
    const sectionCount = parseBodySections(body).length;
    console.log(`  ${slug}.md (${sectionCount} sections)`);
  }

  console.log("\nDone. Run npm run build to generate HTML.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
