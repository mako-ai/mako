/**
 * `dbt_file`: a file in the workspace's dbt project, addressed by its path.
 * The work is in ../dbt-file.ts, which the dbt explorer's route
 * (`POST /dbt/projects/:id/files/rename`) calls too.
 */
import { resolveDbtProjectPath } from "@mako/schemas";
import { parseDbtFileRef, renameDbtFile, resolveDbtFile } from "../dbt-file";
import { RenameError, type RenameHandler } from "../types";

export const dbtFileRenameHandler: RenameHandler = {
  kind: "dbt_file",
  describe:
    "`ref` = the file's path in the dbt project (`models/orders.sql`; `dbt/<path>`, `<projectId>/<path>` and the `/x/<projectId>/file/<path>` URL work too, and so does a path the file was moved away from). `slug` = its new full project path (a move and a rename are the same edit); `title` = a new file name in the same folder. Renaming a model or a seed renames the dbt node: unless `options.updateRefs` is false, the same commit rewrites `ref('old')` across the project, job selectors in dbt/jobs/*.yml, the model's entry in properties files and its key in dbt_project.yml. A snapshot is named by its `{% snapshot %}` block, so its file is only moved. Needs the admin or owner role, like every dbt file change, and commits on the caller's session branch. `warnings` name what was not fixed: the old warehouse relation, selectors.yml, consoles and app bindings that still name it, and folder-level dbt_project.yml config that stops applying after a move.",
  resolve: resolveDbtFile,
  async rename(ctx, request) {
    // Whatever `resolve` accepts names the file, a path it has since moved
    // away from included; the move is always from where it is now.
    const resolved = await resolveDbtFile(ctx, request.ref);
    const named = resolved
      ? {
          projectId: resolved.id.slice(0, resolved.id.indexOf("/")),
          path: resolved.current.slug as string,
        }
      : parseDbtFileRef(request.ref);
    if (!named) throw new RenameError("Give the file's path as ref.", 400);
    const slug = request.slug?.trim();
    const title = request.title?.trim();
    if (title?.includes("/")) {
      throw new RenameError(
        "title is a file name. Give slug to move the file to another folder.",
        400,
      );
    }
    let to: string;
    if (slug) {
      // A file has one name: a title that says otherwise is refused, not
      // dropped without a word.
      if (title && slug.slice(slug.lastIndexOf("/") + 1) !== title) {
        throw new RenameError(
          "A dbt file has one name. Give its new path as slug; title, if given, must be that path's file name.",
          400,
        );
      }
      to = slug;
    } else if (title) {
      const at = resolveDbtProjectPath(named.path);
      const path = at.ok ? at.path : named.path;
      to = `${path.slice(0, path.lastIndexOf("/") + 1)}${title}`;
    } else {
      throw new RenameError("Give a new title (file name) or slug (path).");
    }
    const { updateRefs, clientId } = request.options ?? {};
    return renameDbtFile(ctx, {
      projectId: named.projectId,
      from: named.path,
      to,
      updateRefs: updateRefs !== false,
      clientId: typeof clientId === "string" ? clientId : undefined,
    });
  },
};
