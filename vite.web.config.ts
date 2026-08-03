import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const workbenchDir = path.resolve(rootDir, "src/pages/workbench");

export default defineConfig({
  root: workbenchDir,
  publicDir: path.resolve(rootDir, "public"),
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
    },
  },
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: "../../../node_modules/vditor/dist",
          dest: "vendor/vditor",
        },
      ],
    }),
  ],
  build: {
    outDir: path.resolve(rootDir, "dist-web"),
    emptyOutDir: true,
  },
});
