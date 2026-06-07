import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const postsBackupDir = "E:/vulkan_posts_backup/posts";

const REF_SECTION =
  /\r?\n---\r?\n\r?\n## (?:참고 출처|참고 자료|Evidence|참고|\d+\. 참고)\r?\n[\s\S]*$/;

const STANDALONE_SOURCE_LINE = /^\[출처\]\([^)]+\)\s*\r?\n/gm;
const TRAILING_SOURCE_BLOCK = /\r?\n출처:\s*\r?\n(?:\r?\n- .+)+$/m;

export function stripReferences(content) {
  let text = content;
  text = text.replace(REF_SECTION, "");
  text = text.replace(STANDALONE_SOURCE_LINE, "");
  text = text.replace(TRAILING_SOURCE_BLOCK, "");
  return text.trimEnd() + "\n";
}

async function processDir(dir) {
  const entries = await fs.readdir(dir);
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(dir, name);
    const raw = await fs.readFile(file, "utf-8");
    const next = stripReferences(raw);
    if (next !== raw) {
      await fs.writeFile(file, next, "utf-8");
      console.log(`  ${file}`);
    }
  }
}

async function main() {
  console.log("backup posts/");
  await processDir(postsBackupDir);
  console.log("content/");
  await processDir(path.join(root, "content"));
  console.log("done");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
