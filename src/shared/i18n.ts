import { STORAGE_KEYS } from "@/shared/storage-keys";
import { getLocalStorageArea } from "@/shared/browser-platform";

export const SUPPORTED_LOCALES = ["en", "zh-CN"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

type MessageParams = Record<string, string | number>;

const MESSAGES = {
  en: {
    "app.title": "JustWork",
    "app.sidepanel.title": "JustWork Notes",
    "app.sidepanel.subtitle": "Document shell · Vditor WYSIWYG",
    "app.sidepanel.editorLabel": "Document editor",
    "app.workbench.title": "JustWork Workspace",
    "app.workbench.brand": "JustWork",
    "app.workbench.pageTag": "Workspace",
    "app.workbench.languageSwitcher": "Language",
    "app.workbench.language.en": "EN",
    "app.workbench.language.zh": "中文",
    "status.connecting": "Connecting",
    "status.online": "Online",
    "status.offline": "Offline",
    "status.saved": "Saved",
    "status.loading": "Loading",
    "status.creatingShare": "Creating share link...",
    "status.saving": "Saving",
    "status.synced": "Synced",
    "status.offlinePending": "Offline, waiting to sync",
    "status.copied": "Copied to clipboard",
    "status.copyFailed": "Unable to copy to clipboard. Check browser permissions or page focus.",
    "status.reverted": "Reverted",
    "status.locked": "Locked",
    "status.backendError": "Connection error",
    "common.close": "Close",
    "gate.setup.kicker": "JustWork Backend",
    "gate.setup.title": "Create an encrypted workspace",
    "gate.setup.description":
      "Enter a workspace password. Content is encrypted before syncing to JustWork Backend, and the password is never written to the database.",
    "gate.setup.workspaceTitlePlaceholder": "Workspace title (optional)",
    "gate.setup.passwordPlaceholder": "Workspace password",
    "gate.setup.button": "Create and unlock",
    "gate.unlock.kicker": "Encrypted workspace",
    "gate.unlock.title": "Unlock workspace",
    "gate.unlock.description": "The workspace is locked. Enter the password to read document contents.",
    "gate.unlock.workspaceIdPlaceholder": "Workspace ID",
    "gate.unlock.passwordPlaceholder": "Workspace password",
    "gate.unlock.button": "Unlock",
    "gate.unlock.createWorkspace": "Create a new workspace",
    "gate.rememberPassword": "Remember password on this device",
    "gate.rememberPasswordHint": "Stored locally in this browser only. The backend never stores the workspace password.",
    "gate.recent.title": "Recent workspaces",
    "gate.recent.empty": "No records yet. Created or unlocked workspaces will appear here.",
    "gate.recent.showMore": "Show more",
    "gate.recent.collapse": "Collapse",
    "gate.recent.remove": "Remove from list",
    "sidebar.searchPlaceholder": "Search / jump to page",
    "sidebar.newFile": "New document",
    "sidebar.newTable": "New sheet",
    "sidebar.newBoard": "New table",
    "sidebar.newFolder": "New folder",
    "sidebar.pin": "Pin",
    "sidebar.share": "Share",
    "sidebar.unpin": "Unpin",
    "sidebar.delete": "Delete",
    "sidebar.people": "Workspace people",
    "sidebar.peopleEmpty": "No one has joined this workspace yet.",
    "sidebar.peopleMention": " ",
    "sidebar.pinned": "Pinned",
    "sidebar.pages": "Pages",
    "sidebar.trash": "Trash",
    "sidebar.label": "Workspace sidebar",
    "sidebar.connectAgent": "Connect Agent",
    "editor.pageTag": "Page",
    "editor.untitledDocument": "Untitled document",
    "editor.untitledPage": "Untitled page",
    "editor.untitledTable": "Untitled sheet",
    "editor.untitledBoard": "Untitled table",
    "editor.untitled": "Untitled",
    "editor.untitledFolder": "Untitled folder",
    "editor.titleInput": "Document title",
    "editor.folderPrefix": "[Folder] ",
    "doc.root": "Root",
    "drawer.profile.title": "Profile",
    "drawer.profile.workspaceHeading": "Workspace",
    "drawer.profile.workspaceIdHeading": "Workspace ID",
    "drawer.profile.workspaceDesc":
      "This is the unique identifier for unlock and API access. It does not depend on the workspace title and can be shared across devices.",
    "drawer.profile.copy": "Copy",
    "drawer.profile.workspaceNameHeading": "Workspace name",
    "drawer.profile.workspaceNameDesc":
      "Used in the recent-workspaces list. Defaults to <span class=\"workspace-info-em\">work_last4</span>; spaces are saved as underscores, and can be changed at any time.",
    "drawer.profile.workspaceNamePlaceholder": "For example: Project docs",
    "drawer.profile.saveWorkspaceName": "Save workspace name",
    "drawer.profile.personalHeading": "Personal info",
    "drawer.profile.userIdHeading": "User ID",
    "drawer.profile.userIdDesc":
      "A local identity used for encryption and backend linkage. It is not shown in the navigation bar.",
    "drawer.profile.nicknameHeading": "Workspace nickname",
    "drawer.profile.nicknameDesc":
      "Used for presence and inbox mentions in this workspace. It is stored locally and can be changed later.",
    "drawer.profile.nicknamePlaceholder": "For example: Alice",
    "drawer.profile.saveNickname": "Save nickname",
    "drawer.profile.currentNickname": "Current nickname: {{nickname}}",
    "drawer.profile.loadingNicknameFailed": "Unable to load the nickname for now. Check whether the backend is online.",
    "drawer.profile.saveInProgress": "Saving...",
    "drawer.profile.savedNickname": "Saved.",
    "drawer.profile.workspaceNameSaved": "Workspace name saved: {{workspaceName}}",
    "drawer.profile.noNameablePage": "No page is available for naming right now.",
    "drawer.message.title": "Inbox",
    "drawer.message.membersHeading": "Workspace people",
    "drawer.message.membersEmpty": "No people found in this workspace yet.",
    "drawer.message.logHeading": "Mentions",
    "drawer.message.empty": "No inbox items yet.",
    "drawer.message.inputPlaceholder": "Inbox",
    "drawer.message.send": "Open",
    "mention.empty": "No matching people",
    "drawer.message.promptTitle": "Choose your nickname",
    "drawer.message.promptDesc":
      "This name is shown to other people in the workspace and used for @mentions.",
    "drawer.message.promptSave": "Continue",
    "drawer.agent.title": "Connect Agent",
    "drawer.agent.description": "Copy this setup text and send it to your Agent. It includes this workspace ID and password.",
    "drawer.agent.promptLabel": "Agent setup text",
    "drawer.agent.copy": "Copy setup text",
    "drawer.agent.downloadSkill": "Download SKILL.md",
    "drawer.agent.openBackendSkill": "Open Skill URL",
    "doc.folder": "Folder",
    "doc.table": "Sheet",
    "doc.board": "Table",
    "doc.welcome": "Welcome",
    "doc.protected": "Protected item",
    "doc.welcomeMarkdownTitle": "Welcome to JustWork",
    "doc.welcomeMarkdownRecentHeading": "Recent",
    "doc.welcomeMarkdownOverviewHeading": "Workspace overview",
    "doc.welcomeMarkdownRecentEmpty": "No recent items",
    "doc.welcomeMarkdownIntro1": "This is your document hub. It supports nested pages, search, pinning, and the trash.",
    "doc.welcomeMarkdownIntro2": "You can pin frequently used pages to the top. Deletions go to the trash first, then can be permanently removed.",
    "doc.trash": "Move to trash",
    "doc.restore": "Restore",
    "doc.deleteForever": "Delete",
    "doc.revert": "Revert",
    "doc.createdFile": "File created",
    "doc.createdTable": "Sheet created",
    "doc.createdBoard": "Table created",
    "doc.createdFolder": "Folder created",
    "doc.pinned": "Pinned",
    "doc.unpinned": "Unpinned",
    "doc.moved": "Moved",
    "doc.restored": "Restored",
    "doc.hardDeleted": "Deleted permanently",
    "doc.trashed": "Moved to trash",
    "doc.workspaceNameDefault": "work_last4",
    "doc.workspaceBackend": "Backend workspace",
    "doc.workspaceNameSaved": "Workspace name saved",
    "structured.table.addColumn": "Add column",
    "structured.table.addRow": "Add row",
    "structured.table.deleteColumn": "Delete column",
    "structured.table.deleteRow": "Delete row",
    "structured.table.freezeHeader": "Freeze header",
    "structured.board.addColumn": "Add column",
    "structured.board.addCard": "Add card",
    "structured.board.deleteColumn": "Delete column",
    "structured.board.deleteCard": "Delete card",
    "structured.board.addField": "Add field",
    "structured.board.removeField": "Remove field",
    "structured.board.template": "Template",
    "structured.board.emptyCard": "Select a card to edit",
    "toast.conflict": "Conflict with another change. Refresh or sync before trying again.",
    "toast.invalidPassword": "Please enter a workspace password",
    "toast.invalidWorkspaceId": "Please enter a Workspace ID",
    "toast.noPassword": "Please enter a password",
    "toast.noWorkspaceId": "Please fill in the Workspace ID",
    "toast.workspaceNameMissing": "No page is available for naming right now.",
    "toast.copied": "Copied to clipboard",
    "toast.copyFailed":
      "Unable to copy to clipboard. Check browser permissions or page focus.",
    "toast.connectionError": "Connection error",
    "toast.backendNicknameFailed": "Unable to load the server nickname for now. Check whether the backend is online.",
    "toast.locked": "Locked",
    "toast.shareCreated": "Share link created and copied",
  },
  "zh-CN": {
    "app.title": "JustWork",
    "app.sidepanel.title": "JustWork 文档",
    "app.sidepanel.subtitle": "文档外壳 · Vditor 所见即所得",
    "app.sidepanel.editorLabel": "文档编辑器",
    "app.workbench.title": "JustWork 工作台",
    "app.workbench.brand": "JustWork",
    "app.workbench.pageTag": "工作区",
    "app.workbench.languageSwitcher": "语言",
    "app.workbench.language.en": "EN",
    "app.workbench.language.zh": "中文",
    "status.connecting": "连接中",
    "status.online": "在线",
    "status.offline": "离线",
    "status.saved": "已保存",
    "status.loading": "加载中",
    "status.creatingShare": "正在创建分享链接…",
    "status.saving": "保存中",
    "status.synced": "已同步",
    "status.offlinePending": "离线，待同步",
    "status.copied": "已复制到剪贴板",
    "status.copyFailed": "无法复制到剪贴板，请检查浏览器权限或页面焦点。",
    "status.reverted": "已回滚",
    "status.locked": "已锁定",
    "status.backendError": "连接错误",
    "common.close": "关闭",
    "gate.setup.kicker": "JustWork Backend",
    "gate.setup.title": "创建加密工作区",
    "gate.setup.description": "输入一个工作区密码。内容会加密后同步到 JustWork Backend，密码不会写入数据库。",
    "gate.setup.workspaceTitlePlaceholder": "工作区标题（可选）",
    "gate.setup.passwordPlaceholder": "工作区密码",
    "gate.setup.button": "创建并解锁",
    "gate.unlock.kicker": "Encrypted workspace",
    "gate.unlock.title": "解锁工作区",
    "gate.unlock.description": "工作区已锁定。输入密码后才能读取文档内容。",
    "gate.unlock.workspaceIdPlaceholder": "Workspace ID",
    "gate.unlock.passwordPlaceholder": "工作区密码",
    "gate.unlock.button": "解锁",
    "gate.unlock.createWorkspace": "新建工作区",
    "gate.recent.title": "最近使用的工作区",
    "gate.recent.empty": "暂无记录，创建或解锁成功后会出现在这里。",
    "gate.recent.showMore": "显示更多",
    "gate.recent.collapse": "收起",
    "gate.recent.remove": "从列表移除",
    "sidebar.searchPlaceholder": "搜索 / 跳转页面",
    "sidebar.newFile": "新建文件",
    "sidebar.newFolder": "新建文件夹",
    "sidebar.pin": "置顶",
    "sidebar.share": "分享",
    "sidebar.unpin": "取消置顶",
    "sidebar.delete": "删除",
    "sidebar.pinned": "置顶",
    "sidebar.pages": "页面",
    "sidebar.trash": "垃圾箱",
    "sidebar.label": "工作区侧栏",
    "editor.pageTag": "Page",
    "editor.untitledDocument": "未命名文档",
    "editor.untitledPage": "未命名页面",
    "editor.untitled": "未命名",
    "editor.untitledFolder": "未命名文件夹",
    "editor.titleInput": "文档标题",
    "editor.folderPrefix": "[文件夹] ",
    "doc.root": "根目录",
    "drawer.profile.title": "Profile（信息）",
    "drawer.profile.workspaceHeading": "工作区",
    "drawer.profile.workspaceIdHeading": "Workspace ID",
    "drawer.profile.workspaceDesc": "解锁与 API 均以此为唯一标识；与工作区标题无关，可多设备共用。",
    "drawer.profile.copy": "复制",
    "drawer.profile.workspaceNameHeading": "工作区名称",
    "drawer.profile.workspaceNameDesc": "用于最近工作区展示。默认为 <span class=\"workspace-info-em\">work_后四位</span>；输入空格时，保存会用 _ 替换，可随时修改。",
    "drawer.profile.workspaceNamePlaceholder": "例如：项目文档",
    "drawer.profile.saveWorkspaceName": "保存工作区名称",
    "drawer.profile.personalHeading": "个人信息",
    "drawer.profile.userIdHeading": "用户 ID",
    "drawer.profile.userIdDesc": "本机生成的身份标识，用于加密与后端关联；不会作为导航栏展示。",
    "drawer.profile.nicknameHeading": "工作区昵称",
    "drawer.profile.nicknameDesc": "用于这个工作区里的在线状态和消息，会保存在本地，也可以随时更改。",
    "drawer.profile.nicknamePlaceholder": "例如：张三",
    "drawer.profile.saveNickname": "保存昵称",
    "drawer.profile.currentNickname": "当前昵称：{{nickname}}",
    "drawer.profile.loadingNicknameFailed": "暂时无法加载昵称（请确认后端在线）",
    "drawer.profile.saveInProgress": "保存中…",
    "drawer.profile.savedNickname": "已保存。",
    "drawer.profile.workspaceNameSaved": "工作区名称已保存：{{workspaceName}}",
    "drawer.profile.noNameablePage": "暂无可命名页面。",
    "drawer.message.title": "Inbox",
    "drawer.message.membersHeading": "在线成员",
    "drawer.message.membersEmpty": "当前还没有人在线。",
    "drawer.message.logHeading": "提及",
    "drawer.message.empty": "还没有 inbox 项目。",
    "drawer.message.inputPlaceholder": "Inbox",
    "drawer.message.send": "打开",
    "drawer.message.promptTitle": "设置你的昵称",
    "drawer.message.promptDesc": "这个名字会显示给工作区里的其他人，并用于 @ 提及。",
    "drawer.message.promptSave": "继续",
    "doc.folder": "文件夹",
    "doc.welcome": "欢迎",
    "doc.protected": "受保护条目",
    "doc.welcomeMarkdownTitle": "欢迎来到 JustWork",
    "doc.welcomeMarkdownRecentHeading": "最近访问",
    "doc.welcomeMarkdownOverviewHeading": "工作区简介",
    "doc.welcomeMarkdownRecentEmpty": "暂无最近访问",
    "doc.welcomeMarkdownIntro1": "这里是你的文档中枢，支持层级页面、搜索、Pin、垃圾箱。",
    "doc.welcomeMarkdownIntro2": "你可以把常用页面 Pin 到顶部，删除内容先进入垃圾箱再彻底删除。",
    "doc.trash": "移入垃圾箱",
    "doc.restore": "恢复",
    "doc.deleteForever": "删除",
    "doc.revert": "回滚",
    "doc.createdFile": "页面已创建",
    "doc.createdFolder": "文件夹已创建",
    "doc.pinned": "已置顶",
    "doc.unpinned": "已取消置顶",
    "doc.moved": "已移动",
    "doc.restored": "已恢复",
    "doc.hardDeleted": "已彻底删除",
    "doc.trashed": "已移入垃圾箱",
    "doc.workspaceNameDefault": "work_后四位",
    "doc.workspaceBackend": "Backend workspace",
    "doc.workspaceNameSaved": "工作区名称已保存",
    "toast.conflict": "与其他修改冲突，请刷新或同步后重试。",
    "toast.invalidPassword": "请输入工作区密码",
    "toast.invalidWorkspaceId": "请填写 Workspace ID",
    "toast.noPassword": "请输入密码",
    "toast.noWorkspaceId": "请填写 Workspace ID",
    "toast.workspaceNameMissing": "暂无可命名页面。",
    "toast.copied": "已复制到剪贴板",
    "toast.copyFailed": "无法复制到剪贴板，请检查浏览器权限或页面焦点。",
    "toast.connectionError": "连接错误",
    "toast.backendNicknameFailed": "暂时无法加载服务端昵称（请确认后端在线）",
    "toast.locked": "已锁定",
    "toast.shareCreated": "分享链接已创建并复制",
  },
} as const;

export type MessageKey = keyof typeof MESSAGES.en;

export type Translator = {
  readonly locale: Locale;
  t(key: MessageKey, params?: MessageParams): string;
};

function normalizeLocaleTag(raw: string | undefined | null): Locale | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized.startsWith("zh")) return "zh-CN";
  if (normalized.startsWith("en")) return "en";
  return null;
}

