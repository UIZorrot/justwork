/// <reference types="chrome" />

/**
 * 点击扩展图标时打开独立工作台页面（非 popup / 非 side panel）。
 */
function openWorkbenchPage(): void {
  const url = chrome.runtime.getURL("src/pages/workbench/index.html");
  void chrome.tabs.create({ url });
}

chrome.action.onClicked.addListener(openWorkbenchPage);
