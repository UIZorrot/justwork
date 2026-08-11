export type PageEditPersistencePlan = {
  commitLocalEdit: boolean;
  scheduleSave: boolean;
};

export function planPageEditPersistence(
  hasCollaborator: boolean,
  collaborationReady = hasCollaborator,
): PageEditPersistencePlan {
  return {
    commitLocalEdit: true,
    // Before the canonical room is loaded, an editor change has no Yjs update
    // attached to it yet. Persist it as a local draft, then replay it onto the
    // canonical Y.Doc. Sending Markdown through REST here would create a second
    // text lineage that can disappear and later be broadcast back in a batch.
    scheduleSave: !hasCollaborator || collaborationReady,
  };
}

export function isMeaningfulPageEdit(previousMarkdown: string, nextMarkdown: string): boolean {
  if (previousMarkdown.trim().length === 0 && nextMarkdown.trim().length === 0) return false;
  return previousMarkdown !== nextMarkdown;
}

export function shouldReplayUnboundPageEdit(
  baseMarkdown: string,
  editorMarkdown: string,
  collaborationReady: boolean,
  hasPendingLocalEdit: boolean,
): boolean {
  // Editor DOM drift is not proof of user intent. Vditor normalization, a
  // delayed programmatic render, hydration, or a room reconnect can all make
  // the mounted surface differ from the canonical body while the user is idle.
  // Only a previously recorded local edit may be replayed into a new lineage.
  return (
    !collaborationReady
    && hasPendingLocalEdit
    && isMeaningfulPageEdit(baseMarkdown, editorMarkdown)
  );
}

export function shouldPersistCollaborativeMarkdown(
  hasCollaborator: boolean,
  collaborationReady: boolean,
  pendingUpdateCount: number,
): boolean {
  // Once a page has joined its Yjs lineage, REST Markdown is only a derived
  // snapshot committed alongside the exact Yjs update. Falling back to the
  // legacy whole-text REST diff without an update creates a second writer that
  // can delete concurrent content already accepted by the room.
  return !hasCollaborator || !collaborationReady || pendingUpdateCount > 0;
}
