import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "JustWork Doc Shell",
  version: "0.0.1",
  description: "协同文档骨架：独立页面工作台（Vditor 所见即所得）",
  icons: {
    "16": "justwork_logo.png",
    "32": "justwork_logo.png",
    "48": "justwork_logo.png",
    "128": "justwork_logo.png",
  },
  action: {
    default_title: "打开 JustWork",
    default_icon: {
      "16": "justwork_logo.png",
      "32": "justwork_logo.png",
      "48": "justwork_logo.png",
      "128": "justwork_logo.png",
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
