export function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function slugify(text, { fallback = "section", maxLength } = {}) {
  let slug = String(text)
    .toLowerCase()
    .replace(/[^\w\u3131-\uD79D\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");

  if (typeof maxLength === "number") {
    slug = slug.slice(0, maxLength);
  }

  return slug || fallback;
}
