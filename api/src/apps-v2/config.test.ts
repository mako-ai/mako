import assert from "node:assert/strict";
import {
  APP_V2_SESSION_MAX_TIMEOUT_MS,
  APP_V2_SESSION_OPERATION_LEASE_MS,
  getAppsV2GitRoot,
  getAppsV2MaxRepositoryBytes,
  getAppsV2SandboxConfiguration,
  isAppsV2Enabled,
  isAppsV2GitHubPushEnabled,
  validateAppsV2StartupConfiguration,
} from "./config";

const previousNodeEnvironment = process.env.NODE_ENV;
const previousGitRoot = process.env.APPS_V2_GIT_ROOT;
const previousEnabled = process.env.APPS_V2_ENABLED;
const previousGitHubPushEnabled = process.env.APPS_V2_GITHUB_PUSH_ENABLED;
const previousCloudRunService = process.env.K_SERVICE;
const previousMaxRepositoryBytes = process.env.APPS_V2_MAX_REPOSITORY_BYTES;
const previousDurabilityConfirmed =
  process.env.APPS_V2_GIT_DURABILITY_CONFIRMED;
const previousEphemeralGit = process.env.APPS_V2_ALLOW_EPHEMERAL_GIT;
const previousInngestEnvironment = process.env.INNGEST_ENV;
const previousBaseUrl = process.env.BASE_URL;
const previousSandboxProvider = process.env.APPS_V2_SANDBOX_PROVIDER;
const previousE2BApiKey = process.env.E2B_API_KEY;
const previousE2BTemplateId = process.env.E2B_TEMPLATE_ID;
const previousE2BUser = process.env.APPS_V2_E2B_USER;

try {
  assert(
    APP_V2_SESSION_OPERATION_LEASE_MS > APP_V2_SESSION_MAX_TIMEOUT_MS,
    "default operation lease must cover the configured command maximum",
  );
  process.env.APPS_V2_ENABLED = "false";
  assert.equal(isAppsV2Enabled(), false);
  process.env.APPS_V2_ENABLED = "true";
  assert.equal(isAppsV2Enabled(), true);
  delete process.env.APPS_V2_GITHUB_PUSH_ENABLED;
  assert.equal(isAppsV2GitHubPushEnabled(), false);
  process.env.APPS_V2_GITHUB_PUSH_ENABLED = "true";
  assert.equal(isAppsV2GitHubPushEnabled(), true);

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
  delete process.env.APPS_V2_GIT_DURABILITY_CONFIRMED;
  process.env.APPS_V2_ALLOW_EPHEMERAL_GIT = "true";
  process.env.INNGEST_ENV = "pr-698";
  process.env.BASE_URL = "https://pr-698.mako.ai";
  process.env.APPS_V2_GIT_ROOT = "/tmp/mako-apps-v2-git";
  assert.equal(getAppsV2GitRoot(), "/tmp/mako-apps-v2-git");
  process.env.BASE_URL = "https://app.mako.ai";
  assert.throws(() => getAppsV2GitRoot(), /DURABILITY_CONFIRMED=true/);
  delete process.env.APPS_V2_ALLOW_EPHEMERAL_GIT;
  delete process.env.INNGEST_ENV;
  delete process.env.BASE_URL;
  process.env.APPS_V2_GIT_DURABILITY_CONFIRMED = "true";
  process.env.APPS_V2_GIT_ROOT = "/var/lib/mako/apps-v2";

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

  delete process.env.APPS_V2_SANDBOX_PROVIDER;
  delete process.env.E2B_API_KEY;
  delete process.env.E2B_TEMPLATE_ID;
  delete process.env.APPS_V2_E2B_USER;
  assert.deepEqual(getAppsV2SandboxConfiguration(), {
    available: false,
    provider: "off",
    reason: "off",
  });
  process.env.APPS_V2_SANDBOX_PROVIDER = "e2b";
  assert.equal(getAppsV2SandboxConfiguration().available, false);
  process.env.E2B_API_KEY = "control-only";
  process.env.E2B_TEMPLATE_ID = "pinned-template";
  assert.equal(getAppsV2SandboxConfiguration().available, false);
  process.env.APPS_V2_E2B_USER = "mako";
  assert.deepEqual(getAppsV2SandboxConfiguration(), {
    available: true,
    provider: "e2b",
    apiKey: "control-only",
    templateId: "pinned-template",
    user: "mako",
  });
  process.env.APPS_V2_SANDBOX_PROVIDER = "local";
  assert.deepEqual(getAppsV2SandboxConfiguration(), {
    available: false,
    provider: "off",
    reason: "unsupported_provider",
  });
} finally {
  if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnvironment;
  if (previousGitRoot === undefined) delete process.env.APPS_V2_GIT_ROOT;
  else process.env.APPS_V2_GIT_ROOT = previousGitRoot;
  if (previousEnabled === undefined) delete process.env.APPS_V2_ENABLED;
  else process.env.APPS_V2_ENABLED = previousEnabled;
  if (previousGitHubPushEnabled === undefined) {
    delete process.env.APPS_V2_GITHUB_PUSH_ENABLED;
  } else {
    process.env.APPS_V2_GITHUB_PUSH_ENABLED = previousGitHubPushEnabled;
  }
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
  if (previousEphemeralGit === undefined) {
    delete process.env.APPS_V2_ALLOW_EPHEMERAL_GIT;
  } else {
    process.env.APPS_V2_ALLOW_EPHEMERAL_GIT = previousEphemeralGit;
  }
  if (previousInngestEnvironment === undefined) {
    delete process.env.INNGEST_ENV;
  } else {
    process.env.INNGEST_ENV = previousInngestEnvironment;
  }
  if (previousBaseUrl === undefined) {
    delete process.env.BASE_URL;
  } else {
    process.env.BASE_URL = previousBaseUrl;
  }
  if (previousSandboxProvider === undefined) {
    delete process.env.APPS_V2_SANDBOX_PROVIDER;
  } else {
    process.env.APPS_V2_SANDBOX_PROVIDER = previousSandboxProvider;
  }
  if (previousE2BApiKey === undefined) delete process.env.E2B_API_KEY;
  else process.env.E2B_API_KEY = previousE2BApiKey;
  if (previousE2BTemplateId === undefined) delete process.env.E2B_TEMPLATE_ID;
  else process.env.E2B_TEMPLATE_ID = previousE2BTemplateId;
  if (previousE2BUser === undefined) delete process.env.APPS_V2_E2B_USER;
  else process.env.APPS_V2_E2B_USER = previousE2BUser;
}
