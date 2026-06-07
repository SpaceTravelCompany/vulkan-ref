import { splitMarkdownByH2 } from "./sections.js";

function matchSection(section, rule) {
  if (rule === "*") return true;
  if (typeof rule === "string") return section.title.startsWith(rule) || section.title === rule;
  if (rule.startsWith) return section.title.startsWith(rule.startsWith);
  if (rule.includes) return section.title.includes(rule.includes);
  return false;
}

function shouldExclude(section, rule) {
  if (rule.excludes) return section.title.includes(rule.excludes);
  return matchSection(section, rule);
}

function pickSections(sections, rules) {
  const picked = [];
  for (const rule of rules) {
    if (rule === "*") {
      picked.push(...sections);
      continue;
    }
    for (const section of sections) {
      if (matchSection(section, rule) && !picked.includes(section)) {
        picked.push(section);
      }
    }
  }
  return picked;
}

export function sectionsToMarkdown(sections) {
  return sections
    .map((s) => `## ${s.title}\n\n${s.lines.join("\n").trim()}`)
    .join("\n\n---\n\n");
}

export function composeFromSections(sectionGroups) {
  return sectionsToMarkdown(sectionGroups.flat());
}

export function parseBodySections(body) {
  return splitMarkdownByH2(body.trim());
}

export function filterSections(sections, { include, exclude } = {}) {
  let result = sections;
  if (include) {
    result = pickSections(result, include);
  }
  if (exclude) {
    result = result.filter((s) => !exclude.some((rule) => shouldExclude(s, rule)));
  }
  return result;
}

export function splitExtensionSections(sections) {
  const meta = sections.filter((s) =>
    ["Summary", "선별 기준"].includes(s.title),
  );
  const numbered = sections.filter((s) => /^\d+\./.test(s.title));
  const summaryEnd = sections.filter((s) => s.title.startsWith("종합"));

  const byNum = (from, to) =>
    numbered.filter((s) => {
      const n = Number.parseInt(s.title, 10);
      return n >= from && n <= to;
    });

  return {
    foundation: [...meta, ...byNum(1, 6), ...summaryEnd],
    rendering: byNum(7, 12),
    advanced: byNum(13, 20),
  };
}
