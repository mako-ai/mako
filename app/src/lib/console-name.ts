/**
 * Canonical console name/path helpers.
 *
 * SINGLE SOURCE OF TRUTH: a console's display name is its LEAF name
 * (`SavedConsole.name` on the server). Its location is the folder hierarchy
 * (`folderId` → `ConsoleFolder.parentId`). The slash-delimited `path` is a
 * DERIVED convenience (folder ancestry joined with the leaf), used only for
 * the breadcrumb folder trail and deep links — it is never the display name.
 *
 * Historically the client set `tab.title` to the full path in some open paths
 * (sidebar click, explicit save, move) and to the leaf in others (server /
 * agent opens), then masked the difference by splitting on "/" in the tab
 * strip. That made the same value mean two different things. These helpers +
 * the "title is always the leaf" rule remove the ambiguity.
 */

/** The leaf (last non-empty segment) of a console path, or the value itself. */
export function consoleLeafName(pathOrName: string | undefined | null): string {
  if (!pathOrName) return "";
  const parts = pathOrName.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : pathOrName;
}

/**
 * The folder trail (ancestor folder names) for a console, derived from its
 * full derived `filePath` by stripping the trailing leaf `name`. Robust to a
 * leaf name that itself contains slashes (legacy data): we strip the exact
 * trailing `/<name>` rather than blindly dropping the last "/" segment.
 */
export function consoleFolderTrail(
  filePath: string | undefined | null,
  leafName: string | undefined | null,
): string[] {
  if (!filePath) return [];
  const leaf = leafName ?? "";
  if (!leaf || filePath === leaf) return [];
  const suffix = `/${leaf}`;
  const folderPath = filePath.endsWith(suffix)
    ? filePath.slice(0, -suffix.length)
    : filePath;
  return folderPath.split("/").filter(Boolean);
}
