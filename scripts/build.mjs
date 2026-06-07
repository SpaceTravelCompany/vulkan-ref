import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdown } from "../lib/markdown.js";
import { splitMarkdownByH2 } from "../lib/sections.js";
import { escapeHtml, slugify } from "../lib/html.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const contentDir = path.join(root, "content");
const assetsDir = path.join(root, "assets");

const site = JSON.parse(await fs.readFile(path.join(root, "site.json"), "utf-8"));

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };

  const meta = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: match[2] };
}

function buildTopicSections(body) {
  const chunks = splitMarkdownByH2(body.trim());
  const usedIds = new Set();

  return chunks.map((chunk) => {
    const { html } = renderMarkdown(chunk.lines.join("\n").trim());
    const baseId = slugify(chunk.title, { maxLength: 80 });
    let id = baseId;
    let n = 2;
    while (usedIds.has(id)) {
      id = `${baseId}-${n++}`;
    }
    usedIds.add(id);
    return { id, title: chunk.title, html };
  });
}

function renderNav(siteData) {
  const groups = site.sections
    .map((section) => {
      const buttons = section.topics
        .map((topic) => {
          return `<button type="button" class="topic-btn" data-topic="${topic.slug}" title="${escapeHtml(topic.summary)}">
  <span class="topic-btn-icon" aria-hidden="true">${topic.icon}</span>
  <span class="topic-btn-label">${escapeHtml(topic.title)}</span>
</button>`;
        })
        .join("");
      return `<div class="nav-group">
  <p class="nav-group-label">${escapeHtml(section.title)}</p>
  <div class="nav-group-btns">${buttons}</div>
</div>`;
    })
    .join("");

  return `<nav class="nav-panel" aria-label="주제">
  <div class="nav-brand">
    <div class="brand-btn">
      <span class="brand-mark">Vk</span>
      <span class="brand-text">${escapeHtml(site.title)}</span>
    </div>
    <p class="brand-sub">${escapeHtml(site.subtitle)}</p>
  </div>
  ${groups}
  <div class="nav-reference" aria-label="Vulkan 참고 레퍼런스">
    <p class="nav-group-label">Vulkan 참고 레퍼런스</p>
    <div class="reference-links">
      <a class="reference-link" href="https://docs.vulkan.org/refpages/latest/" target="_blank" rel="noopener noreferrer">
        <span class="reference-link-mark" aria-hidden="true">↗</span>
        <span class="reference-link-label">Vulkan Reference</span>
      </a>
      <a class="reference-link" href="https://www.howtovulkan.com/" target="_blank" rel="noopener noreferrer">
        <span class="reference-link-mark" aria-hidden="true">↗</span>
        <span class="reference-link-label">How to Vulkan</span>
      </a>
      <a class="reference-link" href="https://vulkan.gpuinfo.org/" target="_blank" rel="noopener noreferrer">
        <span class="reference-link-mark" aria-hidden="true">↗</span>
        <span class="reference-link-label">Vulkan Hardware Database</span>
      </a>
      <a class="reference-link" href="https://vulkan.lunarg.com/sdk/home" target="_blank" rel="noopener noreferrer">
        <span class="reference-link-mark" aria-hidden="true">↗</span>
        <span class="reference-link-label">LunarG Vulkan SDK</span>
      </a>
    </div>
  </div>
  <div class="nav-license" aria-label="라이선스">
    <a class="cc-badge" href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="license noopener noreferrer" title="문서/콘텐츠: CC BY-NC-SA 4.0">
      <img class="cc-badge-img" src="assets/cc-by-nc-sa.svg" alt="CC BY-NC-SA 4.0">
    </a>
  </div>
</nav>`;
}

async function buildSiteData() {
  const slugs = [...new Set(site.sections.flatMap((s) => s.topics.map((t) => t.slug)))];
  const topicMetaBySlug = new Map(
    site.sections.flatMap((section) => section.topics.map((topic) => [topic.slug, topic])),
  );

  const topics = {};

  for (const slug of slugs) {
    const raw = await fs.readFile(path.join(contentDir, `${slug}.md`), "utf-8");
    const { meta, body } = parseFrontmatter(raw);
    const metaTopic = topicMetaBySlug.get(slug);

    topics[slug] = {
      title: meta.title || slug,
      summary: metaTopic?.summary || "",
      sections: buildTopicSections(body),
    };
    console.log(`  ${slug}: ${topics[slug].sections.length} sections`);
  }

  return { site, topics };
}

function renderPage(siteData) {
  const json = JSON.stringify(siteData).replace(/</g, "\\u003c");
  const nav = renderNav(siteData);

  return `<!DOCTYPE html>
<html lang="ko" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(site.title)}</title>
  <link rel="icon" type="image/svg+xml" href="assets/favicon.svg">
  <script>
    (function () {
      var key = "vulkan-ref-theme";
      var saved = localStorage.getItem(key);
      var theme = saved;
      if (!theme) {
        theme = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
      }
      document.documentElement.dataset.theme = theme;
    })();
  </script>
  <link rel="stylesheet" href="assets/main.css">
  <link rel="stylesheet" href="assets/prism.css">
</head>
<body>
  <div class="app" id="app">
    <div class="nav-backdrop" id="nav-backdrop" hidden></div>
    ${nav}
    <main class="main-panel" id="main-panel">
      <header class="main-header">
        <button type="button" class="icon-btn nav-toggle" id="nav-toggle" aria-label="주제 메뉴">☰</button>
        <div class="main-header-text">
          <p class="main-eyebrow" id="topic-eyebrow">${escapeHtml(site.title)}</p>
          <h1 class="main-title" id="section-title"></h1>
        </div>
        <div class="main-header-actions">
          <button type="button" class="icon-btn theme-toggle" id="theme-toggle" aria-label="테마 전환">
            <span class="theme-icon-dark" aria-hidden="true">☾</span>
            <span class="theme-icon-light" aria-hidden="true">☀</span>
          </button>
          <button type="button" class="text-btn" id="tabs-toggle" aria-expanded="true" aria-controls="section-tabs-wrap">섹션 숨기기</button>
          <button type="button" class="icon-btn sec-nav-btn" id="sec-prev" disabled aria-label="이전 섹션">‹</button>
          <span class="sec-counter" id="sec-counter"></span>
          <button type="button" class="icon-btn sec-nav-btn" id="sec-next" disabled aria-label="다음 섹션">›</button>
        </div>
      </header>
      <div class="section-tabs-wrap" id="section-tabs-wrap">
        <div class="section-tabs" id="section-tabs" role="tablist"></div>
      </div>
      <article class="content-viewport prose" id="content-viewport" role="tabpanel"></article>
    </main>
  </div>
  <script type="application/json" id="site-data">${json}</script>
  <script src="assets/prism.js"></script>
  <script src="assets/app.js"></script>
</body>
</html>`;
}

async function copyAssets() {
  const dest = path.join(distDir, "assets");
  await fs.mkdir(dest, { recursive: true });
  for (const file of ["main.css", "prism.css", "prism.js", "app.js", "favicon.svg", "cc-by-nc-sa.svg"]) {
    await fs.copyFile(path.join(assetsDir, file), path.join(dest, file));
  }
}

async function main() {
  await fs.rm(distDir, { recursive: true, force: true });
  await fs.mkdir(distDir, { recursive: true });

  const siteData = await buildSiteData();
  const page = renderPage(siteData);
  await fs.writeFile(path.join(distDir, "index.html"), page, "utf-8");
  console.log("  index.html (SPA)");

  await copyAssets();
  console.log("\nBuild complete → vulkan-ref/dist/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
