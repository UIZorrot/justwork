import { z } from "zod";
import { buildAgentCatalog } from "./schemas.js";
import type { OperationMeta } from "./schemas.js";

export const pingArgs = z.object({});

export const docGetArgs = z.object({
  path: z.enum(["primary"]).optional(),
});

export const docSetArgs = z.object({
  markdown: z.string(),
  resetRevision: z.boolean().optional(),
});

export const docAppendArgs = z.object({
  text: z.string(),
  separator: z.string().optional(),
});

export const docReplaceRangeArgs = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  replacement: z.string(),
});

export const identityCurrentArgs = z.object({});

export const workspaceCreateArgs = z.object({
  workspaceId: z.string().optional(),
  password: z.string().min(1),
  title: z.string().optional(),
});

export const workspaceStatusArgs = z.object({
  workspaceId: z.string().optional(),
});

export const workspaceUnlockArgs = z.object({
  workspaceId: z.string().optional(),
  password: z.string().min(1),
});

export const workspaceLockArgs = z.object({
  workspaceId: z.string().optional(),
});

export const workspaceTreeGetArgs = z.object({
  workspaceId: z.string().optional(),
});

export const workspaceItemGetArgs = z.object({
  workspaceId: z.string().optional(),
  id: z.string().min(1),
});

export const workspaceItemSetArgs = z.object({
  workspaceId: z.string().optional(),
  id: z.string().min(1),
  title: z.string().optional(),
  markdown: z.string().optional(),
});

export const OPERATIONS: OperationMeta[] = [
  {
    name: "health.ping",
    description: "Connectivity check with no arguments.",
    input: pingArgs,
  },
  {
    name: "doc.get",
    description: "Read the current primary Markdown document and revision.",
    input: docGetArgs,
  },
  {
    name: "doc.set",
    description: "Replace the current primary Markdown document.",
    input: docSetArgs,
  },
  {
    name: "doc.append",
    description: "Append text to the current primary Markdown document.",
    input: docAppendArgs,
  },
  {
    name: "doc.replaceRange",
    description: "Replace a character range in the current primary Markdown document.",
    input: docReplaceRangeArgs,
  },
  {
    name: "meta.schema",
    description: "Return the JSON Schema catalog for all registered operations.",
    input: pingArgs,
  },
  {
    name: "identity.current",
    description: "Return the local Bridge identity for third-party Agent attribution.",
    input: identityCurrentArgs,
  },
  {
    name: "workspace.create",
    description: "Create a local encrypted workspace for third-party Agent access.",
    input: workspaceCreateArgs,
  },
  {
    name: "workspace.status",
    description: "Return workspace existence, id, and lock state without exposing plaintext.",
    input: workspaceStatusArgs,
  },
  {
    name: "workspace.unlock",
    description: "Unlock a local encrypted workspace session using a workspace password.",
    input: workspaceUnlockArgs,
  },
  {
    name: "workspace.lock",
    description: "Clear the local decrypted workspace session.",
    input: workspaceLockArgs,
  },
  {
    name: "workspace.tree.get",
    description: "Return the unlocked workspace document tree summary.",
    input: workspaceTreeGetArgs,
  },
  {
    name: "workspace.item.get",
    description: "Return one unlocked workspace item by id.",
    input: workspaceItemGetArgs,
  },
  {
    name: "workspace.item.set",
    description: "Modify one unlocked workspace item and persist the encrypted payload.",
    input: workspaceItemSetArgs,
  },
];

export function getAgentCatalogJson() {
  return buildAgentCatalog(OPERATIONS);
}
