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
    "quota.externalUnlimited": "Own database · unlimited",
    "status.creatingShare": "Creating share link...",
    "status.saving": "Saving",
    "status.creating": "Creating...",
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
    "gate.setup.buttonBusy": "Creating workspace...",
    "gate.plan.ariaLabel": "Workspace plan",
    "gate.plan.freeTitle": "Free workspace",
    "gate.plan.freeDesc": "Standard storage · 200 history records · up to 5 workspaces",
    "gate.plan.paidTitle": "Paid workspace",
    "gate.plan.paidDesc": "4× storage · 1000 history records · unlimited workspaces · optional custom database",
    "gate.plan.databaseLabel": "Custom PostgreSQL database (optional)",
    "gate.plan.databasePlaceholder": "postgresql://user:password@host/database",
    "gate.plan.databaseHint": "Optional. Leave blank to use JustWork storage; if provided, it is sent only after payment and encrypted by the backend routing key.",
    "gate.plan.checkoutButton": "Continue to Stripe",
    "gate.plan.checkoutBusy": "Waiting for Stripe payment...",
    "gate.plan.unavailable": "Paid workspaces are not configured on this backend.",
    "gate.plan.popupBlocked": "Allow pop-ups to open Stripe Checkout, then try again.",
    "gate.plan.checkoutStatusError": "Stripe Checkout status: {{status}}",
    "gate.plan.checkoutClosed": "Stripe Checkout was closed before payment completed.",
    "gate.plan.checkoutTimeout": "Stripe Checkout timed out before payment completed.",
    "gate.unlock.kicker": "Encrypted workspace",
    "gate.unlock.title": "Unlock workspace",
    "gate.unlock.description": "The workspace is locked. Enter the password to read document contents.",
    "gate.unlock.workspaceIdPlaceholder": "Workspace ID",
    "gate.unlock.passwordPlaceholder": "Workspace password",
    "gate.unlock.button": "Unlock",
    "gate.unlock.buttonBusy": "Unlocking...",
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
    "sidebar.peopleMention": "Click to copy mention",
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
    "drawer.history.title": "Activity history",
    "drawer.history.refresh": "Refresh",
    "drawer.history.ariaLabel": "Activity history",
    "drawer.history.itemLabel": "Document",
    "drawer.history.eventLabel": "Event",
    "drawer.history.localHint": "Stored on this device only. Not synced to the server.",
    "history.modify": "Modify document",
    "history.create": "Create item",
    "history.move": "Move item",
    "history.pin": "Pin state change",
    "history.trash": "Move to trash",
    "history.restore": "Restore from trash",
    "history.hardDelete": "Hard delete",
    "history.patch": "Patch replace",
    "history.revert": "History revert",
    "history.passwordChange": "Workspace password changed",
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
    "drawer.profile.securityHeading": "Workspace security",
    "drawer.profile.passwordHeading": "Change password",
    "drawer.profile.passwordWarning": "Changing the password immediately removes every member except the workspace creator. They need the new password to join again.",
    "drawer.profile.newPasswordPlaceholder": "New workspace password",
    "drawer.profile.confirmPasswordPlaceholder": "Confirm new password",
    "drawer.profile.changePassword": "Change password and remove other members",
    "drawer.profile.passwordRequired": "Enter a new workspace password.",
    "drawer.profile.passwordMismatch": "The two passwords do not match.",
    "drawer.profile.passwordUnchanged": "The new password must be different from the current password.",
    "drawer.profile.passwordChanging": "Saving pending changes and changing the password...",
    "drawer.profile.passwordConfirm": "Changing the password will immediately remove {{count}} other member(s), close their current connections, and require the new password to join again. Continue?",
    "drawer.profile.passwordChanged": "Password changed. {{count}} other member(s) were removed. Unlock again with the new password.",
    "drawer.message.title": "Inbox",
    "drawer.message.unreadCount": "{{count}} unread",
    "drawer.message.membersHeading": "Workspace people",
    "drawer.message.membersEmpty": "No people found in this workspace yet.",
    "drawer.message.logHeading": "Mentions",
    "drawer.message.empty": "No inbox items yet.",
    "drawer.message.markAllRead": "Mark all read",
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
    "doc.folderEmpty": "This folder is empty.",
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
    "structured.table.addSheet": "Add sheet",
    "structured.table.createSheet": "Create",
    "structured.table.cancelSheet": "Cancel",
    "structured.table.sheetNamePlaceholder": "New child sheet",
    "structured.table.defaultNameColumn": "Name",
    "structured.table.defaultNotesColumn": "Notes",
    "structured.table.defaultUntitledRow": "Untitled row",
    "structured.table.defaultSheetName": "Sheet",
    "structured.board.addColumn": "Add column",
    "structured.board.addCard": "Add card",
    "structured.board.deleteColumn": "Delete column",
    "structured.board.deleteCard": "Delete card",
    "structured.board.addField": "Add field",
    "structured.board.removeField": "Remove field",
    "structured.board.template": "Template",
    "structured.board.emptyCard": "Select a card to edit",
    "structured.board.expand": "Expand",
    "structured.board.collapse": "Collapse",
    "structured.board.columnTemplate": "Column template",
    "structured.board.card": "Card",
    "structured.board.close": "Close",
    "structured.board.untitledCard": "Untitled card",
    "structured.board.noDetails": "No details yet",
    "structured.board.columnColor": "Column color",
    "structured.board.newColumn": "New column",
    "structured.board.newField": "New field",
    "structured.board.statusTodo": "To do",
    "structured.board.statusDoing": "In progress",
    "structured.board.statusDone": "Done",
    "structured.board.statusPaused": "Paused",
    "structured.board.defaultTemplateTitle": "Card template",
    "structured.board.defaultSummaryField": "Summary",
    "structured.board.defaultDetailsField": "Details",
    "structured.board.defaultTodoColumn": "To do",
    "structured.board.defaultDoingColumn": "Doing",
    "structured.board.defaultDoneColumn": "Done",
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
    "quota.externalUnlimited": "自有数据库 · 不限额",
    "status.creatingShare": "正在创建分享链接…",
    "status.saving": "保存中",
    "status.creating": "正在创建…",
    "status.synced": "已同步",
    "status.offlinePending": "离线，待同步",
    "status.copied": "已复制到剪贴板",
    "status.copyFailed": "无法复制到剪贴板，请检查浏览器权限或页面焦点。",
    "status.reverted": "已回滚",
    "status.locked": "退出当前项目",
    "status.backendError": "连接错误",
    "common.close": "关闭",
    "gate.setup.kicker": "JustWork Backend",
    "gate.setup.title": "创建加密工作区",
    "gate.setup.description": "输入一个工作区密码。内容会加密后同步到 JustWork Backend，密码不会写入数据库。",
    "gate.setup.workspaceTitlePlaceholder": "工作区标题（可选）",
    "gate.setup.passwordPlaceholder": "工作区密码",
    "gate.setup.button": "创建并解锁",
    "gate.setup.buttonBusy": "正在创建工作区…",
    "gate.plan.ariaLabel": "工作区套餐",
    "gate.plan.freeTitle": "免费工作区",
    "gate.plan.freeDesc": "标准存储空间 · 保留 200 条历史 · 最多 5 个工作区",
    "gate.plan.paidTitle": "付费工作区",
    "gate.plan.paidDesc": "4 倍容量 · 1000 条历史 · 数量不限 · 可选独立数据库",
    "gate.plan.databaseLabel": "自定义 PostgreSQL 数据库（可选）",
    "gate.plan.databasePlaceholder": "postgresql://用户:密码@主机/数据库",
    "gate.plan.databaseHint": "可选；留空则使用 JustWork 默认存储。填写后仅在支付完成后发送，并由后端路由密钥加密保存。",
    "gate.plan.checkoutButton": "前往 Stripe 支付",
    "gate.plan.checkoutBusy": "等待 Stripe 支付…",
    "gate.plan.unavailable": "当前后端尚未配置付费工作区。",
    "gate.plan.popupBlocked": "请允许弹出窗口以打开 Stripe Checkout，然后重试。",
    "gate.plan.checkoutStatusError": "Stripe Checkout 状态：{{status}}",
    "gate.plan.checkoutClosed": "Stripe Checkout 已在支付完成前关闭。",
    "gate.plan.checkoutTimeout": "等待 Stripe Checkout 支付完成超时。",
    "gate.unlock.kicker": "加密工作区",
    "gate.unlock.title": "解锁工作区",
    "gate.unlock.description": "工作区已锁定。输入密码后才能读取文档内容。",
    "gate.unlock.workspaceIdPlaceholder": "工作区 ID",
    "gate.unlock.passwordPlaceholder": "工作区密码",
    "gate.unlock.button": "解锁",
    "gate.unlock.buttonBusy": "正在解锁…",
    "gate.unlock.createWorkspace": "新建工作区",
    "gate.recent.title": "最近使用的工作区",
    "gate.recent.empty": "暂无记录，创建或解锁成功后会出现在这里。",
    "gate.recent.showMore": "显示更多",
    "gate.recent.collapse": "收起",
    "gate.recent.remove": "从列表移除",
    "sidebar.searchPlaceholder": "搜索 / 跳转页面",
    "sidebar.newFile": "新建文件",
    "sidebar.newTable": "新建表格",
    "sidebar.newBoard": "新建看板",
    "sidebar.newFolder": "新建文件夹",
    "sidebar.pin": "置顶",
    "sidebar.share": "分享",
    "sidebar.unpin": "取消置顶",
    "sidebar.delete": "删除",
    "sidebar.pinned": "置顶",
    "sidebar.pages": "页面",
    "sidebar.trash": "垃圾箱",
    "sidebar.label": "工作区侧栏",
    "editor.pageTag": "页面",
    "editor.untitledDocument": "未命名文档",
    "editor.untitledPage": "未命名页面",
    "editor.untitled": "未命名",
    "editor.untitledFolder": "未命名文件夹",
    "editor.titleInput": "文档标题",
    "editor.folderPrefix": "[文件夹] ",
    "doc.root": "根目录",
    "drawer.history.title": "操作历史",
    "drawer.history.refresh": "刷新",
    "drawer.history.ariaLabel": "操作历史",
    "drawer.history.itemLabel": "文档",
    "drawer.history.eventLabel": "事件",
    "drawer.history.localHint": "仅保存在本设备，不会同步到服务器。",
    "history.modify": "修改文档",
    "history.create": "新建条目",
    "history.move": "移动条目",
    "history.pin": "置顶变更",
    "history.trash": "移入垃圾箱",
    "history.restore": "从垃圾箱恢复",
    "history.hardDelete": "彻底删除",
    "history.patch": "片段替换",
    "history.revert": "历史回滚",
    "history.passwordChange": "工作区密码已修改",
    "drawer.profile.title": "项目设置",
    "drawer.profile.workspaceHeading": "工作区",
    "drawer.profile.workspaceIdHeading": "工作区 ID",
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
    "drawer.profile.securityHeading": "工作区安全",
    "drawer.profile.passwordHeading": "修改密码",
    "drawer.profile.passwordWarning": "修改密码后，除工作区创建者外的所有成员都会立即被移除，现有连接也会断开。他们需要使用新密码才能重新加入。",
    "drawer.profile.newPasswordPlaceholder": "新工作区密码",
    "drawer.profile.confirmPasswordPlaceholder": "确认新密码",
    "drawer.profile.changePassword": "修改密码并移除其他成员",
    "drawer.profile.passwordRequired": "请输入新的工作区密码。",
    "drawer.profile.passwordMismatch": "两次输入的密码不一致。",
    "drawer.profile.passwordUnchanged": "新密码不能与当前密码相同。",
    "drawer.profile.passwordChanging": "正在保存待处理内容并修改密码…",
    "drawer.profile.passwordConfirm": "修改密码将立即移除其他 {{count}} 名成员、断开他们当前的连接，并要求使用新密码才能重新加入。确定继续吗？",
    "drawer.profile.passwordChanged": "密码已修改，已移除其他 {{count}} 名成员。请使用新密码重新解锁。",
    "drawer.message.title": "收件箱",
    "drawer.message.membersHeading": "工作区成员",
    "drawer.message.membersEmpty": "当前还没有工作区成员。",
    "drawer.message.logHeading": "提及",
    "drawer.message.empty": "收件箱中还没有消息。",
    "drawer.message.markAllRead": "全部标为已读",
    "drawer.message.inputPlaceholder": "收件箱",
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
    "doc.welcomeMarkdownIntro1": "这里是你的文档中枢，支持层级页面、搜索、置顶和垃圾箱。",
    "doc.welcomeMarkdownIntro2": "你可以把常用页面置顶，删除的内容会先进入垃圾箱，之后可彻底删除。",
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
    "doc.workspaceBackend": "后端工作区",
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
    "gate.rememberPassword": "在此设备上记住密码",
    "gate.rememberPasswordHint": "仅保存在此浏览器本地；后端不会保存工作区密码。",
    "sidebar.people": "工作区成员",
    "sidebar.peopleEmpty": "此工作区还没有成员加入。",
    "sidebar.peopleMention": "点击复制提及",
    "sidebar.connectAgent": "连接 Agent",
    "editor.untitledTable": "未命名表格",
    "editor.untitledBoard": "未命名看板",
    "mention.empty": "没有匹配的成员",
    "drawer.message.unreadCount": "{{count}} 条未读",
    "drawer.agent.title": "连接 Agent",
    "drawer.agent.description": "复制这段设置文本并发送给你的 Agent，其中包含工作区 ID 和密码。",
    "drawer.agent.promptLabel": "Agent 设置文本",
    "drawer.agent.copy": "复制设置文本",
    "drawer.agent.downloadSkill": "下载 SKILL.md",
    "drawer.agent.openBackendSkill": "打开 Skill 地址",
    "doc.table": "表格",
    "doc.board": "看板",
    "doc.createdTable": "表格已创建",
    "doc.createdBoard": "看板已创建",
    "structured.table.addColumn": "添加列",
    "structured.table.addRow": "添加行",
    "structured.table.deleteColumn": "删除列",
    "structured.table.deleteRow": "删除行",
    "structured.table.freezeHeader": "冻结表头",
    "structured.board.addColumn": "添加列",
    "structured.board.addCard": "添加卡片",
    "structured.board.deleteColumn": "删除列",
    "structured.board.deleteCard": "删除卡片",
    "structured.board.addField": "添加字段",
    "structured.board.removeField": "删除字段",
    "structured.board.template": "模板",
    "structured.board.emptyCard": "选择一张卡片进行编辑",
    "doc.folderEmpty": "这个文件夹里还没有内容。",
    "structured.table.addSheet": "添加工作表",
    "structured.table.createSheet": "创建",
    "structured.table.cancelSheet": "取消",
    "structured.table.sheetNamePlaceholder": "新建子工作表",
    "structured.table.defaultNameColumn": "名称",
    "structured.table.defaultNotesColumn": "备注",
    "structured.table.defaultUntitledRow": "未命名行",
    "structured.table.defaultSheetName": "工作表",
    "structured.board.expand": "展开",
    "structured.board.collapse": "收起",
    "structured.board.columnTemplate": "列模板",
    "structured.board.card": "卡片",
    "structured.board.close": "关闭",
    "structured.board.untitledCard": "未命名卡片",
    "structured.board.noDetails": "暂无详细内容",
    "structured.board.columnColor": "列颜色",
    "structured.board.newColumn": "新列",
    "structured.board.newField": "新字段",
    "structured.board.statusTodo": "待开始",
    "structured.board.statusDoing": "进行中",
    "structured.board.statusDone": "已完成",
    "structured.board.statusPaused": "已暂停",
    "structured.board.defaultTemplateTitle": "卡片模板",
    "structured.board.defaultSummaryField": "摘要",
    "structured.board.defaultDetailsField": "详细内容",
    "structured.board.defaultTodoColumn": "待开始",
    "structured.board.defaultDoingColumn": "进行中",
    "structured.board.defaultDoneColumn": "已完成",
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
