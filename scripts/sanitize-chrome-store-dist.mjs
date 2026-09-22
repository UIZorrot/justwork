import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/** @typedef {[RegExp, string]} Replacement */

/** @type {Replacement[]} */
export const REMOTE_CODE_REPLACEMENTS = [
  [/https:\/\/unpkg\.com\/vditor@/g, "vendor/vditor@"],
  [/https:\/\/unpkg\.com\/vditor\/dist/g, "vendor/vditor/dist"],
  [/https:\/\/unpkg\.com\/vditor/g, "vendor/vditor"],
  [/https:\/\/cdn\.jsdelivr\.net\/npm\/vditor\/dist/g, "vendor/vditor/dist"],
  [/https:\/\/cdn\.jsdelivr\.net\/npm\/vditor[^"'`\s)]+/g, "vendor/vditor"],
  [/https:\/\/unpkg\.com\/[^"'`\s)]+/g, "extension-local-resource"],
  [/https:\/\/cdn\.jsdelivr\.net\/[^"'`\s)]+/g, "extension-local-resource"],
];

/** @type {RegExp[]} */
export const REMOTE_CODE_PATTERNS = [
  /unpkg\.com/,
  /jsdelivr\.net/,
];

/**
 * @param {string} text
 * @returns {string}
 */
export function sanitizeRemoteCodeLiterals(text) {
  let output = text;
  for (const [pattern, replacement] of REMOTE_CODE_REPLACEMENTS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

/**
 * @param {string} dir
 * @returns {Promise<{ files: number; changed: number }>}
 */
export async function sanitizeDistDirectory(dir) {
  let files = 0;
  let changed = 0;

  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      files += 1;
      const before = await readFile(absolute, "utf8");
      const after = sanitizeRemoteCodeLiterals(before);
      if (after !== before) {
        changed += 1;
        await writeFile(absolute, after, "utf8");
      }
    }
  }

  await walk(dir);
  return { files, changed };
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function findRemoteCodeViolations(text) {
  const hits = [];
  for (const pattern of REMOTE_CODE_PATTERNS) {
    if (pattern.test(text)) {
      hits.push(pattern.source);
    }
  }
  return hits;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const distDir = join(process.cwd(), "dist");
  const result = await sanitizeDistDirectory(distDir);
  console.log(`Sanitized ${result.changed}/${result.files} JS files in dist/`);
}
