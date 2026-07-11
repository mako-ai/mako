export function getAppV2ProjectEventAudience(
  access: "private" | "workspace",
  actorId: string,
): { forUserId?: string } {
  return access === "workspace" ? {} : { forUserId: actorId };
}
