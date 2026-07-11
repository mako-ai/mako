import assert from "node:assert/strict";
import {
  getAppsV2GitRoot,
  getAppsV2MaxRepositoryBytes,
  isAppsV2Enabled,
  validateAppsV2StartupConfiguration,
} from "./config";

const previousNodeEnvironment = process.env.NODE_ENV;
const previousGitRoot = process.env.APPS_V2_GIT_ROOT;
const previousEnabled = process.env.APPS_V2_ENABLED;
const previousCloudRunService = process.env.K_SERVICE;
const previousMaxRepositoryBytes = process.env.APPS_V2_MAX_REPOSITORY_BYTES;
const previousDurabilityConfirmed =
  process.env.APPS_V2_GIT_DURABILITY_CONFIRMED;

try {
  process.env.APPS_V2_ENABLED = "false";
  assert.equal(isAppsV2Enabled(), false);
  process.env.APPS_V2_ENABLED = "true";
  assert.equal(isAppsV2Enabled(), true);

  process.env.NODE_ENV = "production";
  process.env.APPS_V2_ENABLED = "false";
  delete process.env.APPS_V2_GIT_DURABILITY_CONFIRMED;
  delete process.env.APPS_V2_GIT_ROOT;
  assert.doesNotThrow(() => validateAppsV2StartupConfiguration());
  process.env.APPS_V2_ENABLED = "true";
  process.env.APPS_V2_GIT_ROOT = "/var/lib/mako/apps-v2";
  assert.throws(() => getAppsV2GitRoot(), /DURABILITY_CONFIRMED=true/);
  process.env.APPS_V2_GIT_DURABILITY_CONFIRMED = "true";
  delete process.env.APPS_V2_GIT_ROOT;
  assert.throws(() => getAppsV2GitRoot(), /required in production/);
  process.env.APPS_V2_GIT_ROOT = "relative/apps";
  assert.throws(() => getAppsV2GitRoot(), /absolute production path/);
  process.env.APPS_V2_GIT_ROOT = "/tmp/apps-v2";
  assert.throws(() => getAppsV2GitRoot(), /temporary storage/);
  process.env.APPS_V2_GIT_ROOT = "/var/lib/mako/apps-v2";
  assert.equal(getAppsV2GitRoot(), "/var/lib/mako/apps-v2");

  process.env.NODE_ENV = "development";
  process.env.K_SERVICE = "mako-api";
  delete process.env.APPS_V2_GIT_DURABILITY_CONFIRMED;
  process.env.APPS_V2_GIT_ROOT = "/var/lib/mako/apps-v2";
  assert.throws(() => getAppsV2GitRoot(), /DURABILITY_CONFIRMED=true/);
  process.env.APPS_V2_GIT_DURABILITY_CONFIRMED = "true";
  delete process.env.APPS_V2_GIT_ROOT;
  assert.throws(() => getAppsV2GitRoot(), /required in production/);
  delete process.env.K_SERVICE;
  assert.equal(getAppsV2GitRoot(), "/tmp/mako-apps-v2-git");
  process.env.APPS_V2_MAX_REPOSITORY_BYTES = "12345";
  assert.equal(getAppsV2MaxRepositoryBytes(), 12345);
  process.env.APPS_V2_MAX_REPOSITORY_BYTES = "not-a-size";
  assert.throws(() => getAppsV2MaxRepositoryBytes(), /positive integer/);
} finally {
  if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnvironment;
  if (previousGitRoot === undefined) delete process.env.APPS_V2_GIT_ROOT;
  else process.env.APPS_V2_GIT_ROOT = previousGitRoot;
  if (previousEnabled === undefined) delete process.env.APPS_V2_ENABLED;
  else process.env.APPS_V2_ENABLED = previousEnabled;
  if (previousCloudRunService === undefined) delete process.env.K_SERVICE;
  else process.env.K_SERVICE = previousCloudRunService;
  if (previousMaxRepositoryBytes === undefined) {
    delete process.env.APPS_V2_MAX_REPOSITORY_BYTES;
  } else {
    process.env.APPS_V2_MAX_REPOSITORY_BYTES = previousMaxRepositoryBytes;
  }
  if (previousDurabilityConfirmed === undefined) {
    delete process.env.APPS_V2_GIT_DURABILITY_CONFIRMED;
  } else {
    process.env.APPS_V2_GIT_DURABILITY_CONFIRMED = previousDurabilityConfirmed;
  }
}
