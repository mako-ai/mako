/** Up to two letters from an email's name part (`jane.doe@…` → `JD`), for avatars. */
export function initials(text: string): string {
  const name = text.split("@")[0] ?? text;
  const parts = name.split(/[._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}
