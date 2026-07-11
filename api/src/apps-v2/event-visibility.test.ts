import assert from "node:assert/strict";
import { getAppV2ProjectEventAudience } from "./event-visibility";

assert.deepEqual(
  getAppV2ProjectEventAudience({
    access: "private",
    owner_id: "owner-1",
    sharedWith: [
      { userId: "viewer-1" },
      { userId: "editor-1" },
      { userId: "viewer-1" },
    ],
  }),
  {
    forUserIds: ["owner-1", "viewer-1", "editor-1"],
  },
);
assert.deepEqual(
  getAppV2ProjectEventAudience({
    access: "workspace",
    owner_id: "owner-1",
    sharedWith: [],
  }),
  {},
);
