import {
  AgentInvokeBodySchema,
  DocumentBodySchema,
  docAppendArgs,
  docGetArgs,
  docReplaceRangeArgs,
  docSetArgs,
  identityCurrentArgs,
  pingArgs,
  workspaceCreateArgs,
  workspaceItemGetArgs,
  workspaceItemSetArgs,
  workspaceLockArgs,
  workspaceStatusArgs,
  workspaceTreeGetArgs,
  workspaceUnlockArgs,
} from "@justwork/agent-protocol";
import { getAgentCatalogJson } from "@justwork/agent-protocol";
import {
  createEncryptedWorkspace,
  loadOrCreateLocalIdentity,
  loadWorkspaceMeta,
  lockWorkspace,
  saveEncryptedWorkspaceState,
  unlockWorkspace,
  type RuntimeStorage,
  type WorkspaceSession,
} from "@justwork/workspace-runtime";
import type { DocState } from "./state.js";

export type BridgeWorkspaceDoc = {
  id: string;
  title: string;
  markdown: string;
  revision: number;
  updatedAt: string;
  lastVisitedAt: string;
  parentId: string | null;
  pinned: boolean;
  inTrash: boolean;
  kind: "welcome" | "page" | "folder";
};

export type BridgeWorkspaceState = {
  activeDocId: string;
  docs: BridgeWorkspaceDoc[];
  workspaceDescription: string;
};

export type DispatchContext = {
  state: DocState;
  runtimeStorage?: RuntimeStorage;
  workspaceSession?: WorkspaceSession<BridgeWorkspaceState>;
  workspacePassword?: string;
  bump: () => void;
};

type UnlockedWorkspaceSession = WorkspaceSession<BridgeWorkspaceState> & {
  state: BridgeWorkspaceState;
};

function nowIso(): string {
  return new Date().toISOString();
}

