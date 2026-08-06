import { defineManifest } from "@crxjs/vite-plugin";

const isChromeStoreRelease = process.env.JUSTWORK_CHROME_STORE === "1";

export default defineManifest({
  manifest_version: 3,
  name: "JustWork — Encrypted Collaborative Workspace for Humans and AI Agents",
  short_name: "JustWork",
  version: "0.0.8",
  description: "An Agent-native collaborative workspace for teams, built end to end for usability, openness, and powerful human–Agent workflows.",
  icons: {
    "16": "justwork_logo.png",
    "32": "justwork_logo.png",
    "48": "justwork_logo.png",
    "128": "justwork_logo.png",
  },
  action: {
    default_title: "Open JustWork",
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
  host_permissions: isChromeStoreRelease
    ? ["https://api.tool.justwork.txzy.net/*"]
    : ["https://api.tool.justwork.txzy.net/*", "http://127.0.0.1/*", "http://localhost/*"],
  web_accessible_resources: [
    {
      resources: ["vendor/vditor/**/*", "agent/SKILL.md"],
      matches: ["<all_urls>"],
    },
  ],
});
