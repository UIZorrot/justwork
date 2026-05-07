import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export const DocumentBodySchema = z.object({
  markdown: z.string(),
});

export const DocumentResponseSchema = z.object({
  markdown: z.string(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string(),
});

export const BridgeHealthSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  port: z.number().optional(),
  auth: z.enum(["none", "bearer"]),
});

export const AgentInvokeBodySchema = z.object({
  /** 稳定操作名，与 OPERATIONS 注册表一致 */
  op: z.string(),
  /** 操作参数，结构由该 op 的 inputSchema 描述 */
  args: z.record(z.unknown()).optional(),
});

export const AgentInvokeResponseSchema = z.object({
  ok: z.boolean(),
  op: z.string(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

export type DocumentBody = z.infer<typeof DocumentBodySchema>;
export type DocumentResponse = z.infer<typeof DocumentResponseSchema>;
export type AgentInvokeBody = z.infer<typeof AgentInvokeBodySchema>;

/** Bridge / CLI 注册的单个可调操作（供 Agent 自省） */
export interface OperationMeta {
  name: string;
  description: string;
  input: z.ZodType<unknown>;
}

export function opJsonSchema(op: OperationMeta) {
  return zodToJsonSchema(op.input, { name: op.name, $refStrategy: "none" });
}

export function buildAgentCatalog(operations: OperationMeta[]) {
  return {
    version: "0.0.1",
    operations: operations.map((o) => ({
      name: o.name,
      description: o.description,
      inputSchema: opJsonSchema(o),
    })),
  };
}
