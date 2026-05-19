/// <reference types="chrome" />

import { STORAGE_KEYS } from "@/shared/storage-keys";
import type { WorkspaceDocContent } from "@/shared/storage-keys";

/**
 * 点击扩展图标时打开独立工作台页面（非 popup / 非 side panel）。
 */
function openWorkbenchPage(): void {
  const url = chrome.runtime.getURL("src/pages/workbench/index.html");
  void chrome.tabs.create({ url });
}

chrome.action.onClicked.addListener(openWorkbenchPage);

type BackendDocDraft = {
  workspaceId: string;
  itemId: string;
  markdown?: string;
  title?: string;
  content?: WorkspaceDocContent | null;
  seq: number;
  updatedAt: string;
};

type BackendDocDraftSyncMessage = {
  type: "justwork.backendDocDraft.sync";
  drafts: Record<string, BackendDocDraft>;
};

let draftSyncQueue: Promise<void> = Promise.resolve();

function persistDraftSnapshot(drafts: Record<string, BackendDocDraft>): Promise<void> {
  return chrome.storage.local.set({ [STORAGE_KEYS.BACKEND_DOC_DRAFTS]: drafts });
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const typed = message as BackendDocDraftSyncMessage | null;
  if (!typed || typed.type !== "justwork.backendDocDraft.sync") return;
  draftSyncQueue = draftSyncQueue
    .then(async () => {
      await persistDraftSnapshot(typed.drafts);
      sendResponse({ ok: true });
    })
    .catch(() => {
      sendResponse({ ok: false });
    });
  return true;
});
