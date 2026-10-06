/**
 * `dbt_file` — a file in the workspace's dbt project, addressed by path.
 * The work is in ../dbt-file.ts (shared with `POST /dbt/projects/:id/files/rename`).
 */
import { RenameError, type RenameHandler } from "../types";
import { parseDbtFileRef, renameDbtFile, resolveDbtFile } from "../dbt-file";

export const dbtFileRenameHandler: RenameHandler = {
  kind: "dbt_file",
  describe:
    "`ref` is a project-relative path (`models/orders.sql`), `dbt/<path>`, `<projectId>/<path>` or the `/x/<projectId>/file/<path>` URL; `slug` = the new project-relative path (a move), `title` = a new file name in the same folder. Renaming a model or seed renames the dbt node (a snapshot is named by its `{% snapshot %}` block, so its file is just moved): `options.updateRefs` (default true) rewrites `ref('old')` across the project and `--select old` in dbt/jobs/*.yml in the same commit. Commits on the caller's session branch (a workspace API key acts as the user who created it, so on that user's branch). `warnings` list the old warehouse relation and consoles/bindings/dashboards whose SQL still names it.",
  resolve: resolveDbtFile,
  async rename(ctx, request) {
    const parsed = parseDbtFileRef(request.ref);
    if (!parsed) throw new RenameError("A dbt file path is required", 400);
    let to: string;
    if (request.slug) {
      to = request.slug;
    } else if (request.title) {
      // A new file NAME keeps the folder; a title with a slash is a move
      // in disguise and is refused so nobody renames into a folder by typo.
      if (request.title.includes("/")) {
        throw new RenameError(
          "title is a file name; use slug to move the file to another folder",
          400,
        );
      }
      const dir = parsed.path.includes("/")
        ? parsed.path.slice(0, parsed.path.lastIndexOf("/") + 1)
        : "";
      to = `${dir}${request.title}`;
    } else {
      throw new RenameError(
        "Give a new title (file name) or slug (path).",
        400,
      );
    }
    const updateRefs = request.options?.updateRefs;
    return renameDbtFile(ctx, {
      projectId: parsed.projectId,
      from: parsed.path,
      to,
      updateRefs: typeof updateRefs === "boolean" ? updateRefs : true,
      clientId:
        typeof request.options?.clientId === "string"
          ? request.options.clientId
          : undefined,
    });
  },
};
