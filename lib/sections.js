export function splitMarkdownByH2(body) {
  const chunks = [];
  let intro = [];
  let current = null;

  for (const line of body.split("\n")) {
    if (/^## /.test(line)) {
      if (current) chunks.push(current);
      else if (intro.length) {
        chunks.push({ title: "소개", lines: [...intro] });
        intro = [];
      }
      current = { title: line.slice(3).trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      intro.push(line);
    }
  }

  if (current) chunks.push(current);
  else if (intro.length) chunks.push({ title: "소개", lines: intro });

  return chunks.filter((chunk) => chunk.title !== "목차");
}
