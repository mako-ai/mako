import assert from "node:assert/strict";
import { getAppV2ProjectEventAudience } from "./event-visibility";

assert.deepEqual(getAppV2ProjectEventAudience("private", "owner-1"), {
  forUserId: "owner-1",
});
assert.deepEqual(getAppV2ProjectEventAudience("workspace", "owner-1"), {});