function makeDocId(): string {
  return `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function defaultWorkspaceState(title = "Agent Workspace"): BridgeWorkspaceState {
  const now = nowIso();
  const root: BridgeWorkspaceDoc = {
    id: "root",
    title: "根目录",
    markdown: "",
    revision: 0,
    updatedAt: now,
    lastVisitedAt: now,
    parentId: null,
    pinned: false,
    inTrash: false,
    kind: "folder",
  };
  const doc: BridgeWorkspaceDoc = {
    id: makeDocId(),
    title,
    markdown: "",
    revision: 0,
    updatedAt: now,
    lastVisitedAt: now,
    parentId: root.id,
    pinned: false,
    inTrash: false,
    kind: "page",
  };
  return {
    activeDocId: doc.id,
    workspaceDescription: "Encrypted workspace for third-party Agent access.",
    docs: [root, doc],
  };
}

function requireRuntimeStorage(ctx: DispatchContext): RuntimeStorage {
  if (!ctx.runtimeStorage) {
    throw new Error("workspace runtime storage is not configured");
  }
  return ctx.runtimeStorage;
}

function requireUnlockedWorkspace(
  ctx: DispatchContext,
  workspaceId?: string,
): UnlockedWorkspaceSession {
  const session = ctx.workspaceSession;
  if (!session?.state || session.locked) {
    throw new Error("workspace locked");
  }
  if (workspaceId && session.meta.workspaceId !== workspaceId) {
    throw new Error("workspace not found");
  }
  return session as UnlockedWorkspaceSession;
}

function treeItems(state: BridgeWorkspaceState) {
  return state.docs
    .filter((doc) => !doc.inTrash)
    .map((doc) => ({
      id: doc.id,
      title: doc.title,
      kind: doc.kind,
      parentId: doc.parentId,
      pinned: doc.pinned,
      updatedAt: doc.updatedAt,
    }));
}

export async function dispatchInvoke(ctx: DispatchContext, body: unknown): Promise<any> {
  const parsed = AgentInvokeBodySchema.parse(body);
  const { op, args } = parsed;

  switch (op) {
    case "health.ping":
      pingArgs.parse(args ?? {});
      return { pong: true as const, t: Date.now() };

    case "doc.get": {
      docGetArgs.parse(args ?? {});
      return {
        markdown: ctx.state.markdown,
        revision: ctx.state.revision,
        updatedAt: ctx.state.updatedAt,
      };
    }

    case "doc.set": {
      const a = docSetArgs.parse(args ?? {});
      ctx.state.markdown = a.markdown;
      if (a.resetRevision) {
        ctx.state.revision = 0;
      }
      ctx.bump();
      return {
        markdown: ctx.state.markdown,
        revision: ctx.state.revision,
        updatedAt: ctx.state.updatedAt,
      };
    }

    case "doc.append": {
      const a = docAppendArgs.parse(args ?? {});
      const sep = a.separator ?? "\n\n";
      ctx.state.markdown =
        ctx.state.markdown.length === 0 ? a.text : `${ctx.state.markdown}${sep}${a.text}`;
      ctx.bump();
      return {
        markdown: ctx.state.markdown,
        revision: ctx.state.revision,
        updatedAt: ctx.state.updatedAt,
      };
    }

    case "doc.replaceRange": {
      const a = docReplaceRangeArgs.parse(args ?? {});
      const { start, end, replacement } = a;
      const cur = ctx.state.markdown;
      const next = cur.slice(0, start) + replacement + cur.slice(end);
      ctx.state.markdown = next;
      ctx.bump();
      return {
        markdown: ctx.state.markdown,
        revision: ctx.state.revision,
        updatedAt: ctx.state.updatedAt,
      };
    }

    case "meta.schema":
      pingArgs.parse(args ?? {});
      return getAgentCatalogJson();

    case "identity.current": {
      identityCurrentArgs.parse(args ?? {});
      const identity = await loadOrCreateLocalIdentity(requireRuntimeStorage(ctx));
      return {
        userId: identity.userId,
        publicKeyJwk: identity.publicKeyJwk,
        createdAt: identity.createdAt,
      };
    }

    case "workspace.create": {
      const a = workspaceCreateArgs.parse(args ?? {});
      const storage = requireRuntimeStorage(ctx);
      const identity = await loadOrCreateLocalIdentity(storage);
      const created = await createEncryptedWorkspace<BridgeWorkspaceState>(storage, {
        creator: identity,
        password: a.password,
        plaintextState: defaultWorkspaceState(a.title),
      });
      ctx.workspaceSession = created.session;
      ctx.workspacePassword = a.password;
      return {
        workspaceId: created.meta.workspaceId,
        creatorUserId: created.meta.creatorUserId,
        memberUserIds: created.meta.memberUserIds,
        locked: false,
      };
    }

    case "workspace.status": {
      const a = workspaceStatusArgs.parse(args ?? {});
      const meta = await loadWorkspaceMeta(requireRuntimeStorage(ctx));
      if (!meta || (a.workspaceId && meta.workspaceId !== a.workspaceId)) {
        return { exists: false, locked: true };
      }
      const unlocked = Boolean(ctx.workspaceSession?.state && !ctx.workspaceSession.locked);
      return {
        exists: true,
        workspaceId: meta.workspaceId,
        creatorUserId: meta.creatorUserId,
        memberUserIds: meta.memberUserIds,
        locked: !unlocked,
      };
    }

    case "workspace.unlock": {
      const a = workspaceUnlockArgs.parse(args ?? {});
      const session = await unlockWorkspace<BridgeWorkspaceState>(requireRuntimeStorage(ctx), a.password);
      if (a.workspaceId && session.meta.workspaceId !== a.workspaceId) {
        throw new Error("workspace not found");
      }
      ctx.workspaceSession = session;
      ctx.workspacePassword = a.password;
      return {
        workspaceId: session.meta.workspaceId,
        locked: false,
      };
    }

    case "workspace.lock": {
      const a = workspaceLockArgs.parse(args ?? {});
      if (ctx.workspaceSession) {
        if (a.workspaceId && ctx.workspaceSession.meta.workspaceId !== a.workspaceId) {
          throw new Error("workspace not found");
        }
        lockWorkspace(ctx.workspaceSession);
      }
      ctx.workspacePassword = undefined;
      return { locked: true };
    }

    case "workspace.tree.get": {
      const a = workspaceTreeGetArgs.parse(args ?? {});
      const session = requireUnlockedWorkspace(ctx, a.workspaceId);
      return {
        workspaceId: session.meta.workspaceId,
        activeDocId: session.state.activeDocId,
        items: treeItems(session.state),
      };
    }

    case "workspace.item.get": {
      const a = workspaceItemGetArgs.parse(args ?? {});
      const session = requireUnlockedWorkspace(ctx, a.workspaceId);
      const item = session.state.docs.find((doc) => doc.id === a.id && !doc.inTrash);
      if (!item) throw new Error("workspace item not found");
      return {
        workspaceId: session.meta.workspaceId,
        item,
      };
    }

    case "workspace.item.set": {
      const a = workspaceItemSetArgs.parse(args ?? {});
      const storage = requireRuntimeStorage(ctx);
      const session = requireUnlockedWorkspace(ctx, a.workspaceId);
      if (!ctx.workspacePassword) throw new Error("workspace locked");

      let nextItem: BridgeWorkspaceDoc | undefined;
      const now = nowIso();
      const nextState: BridgeWorkspaceState = {
        ...session.state,
        docs: session.state.docs.map((doc) => {
          if (doc.id !== a.id) return doc;
          nextItem = {
            ...doc,
            title: a.title ?? doc.title,
            markdown: a.markdown ?? doc.markdown,
            revision: doc.revision + 1,
            updatedAt: now,
          };
          return nextItem;
        }),
      };
      if (!nextItem) throw new Error("workspace item not found");

      await saveEncryptedWorkspaceState(storage, {
        password: ctx.workspacePassword,
        state: nextState,
      });
      ctx.workspaceSession = {
        ...session,
        state: nextState,
      };

      return {
        workspaceId: session.meta.workspaceId,
        item: nextItem,
      };
    }

    default:
      throw new Error(`unknown op: ${op}`);
  }
}

export function applyPutDocument(ctx: DispatchContext, body: unknown) {
  const { markdown } = DocumentBodySchema.parse(body);
  ctx.state.markdown = markdown;
  ctx.bump();
  return {
    markdown: ctx.state.markdown,
    revision: ctx.state.revision,
    updatedAt: ctx.state.updatedAt,
  };
}
