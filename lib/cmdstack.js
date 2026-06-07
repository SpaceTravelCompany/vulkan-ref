import { escapeHtml } from "./html.js";

function isBoxBorder(line) {
  const trimmed = line.trim();
  return (
    !trimmed ||
    /^[┌└├│┐┘─┬┴┼▼▲\s]+$/.test(trimmed) ||
    /^[│|]\s*$/.test(trimmed) ||
    /^[↓↑\s]+$/.test(trimmed)
  );
}

function treeDepth(line) {
  const prefix = line.match(/^[\s│|]*/)?.[0] ?? "";
  let depth = (prefix.match(/│/g) || []).length;
  if (/^\s*(?:├──|└──)/.test(line.trim())) {
    depth = Math.max(depth + 1, 1);
  }
  return depth;
}

function normalizeLine(line) {
  let text = line.trim();
  if (isBoxBorder(text)) return null;

  text = text.replace(/^──\s*/, "");
  text = text.replace(/^│\s*/, "");

  const pipeParts = text
    .split("│")
    .map((part) => part.trim())
    .filter(Boolean);

  if (pipeParts.length >= 2) {
    return { cmd: pipeParts[0], note: pipeParts.slice(1).join(" · "), depth: treeDepth(line) };
  }

  if (/^(?:├──|└──)/.test(text)) {
    text = text.replace(/^(?:├──|└──)\s*/, "");
  }

  const arrow = text.match(/^(.+?)\s*(?:←|──|→)\s*(.+)$/);
  if (arrow) {
    return { cmd: arrow[1].trim(), note: arrow[2].trim(), depth: treeDepth(line) };
  }

  return { cmd: text, note: "", depth: treeDepth(line) };
}

function parseRow(line) {
  const parsed = normalizeLine(line);
  if (!parsed) return null;

  const { cmd, note, depth } = parsed;
  const noteHtml = note ? `<span class="cmdstack-note">${escapeHtml(note)}</span>` : "";
  const depthStyle = depth > 0 ? ` style="--cmdstack-depth: ${depth}"` : "";
  const treeClass = depth > 0 ? " cmdstack-row-tree" : "";

  return `<div class="cmdstack-row${treeClass}"${depthStyle}>
    <code class="cmdstack-cmd">${escapeHtml(cmd)}</code>
    ${noteHtml}
  </div>`;
}

function splitSections(source) {
  const sections = [];
  let current = [];

  for (const line of source.split("\n")) {
    const trimmed = line.trim();

    if (/^-{3,}\s*$/.test(trimmed)) {
      if (current.length) sections.push(current);
      current = [];
      continue;
    }

    if (isBoxBorder(trimmed) || trimmed === "│") continue;

    current.push(line);
  }

  if (current.length) sections.push(current);
  return sections;
}

export function renderCmdstack(source) {
  const sections = splitSections(source.trim());
  if (sections.length === 0) return "";

  const sectionHtml = sections
    .map((lines) => {
      const rows = lines.map(parseRow).filter(Boolean).join("");
      return `<div class="cmdstack-section">${rows}</div>`;
    })
    .join('<div class="cmdstack-divider" aria-hidden="true"></div>');

  return `<div class="cmdstack">${sectionHtml}</div>`;
}
