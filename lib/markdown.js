import { marked } from "marked";
import { renderCmdstack } from "./cmdstack.js";
import { renderRelflow } from "./relflow.js";

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\u3131-\uD79D\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function uniqueSlug(base, used) {
  let slug = base || "section";
  let i = 2;
  while (used.has(slug)) {
    slug = `${base}-${i++}`;
  }
  used.add(slug);
  return slug;
}

export function renderMarkdown(markdown) {
  const headings = [];
  const usedIds = new Set();
  const renderer = new marked.Renderer();
  const defaultTable = renderer.table.bind(renderer);

  renderer.heading = ({ tokens, depth }) => {
    const text = tokens.map((token) => token.raw ?? token.text ?? "").join("");
    const id = uniqueSlug(slugify(text), usedIds);

    if (depth <= 4) {
      headings.push({ id, text, depth });
    }

    return `<h${depth} id="${id}">${escapeHtml(text)}</h${depth}>`;
  };

  renderer.table = (token) => {
    return `<div class="prose-table-wrap">${defaultTable(token)}</div>`;
  };

  renderer.code = (token) => {
    if (token.lang === "cmdstack" || token.lang === "diagram") {
      return renderCmdstack(token.text);
    }
    if (token.lang === "relflow") {
      return renderRelflow(token.text);
    }

    const lang = token.lang || "text";
    const escaped = escapeHtml(token.text);
    return `<div class="code-toolbar"><pre class="language-${lang}"><code class="language-${lang}">${escaped}</code></pre></div>`;
  };

  const html = marked(markdown, { renderer });
  return { html, headings };
}
