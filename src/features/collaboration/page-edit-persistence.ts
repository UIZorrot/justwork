export type PageEditPersistencePlan = {
  commitLocalEdit: boolean;
  scheduleSave: boolean;
};

export function planPageEditPersistence(_hasCollaborator: boolean): PageEditPersistencePlan {
  return {
    commitLocalEdit: true,
    scheduleSave: true,
  };
}
