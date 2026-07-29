import type { WorkspaceDoc, WorkspaceDocContent, WorkspaceDocsState } from "@/shared/storage-keys";
import {
  applyWorkspaceMutationLog,
  type WorkspaceMutation,
  type WorkspaceMutationKind,
  type WorkspaceMutationPatch,
} from "./mutation-log";

export type WorkspaceOperationKind = WorkspaceMutationKind;

export type WorkspaceOperationPatch = WorkspaceMutationPatch;

export type WorkspaceOperation = {
  id: string;
  workspaceId: string;
  itemId: string;
  kind: WorkspaceOperationKind;
  doc?: WorkspaceDoc;
  patch?: WorkspaceOperationPatch;
  base?: WorkspaceOperationPatch;
  baseRevision?: number;
  localSeq: number;
  createdAt: string;
};

export type WorkspaceOperationReplayResult = {
  state: WorkspaceDocsState;
  operations: WorkspaceOperation[];
};

function operationToMutation(operation: WorkspaceOperation): WorkspaceMutation {
  return {
    ...operation,
    status: "pending",
    clientSeq: operation.localSeq,
  };
}

function mutationToOperation(mutation: WorkspaceMutation): WorkspaceOperation {
  const {
    status: _status,
    clientSeq,
    lastError: _lastError,
    ...operation
  } = mutation;
  return {
    ...operation,
    localSeq: clientSeq,
  };
}

export function applyWorkspaceOperationJournal(
  state: WorkspaceDocsState,
  operations: WorkspaceOperation[],
): WorkspaceOperationReplayResult {
  const replayed = applyWorkspaceMutationLog(state, operations.map(operationToMutation));
  return {
    state: replayed.state,
    operations: replayed.mutations.map(mutationToOperation),
  };
}
