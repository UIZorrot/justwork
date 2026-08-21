import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.resolve(rootDir, "website");
const outDir = path.resolve(rootDir, "dist-site");

function assembleSite(): Plugin {
  return {
    name: "assemble-justwork-site",
    closeBundle() {
      const packageJson = JSON.parse(readFileSync(path.resolve(rootDir, "package.json"), "utf8")) as {
        version: string;
      };
      const zipName = `justwork-chrome-store-v${packageJson.version}.zip`;
      const zipSource = path.resolve(siteDir, "public", "downloads", zipName);
      const appSource = path.resolve(rootDir, "dist-web");

      if (!existsSync(zipSource)) {
        throw new Error(`Missing website release asset: ${zipName}. Package and copy the current extension release first.`);
      }
      if (!existsSync(appSource)) {
        throw new Error("Missing dist-web. Run yarn build:web:site first.");
      }

      const downloadDir = path.resolve(outDir, "downloads");
      mkdirSync(downloadDir, { recursive: true });
      cpSync(appSource, path.resolve(outDir, "app"), { recursive: true });

      const bytes = readFileSync(zipSource);
      writeFileSync(
        path.resolve(downloadDir, "latest.json"),
        `${JSON.stringify({
          version: packageJson.version,
          filename: zipName,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }, null, 2)}\n`,
      );
    },
  };
}

export default defineConfig({
  root: siteDir,
  publicDir: path.resolve(siteDir, "public"),
  plugins: [assembleSite()],
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        home: path.resolve(siteDir, "index.html"),
        docs: path.resolve(siteDir, "docs", "index.html"),
        privacy: path.resolve(siteDir, "privacy", "index.html"),
        disclaimer: path.resolve(siteDir, "disclaimer", "index.html"),
        homeEn: path.resolve(siteDir, "en", "index.html"),
        docsEn: path.resolve(siteDir, "en", "docs", "index.html"),
        privacyEn: path.resolve(siteDir, "en", "privacy", "index.html"),
        disclaimerEn: path.resolve(siteDir, "en", "disclaimer", "index.html"),
      },
    },
  },
});