function formatMessage(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? "" : String(value);
  });
}

export function detectBrowserLocale(): Locale {
  const chromeLocale = normalizeLocaleTag(globalThis.chrome?.i18n?.getUILanguage?.());
  if (chromeLocale) return chromeLocale;

  const navigatorLocale = normalizeLocaleTag(globalThis.navigator?.languages?.[0] ?? globalThis.navigator?.language);
  if (navigatorLocale) return navigatorLocale;

  return DEFAULT_LOCALE;
}

export async function loadPreferredLocale(): Promise<Locale | null> {
  const raw = await getLocalStorageArea().get(STORAGE_KEYS.UI_LOCALE);
  return normalizeLocaleTag(raw[STORAGE_KEYS.UI_LOCALE] as string | undefined);
}

export async function savePreferredLocale(locale: Locale): Promise<void> {
  await getLocalStorageArea().set({ [STORAGE_KEYS.UI_LOCALE]: locale });
}

export async function resolvePreferredLocale(): Promise<Locale> {
  return (await loadPreferredLocale()) ?? detectBrowserLocale();
}

export function observePreferredLocaleChanges(onLocale: (locale: Locale) => void): () => void {
  const storage = globalThis.chrome?.storage;
  if (!storage?.onChanged?.addListener || !storage?.onChanged?.removeListener) {
    return () => { };
  }
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== "local") return;
    const change = changes[STORAGE_KEYS.UI_LOCALE];
    if (!change) return;
    const nextLocale = normalizeLocaleTag(change.newValue as string | undefined);
    if (!nextLocale) return;
    onLocale(nextLocale);
  };
  storage.onChanged.addListener(handler);
  return () => storage.onChanged.removeListener(handler);
}

