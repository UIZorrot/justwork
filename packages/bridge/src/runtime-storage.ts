import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeStorage } from "@justwork/workspace-runtime";

export function createFileRuntimeStorage(dir: string): RuntimeStorage {
  const filePath = path.join(dir, "runtime-storage.json");

  const readAll = async (): Promise<Record<string, unknown>> => {
    try {
      return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  const writeAll = async (data: Record<string, unknown>): Promise<void> => {
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
  };

  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const data = await readAll();
      return data[key] as T | undefined;
    },
    async set<T = unknown>(key: string, value: T): Promise<void> {
      const data = await readAll();
      data[key] = value;
      await writeAll(data);
    },
    async remove(key: string): Promise<void> {
      const data = await readAll();
      delete data[key];
      await writeAll(data);
    },
  };
}
