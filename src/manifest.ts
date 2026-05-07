import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "JustWork Doc Shell",
  version: "0.0.1",
  description: "协同文档骨架：独立页面工作台（Vditor 所见即所得）",
  icons: {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png",
  },
  action: {
    default_title: "打开 JustWork",
    default_icon: {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png",
    },
  },
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  options_ui: {
    page: "src/pages/workbench/index.html",
    open_in_tab: true,
  },
  permissions: ["storage"],
  host_permissions: ["http://127.0.0.1/*", "http://localhost/*"],
  web_accessible_resources: [
    {
      resources: ["vendor/vditor/**/*"],
      matches: ["<all_urls>"],
    },
  ],
});
