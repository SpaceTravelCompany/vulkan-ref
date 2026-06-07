export function splitMarkdownByH2(body, { introTitle = "소개", hiddenTitles = ["목차"] } = {}) {
  const chunks = [];
  const hiddenTitleSet = new Set(hiddenTitles);
  let intro = [];
  let current = null;

  function pushIntro() {
    if (!intro.some((line) => line.trim() !== "")) {
      intro = [];
      return;
    }
    chunks.push({ title: introTitle, lines: [...intro] });
    intro = [];
  }

  for (const line of body.split("\n")) {
    if (/^## /.test(line)) {
      if (current) chunks.push(current);
      else pushIntro();
      current = { title: line.slice(3).trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      intro.push(line);
    }
  }

  if (current) chunks.push(current);
  else pushIntro();

  return chunks.filter((chunk) => !hiddenTitleSet.has(chunk.title));
}
