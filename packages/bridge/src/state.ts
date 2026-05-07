import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type DocState = {
  markdown: string;
  revision: number;
  updatedAt: string;
};

export function emptyState(): DocState {
  const now = new Date().toISOString();
  return { markdown: "", revision: 0, updatedAt: now };
}

export async function persistState(dir: string, state: DocState): Promise<void> {
  await mkdir(dir, { recursive: true });
  const base = path.join(dir);
  await writeFile(path.join(base, "document.md"), state.markdown, "utf8");
  await writeFile(
    path.join(base, "state.json"),
    JSON.stringify({ revision: state.revision, updatedAt: state.updatedAt }, null, 2),
    "utf8",
  );
}

export async function loadState(dir: string): Promise<DocState | null> {
  try {
    const mdPath = path.join(dir, "document.md");
    const stPath = path.join(dir, "state.json");
    const markdown = await readFile(mdPath, "utf8");
    const raw = await readFile(stPath, "utf8");
    const meta = JSON.parse(raw) as { revision?: number; updatedAt?: string };
    return {
      markdown,
      revision: typeof meta.revision === "number" ? meta.revision : 0,
      updatedAt: typeof meta.updatedAt === "string" ? meta.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
