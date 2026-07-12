import assert from "node:assert/strict";
import {
  defaultExpertiseMode,
  isolateAppToolFamily,
  toolNamesForModes,
} from "./registry";
import { buildCurrentScreenContext } from "../unified/prompt";

assert.equal(
  defaultExpertiseMode({ authType: "session", activeView: "empty" }, "app-v2"),
  "app",
);
assert.equal(
  defaultExpertiseMode(
    { authType: "session", activeView: "empty" },
    "app-v2-file",
  ),
  "app",
);

const appTools = toolNamesForModes(["app"]);
for (const toolName of [
  "app2_list_apps",
  "app2_create_app",
  "app2_read_file",
  "app2_write_file",
  "app2_edit_file",
  "app2_delete_file",
  "app2_move_file",
  "app2_status",
  "app2_commit",
  "app2_bash",
  "app2_install_packages",
]) {
  assert.equal(appTools.has(toolName), true, `${toolName} must be in App mode`);
}

assert.equal(appTools.has("list_open_apps"), true);
assert.equal(appTools.has("app_edit_file"), true);

const appV2ActiveTools = isolateAppToolFamily(Array.from(appTools), "app-v2");
assert.equal(appV2ActiveTools.includes("app2_edit_file"), true);
assert.equal(appV2ActiveTools.includes("app_edit_file"), false);
assert.equal(appV2ActiveTools.includes("list_data_sources"), true);

const appV1ActiveTools = isolateAppToolFamily(Array.from(appTools), "app-file");
assert.equal(appV1ActiveTools.includes("app_edit_file"), true);
assert.equal(appV1ActiveTools.includes("app2_edit_file"), false);
assert.equal(appV1ActiveTools.includes("list_data_sources"), true);

const appV2RailMode = defaultExpertiseMode({
  activeView: "empty",
  activeExplorer: "apps-v2",
});
assert.equal(appV2RailMode, "app");
assert.equal(
  defaultExpertiseMode(
    { activeView: "empty", activeExplorer: "apps-v2" },
    "dashboard",
  ),
  "dashboard",
);
const appV2RailTools = isolateAppToolFamily(
  Array.from(toolNamesForModes([appV2RailMode])),
  undefined,
  "apps-v2",
);
assert.equal(appV2RailTools.includes("app2_edit_file"), true);
assert.equal(appV2RailTools.includes("app_edit_file"), false);

const appV1RailMode = defaultExpertiseMode({
  activeView: "empty",
  activeExplorer: "apps",
});
assert.equal(appV1RailMode, "app");
const appV1RailTools = isolateAppToolFamily(
  Array.from(toolNamesForModes([appV1RailMode])),
  undefined,
  "apps",
);
assert.equal(appV1RailTools.includes("app_edit_file"), true);
assert.equal(appV1RailTools.includes("app2_edit_file"), false);

const explicitV1TabTools = isolateAppToolFamily(
  Array.from(appTools),
  "app",
  "apps-v2",
);
assert.equal(explicitV1TabTools.includes("app_edit_file"), true);
assert.equal(explicitV1TabTools.includes("app2_edit_file"), false);
const explicitV2TabTools = isolateAppToolFamily(
  Array.from(appTools),
  "app-v2",
  "apps",
);
assert.equal(explicitV2TabTools.includes("app2_edit_file"), true);
assert.equal(explicitV2TabTools.includes("app_edit_file"), false);

const screen = buildCurrentScreenContext({
  workspaceId: "workspace-1",
  authType: "session",
  activeExplorer: "apps-v2",
  openTabs: [
    {
      id: "v1-tab",
      kind: "app",
      title: "Legacy",
      isActive: false,
      appId: "app-1",
    },
    {
      id: "v2-tab",
      kind: "app-v2",
      title: "Project",
      isActive: true,
      projectId: "project-1",
    },
  ],
});
assert.match(screen, /App "Legacy" \(app id: app-1\)/);
assert.match(screen, /App Project "Project" \(project id: project-1\)/);
assert.match(screen, /Visible explorer: App Projects \(apps-v2\)/);