export function createTranslator(locale: Locale): Translator {
  return {
    locale,
    t(key: MessageKey, params?: MessageParams): string {
      const localeMessages = MESSAGES[locale] as Record<string, string>;
      const enMessages = MESSAGES.en as Record<string, string>;
      const template = localeMessages[key] ?? enMessages[key];
      return formatMessage(template, params);
    },
  };
}

export function applyI18n(root: ParentNode | Document, translator: Translator): void {
  const doc = root instanceof Document ? root : root.ownerDocument;
  if (doc) {
    doc.documentElement.lang = translator.locale;
  }

  if (root instanceof Document) {
    const titleEl = root.querySelector<HTMLTitleElement>("title[data-i18n]");
    if (titleEl?.dataset.i18n) {
      root.title = translator.t(titleEl.dataset.i18n as MessageKey);
    }
  }

  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    if (el.tagName === "TITLE") return;
    const key = el.dataset.i18n;
    if (!key) return;
    el.textContent = translator.t(key as MessageKey);
  });

  root.querySelectorAll<HTMLElement>("[data-i18n-html]").forEach((el) => {
    const key = el.dataset.i18nHtml;
    if (!key) return;
    el.innerHTML = translator.t(key as MessageKey);
  });

  root.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach((el) => {
    const key = el.dataset.i18nPlaceholder;
    if (!key) return;
    el.setAttribute("placeholder", translator.t(key as MessageKey));
  });

  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    const key = el.dataset.i18nTitle;
    if (!key) return;
    el.setAttribute("title", translator.t(key as MessageKey));
  });

  root.querySelectorAll<HTMLElement>("[data-i18n-aria-label]").forEach((el) => {
    const key = el.dataset.i18nAriaLabel;
    if (!key) return;
    el.setAttribute("aria-label", translator.t(key as MessageKey));
  });
}
