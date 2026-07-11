interface AppV2ProjectAudience {
  access: "private" | "workspace";
  owner_id: string;
  sharedWith: Array<{ userId: string }>;
}

export function getAppV2ProjectEventAudience(project: AppV2ProjectAudience): {
  forUserIds?: string[];
} {
  if (project.access === "workspace") return {};
  return {
    forUserIds: [
      ...new Set([
        project.owner_id,
        ...project.sharedWith.map(entry => entry.userId),
      ]),
    ],
  };
}
