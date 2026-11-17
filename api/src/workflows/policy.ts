/**
 * Who may put workflows on main and switch them on. What is on main runs on
 * the workspace's schedule with the workspace's data, so a push or merge to
 * main that changes `workflows/`, the Active switch and a webhook are an
 * admin's call. Members write workflows in their checkout and on branches,
 * and test them in their sandbox. The rule is read at every door onto main:
 * the git endpoint, a merge, the switches.
 */
export const mayChangeWorkflows = (role?: string | null): boolean =>
  role === "owner" || role === "admin";

export const WORKFLOWS_ADMIN_ONLY =
  "Only workspace admins put workflows on main and switch them on; test yours in the sandbox and ask an admin.";

/**
 * Connector folders: code on main runs in a box with the keys of the
 * connections that use it. A member landing new code there could read those
 * keys, so `connectors/` reaches main the way `workflows/` does: through an
 * owner or admin, at the git endpoint and at a merge. Members still change
 * connectors on branches.
 */
export const mayChangeConnectors = mayChangeWorkflows;

export const CONNECTORS_ADMIN_ONLY =
  "Only workspace admins put connector code on main: it runs with the keys of the connections that use it. Push a branch and ask an admin to merge.";
