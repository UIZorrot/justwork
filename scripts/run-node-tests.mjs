import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const ignoredDirs = new Set([".git", ".justwork-data", ".worktrees", "dist", "node_modules"]);

async function findTests(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolute = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) {
        files.push(...(await findTests(absolute)));
      }
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
      files.push(absolute);
    }
  }

  return files;
}

const requested = process.argv.slice(2);
const testFiles = requested.length > 0
  ? requested.map((file) => join(root, file))
  : await findTests(root);

for (const file of testFiles.sort()) {
  const label = relative(root, file).split(sep).join("/");
  console.log(`# ${label}`);
  await import(pathToFileURL(file).href);
}
