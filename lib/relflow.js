function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderBoxLines(lines) {
  return lines.map((line) => `<div class="relflow-line">${escapeHtml(line)}</div>`).join("");
}

export function renderRelflow(source) {
  let leftHeader = "";
  let rightHeader = "";
  let arrow = "→";
  const leftLines = [];
  const rightLines = [];
  const footer = [];
  let footerSide = "left";

  let phase = "headers";

  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed === "---") {
      if (phase === "headers") phase = "panels";
      else if (phase === "panels") phase = "footer";
      continue;
    }

    if (phase === "headers") {
      if (/^cpu:/i.test(trimmed)) leftHeader = trimmed.replace(/^cpu:\s*/i, "");
      else if (/^gpu:/i.test(trimmed)) rightHeader = trimmed.replace(/^gpu:\s*/i, "");
      else if (/^left:/i.test(trimmed)) leftHeader = trimmed.replace(/^left:\s*/i, "");
      else if (/^right:/i.test(trimmed)) rightHeader = trimmed.replace(/^right:\s*/i, "");
      else if (/^arrow:/i.test(trimmed)) arrow = trimmed.replace(/^arrow:\s*/i, "");
      continue;
    }

    if (phase === "panels") {
      const parts = trimmed.split("|").map((part) => part.trim());
      if (parts.length >= 2) {
        leftLines.push(parts[0]);
        rightLines.push(parts[1]);
      }
      continue;
    }

    if (/^foot:/i.test(trimmed)) {
      footerSide = trimmed.replace(/^foot:\s*/i, "").toLowerCase();
      continue;
    }

    footer.push(trimmed.replace(/^[↕↔⇅]\s*/, ""));
  }

  const footerHtml = footer
    .map(
      (item) =>
        `<div class="relflow-foot-item"><span class="relflow-foot-icon" aria-hidden="true">↕</span>${escapeHtml(item)}</div>`,
    )
    .join("");

  const footColumn =
    footerSide === "right" ? "relflow-foot-right" : footerSide === "center" ? "relflow-foot-center" : "relflow-foot-left";

  return `<div class="relflow">
  <div class="relflow-grid">
    <div class="relflow-col-title relflow-col-title-left">${escapeHtml(leftHeader)}</div>
    <div class="relflow-grid-spacer" aria-hidden="true"></div>
    <div class="relflow-col-title relflow-col-title-right">${escapeHtml(rightHeader)}</div>
    <div class="relflow-box relflow-box-left">${renderBoxLines(leftLines)}</div>
    <div class="relflow-arrow" aria-hidden="true">${escapeHtml(arrow)}</div>
    <div class="relflow-box relflow-box-right">${renderBoxLines(rightLines)}</div>
    ${
      footerHtml
        ? `<div class="relflow-foot ${footColumn}">${footerHtml}</div>`
        : ""
    }
  </div>
</div>`;
}
