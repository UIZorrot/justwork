export type WorkspaceAccessModel = {
  workspaceId: string;
  creatorUserId: string;
  memberUserIds: string[];
};

export function canWriteWorkspace(workspace: WorkspaceAccessModel, userId: string): boolean {
  return workspace.memberUserIds.includes(userId);
}

export function canModifyWorkspacePassword(workspace: WorkspaceAccessModel, userId: string): boolean {
  return workspace.creatorUserId === userId;
}

export function canDeleteWorkspace(workspace: WorkspaceAccessModel, userId: string): boolean {
  return workspace.creatorUserId === userId;
}
